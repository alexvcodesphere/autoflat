/**
 * Die Pipeline (§2): extract -> gate -> resolve -> draft.
 *
 * Ersetzt scripts/pipeline.ts. Anders als das Wegwerf-Skript schreibt sie
 * mit, hält das Tagesbudget (§16) ein und meldet jeden Schritt über den
 * Event-Bus, damit die UI mitläuft.
 *
 * Jede Stufe hat Timeout und Fallback (§8): Bricht etwas ab, bekomme ich den
 * Plain-Draft oder T0 und bin nie schlechter dran als ganz ohne System.
 */
import type { Db } from '../db/index.ts';
import type { Registry } from '../llm/registry.ts';
import type { CaptureInput } from '../lib/capture.ts';
import { externalIdFromUrl, sourceFromUrl } from '../lib/capture.ts';
import { runExtract, type Payload } from '../stages/extract.ts';
import { runGate } from '../stages/gate.ts';
import { researchFirma } from '../stages/research-firma.ts';
import { findVerwaltung, upsertVerwaltung, type Verwaltung } from '../db/verwaltung.ts';
import { insertSeed } from '../db/seed.ts';
import { settleGrounding } from '../db/grounding.ts';
import { renderVerwaltung } from '../render/verwaltung.ts';
import { loadProfile } from '../lib/profile.ts';
import { decideSendMode, type SendMode } from '../lib/send-mode.ts';
import { isSendBranch, type Branch } from '../lib/classify.ts';
import {
  upsertCapture, markDrafted, addCost, costToday, previousContact,
  type CaptureDecision,
} from '../db/listing.ts';
import { env } from '../config/env.ts';

export type PipelineStep = 'extract' | 'cache' | 'research' | 'gate' | 'draft' | 'done' | 'failed';

export interface PipelineEvent {
  listingId: number;
  step: PipelineStep;
  message: string;
  costUsd: number;
  ms: number;
}

export interface PipelineResult {
  listingId: number;
  decision: CaptureDecision;
  branch: Branch | null;
  sendMode: SendMode | null;
  recipient: string | null;
  costUsd: number;
  ms: number;
  /** Warum die Pipeline vorzeitig endete, falls sie das tat. */
  stoppedAt?: PipelineStep;
  error?: string;
}

export class BudgetExceeded extends Error {}

export interface RunPipelineOptions {
  /** Recherche bei Cache-Miss zulassen (§8 Flow B). */
  research?: boolean;
  onEvent?: (event: PipelineEvent) => void;
}

/**
 * §16: "Warnung bei > $2/Tag, harter Stopp bei > $5/Tag."
 *
 * Vor dem ersten Modellaufruf prüfen — ein Stopp mitten in der Pipeline
 * würde ein halb bearbeitetes Inserat hinterlassen.
 */
function assertBudget(db: Db): void {
  const spent = costToday(db);
  if (spent > env.costStopUsdPerDay) {
    throw new BudgetExceeded(
      `Tagesbudget erschöpft: $${spent.toFixed(4)} von $${env.costStopUsdPerDay} (§16). ` +
        `Morgen wieder, oder COST_STOP_USD_PER_DAY in .env anheben.`,
    );
  }
}

