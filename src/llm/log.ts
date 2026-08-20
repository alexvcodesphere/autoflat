/**
 * "raw: Rohausgabe, immer mitschreiben — Debugging" (§11).
 *
 * Eine JSONL-Datei pro Tag unter data/llm-log/. Bewusst keine Tabelle: das
 * Log ist Wegwerfmaterial, die abrechnungsrelevanten Zahlen landen in
 * listing_event.
 *
 * §15: html_snapshot bleibt lokal — nie an ein Modell, nie in ein Log. Da
 * hier nur protokolliert wird, was tatsächlich an das Modell ging, ist das
 * automatisch erfüllt, solange kein Aufrufer den Snapshot in `input` legt.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.ts';
import type { LlmResult } from './types.ts';

export interface LlmLogEntry {
  stage?: string;
  adapter: string;
  system: string;
  input: string;
  result: LlmResult<unknown>;
}

export function logLlmCall(entry: LlmLogEntry): void {
  if (!env.llmLogEnabled) return;
  try {
    const dir = resolve(env.llmLogDir);
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const line = JSON.stringify({
      at: now.toISOString(),
      stage: entry.stage ?? null,
      adapter: entry.adapter,
      provider: entry.result.provider,
      model: entry.result.model,
      ok: entry.result.ok,
      error: entry.result.error ?? null,
      ms: entry.result.ms,
      usage: entry.result.usage,
      costUsd: entry.result.costUsd,
      system: entry.system,
      input: entry.input,
      raw: entry.result.raw,
    });
    appendFileSync(resolve(dir, `${now.toISOString().slice(0, 10)}.jsonl`), line + '\n');
  } catch {
    // Logging darf einen Lauf nie zum Scheitern bringen.
  }
}
