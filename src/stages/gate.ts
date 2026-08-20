/**
 * Stufe `gate` (§14 Phase 5).
 *
 * Betrugsprüfung und Klassifikation in einem Aufruf (§7 Stufe 3): "Derselbe
 * Aufruf gibt den Zweig zurück — null zusätzliche LLM-Aufrufe."
 *
 * Das Gate läuft bei jedem Inserat, auch wenn ein hartes Signal den Zweig
 * schon festlegt: Die Betrugsprüfung ist davon unabhängig.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GenerateAdapter, LlmResult } from '../llm/types.ts';
import { loadSchema } from '../llm/validate.ts';
import { logLlmCall } from '../llm/log.ts';
import type { Payload } from './extract.ts';
import type { Verwaltung } from '../db/verwaltung.ts';
import { hardSignal, type Branch, type BranchConfidence, type HardSignal } from '../lib/classify.ts';

const PROMPT_PATH = resolve(import.meta.dirname, '../../prompts/gate.md');

export type FraudRisk = 'low' | 'medium' | 'high';
export type FraudSignal =
  | 'rent_far_below_market' | 'prepayment_before_viewing' | 'landlord_abroad'
  | 'keys_by_mail' | 'machine_translated' | 'pressure_to_leave_platform'
  | 'no_viewing_possible' | 'identity_inconsistent' | 'other';

export interface GateVerdict {
  risk: FraudRisk;
  signals: FraudSignal[];
  branch: Branch;
  branch_confidence: BranchConfidence;
  firm_type_guess: 'verwaltung' | 'makler' | 'gesellschaft' | 'genossenschaft' | 'privat' | 'unknown';
  reasoning: string;
}

export interface GateResult {
  ok: boolean;
  /** Rohes Modellurteil, unverändert. */
  verdict: GateVerdict | null;
  /** Der Zweig, mit dem weitergearbeitet wird — harte Signale können gewinnen. */
  branch: Branch;
  branchConfidence: BranchConfidence;
  /** Woher der Zweig kommt. Gehört in die UI, damit die Entscheidung nachvollziehbar ist. */
  branchSource: 'hard_signal' | 'gate' | 'fallback';
  hardSignal: HardSignal | null;
  risk: FraudRisk;
  signals: FraudSignal[];
  note?: string;
  llm: LlmResult<GateVerdict>;
}

let systemPrompt: string | null = null;
function loadSystemPrompt(): string {
  systemPrompt ??= readFileSync(PROMPT_PATH, 'utf8');
  return systemPrompt;
}

/**
 * page_text wird gedeckelt wie bei extract. §7 Stufe 3 begründet, warum der
 * Volltext hier überhaupt hingehört: "Ein Modell mit dem vollen page_text
 * unterscheidet Makler von Verwaltung deutlich besser als jede Regex."
 */
const MAX_PAGE_TEXT_CHARS = 24_000;

export interface GateInput {
  payload: Payload;
  pageText: string;
  source: string;
  cached?: Verwaltung | null;
}

export function buildGateInput(input: GateInput): string {
  const parts = [
    `Quelle: ${input.source}`,
    '',
    '--- Extrahierte Daten ---',
    JSON.stringify(input.payload, null, 1),
  ];
  if (input.cached) {
    // Was der Cache schon weiß, gehört in den Kontext — sonst widerspricht
    // das Gate einem Ergebnis, das aus echter Recherche stammt.
    parts.push(
      '',
      '--- Bereits bekannt über diese Firma ---',
      `firm_type: ${input.cached.firm_type}, confidence: ${input.cached.confidence}` +
        (input.cached.portal_only ? ', portal_only: true' : ''),
    );
  }
  parts.push('', '--- Seitentext ---', input.pageText.slice(0, MAX_PAGE_TEXT_CHARS));
  return parts.join('\n');
}

/**
 * Der Fallback, wenn das Gate scheitert (§8: "Jede Stufe braucht Timeout und
 * Fallback").
 *
 * T0 ist die sichere Wahl: kein Versand, Text zum Kopieren, ich bewerbe mich
 * selbst übers Portal. Nie schlechter dran als ganz ohne System.
 */
const FALLBACK_BRANCH: Branch = 'T0';

export async function runGate(
  adapter: GenerateAdapter,
  input: GateInput,
  opts: { timeoutMs?: number } = {},
): Promise<GateResult> {
  const signal = hardSignal({ payload: input.payload, source: input.source, cached: input.cached });
  const system = loadSystemPrompt();
  const text = buildGateInput(input);
  const schema = loadSchema('gate');

  const llm = await adapter.generate<GateVerdict>(
    { system, input: text, schema, temperature: 0 },
    opts.timeoutMs ?? 8_000,
  );
  logLlmCall({ stage: 'gate', adapter: adapter.id, system, input: text, result: llm });

  if (!llm.ok || !llm.data) {
    // Ohne Gate-Urteil gibt es keine Betrugsprüfung. Ein hartes Signal darf
    // den Zweig trotzdem setzen, aber der Versand bleibt gesperrt: §9 verlangt
    // Approve, sobald etwas unklar ist — und hier ist alles unklar.
    return {
      ok: false,
      verdict: null,
      branch: signal?.decisive ? signal.branch : FALLBACK_BRANCH,
      branchConfidence: 'low',
      branchSource: signal?.decisive ? 'hard_signal' : 'fallback',
      hardSignal: signal,
      risk: 'medium',
      signals: [],
      ...(signal?.note ? { note: signal.note } : {}),
      llm,
    };
  }

  const verdict = llm.data;

  // Ein entscheidendes hartes Signal gewinnt: ein Cache-Eintrag stammt aus
  // echter Recherche, eine Portal-Kennzeichnung ist Tatsache. Das Gate urteilt
  // über Text und kann sich irren.
  if (signal?.decisive) {
    return {
      ok: true,
      verdict,
      branch: signal.branch,
      branchConfidence: signal.confidence,
      branchSource: 'hard_signal',
      hardSignal: signal,
      risk: verdict.risk,
      signals: verdict.signals,
      ...(signal.note ? { note: signal.note } : {}),
      llm,
    };
  }

  // Nicht entscheidendes Signal: Das Gate darf widersprechen, aber nur mit
  // hoher Konfidenz. Ein Portal, das "privat" schreibt, wiegt mehr als eine
  // Vermutung aus dem Fließtext.
  if (signal && verdict.branch !== signal.branch && verdict.branch_confidence !== 'high') {
    return {
      ok: true,
      verdict,
      branch: signal.branch,
      branchConfidence: 'medium',
      branchSource: 'hard_signal',
      hardSignal: signal,
      risk: verdict.risk,
      signals: verdict.signals,
      llm,
    };
  }

  return {
    ok: true,
    verdict,
    branch: verdict.branch,
    branchConfidence: verdict.branch_confidence,
    branchSource: 'gate',
    hardSignal: signal,
    risk: verdict.risk,
    signals: verdict.signals,
    llm,
  };
}
