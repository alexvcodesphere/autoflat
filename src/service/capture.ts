/**
 * `POST /capture` (§4) als reine Funktion.
 *
 * Bewusst ohne Framework: der Next Route Handler ruft sie auf, und die Tests
 * rufen sie direkt — ohne HTTP dazwischen. Ein Test, der über einen echten
 * Port geht, prüft vor allem das Framework.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Registry } from '../llm/registry.ts';
import { sourceFromUrl, type CaptureInput } from '../lib/capture.ts';
import { runPipeline, BudgetExceeded, type PipelineResult } from './pipeline.ts';
import { publish } from './events.ts';
import { env } from '../config/env.ts';

export interface CaptureBody {
  capture_version?: string;
  url?: string | null;
  source?: string;
  page_text?: string;
  json_ld?: string[];
  /** §15: bleibt lokal. Nie an ein Modell, nie in ein Log. */
  html_snapshot?: string;
}

export interface CaptureResponse {
  status: number;
  body: PipelineResult | { error: string };
}

/**
 * Kürzer als das hier ist kein Exposé. Fängt versehentlich leere Aufrufe der
 * Extension ab, bevor sie einen Modellaufruf kosten.
 */
const MIN_PAGE_TEXT = 50;

export interface HandleCaptureOptions {
  research?: boolean;
}

export async function handleCapture(
  db: Db,
  registry: Registry,
  body: CaptureBody,
  opts: HandleCaptureOptions = {},
): Promise<CaptureResponse> {
  if (typeof body?.page_text !== 'string' || body.page_text.trim().length < MIN_PAGE_TEXT) {
    return { status: 400, body: { error: 'page_text fehlt oder ist zu kurz' } };
  }

  const capture: CaptureInput = {
    capture_version: body.capture_version ?? 'v1',
    url: body.url ?? null,
    source: body.source ?? sourceFromUrl(body.url ?? null),
    page_text: body.page_text,
    json_ld: Array.isArray(body.json_ld) ? body.json_ld : [],
  };

  let result: PipelineResult;
  try {
    result = await runPipeline(db, registry, capture, {
      research: opts.research ?? true,
      onEvent: (e) => publish({
        type: 'pipeline', listingId: e.listingId, step: e.step, message: e.message,
      }),
    });
  } catch (err) {
    if (err instanceof BudgetExceeded) return { status: 429, body: { error: err.message } };
    throw err;
  }

  // §4: der Snapshot geht nur auf Platte. Zweck ist die Neu-Extraktion in
  // Woche drei, wenn ein Feld dazukommt — ohne die Seite erneut zu besuchen.
  if (typeof body.html_snapshot === 'string' && result.listingId > 0) {
    try {
      const dir = resolve(env.snapshotDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${result.listingId}.html`), body.html_snapshot);
    } catch {
      // Ein fehlender Snapshot ist kein Grund, die Erfassung zu verwerfen.
    }
  }

  publish({ type: 'listing', listingId: result.listingId });
  return { status: result.decision === 'existing' ? 200 : 201, body: result };
}
