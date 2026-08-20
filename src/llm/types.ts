/**
 * Fähigkeits-Interfaces (§11).
 *
 * `LlmResult` ist die einzige Form, die eine Stufe je zu sehen bekommt. Kein
 * anbieterspezifisches Feld darf durchsickern — kein `candidates`, kein
 * `stop_reason`, kein `structured_output`. Sickert etwas durch, ist die
 * Abstraktion wertlos.
 *
 * Fehler werden nicht geworfen, sondern zurückgegeben: `ok: false` plus
 * `error.kind`. Jede Stufe entscheidet selbst über ihren Fallback (§8).
 */

export type JsonSchema = Record<string, unknown>;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Gemini: zählt als Output und wird so abgerechnet. */
  thinkingTokens?: number;
  cachedInputTokens?: number;
  /** Für Grounding-Abrechnung. Ein Request kann mehrere Suchen auslösen. */
  searchQueries?: number;
}

export type LlmErrorKind =
  | 'timeout'
  | 'schema'
  | 'auth'
  | 'rate_limit'
  | 'refusal'
  | 'unknown';

export interface LlmError {
  kind: LlmErrorKind;
  message: string;
}

export interface LlmResult<T> {
  ok: boolean;
  data: T | null;
  /** Rohausgabe, immer mitschreiben — Debugging. */
  raw: string;
  usage: LlmUsage;
  costUsd: number;
  ms: number;
  provider: string;
  model: string;
  error?: LlmError;
}

export interface GenerateRequest {
  system: string;
  input: string;
  schema: JsonSchema;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ResearchRequest {
  system: string;
  task: string;
  schema: JsonSchema;
  /** Hinweis an den Adapter, keine Garantie. */
  maxSteps?: number;
  /** Beliebige URLs holen, nicht nur Suchtreffer. */
  allowFetch?: boolean;
}

export interface GenerateAdapter {
  readonly id: string;
  generate<T>(req: GenerateRequest, timeoutMs: number): Promise<LlmResult<T>>;
}

export interface ResearchAdapter {
  readonly id: string;
  readonly supportsGrounding: boolean;
  research<T>(req: ResearchRequest, timeoutMs: number): Promise<LlmResult<T>>;
}

export const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };
