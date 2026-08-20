/**
 * Mock-Adapter für Tests und den Rauchtest ohne API-Key.
 *
 * Läuft bewusst durch denselben Validierungs- und Preispfad wie der echte
 * Adapter — sonst bewiese ein grüner Test nichts über die Kette.
 */
import type {
  GenerateAdapter,
  GenerateRequest,
  LlmError,
  LlmResult,
  LlmUsage,
} from '../types.ts';
import { priceCall, hasPricing } from '../pricing.ts';
import { validateAgainst } from '../validate.ts';

export interface MockGenerateOptions {
  model: string;
  /** Was das "Modell" antwortet. Funktion bekommt den Request. */
  response?: unknown | ((req: GenerateRequest) => unknown);
  /** Roher Text statt eines Objekts — für Tests mit kaputtem JSON. */
  rawResponse?: string;
  usage?: Partial<LlmUsage>;
  delayMs?: number;
  /** Erzwingt einen Fehler statt einer Antwort. */
  failWith?: LlmError;
}

const DEFAULT_USAGE: LlmUsage = { inputTokens: 1200, outputTokens: 180, thinkingTokens: 0 };

export function createMockGenerateAdapter(opts: MockGenerateOptions): GenerateAdapter {
  const { model } = opts;
  const usage: LlmUsage = { ...DEFAULT_USAGE, ...opts.usage };

  return {
    id: `mock-generate:${model}`,

    async generate<T>(req: GenerateRequest, timeoutMs: number): Promise<LlmResult<T>> {
      const startedAt = performance.now();
      const delay = opts.delayMs ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      const costUsd = hasPricing(model) ? priceCall(model, usage).totalUsd : 0;
      const base = (raw: string) => ({
        raw,
        usage,
        costUsd,
        ms: Math.round(performance.now() - startedAt),
        provider: 'mock',
        model,
      });

      if (delay > timeoutMs) {
        return {
          ...base(''),
          ok: false,
          data: null,
          error: { kind: 'timeout', message: `Mock-Timeout nach ${timeoutMs} ms` },
        };
      }
      if (opts.failWith) {
        return { ...base(''), ok: false, data: null, error: opts.failWith };
      }

      let raw: string;
      if (opts.rawResponse !== undefined) {
        raw = opts.rawResponse;
      } else {
        const value =
          typeof opts.response === 'function'
            ? (opts.response as (r: GenerateRequest) => unknown)(req)
            : opts.response;
        raw = JSON.stringify(value ?? null);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ...base(raw),
          ok: false,
          data: null,
          error: { kind: 'schema', message: `Antwort ist kein JSON: ${(err as Error).message}` },
        };
      }

      const validation = validateAgainst<T>(req.schema, parsed);
      if (!validation.valid) {
        return {
          ...base(raw),
          ok: false,
          data: null,
          error: { kind: 'schema', message: `Schemaverletzung: ${validation.errors.join('; ')}` },
        };
      }
      return { ...base(raw), ok: true, data: validation.data };
    },
  };
}