export async function runPipeline(
  db: Db,
  registry: Registry,
  capture: CaptureInput,
  opts: RunPipelineOptions = {},
): Promise<PipelineResult> {
  const startedAt = performance.now();
  let cost = 0;
  let listingId = 0;

  const source = capture.source || sourceFromUrl(capture.url);
  const emit = (step: PipelineStep, message: string, stepCost = 0, stepMs = 0): void => {
    opts.onEvent?.({ listingId, step, message, costUsd: stepCost, ms: stepMs });
  };
  const finish = (over: Partial<PipelineResult>): PipelineResult => ({
    listingId,
    decision: 'created',
    branch: null,
    sendMode: null,
    recipient: null,
    costUsd: cost,
    ms: Math.round(performance.now() - startedAt),
    ...over,
  });

  assertBudget(db);

  // ------------------------------------------------------------- 1 extract
  const extractAdapter = registry.generate('extract');
  const extract = await runExtract(extractAdapter, capture, {
    timeoutMs: registry.bindings.extract.timeoutMs,
  });
  cost += extract.llm.costUsd;
  emit('extract', extract.ok ? 'Daten gelesen' : `gescheitert: ${extract.llm.error?.message}`,
    extract.llm.costUsd, extract.llm.ms);

  if (!extract.ok || !extract.payload) {
    return finish({ stoppedAt: 'extract', error: extract.llm.error?.message ?? 'extract fehlgeschlagen' });
  }
  const payload: Payload = extract.payload;

  // §4: fehlt eine Objektnummer, trägt ein Ersatzschlüssel aus der URL.
  const externalId = payload.listing.external_id ?? externalIdFromUrl(capture.url);
  if (!externalId) {
    return finish({ stoppedAt: 'extract', error: 'Weder Objektnummer noch brauchbare URL — nicht speicherbar' });
  }

  const { id, decision } = upsertCapture(db, {
    externalId, source, url: capture.url, payload,
  });
  listingId = id;
  addCost(db, id, extract.llm.costUsd);

  if (decision === 'existing') {
    emit('done', 'Schon bearbeitet — kein neuer Lauf (§4)');
    return finish({ decision, stoppedAt: 'done' });
  }

  // --------------------------------------------------------- 2 Firmen-Cache
  const nameRaw = payload.provider.name_raw;
  let cached: Verwaltung | null = nameRaw ? findVerwaltung(db, nameRaw) : null;
  emit('cache', cached ? `Cache-Treffer: ${cached.name_canonical} (Flow A)` :
    nameRaw ? `Cache-Miss: ${nameRaw}` : 'Kein Anbietername');

  // ------------------------------------------------------------ 3 research
  if (!cached && nameRaw && opts.research) {
    const adapter = registry.research('research_firma');
    const hint = [payload.listing.street, payload.listing.postcode, payload.listing.district]
      .filter(Boolean).join(' ') || null;
    const res = await researchFirma(adapter, {
      name: nameRaw,
      addressHint: hint,
      websiteHint: payload.provider.website_raw,
      contactPerson: payload.provider.contact_person_raw,
    }, { timeoutMs: registry.bindings.research_firma.timeoutMs, allowFallback: true });

    // Suchanfragen gegen das Freikontingent rechnen (§11).
    const settled = settleGrounding(db, res.llm.usage.searchQueries ?? 0);
    const real = res.llm.costUsd - settled.conservativeUsd + settled.groundingUsd;
    cost += real;
    addCost(db, id, real);

    const email = res.data?.email_vermietung ?? res.data?.email_general ?? null;
    if (res.ok && res.data && res.data.confidence !== 'none' && email) {
      upsertVerwaltung(db, {
        nameRaw,
        firm_type: res.data.firm_type,
        domain: res.data.domain,
        impressum_url: res.data.impressum_url,
        vermietung_url: res.data.vermietung_url,
        email_vermietung: res.data.email_vermietung,
        email_general: res.data.email_general,
        contact_persons: res.data.contact_persons,
        confidence: res.data.confidence,
        portal_only: res.data.portal_only,
        source: 'listing',
      });
      cached = findVerwaltung(db, nameRaw);
      emit('research', `gefunden: ${email} (${res.data.firm_type}, ${res.data.confidence})`, real, res.llm.ms);
    } else {
      // §8 Flow B, Schritt 4: die Firma inseriert nachweislich — Priorität 1.
      insertSeed(db, { name_raw: nameRaw, address: hint, origin: 'listing', priority: 1 });
      emit('research', `nichts Belastbares — Firma in die Warteschlange`, real, res.llm.ms);
    }
  }

  // ---------------------------------------------------------------- 4 gate
  const gate = await runGate(
    registry.generate('gate'),
    { payload, pageText: capture.page_text, source, cached },
    { timeoutMs: registry.bindings.gate.timeoutMs },
  );
  cost += gate.llm.costUsd;
  addCost(db, id, gate.llm.costUsd);
  emit('gate', gate.ok
    ? `${gate.branch}, Risiko ${gate.risk}${gate.signals.length ? ` (${gate.signals.join(', ')})` : ''}`
    : `gescheitert, Rückfall T0: ${gate.llm.error?.message}`,
    gate.llm.costUsd, gate.llm.ms);

  const branch = gate.branch;
  const recipient = isSendBranch(branch)
    ? (cached?.email_vermietung ?? cached?.email_general ?? null)
    : null;

  const { mode, reasons } = decideSendMode({
    branch,
    risk: gate.risk,
    branchConfidence: gate.branchConfidence,
    recipientConfidence: cached?.confidence ?? null,
    hasRecipient: recipient !== null,
  });

  // --------------------------------------------------------------- 5 draft
  // Ohne Modell (§8 Flow A). Nur T_VERWALTUNG ist gebaut; die anderen
  // Templates kommen in Phase 9/10 und bekommen denselben Renderer.
  let subject: string | null = null;
  let body: string | null = null;
  try {
    const profile = loadProfile();
    const prev = cached ? previousContact(db, cached.id, id) : null;
    const draft = renderVerwaltung(payload, profile, {
      previousContact: prev
        ? { sentAt: (prev.sent_at ?? prev.created_at).slice(0, 10), externalId: prev.external_id }
        : undefined,
    });
    subject = draft.subject;
    body = draft.body;
    emit('draft', `${draft.wordCount} Wörter${draft.blockers.length ? ` · ${draft.blockers.join('; ')}` : ''}`);
  } catch (err) {
    emit('draft', `Renderer gescheitert: ${(err as Error).message}`);
  }

  const state = markDrafted(db, {
    id,
    verwaltungId: cached?.id ?? null,
    branch,
    branchConfidence: gate.branchConfidence,
    risk: gate.risk,
    signals: gate.signals,
    subject,
    body,
    recipient,
    sendMode: mode,
    usedHook: false,
    costUsd: 0,
  });

  emit('done', `${state} · ${mode}${reasons.length ? ` (${reasons[0]})` : ''}`);
  return finish({ decision, branch, sendMode: mode, recipient });
}
