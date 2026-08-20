/**
 * gemini-generate — Fähigkeit `generate` (§11).
 *
 * Ein Aufruf, Systemprompt + Input -> JSON nach Schema. Wirft nicht, sondern
 * gibt `ok:false` mit `error.kind` zurück.
 */
import { GoogleGenAI } from '@google/genai';
import type { GenerateAdapter, GenerateRequest, LlmResult, LlmUsage } from '../types.ts';
import { priceCall, hasPricing } from '../pricing.ts';
import { validateAgainst } from '../validate.ts';
import { toGeminiJsonSchema } from './gemini-schema.ts';
import {
  PROVIDER, mapUsage, checkUsageConsistency, classifyError, REFUSAL_FINISH_REASONS,
} from './gemini-common.ts';

export { classifyError } from './gemini-common.ts';

export interface GeminiGenerateOptions {
  apiKey: string;
  model: string;
}

export function createGeminiGenerateAdapter(opts: GeminiGenerateOptions): GenerateAdapter {
  const { apiKey, model } = opts;
  if (!hasPricing(model)) {
    throw new Error(
      `gemini-generate: kein Preis für ${model} in config/pricing.json — ` +
        `costUsd wäre still 0 und das Tagesbudget (§16) wirkungslos.`,
    );
  }
  const client = new GoogleGenAI({ apiKey });

  return {
    id: `gemini-generate:${model}`,

    async generate<T>(req: GenerateRequest, timeoutMs: number): Promise<LlmResult<T>> {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const base = (usage: LlmUsage, raw: string): Omit<LlmResult<T>, 'ok' | 'data' | 'error'> => ({
        raw,
        usage,
        costUsd: priceCall(model, usage).totalUsd,
        ms: Math.round(performance.now() - startedAt),
        provider: PROVIDER,
        model,
      });

      try {
        const response = await client.models.generateContent({
          model,
          contents: req.input,
          config: {
            systemInstruction: req.system,
            responseMimeType: 'application/json',
            responseJsonSchema: toGeminiJsonSchema(req.schema),
            ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
            ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
            abortSignal: controller.signal,
          },
        });

        checkUsageConsistency(response.usageMetadata, model);
        const usage = mapUsage(response.usageMetadata);
        const raw = response.text ?? '';
        const finishReason = String(response.candidates?.[0]?.finishReason ?? '');
        const blockReason = String(response.promptFeedback?.blockReason ?? '');

        if (blockReason || REFUSAL_FINISH_REASONS.has(finishReason)) {
          return {
            ...base(usage, raw),
            ok: false,
            data: null,
            error: {
              kind: 'refusal',
              message: `Gemini hat abgelehnt (finishReason=${finishReason || '-'}, blockReason=${blockReason || '-'})`,
            },
          };
        }

        if (raw.trim() === '') {
          return {
            ...base(usage, raw),
            ok: false,
            data: null,
            error: {
              kind: 'schema',
              message:
                finishReason === 'MAX_TOKENS'
                  ? 'Leere Antwort: maxOutputTokens erreicht, bevor Text kam.'
                  : `Leere Antwort (finishReason=${finishReason || '-'})`,
            },
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          return {
            ...base(usage, raw),
            ok: false,
            data: null,
            error: {
              kind: 'schema',
              message:
                finishReason === 'MAX_TOKENS'
                  ? 'JSON abgeschnitten: maxOutputTokens erreicht.'
                  : `Antwort ist kein JSON: ${(parseErr as Error).message}`,
            },
          };
        }

        // Nicht auf die Anbieterzusage verlassen (§11).
        const validation = validateAgainst<T>(req.schema, parsed);
        if (!validation.valid) {
          return {
            ...base(usage, raw),
            ok: false,
            data: null,
            error: { kind: 'schema', message: `Schemaverletzung: ${validation.errors.join('; ')}` },
          };
        }

        return { ...base(usage, raw), ok: true, data: validation.data };
      } catch (err) {
        return {
          ...base({ inputTokens: 0, outputTokens: 0 }, ''),
          ok: false,
          data: null,
          error: classifyError(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
