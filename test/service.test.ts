/**
 * Akzeptanzkriterium Phase 6: "Text einfügen -> Draft erscheint in der UI."
 *
 * Ohne Netz: die Registry liefert Mock-Adapter, die durch denselben
 * Validierungs- und Preispfad laufen wie Gemini.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/service/server.ts';
import { openDb, applySchema } from '../src/db/index.ts';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { upsertVerwaltung } from '../src/db/verwaltung.ts';
import { getListing } from '../src/db/listing.ts';
import type { Registry, StageName } from '../src/llm/registry.ts';
import type { Payload } from '../src/stages/extract.ts';
import type { GateVerdict } from '../src/stages/gate.ts';

const PAGE_TEXT = `
Objektnummer 162345678
2-Zimmer-Altbauwohnung mit Balkon in Berlin-Neukölln
Sonnenallee 104, 12045 Berlin
Kaltmiete: 890 EUR
Anbieter: Meyer & Co. Hausverwaltung GmbH
Wir verwalten dieses Objekt seit 2011.
Ansprechpartnerin: Frau S. Kruse
`.trim();

const PAYLOAD: Payload = {
  listing: {
    external_id: '162345678', url: null, street: 'Sonnenallee', house_number: '104',
    postcode: '12045', district: 'Neukölln', rooms: 2, living_space: 58.4,
    cold_rent: 890, warm_rent: 1120, deposit: 2670, takeover_payment_eur: null,
    takeover_note: null, available_from: null, wbs_required: false,
    features: ['Altbau', 'Balkon'], description_excerpt: 'Gepflegte Altbauwohnung.',
  },
  provider: {
    name_raw: 'Meyer & Co. Hausverwaltung GmbH', contact_person_raw: 'Frau S. Kruse',
    phone_raw: '030 1234567', email_raw: null, website_raw: null,
    platform_private_flag: null, self_description: 'Wir verwalten dieses Objekt seit 2011.',
  },
};

const VERDICT: GateVerdict = {
  risk: 'low', signals: [], branch: 'T_VERWALTUNG', branch_confidence: 'high',
  firm_type_guess: 'verwaltung', reasoning: 'Der Text sagt "wir verwalten dieses Objekt".',
};

function mockRegistry(over: { payload?: unknown; verdict?: unknown } = {}): Registry {
  const bindings = Object.fromEntries(
    (['extract', 'gate', 'draft', 'draft_privat', 'research_firma', 'research_person'] as StageName[])
      .map((s) => [s, { stage: s, capability: 'generate', provider: 'mock', model: 'gemini-3.7-flash', timeoutMs: 5000 }]),
  );
  return {
    bindings: bindings as Registry['bindings'],
    generate: (stage) =>
      createMockGenerateAdapter({
        model: 'gemini-3.7-flash',
        response: stage === 'extract' ? (over.payload ?? PAYLOAD) : (over.verdict ?? VERDICT),
      }),
    research: () => { throw new Error('research wird in diesem Test nicht gebraucht'); },
  };
}

function fresh(over: { payload?: unknown; verdict?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wobo-svc-'));
  const db = openDb(join(dir, 't.db'));
  applySchema(db);
  const app = build({ db, registry: mockRegistry(over), research: false });
  return { app, db, cleanup: async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function capture(app: ReturnType<typeof build>, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/capture',
    payload: { capture_version: 'v1', url: 'https://www.immobilienscout24.de/expose/162345678', source: 'is24', page_text: PAGE_TEXT, ...extra },
  });
}

// ------------------------------------------------------------ Ende zu Ende

test('Text einfuegen -> Draft erscheint in der Queue', async () => {
  const { app, db, cleanup } = fresh();
  try {
    const res = await capture(app);
    assert.equal(res.statusCode, 201);
    const body = res.json() as { listingId: number; branch: string; sendMode: string };
    assert.equal(body.branch, 'T_VERWALTUNG');
    assert.ok(body.listingId > 0);

    const queue = (await app.inject({ method: 'GET', url: '/api/queue' })).json() as { listings: unknown[] };
    assert.equal(queue.listings.length, 1);

    const listing = getListing(db, body.listingId)!;
    assert.equal(listing.external_id, '162345678');
    assert.equal(listing.state, 'drafted');
    assert.match(listing.draft_subject!, /^Anfrage 162345678 – Sonnenallee 104, 2 Zi\.$/);
    assert.match(listing.draft_body!, /Sehr geehrte Frau Kruse/);
    assert.ok(listing.cost_usd > 0, 'Kosten werden mitgeschrieben (§11)');
  } finally { await cleanup(); }
});

test('ohne Cache-Treffer gibt es keinen Empfaenger, also kein Versand (§9)', async () => {
  const { app, cleanup } = fresh();
  try {
    const body = (await capture(app)).json() as { sendMode: string; recipient: string | null };
    assert.equal(body.recipient, null);
    assert.equal(body.sendMode, 'blocked');
  } finally { await cleanup(); }
});

test('mit Cache-Treffer wird der Empfaenger gesetzt und der Modus Undo', async () => {
  const { app, db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_vermietung: 'vermietung@meyer-hv.de', confidence: 'high', source: 'prewarm',
    });
    const body = (await capture(app)).json() as { sendMode: string; recipient: string; branch: string };
    assert.equal(body.recipient, 'vermietung@meyer-hv.de');
    assert.equal(body.sendMode, 'undo');
    assert.equal(body.branch, 'T_VERWALTUNG');
  } finally { await cleanup(); }
});

test('schwache Konfidenz des Empfaengers erzwingt Approve (§9)', async () => {
  const { app, db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_general: 'info@meyer-hv.de', confidence: 'low',
    });
    const body = (await capture(app)).json() as { sendMode: string };
    assert.equal(body.sendMode, 'approve');
  } finally { await cleanup(); }
});

test('Betrugsrisiko high sperrt den Versand', async () => {
  const { app, db, cleanup } = fresh({
    verdict: { ...VERDICT, risk: 'high', signals: ['prepayment_before_viewing'] },
  });
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_vermietung: 'v@meyer-hv.de', confidence: 'high',
    });
    const body = (await capture(app)).json() as { listingId: number; sendMode: string };
    assert.equal(body.sendMode, 'blocked');
    const listing = getListing(db, body.listingId)!;
    assert.equal(listing.fraud_risk, 'high');
    assert.deepEqual(listing.fraud_signals, ['prepayment_before_viewing']);
    assert.equal(listing.recipient, 'v@meyer-hv.de', 'Empfaenger steht da, gesendet wird trotzdem nicht');
    assert.equal(listing.send_mode, 'blocked');
  } finally { await cleanup(); }
});

test('T0 landet direkt in manual und hat keinen Empfaenger (§9)', async () => {
  const { app, db, cleanup } = fresh({ verdict: { ...VERDICT, branch: 'T0', firm_type_guess: 'gesellschaft' } });
  try {
    const body = (await capture(app)).json() as { listingId: number; sendMode: string; recipient: string | null };
    assert.equal(body.sendMode, 'manual');
    assert.equal(body.recipient, null, 'ein T0 mit Empfaenger waere laut §9 ein Bug');
    assert.equal(getListing(db, body.listingId)!.state, 'manual');
  } finally { await cleanup(); }
});

// -------------------------------------------------------- Doppelerfassung §4

test('zweite Erfassung laeuft erneut, solange nichts weiter ist', async () => {
  const { app, cleanup } = fresh();
  try {
    const first = (await capture(app)).json() as { listingId: number; decision: string };
    assert.equal(first.decision, 'created');
    const second = (await capture(app)).json() as { listingId: number; decision: string };
    assert.equal(second.decision, 'rerun');
    assert.equal(second.listingId, first.listingId, 'dasselbe Inserat, kein Duplikat');
  } finally { await cleanup(); }
});

test('ist das Inserat weiter, gibt es keinen neuen Lauf', async () => {
  const { app, db, cleanup } = fresh();
  try {
    const first = (await capture(app)).json() as { listingId: number };
    await app.inject({ method: 'POST', url: `/api/listings/${first.listingId}/cancel` });
    const res = await capture(app);
    assert.equal(res.statusCode, 200, 'kein 201 — nichts Neues entstanden');
    assert.equal((res.json() as { decision: string }).decision, 'existing');
    assert.equal(getListing(db, first.listingId)!.state, 'cancelled');
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- Draft-Edit

test('Draft ist editierbar', async () => {
  const { app, db, cleanup } = fresh();
  try {
    const { listingId } = (await capture(app)).json() as { listingId: number };
    const res = await app.inject({
      method: 'PATCH', url: `/api/listings/${listingId}/draft`,
      payload: { subject: 'Neuer Betreff', body: 'Neuer Text' },
    });
    assert.equal(res.statusCode, 200);
    const listing = getListing(db, listingId)!;
    assert.equal(listing.draft_subject, 'Neuer Betreff');
    assert.equal(listing.draft_body, 'Neuer Text');
  } finally { await cleanup(); }
});

test('unerlaubter Zustandswechsel wird abgelehnt (§10)', async () => {
  const { app, cleanup } = fresh();
  try {
    const { listingId } = (await capture(app)).json() as { listingId: number };
    await app.inject({ method: 'POST', url: `/api/listings/${listingId}/cancel` });
    // cancelled -> dead ist nicht erlaubt
    const res = await app.inject({ method: 'POST', url: `/api/listings/${listingId}/done` });
    assert.equal(res.statusCode, 409);
    assert.match((res.json() as { error: string }).error, /nicht erlaubt/);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- Firmen §12

test('Handkorrektur setzt confidence auf verified', async () => {
  const { app, db, cleanup } = fresh();
  try {
    const { id } = upsertVerwaltung(db, {
      nameRaw: 'Meyer Hausverwaltung', firm_type: 'unknown',
      email_general: 'falsch@meyer.de', confidence: 'low',
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/verwaltung/${id}`,
      payload: { firm_type: 'verwaltung', email_vermietung: 'richtig@meyer.de' },
    });
    assert.equal(res.statusCode, 200);
    const v = (res.json() as { verwaltung: { confidence: string; email_vermietung: string; firm_type: string } }).verwaltung;
    assert.equal(v.confidence, 'verified');
    assert.equal(v.email_vermietung, 'richtig@meyer.de');
    assert.equal(v.firm_type, 'verwaltung');
  } finally { await cleanup(); }
});

// ------------------------------------------------------------------ Fehler

test('extract-Fehlschlag endet sauber, ohne halbe Zeile in der DB', async () => {
  const { app, db, cleanup } = fresh({ payload: { listing: { external_id: '1' } } });
  try {
    const res = await capture(app);
    assert.equal(res.statusCode, 201);
    const body = res.json() as { stoppedAt: string; listingId: number };
    assert.equal(body.stoppedAt, 'extract');
    assert.equal(body.listingId, 0, 'nichts angelegt');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM listing_event').get() as { n: number }).n, 0);
  } finally { await cleanup(); }
});

test('kurzer page_text wird abgewiesen', async () => {
  const { app, cleanup } = fresh();
  try {
    const res = await app.inject({ method: 'POST', url: '/capture', payload: { page_text: 'zu kurz' } });
    assert.equal(res.statusCode, 400);
  } finally { await cleanup(); }
});

test('stats liefert Budget und Modellzuordnung', async () => {
  const { app, cleanup } = fresh();
  try {
    await capture(app);
    const stats = (await app.inject({ method: 'GET', url: '/api/stats' })).json() as
      { costToday: number; costStop: number; stages: Record<string, string> };
    assert.ok(stats.costToday > 0);
    assert.equal(stats.costStop, 5);
    assert.equal(stats.stages['extract'], 'mock:gemini-3.7-flash');
  } finally { await cleanup(); }
});
