/**
 * Der Dienst (§2): ein Fastify-Prozess. HTTP, Pipeline, später Cron und Mail.
 *
 * Die UI liegt als eigene Next-App unter web/ und redet über diese JSON-API.
 * Das weicht von §12 ab ("kein separater Frontend-Build, ein Port") — dafür
 * bleibt der Node-Teil unverändert lauffähig, inklusive der CLI-Skripte und
 * der Crons, die in Next keinen guten Platz hätten.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { openDb, applySchema, type Db } from '../db/index.ts';
import { loadRegistry, STAGES, type Registry } from '../llm/registry.ts';
import { runPipeline, BudgetExceeded } from './pipeline.ts';
import { publish, subscribe } from './events.ts';
import {
  listOpen, listAll, getListing, updateDraft, transition, costToday, InvalidTransition,
} from '../db/listing.ts';
import { listVerwaltung, correctVerwaltung } from '../db/verwaltung.ts';
import { seedStats, takeBatch, openQuarantine, type SeedRow } from '../db/seed.ts';
import { groundingStats } from '../db/grounding.ts';
import { importPrewarm, summarize, ImportRejected } from '../lib/prewarm-import.ts';
import { decideSendMode } from '../lib/send-mode.ts';
import { sourceFromUrl, type CaptureInput } from '../lib/capture.ts';
import { env } from '../config/env.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuildOptions {
  db?: Db;
  registry?: Registry;
  /** Recherche bei Cache-Miss zulassen. Aus in Tests. */
  research?: boolean;
}

