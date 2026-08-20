/**
 * Import der Cowork-Ergebnisse (§17).
 *
 * "Cowork liefert JSON ohne erzwungenes Schema. Vertraue der Ausgabe nicht."
 *
 * Der Import ist zeilenweise, nicht alles-oder-nichts: Liefert Cowork 14 von
 * 15 Einträgen, werden die 14 verarbeitet und der fehlende bleibt `pending`.
 */
import type { Db } from '../db/index.ts';
import { normalizeCompanyName } from '../lib/normalize.ts';
import { upsertVerwaltung, type Confidence, type FirmType } from '../db/verwaltung.ts';
import { markSeed, quarantine, releaseStale, type SeedRow } from '../db/seed.ts';

const FIRM_TYPES: ReadonlySet<string> = new Set([
  'verwaltung', 'makler', 'gesellschaft', 'genossenschaft', 'privat', 'unknown',
]);
const CONFIDENCES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'none']);

const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

function emailDomain(email: string): string {
  return email.trim().split('@')[1]!.toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

/** Gleiche Domain oder Subdomain in eine der beiden Richtungen. */
export function domainsMatch(emailDom: string, siteDomain: string): boolean {
  const a = normalizeDomain(emailDom);
  const b = normalizeDomain(siteDomain);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export interface CoworkRow {
  name_input?: unknown;
  domain?: unknown;
  impressum_url?: unknown;
  vermietung_url?: unknown;
  email_vermietung?: unknown;
  email_general?: unknown;
  contact_persons?: unknown;
  firm_type?: unknown;
  portal_only?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}

export interface ImportOutcome {
  accepted: Array<{ name: string; verwaltungId: number; confidence: Confidence }>;
  quarantined: Array<{ name: string; reasons: string[] }>;
  /** Angefordert, aber nicht beantwortet — bleibt pending (§17). */
  missing: string[];
  /** Korrigiert statt abgelehnt: firm_type/confidence auf den Ersatzwert. */
  coerced: Array<{ name: string; note: string }>;
  /** Bestehende Firma war `verified` — nicht überschrieben (§17). */
  skippedVerified: string[];
}

export class ImportRejected extends Error {}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Verarbeitet eine Cowork-Antwort gegen die aktuell offenen Batch-Zeilen.
 *
 * `requested` sind die Zeilen, die der Export als `in_progress` markiert hat.
 * Nur für die wird eine Antwort akzeptiert — eine Zeile, die niemand
 * angefordert hat, geht in Quarantäne, statt still in den Cache zu wandern.
 */
export function importPrewarm(db: Db, rawText: string, requested: SeedRow[]): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new ImportRejected(`Kein gültiges JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ImportRejected(
      `Erwartet wird ein JSON-Array, bekommen: ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }

  const bySeedKey = new Map(requested.map((r) => [r.name_canonical, r]));
  const answered = new Set<string>();

  const outcome: ImportOutcome = {
    accepted: [], quarantined: [], missing: [], coerced: [], skippedVerified: [],
  };

  for (const entry of parsed as CoworkRow[]) {
    const nameInput = asString(entry?.name_input);
    if (!nameInput) {
      outcome.quarantined.push({ name: '(ohne name_input)', reasons: ['name_input fehlt oder ist leer'] });
      continue;
    }

    // §17: name_canonical wird IMMER im Service berechnet, nie aus der
    // Cowork-Ausgabe übernommen.
    const canonical = normalizeCompanyName(nameInput);
    const seed = bySeedKey.get(canonical) ?? null;
    const reasons: string[] = [];

    if (!seed) {
      reasons.push(`"${nameInput}" gehört zu keiner angeforderten Firma dieses Batches`);
    } else {
      answered.add(canonical);
    }

    let firmType = asString(entry.firm_type) ?? 'unknown';
    if (!FIRM_TYPES.has(firmType)) {
      outcome.coerced.push({ name: nameInput, note: `firm_type "${firmType}" unbekannt -> unknown` });
      firmType = 'unknown';
    }

    let confidence = asString(entry.confidence) ?? 'none';
    if (!CONFIDENCES.has(confidence)) {
      outcome.coerced.push({ name: nameInput, note: `confidence "${confidence}" unbekannt -> none` });
      confidence = 'none';
    }

    const domain = asString(entry.domain);
    const emails: Array<['email_vermietung' | 'email_general', string | null]> = [
      ['email_vermietung', asString(entry.email_vermietung)],
      ['email_general', asString(entry.email_general)],
    ];

    for (const [field, value] of emails) {
      if (value === null) continue;
      if (!isValidEmail(value)) {
        reasons.push(`${field} "${value}" ist keine gültige E-Mail-Adresse`);
        continue;
      }
      if (domain && !domainsMatch(emailDomain(value), domain)) {
        reasons.push(`${field} "${value}" passt nicht zur Domain "${domain}"`);
      }
    }

    const hasEmail = emails.some(([, v]) => v !== null);
    if (hasEmail && confidence === 'none') {
      reasons.push('E-Mail vorhanden, aber confidence "none" — widersprüchlich');
    }

    if (reasons.length > 0) {
      quarantine(db, {
        seed_id: seed?.id ?? null,
        name_input: nameInput,
        name_canonical: canonical || null,
        payload: entry,
        reasons,
      });
      outcome.quarantined.push({ name: nameInput, reasons });
      if (seed) markSeed(db, seed.id, 'done');
      continue;
    }

    const contactPersons = Array.isArray(entry.contact_persons)
      ? (entry.contact_persons as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];

    const { id, skipped } = upsertVerwaltung(db, {
      nameRaw: nameInput,
      firm_type: firmType as FirmType,
      domain,
      impressum_url: asString(entry.impressum_url),
      vermietung_url: asString(entry.vermietung_url),
      email_vermietung: emails[0]![1],
      email_general: emails[1]![1],
      contact_persons: contactPersons,
      confidence: confidence as Confidence,
      portal_only: entry.portal_only === true,
      source: 'prewarm',
    });

    if (skipped) outcome.skippedVerified.push(nameInput);
    else outcome.accepted.push({ name: nameInput, verwaltungId: id, confidence: confidence as Confidence });
    if (seed) markSeed(db, seed.id, 'done');
  }

  // Angeforderte, aber unbeantwortete Zeilen zurück in die Warteschlange.
  const unanswered = requested.filter((r) => !answered.has(r.name_canonical));
  releaseStale(db, unanswered.map((r) => r.id));
  outcome.missing = unanswered.map((r) => r.name_raw);

  return outcome;
}

export function summarize(outcome: ImportOutcome): string {
  const parts = [
    `${outcome.accepted.length} übernommen`,
    `${outcome.quarantined.length} in Quarantäne`,
    `${outcome.missing.length} fehlt`,
  ];
  if (outcome.skippedVerified.length > 0) parts.push(`${outcome.skippedVerified.length} verified geschützt`);
  if (outcome.coerced.length > 0) parts.push(`${outcome.coerced.length} korrigiert`);
  return parts.join(', ');
}
