'use server';
/**
 * Mutationen als Server Actions.
 *
 * Ersetzt die PATCH- und POST-Endpunkte, die es in der Fastify-Fassung gab:
 * kein fetch, kein CORS, keine doppelten Typen. Die eigentliche Logik liegt
 * unverändert in src/db/.
 */
import { revalidatePath } from 'next/cache';
import { getDb } from '../lib/server.ts';
import { updateDraft, transition, InvalidTransition, type ListingState } from '../../src/db/listing.ts';
import { correctVerwaltung, upsertVerwaltung, type FirmType } from '../../src/db/verwaltung.ts';
import { getQuarantine, closeQuarantine } from '../../src/db/seed.ts';
import { publish } from '../../src/service/events.ts';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function saveDraft(id: number, subject: string, body: string): Promise<ActionResult> {
  if (!subject.trim() || !body.trim()) {
    return { ok: false, error: 'Betreff und Text dürfen nicht leer sein' };
  }
  updateDraft(getDb(), id, subject, body);
  publish({ type: 'listing', listingId: id });
  revalidatePath(`/listing/${id}`);
  revalidatePath('/');
  return { ok: true };
}

/**
 * Nur Übergänge ohne Mailversand. `queued` und `sent` gehören zu Phase 7 —
 * §10 lässt sie erst zu, wenn tatsächlich gesendet werden kann.
 */
const UI_TRANSITIONS: Record<string, ListingState> = {
  cancel: 'cancelled',
  portal: 'manual',
  done: 'dead',
};

export async function changeState(id: number, action: string): Promise<ActionResult> {
  const to = UI_TRANSITIONS[action];
  if (!to) return { ok: false, error: `unbekannte Aktion: ${action}` };
  try {
    transition(getDb(), id, to);
  } catch (err) {
    if (err instanceof InvalidTransition) return { ok: false, error: err.message };
    throw err;
  }
  publish({ type: 'listing', listingId: id });
  revalidatePath('/');
  revalidatePath(`/listing/${id}`);
  return { ok: true };
}

export interface FirmFix {
  firm_type?: FirmType;
  email_vermietung?: string | null;
  email_general?: string | null;
  portal_only?: boolean;
}

/** §12: "eine Korrektur von Hand setzt confidence = 'verified'". */
export async function fixVerwaltung(id: number, fix: FirmFix): Promise<ActionResult> {
  const updated = correctVerwaltung(getDb(), id, fix);
  if (!updated) return { ok: false, error: 'Firma nicht gefunden' };
  publish({ type: 'verwaltung', id });
  revalidatePath('/firmen');
  return { ok: true };
}

export async function captureText(pageText: string, url: string): Promise<ActionResult & { id?: number }> {
  const { handleCapture } = await import('../../src/service/capture.ts');
  const { getRegistry } = await import('../lib/server.ts');
  const res = await handleCapture(getDb(), getRegistry(), {
    capture_version: 'v1',
    url: url.trim() || null,
    page_text: pageText,
  });
  revalidatePath('/');
  if (res.status >= 400) return { ok: false, error: (res.body as { error: string }).error };
  const result = res.body as { listingId: number };
  return { ok: true, id: result.listingId };
}

/**
 * Quarantänezeile übernehmen (§17). Bewusst über `correctVerwaltung`-Semantik:
 * Wer eine geprüfte Zeile durchwinkt, hat sie angesehen — das ist derselbe
 * Vorgang wie eine Handkorrektur und rechtfertigt `verified`.
 */
export async function acceptQuarantine(id: number): Promise<ActionResult> {
  const db = getDb();
  const row = getQuarantine(db, id);
  if (!row) return { ok: false, error: 'Quarantänezeile nicht gefunden' };

  const p = row.payload as {
    domain?: string | null; impressum_url?: string | null; vermietung_url?: string | null;
    email_vermietung?: string | null; email_general?: string | null;
    contact_persons?: unknown; firm_type?: string; portal_only?: unknown;
  };
  const { id: verwaltungId } = upsertVerwaltung(db, {
    nameRaw: row.name_input,
    firm_type: (p.firm_type ?? 'unknown') as FirmType,
    domain: p.domain ?? null,
    impressum_url: p.impressum_url ?? null,
    vermietung_url: p.vermietung_url ?? null,
    email_vermietung: p.email_vermietung ?? null,
    email_general: p.email_general ?? null,
    contact_persons: Array.isArray(p.contact_persons)
      ? (p.contact_persons as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
    confidence: 'verified',
    portal_only: p.portal_only === true,
    source: 'prewarm',
  });
  correctVerwaltung(db, verwaltungId, {});   // erzwingt verified + last_verified_at
  closeQuarantine(db, id, 'accepted');
  publish({ type: 'verwaltung', id: verwaltungId });
  revalidatePath('/firmen');
  return { ok: true };
}

export async function rejectQuarantine(id: number): Promise<ActionResult> {
  closeQuarantine(getDb(), id, 'rejected');
  revalidatePath('/firmen');
  return { ok: true };
}