export function build(opts: BuildOptions = {}): FastifyInstance {
  const db = opts.db ?? (() => { const d = openDb(); applySchema(d); return d; })();
  const registry = opts.registry ?? loadRegistry({ stages: STAGES });
  const research = opts.research ?? true;

  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  // ------------------------------------------------------------- Erfassung
  /**
   * §4. Der Client parst nichts — er schickt Rohmaterial. Der Snapshot geht
   * nur auf Platte, nie an ein Modell (§15).
   */
  app.post('/capture', async (request, reply) => {
    const body = request.body as Partial<CaptureInput> & { html_snapshot?: string };
    if (typeof body?.page_text !== 'string' || body.page_text.trim().length < 50) {
      return reply.code(400).send({ error: 'page_text fehlt oder ist zu kurz' });
    }

    const capture: CaptureInput = {
      capture_version: body.capture_version ?? 'v1',
      url: body.url ?? null,
      source: body.source ?? sourceFromUrl(body.url ?? null),
      page_text: body.page_text,
      json_ld: Array.isArray(body.json_ld) ? body.json_ld : [],
    };

    let result;
    try {
      result = await runPipeline(db, registry, capture, {
        research,
        onEvent: (e) => publish({
          type: 'pipeline', listingId: e.listingId, step: e.step, message: e.message,
        }),
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) return reply.code(429).send({ error: err.message });
      throw err;
    }

    // §4: Snapshot nur auf Platte, benannt nach der Inseratsnummer.
    if (typeof body.html_snapshot === 'string' && result.listingId > 0) {
      try {
        const dir = resolve(env.snapshotDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${result.listingId}.html`), body.html_snapshot);
      } catch { /* ein fehlender Snapshot ist kein Grund, die Erfassung zu verwerfen */ }
    }

    publish({ type: 'listing', listingId: result.listingId });
    return reply.code(result.decision === 'existing' ? 200 : 201).send(result);
  });

  // ---------------------------------------------------------------- Queue
  app.get('/api/queue', async () => ({ listings: listOpen(db) }));
  app.get('/api/listings', async (request) => {
    const { limit } = request.query as { limit?: string };
    return { listings: listAll(db, limit ? Number(limit) : 200) };
  });

  app.get('/api/listings/:id', async (request, reply) => {
    const listing = getListing(db, Number((request.params as { id: string }).id));
    if (!listing) return reply.code(404).send({ error: 'nicht gefunden' });

    // Den Versandmodus mitliefern, damit die UI ihn nicht nachbauen muss.
    const mode = listing.send_mode ?? decideSendMode({
      branch: listing.branch as never,
      risk: (listing.fraud_risk ?? 'medium') as never,
      branchConfidence: (listing.branch_confidence ?? 'low') as never,
      recipientConfidence: null,
      hasRecipient: listing.recipient !== null,
    }).mode;
    return { listing, sendMode: mode };
  });

  app.patch('/api/listings/:id/draft', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const { subject, body } = request.body as { subject?: string; body?: string };
    if (typeof subject !== 'string' || typeof body !== 'string') {
      return reply.code(400).send({ error: 'subject und body sind Pflicht' });
    }
    if (!getListing(db, id)) return reply.code(404).send({ error: 'nicht gefunden' });
    updateDraft(db, id, subject, body);
    publish({ type: 'listing', listingId: id });
    return { ok: true };
  });

  /**
   * Zustandswechsel aus der UI. Nur die, die ohne Mailversand auskommen —
   * `queued` und `sent` gehören zu Phase 7.
   */
  app.post('/api/listings/:id/:action', async (request, reply) => {
    const { id: rawId, action } = request.params as { id: string; action: string };
    const id = Number(rawId);
    const targets: Record<string, 'cancelled' | 'dead' | 'manual'> = {
      cancel: 'cancelled',
      done: 'dead',        // T0: "ich markiere danach erledigt" (§9)
      portal: 'manual',    // "übers Portal bewerben" (§12)
    };
    const to = targets[action];
    if (!to) return reply.code(400).send({ error: `unbekannte Aktion: ${action}` });

    try {
      transition(db, id, to);
    } catch (err) {
      if (err instanceof InvalidTransition) return reply.code(409).send({ error: err.message });
      throw err;
    }
    publish({ type: 'listing', listingId: id });
    return { ok: true, state: to };
  });

  // --------------------------------------------------------------- Firmen
  app.get('/api/verwaltung', async () => ({
    verwaltung: listVerwaltung(db),
    quarantine: openQuarantine(db),
  }));

  /** §12: Handkorrektur setzt confidence = 'verified'. */
  app.patch('/api/verwaltung/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const updated = correctVerwaltung(db, id, request.body as Record<string, never>);
    if (!updated) return reply.code(404).send({ error: 'nicht gefunden' });
    publish({ type: 'verwaltung', id });
    return { verwaltung: updated };
  });

  // -------------------------------------------------------------- Vorwärmen
  app.get('/api/prewarm/batch', async (request) => {
    const { n } = request.query as { n?: string };
    const batch = takeBatch(db, Math.min(30, Math.max(1, Number(n ?? 15))));
    return {
      batch,
      block: batch.map((r) => `${r.name_raw} | ${r.address ?? 'Berlin'}${r.website_hint ? ` | ${r.website_hint}` : ''}`).join('\n'),
      stats: seedStats(db),
    };
  });

  app.post('/api/prewarm/import', async (request, reply) => {
    const { raw } = request.body as { raw?: string };
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'raw fehlt' });
    const requested = db
      .prepare(`SELECT * FROM seed_company WHERE status = 'in_progress' ORDER BY id`)
      .all() as SeedRow[];
    if (requested.length === 0) {
      return reply.code(409).send({ error: 'Kein offener Batch — erst /api/prewarm/batch aufrufen' });
    }
    try {
      const outcome = importPrewarm(db, raw, requested);
      return { outcome, summary: summarize(outcome) };
    } catch (err) {
      if (err instanceof ImportRejected) return reply.code(400).send({ error: err.message, raw });
      throw err;
    }
  });

  // ---------------------------------------------------------------- Status
  app.get('/api/stats', async () => ({
    costToday: costToday(db),
    costWarn: env.costWarnUsdPerDay,
    costStop: env.costStopUsdPerDay,
    grounding: groundingStats(db),
    seed: seedStats(db),
    stages: Object.fromEntries(
      Object.entries(registry.bindings).map(([k, v]) => [k, `${v.provider}:${v.model}`]),
    ),
  }));

  // ------------------------------------------------------------------- SSE
  app.get('/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    reply.raw.write(': verbunden\n\n');

    const unsubscribe = subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    // Zwischendurch ein Kommentar, damit Proxys die Verbindung nicht kappen.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  app.get('/health', async () => ({ ok: true }));
  app.addHook('onClose', async () => { if (!opts.db) db.close(); });
  return app;
}
