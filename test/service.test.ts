/**
 * Akzeptanzkriterium Phase 6: "Text einfügen -> Draft erscheint in der UI."
 *
 * Ohne Netz: die Registry liefert Mock-Adapter, die durch denselben
 * Validierungs- und Preispfad laufen wie Gemini.
 *
 * Geprüft wird `handleCapture` direkt statt über HTTP. Ein Test, der einen
 * echten Port aufmacht, prüft vor allem das Framework.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCapture } from '../src/service/capture.ts';
import { openDb, applySchema } from '../src/db/index.ts';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { upsertVerwaltung, correctVerwaltung } from '../src/db/verwaltung.ts';
import {
  getListing, listOpen, updateDraft, transition, costToday, InvalidTransition,
} from '../src/db/listing.ts';
import type { Registry, StageName } from '../src/llm/registry.ts';
import type { Payload } from '../src/stages/extract.ts';
import type { GateVerdict } from '../src/stages/gate.ts';
import type { PipelineResult } from '../src/service/pipeline.ts';

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

const ALL_STAGES: StageName[] =
  ['extract', 'gate', 'draft', 'draft_privat', 'research_firma', 'research_person'];

function mockRegistry(over: { payload?: unknown; verdict?: unknown } = {}): Registry {
  const bindings = Object.fromEntries(ALL_STAGES.map((s) => [s, {
    stage: s, capability: 'generate', provider: 'mock', model: 'gemini-3.7-flash', timeoutMs: 5000,
  }]));
  return {
    bindings: bindings as Registry['bindings'],
    generate: (stage) => createMockGenerateAdapter({
      model: 'gemini-3.7-flash',
      response: stage === 'extract' ? (over.payload ?? PAYLOAD) : (over.verdict ?? VERDICT),
    }),
    research: () => { throw new Error('research wird hier nicht gebraucht'); },
  };
}

function fresh(over: { payload?: unknown; verdict?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wobo-svc-'));
  const db = openDb(join(dir, 't.db'));
  applySchema(db);
  const registry = mockRegistry(over);
  return {
    db,
    capture: async (extra: Record<string, unknown> = {}) => {
      const res = await handleCapture(db, registry, {
        capture_version: 'v1',
        url: 'https://www.immobilienscout24.de/expose/162345678',
        source: 'is24',
        page_text: PAGE_TEXT,
        ...extra,
      }, { research: false });
      return { status: res.status, result: res.body as PipelineResult };
    },
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ------------------------------------------------------------ Ende zu Ende

test('Text einfuegen -> Draft landet in der Queue', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    const { status, result } = await capture();
    assert.equal(status, 201);
    assert.equal(result.branch, 'T_VERWALTUNG');
    assert.ok(result.listingId > 0);

    assert.equal(listOpen(db).length, 1);

    const listing = getListing(db, result.listingId)!;
    assert.equal(listing.external_id, '162345678');
    assert.equal(listing.state, 'drafted');
    assert.match(listing.draft_subject!, /^Anfrage 162345678 – Sonnenallee 104, 2 Zi\.$/);
    assert.match(listing.draft_body!, /Sehr geehrte Frau Kruse/);
    assert.ok(listing.cost_usd > 0, 'Kosten werden mitgeschrieben (§11)');
  } finally { cleanup(); }
});

// ------------------------------------------------------------ Versandmodus §9

test('ohne Cache-Treffer kein Empfaenger, also kein Versand', async () => {
  const { capture, cleanup } = fresh();
  try {
    const { result } = await capture();
    assert.equal(result.recipient, null);
    assert.equal(result.sendMode, 'blocked');
  } finally { cleanup(); }
});

test('mit Cache-Treffer wird der Modus Undo', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_vermietung: 'vermietung@meyer-hv.de', confidence: 'high', source: 'prewarm',
    });
    const { result } = await capture();
    assert.equal(result.recipient, 'vermietung@meyer-hv.de');
    assert.equal(result.sendMode, 'undo');
  } finally { cleanup(); }
});

test('schwache Konfidenz des Empfaengers erzwingt Approve', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_general: 'info@meyer-hv.de', confidence: 'low',
    });
    assert.equal((await capture()).result.sendMode, 'approve');
  } finally { cleanup(); }
});

test('Betrugsrisiko high sperrt den Versand, Empfaenger hin oder her', async () => {
  const { db, capture, cleanup } = fresh({
    verdict: { ...VERDICT, risk: 'high', signals: ['prepayment_before_viewing'] },
  });
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'verwaltung',
      email_vermietung: 'v@meyer-hv.de', confidence: 'high',
    });
    const { result } = await capture();
    assert.equal(result.sendMode, 'blocked');
    const listing = getListing(db, result.listingId)!;
    assert.equal(listing.fraud_risk, 'high');
    assert.deepEqual(listing.fraud_signals, ['prepayment_before_viewing']);
    assert.equal(listing.recipient, 'v@meyer-hv.de');
    assert.equal(listing.send_mode, 'blocked');
  } finally { cleanup(); }
});

test('T0 landet direkt in manual und hat keinen Empfaenger', async () => {
  const { db, capture, cleanup } = fresh({
    verdict: { ...VERDICT, branch: 'T0', firm_type_guess: 'gesellschaft' },
  });
  try {
    const { result } = await capture();
    assert.equal(result.sendMode, 'manual');
    assert.equal(result.recipient, null, 'ein T0 mit Empfaenger waere laut §9 ein Bug');
    assert.equal(getListing(db, result.listingId)!.state, 'manual');
  } finally { cleanup(); }
});

// -------------------------------------------------------- Doppelerfassung §4

test('zweite Erfassung laeuft erneut, solange nichts weiter ist', async () => {
  const { capture, cleanup } = fresh();
  try {
    const first = await capture();
    assert.equal(first.result.decision, 'created');
    const second = await capture();
    assert.equal(second.result.decision, 'rerun');
    assert.equal(second.result.listingId, first.result.listingId, 'dasselbe Inserat');
  } finally { cleanup(); }
});

test('ist das Inserat weiter, gibt es keinen neuen Lauf', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    const first = await capture();
    transition(db, first.result.listingId, 'cancelled');
    const again = await capture();
    assert.equal(again.status, 200, 'kein 201 — nichts Neues entstanden');
    assert.equal(again.result.decision, 'existing');
    assert.equal(getListing(db, first.result.listingId)!.state, 'cancelled');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- Draft-Edit

test('Draft ist editierbar', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    const { result } = await capture();
    updateDraft(db, result.listingId, 'Neuer Betreff', 'Neuer Text');
    const listing = getListing(db, result.listingId)!;
    assert.equal(listing.draft_subject, 'Neuer Betreff');
    assert.equal(listing.draft_body, 'Neuer Text');
  } finally { cleanup(); }
});

test('unerlaubter Zustandswechsel wird abgelehnt (§10)', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    const { result } = await capture();
    transition(db, result.listingId, 'cancelled');
    assert.throws(() => transition(db, result.listingId, 'dead'), InvalidTransition);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- Firmen §12

test('Handkorrektur setzt confidence auf verified', async () => {
  const { db, cleanup } = fresh();
  try {
    const { id } = upsertVerwaltung(db, {
      nameRaw: 'Meyer Hausverwaltung', firm_type: 'unknown',
      email_general: 'falsch@meyer.de', confidence: 'low',
    });
    const v = correctVerwaltung(db, id, {
      firm_type: 'verwaltung', email_vermietung: 'richtig@meyer.de',
    })!;
    assert.equal(v.confidence, 'verified');
    assert.equal(v.email_vermietung, 'richtig@meyer.de');
    assert.equal(v.firm_type, 'verwaltung');
  } finally { cleanup(); }
});

// ------------------------------------------------------------------ Fehler

test('extract-Fehlschlag endet sauber, ohne halbe Zeile in der DB', async () => {
  const { db, capture, cleanup } = fresh({ payload: { listing: { external_id: '1' } } });
  try {
    const { result } = await capture();
    assert.equal(result.stoppedAt, 'extract');
    assert.equal(result.listingId, 0, 'nichts angelegt');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM listing_event').get() as { n: number }).n, 0);
  } finally { cleanup(); }
});

test('kurzer page_text wird abgewiesen, bevor er Tokens kostet', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    const { status } = await capture({ page_text: 'zu kurz' });
    assert.equal(status, 400);
    assert.equal(costToday(db), 0, 'kein Modellaufruf');
  } finally { cleanup(); }
});

test('Kosten summieren sich pro Tag (§16)', async () => {
  const { db, capture, cleanup } = fresh();
  try {
    await capture();
    const after = costToday(db);
    assert.ok(after > 0);
    await capture();
    assert.ok(costToday(db) > after, 'der zweite Lauf kostet zusaetzlich');
  } finally { cleanup(); }
});
