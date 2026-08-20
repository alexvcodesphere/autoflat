/**
 * Was sich gemini-generate und gemini-research teilen.
 *
 * Nichts hiervon verlässt die Adapterschicht: nach außen gibt es nur
 * LlmResult (§11).
 */
import type { LlmError, LlmUsage } from '../types.ts';

export const PROVIDER = 'gemini';

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

export function mapUsage(
  meta: GeminiUsageMetadata | undefined,
  searchQueries = 0,
): LlmUsage {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
    thinkingTokens: meta?.thoughtsTokenCount ?? 0,
    cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
    searchQueries,
  };
}

/**
 * Selbstkontrolle der Abrechnungsannahme.
 *
 * Wir rechnen `candidatesTokenCount + thoughtsTokenCount` zum Output-Satz ab.
 * Das stimmt nur, wenn Gemini beide getrennt meldet. Wären thoughts bereits
 * in candidates enthalten, zahlten wir sie doppelt und das Tagesbudget (§16)
 * stünde auf falschen Zahlen. Einmal pro Prozess prüfen, damit es kein
 * Log-Rauschen gibt.
 */
let usageMismatchReported = false;

export function checkUsageConsistency(meta: GeminiUsageMetadata | undefined, model: string): void {
  if (usageMismatchReported || !meta?.totalTokenCount) return;
  const parts =
    (meta.promptTokenCount ?? 0) +
    (meta.candidatesTokenCount ?? 0) +
    (meta.thoughtsTokenCount ?? 0) +
    (meta.toolUsePromptTokenCount ?? 0);
  if (parts === meta.totalTokenCount) return;
  usageMismatchReported = true;
  console.warn(
    `[gemini:${model}] Token-Summen gehen nicht auf: ` +
      `prompt ${meta.promptTokenCount ?? 0} + candidates ${meta.candidatesTokenCount ?? 0} + ` +
      `thoughts ${meta.thoughtsTokenCount ?? 0} + toolUse ${meta.toolUsePromptTokenCount ?? 0} ` +
      `= ${parts}, gemeldet ${meta.totalTokenCount}. ` +
      `Die Kostenrechnung in src/llm/pricing.ts unterstellt, dass thinking-Tokens ` +
      `NICHT in candidates enthalten sind — das ist zu prüfen.`,
  );
}

export const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII',
]);

/** SDK-/HTTP-Fehler auf die sechs Fehlerarten aus §11 abbilden. */
export function classifyError(err: unknown): LlmError {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { kind: 'timeout', message: err.message };
  }

  // `fetch failed` allein ist beim Debuggen wertlos — der eigentliche Grund
  // (ENOTFOUND, ECONNREFUSED, Zertifikatsfehler) steckt in `cause`.
  const cause = (err as { cause?: { message?: string; code?: string } } | null)?.cause;
  const baseMessage = err instanceof Error ? err.message : String(err);
  const message =
    cause?.message && cause.message !== baseMessage
      ? `${baseMessage}: ${cause.message}${cause.code ? ` (${cause.code})` : ''}`
      : baseMessage;
  const status = (err as { status?: number } | null)?.status;
  const haystack = `${status ?? ''} ${message}`.toLowerCase();

  // Ältere Modelle lehnen strukturierte Ausgabe zusammen mit der Suche ab.
  // Ohne eigene Meldung landet das als "unknown" und kostet eine Stunde.
  if (/controlled generation is not supported|not supported with google_search/.test(haystack)) {
    return {
      kind: 'schema',
      message:
        `${message}\n` +
        'Dieses Modell kann strukturierte Ausgabe nicht mit der Google-Suche kombinieren. ' +
        'Nur die Gemini-3-Familie kann das — prüfe STAGE_RESEARCH_* in .env.',
    };
  }
  if (status === 401 || status === 403 || /api[_ ]?key|unauthenticated|permission denied/.test(haystack)) {
    return { kind: 'auth', message };
  }
  if (status === 429 || /rate limit|resource_exhausted|quota/.test(haystack)) {
    return { kind: 'rate_limit', message };
  }
  if (/abort|timed? ?out|deadline/.test(haystack)) {
    return { kind: 'timeout', message };
  }
  return { kind: 'unknown', message };
}
