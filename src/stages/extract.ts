/**
 * Stufe `extract` (§14 Phase 2).
 *
 * page_text (+ json_ld) -> Payload nach §5. Erste Stufe der Pipeline; alles
 * danach hängt an ihrem Ergebnis.
 */
import { readFileSync } from 'node:fs';
import { fromRoot } from '../lib/paths.ts';
import type { GenerateAdapter, LlmResult } from '../llm/types.ts';
import { loadSchema } from '../llm/validate.ts';
import { logLlmCall } from '../llm/log.ts';
import { externalIdFromUrl, type CaptureInput } from '../lib/capture.ts';

/**
 * Schemaversion des Payloads. §5: "Es ändert sich in Woche zwei."
 *
 * v2: takeover_payment_eur und takeover_note. Aufgefallen, weil das Gate in
 * einem echten Inserat eine Abstandszahlung von 7.350 € zitierte, für die es
 * in v1 kein Feld gab — auf eine Wohnung mit 685 € Kaltmiete. §13 verlangt
 * für T_NACHMIETER die "Übernahme" als variablen Teil des Anschreibens.
 */
export const PAYLOAD_VERSION = 2;

export interface Listing {
  external_id: string | null;
  url: string | null;
  street: string | null;
  house_number: string | null;
  postcode: string | null;
  district: string | null;
  rooms: number | null;
  living_space: number | null;
  cold_rent: number | null;
  warm_rent: number | null;
  deposit: number | null;
  /** Abstandszahlung/Ablöse an den bisherigen Mieter, nicht an den Vermieter. */
  takeover_payment_eur: number | null;
  takeover_note: string | null;
  available_from: string | null;
  wbs_required: boolean | null;
  features: string[];
  description_excerpt: string | null;
}

export interface Provider {
  name_raw: string | null;
  contact_person_raw: string | null;
  phone_raw: string | null;
  email_raw: string | null;
  website_raw: string | null;
  platform_private_flag: boolean | null;
  self_description: string | null;
}

export interface Payload {
  listing: Listing;
  provider: Provider;
}

/**
 * Was an dem Payload fehlt, um weiterverarbeitet zu werden.
 *
 * Kein Fehler, sondern ein Wegweiser: ohne `name_raw` gibt es keinen
 * Cache-Lookup und keinen Empfänger, das Inserat gehört nach T0 (§8 Flow B).
 */
export type PayloadIssue = 'no_external_id' | 'no_provider_name';

export interface ExtractResult {
  ok: boolean;
  payload: Payload | null;
  issues: PayloadIssue[];
  /** Roh-Ergebnis der Stufe — Kosten, Dauer, Fehlerart (§11). */
  llm: LlmResult<Payload>;
}

const PROMPT_PATH = fromRoot('prompts', 'extract.md');

let systemPrompt: string | null = null;
function loadSystemPrompt(): string {
  systemPrompt ??= readFileSync(PROMPT_PATH, 'utf8');
  return systemPrompt;
}

/**
 * page_text wird gedeckelt. Ein Exposé liegt bei 4-8k Zeichen (§4); alles
 * deutlich darüber ist Navigationsmüll oder eine Suchergebnisseite, und das
 * Extraktionsbudget von 3 s verträgt keinen Roman.
 */
const MAX_PAGE_TEXT_CHARS = 24_000;
const MAX_JSON_LD_CHARS = 8_000;

export interface BuildInputOptions {
  /** YYYY-MM-DD. Injizierbar, damit Tests nicht am Kalender hängen. */
  today?: string;
}

export function buildExtractInput(capture: CaptureInput, opts: BuildInputOptions = {}): string {
  const parts: string[] = [];
  if (capture.url) parts.push(`URL: ${capture.url}`);
  parts.push(`Quelle: ${capture.source}`);
  // Damit "ab 01.09." zu einem Datum werden kann, ohne dass das Modell das
  // Jahr rät. Der Dienst weiß es, das Modell nicht.
  parts.push(`Heutiges Datum: ${opts.today ?? new Date().toISOString().slice(0, 10)}`);

  const jsonLd = (capture.json_ld ?? []).join('\n').trim();
  if (jsonLd) {
    parts.push(`\n--- JSON-LD ---\n${jsonLd.slice(0, MAX_JSON_LD_CHARS)}`);
  }
  parts.push(`\n--- Seitentext ---\n${capture.page_text.slice(0, MAX_PAGE_TEXT_CHARS)}`);
  return parts.join('\n');
}

/**
 * Nachbereitung nach dem Modellaufruf.
 *
 * - `url` kommt vom Client, nicht vom Modell — der Client weiß es sicher.
 * - Fehlt `external_id`, wird ein Ersatzschlüssel aus der URL gebildet (§4).
 *   Damit ist das Pflichtfeld aus §5 erfüllt, ohne dass das Modell eine
 *   Nummer erfinden muss.
 * - Leere Strings sind kein Wert. Manche Modelle liefern "" statt null.
 */
export function finalizePayload(raw: Payload, capture: CaptureInput): {
  payload: Payload;
  issues: PayloadIssue[];
} {
  const listing: Listing = { ...raw.listing };
  const provider: Provider = { ...raw.provider };

  for (const obj of [listing, provider] as unknown as Array<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.trim() === '') obj[key] = null;
    }
  }

  listing.url = capture.url;
  listing.features = (listing.features ?? []).map((f) => f.trim()).filter(Boolean);

  const issues: PayloadIssue[] = [];
  if (!listing.external_id) {
    const fallback = externalIdFromUrl(capture.url);
    if (fallback) listing.external_id = fallback;
    else issues.push('no_external_id');
  }
  if (!provider.name_raw) issues.push('no_provider_name');

  return { payload: { listing, provider }, issues };
}

export interface ExtractOptions {
  timeoutMs?: number;
  /** Für das Log; ordnet den Aufruf einem Inserat zu. */
  label?: string;
  /** YYYY-MM-DD, siehe BuildInputOptions. */
  today?: string;
}

/**
 * Führt die Stufe aus. Wirft nicht — bei Fehlschlag ist `payload` null und
 * `llm.error` sagt, warum (§8: jede Stufe braucht Timeout und Fallback).
 */
export async function runExtract(
  adapter: GenerateAdapter,
  capture: CaptureInput,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const system = loadSystemPrompt();
  const input = buildExtractInput(capture, { today: opts.today });
  const schema = loadSchema('payload');

  const llm = await adapter.generate<Payload>(
    { system, input, schema, temperature: 0 },
    opts.timeoutMs ?? 8_000,
  );
  logLlmCall({ stage: 'extract', adapter: adapter.id, system, input, result: llm });

  if (!llm.ok || !llm.data) return { ok: false, payload: null, issues: [], llm };

  const { payload, issues } = finalizePayload(llm.data, capture);
  return { ok: true, payload, issues, llm };
}
