/**
 * Alles ohne Netz. Der Mock-Adapter durchläuft denselben Validierungspfad wie
 * Gemini; ob das echte Modell gut urteilt, zeigt `npm run gate:fixtures`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { runGate, buildGateInput, type GateVerdict } from '../src/stages/gate.ts';
import { hardSignal, isSendBranch, isGesellschaft, GESELLSCHAFTEN } from '../src/lib/classify.ts';
import { openDb, applySchema } from '../src/db/index.ts';
import { upsertVerwaltung, findVerwaltung } from '../src/db/verwaltung.ts';
import { loadSchema, validateAgainst } from '../src/llm/validate.ts';
import { toGeminiJsonSchema } from '../src/llm/providers/gemini-schema.ts';
import type { Payload, Listing, Provider } from '../src/stages/extract.ts';

function listing(over: Partial<Listing> = {}): Listing {
  return {
    external_id: '1', url: null, street: null, house_number: null, postcode: null,
    district: null, rooms: 2, living_space: null, cold_rent: null, warm_rent: null,
    deposit: null, takeover_payment_eur: null, takeover_note: null,
    available_from: null, wbs_required: null, features: [],
    description_excerpt: null, ...over,
  };
}
function provider(over: Partial<Provider> = {}): Provider {
  return {
    name_raw: 'Meyer & Co. Hausverwaltung GmbH', contact_person_raw: null, phone_raw: null,
    email_raw: null, website_raw: null, platform_private_flag: null, self_description: null, ...over,
  };
}
function payload(l: Partial<Listing> = {}, p: Partial<Provider> = {}): Payload {
  return { listing: listing(l), provider: provider(p) };
}

const VERDICT: GateVerdict = {
  risk: 'low', signals: [], branch: 'T_VERWALTUNG', branch_confidence: 'high',
  firm_type_guess: 'verwaltung', reasoning: 'Der Text sagt "wir verwalten dieses Objekt".',
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wobo-gate-'));
  const db = openDb(join(dir, 'test.db'));
  applySchema(db);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ------------------------------------------------------- harte Signale (§7)

test('portal_only im Cache schlaegt alles', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, { nameRaw: 'Meyer & Co. Hausverwaltung GmbH', firm_type: 'makler', portal_only: true, confidence: 'high' });
    const s = hardSignal({ payload: payload(), source: 'is24', cached: findVerwaltung(db, 'Meyer & Co. Hausverwaltung GmbH') });
    assert.equal(s?.branch, 'T0');
    assert.equal(s?.decisive, true);
    assert.match(s!.reason, /portal_only/);
  } finally { cleanup(); }
});

test('bekannter firm_type im Cache legt den Zweig fest (§7 Stufe 2)', () => {
  const { db, cleanup } = fresh();
  try {
    for (const [firmType, branch] of [
      ['verwaltung', 'T_VERWALTUNG'], ['makler', 'T_MAKLER'],
      ['gesellschaft', 'T0'], ['genossenschaft', 'T0'], ['privat', 'T_PRIVAT'],
    ] as Array<[string, string]>) {
      const name = `Firma ${firmType} GmbH`;
      upsertVerwaltung(db, { nameRaw: name, firm_type: firmType as never, confidence: 'high' });
      const s = hardSignal({
        payload: payload({}, { name_raw: name }), source: 'is24', cached: findVerwaltung(db, name),
      });
      assert.equal(s?.branch, branch, `${firmType} -> ${branch}`);
      assert.equal(s?.decisive, true);
    }
  } finally { cleanup(); }
});

test('firm_type unknown im Cache legt nichts fest', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, { nameRaw: 'Unklar GmbH', firm_type: 'unknown', confidence: 'low' });
    const s = hardSignal({
      payload: payload({}, { name_raw: 'Unklar GmbH' }), source: 'is24',
      cached: findVerwaltung(db, 'Unklar GmbH'),
    });
    assert.equal(s, null, 'dann entscheidet das Gate');
  } finally { cleanup(); }
});

test('kommunale Gesellschaften und Genossenschaften gehen nach T0 (§8 Flow E)', () => {
  for (const name of GESELLSCHAFTEN) {
    const s = hardSignal({ payload: payload({}, { name_raw: `${name} Wohnungsbaugesellschaft mbH` }), source: 'is24' });
    assert.equal(s?.branch, 'T0', name);
    assert.ok(s?.note, `${name}: Checklisten-Hinweis fehlt`);
  }
  for (const name of ['Wohnungsgenossenschaft Solidarität eG', 'Baugenossenschaft Freie Scholle eG', 'Berliner Bau- und Wohnungsgenossenschaft von 1892 eG']) {
    const s = hardSignal({ payload: payload({}, { name_raw: name }), source: 'is24' });
    assert.equal(s?.branch, 'T0', name);
    assert.equal(s?.decisive, true);
  }
});

test('Gesellschaften werden auch mit Rechtsform-Anhang erkannt', () => {
  // "Howoge Wohnungsbaugesellschaft mbH" normalisiert zu
  // "howoge wohnungsbaugesellschaft" — ein exakter Vergleich griff hier nicht.
  for (const name of [
    'Howoge Wohnungsbaugesellschaft mbH', 'Degewo AG', 'Gewobag Wohnungsbau-AG',
    'WBM Wohnungsbaugesellschaft Berlin-Mitte mbH', 'GESOBAU AG',
    'Berlinovo Immobilien GmbH', 'STADT UND LAND Wohnbauten-GmbH',
  ]) {
    assert.equal(isGesellschaft(name), true, name);
  }
  // Und keine Teilzeichenketten-Treffer: "wbm" steckt in "schwbmeier".
  for (const name of ['Schwbmeier Immobilien', 'Regensburger Immobilien GmbH', 'Meyer Hausverwaltung', 'Degen & Wolff']) {
    assert.equal(isGesellschaft(name), false, name);
  }
});

test('eine normale GmbH ist keine Genossenschaft', () => {
  // "eG" darf nicht mitten im Wort treffen.
  for (const name of ['Regensburger Immobilien GmbH', 'Siegel Hausverwaltung', 'Wegener & Partner']) {
    const s = hardSignal({ payload: payload({}, { name_raw: name }), source: 'is24' });
    assert.equal(s, null, `${name} faelschlich als Genossenschaft erkannt`);
  }
});

test('Portal-Kennzeichnung privat ist stark, aber nicht entscheidend', () => {
  const s = hardSignal({ payload: payload({}, { platform_private_flag: true }), source: 'is24' });
  assert.equal(s?.branch, 'T_PRIVAT');
  assert.equal(s?.decisive, false, 'es kann ein Nachmieter sein — anderer Zweig');
});

test('wg_gesucht deutet auf Nachmieter, entscheidet aber nicht', () => {
  const s = hardSignal({ payload: payload(), source: 'wg_gesucht' });
  assert.equal(s?.branch, 'T_NACHMIETER');
  assert.equal(s?.decisive, false);
});

test('ohne Anbietername gibt es keinen Empfaenger', () => {
  const s = hardSignal({ payload: payload({}, { name_raw: null }), source: 'is24' });
  assert.equal(s?.branch, 'T0');
  assert.equal(s?.decisive, true);
});

test('T0 ist kein Versandzweig (§9)', () => {
  assert.equal(isSendBranch('T0'), false);
  for (const b of ['T_VERWALTUNG', 'T_MAKLER', 'T_NACHMIETER', 'T_PRIVAT'] as const) {
    assert.equal(isSendBranch(b), true, b);
  }
});

// ------------------------------------------------------------------- Stufe

test('Gate-Urteil wird uebernommen, wenn kein hartes Signal greift', async () => {
  const adapter = createMockGenerateAdapter({ model: 'gemini-3.7-flash', response: VERDICT });
  const r = await runGate(adapter, { payload: payload(), pageText: 'Wir verwalten dieses Objekt.', source: 'is24' });
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'T_VERWALTUNG');
  assert.equal(r.branchSource, 'gate');
  assert.equal(r.hardSignal, null);
  assert.ok(r.llm.costUsd > 0);
});

test('entscheidendes hartes Signal gewinnt gegen das Gate', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VERDICT, branch: 'T_VERWALTUNG', branch_confidence: 'high' },
  });
  const r = await runGate(adapter, {
    payload: payload({}, { name_raw: 'Howoge Wohnungsbaugesellschaft mbH' }),
    pageText: 'x', source: 'is24',
  });
  assert.equal(r.branch, 'T0', 'kommunale Gesellschaft, egal was das Gate sagt');
  assert.equal(r.branchSource, 'hard_signal');
  // Das Betrugsurteil bleibt trotzdem erhalten.
  assert.equal(r.risk, 'low');
});

test('Gate darf ein weiches Signal ueberstimmen — aber nur mit hoher Konfidenz', async () => {
  const base = { payload: payload({}, { platform_private_flag: true }), pageText: 'x', source: 'is24' };

  const sicher = await runGate(
    createMockGenerateAdapter({
      model: 'gemini-3.7-flash',
      response: { ...VERDICT, branch: 'T_NACHMIETER', branch_confidence: 'high', firm_type_guess: 'privat' },
    }),
    base,
  );
  assert.equal(sicher.branch, 'T_NACHMIETER');
  assert.equal(sicher.branchSource, 'gate');

  const unsicher = await runGate(
    createMockGenerateAdapter({
      model: 'gemini-3.7-flash',
      response: { ...VERDICT, branch: 'T_NACHMIETER', branch_confidence: 'low', firm_type_guess: 'privat' },
    }),
    base,
  );
  assert.equal(unsicher.branch, 'T_PRIVAT', 'bei Unsicherheit gewinnt die Portal-Kennzeichnung');
  assert.equal(unsicher.branchSource, 'hard_signal');
});

test('Betrugsurteil kommt immer vom Gate, nie von harten Signalen', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VERDICT, risk: 'high', signals: ['prepayment_before_viewing', 'keys_by_mail'] },
  });
  const r = await runGate(adapter, {
    payload: payload({}, { name_raw: 'Gewobag Wohnungsbau-AG' }), pageText: 'x', source: 'is24',
  });
  assert.equal(r.branch, 'T0', 'Zweig vom harten Signal');
  assert.equal(r.risk, 'high', 'Risiko vom Gate');
  assert.deepEqual(r.signals, ['prepayment_before_viewing', 'keys_by_mail']);
});

test('scheitert das Gate, ist der Rueckfall T0 — kein Versand', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.7-flash', failWith: { kind: 'timeout', message: 'zu langsam' },
  });
  const r = await runGate(adapter, { payload: payload(), pageText: 'x', source: 'is24' });
  assert.equal(r.ok, false);
  assert.equal(r.branch, 'T0');
  assert.equal(isSendBranch(r.branch), false);
  assert.equal(r.branchConfidence, 'low');
  assert.equal(r.risk, 'medium', 'ohne Pruefung nicht als harmlos durchwinken');
});

test('scheitert das Gate, bleibt ein entscheidendes hartes Signal gueltig', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.7-flash', failWith: { kind: 'rate_limit', message: '429' },
  });
  const r = await runGate(adapter, {
    payload: payload({}, { name_raw: 'Degewo AG' }), pageText: 'x', source: 'is24',
  });
  assert.equal(r.branch, 'T0');
  assert.equal(r.branchSource, 'hard_signal');
});

test('unbekanntes Signal im Modellurteil wird vom Schema abgefangen', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VERDICT, signals: ['vermieter_wirkt_unsympathisch'] },
  });
  const r = await runGate(adapter, { payload: payload(), pageText: 'x', source: 'is24' });
  assert.equal(r.ok, false);
  assert.equal(r.llm.error?.kind, 'schema');
});

// ------------------------------------------------------------------ Eingabe

test('Gate-Eingabe enthaelt Payload, Seitentext und Cache-Wissen', () => {
  const input = buildGateInput({
    payload: payload({ cold_rent: 890 }),
    pageText: 'Wir verwalten dieses Objekt seit 2011.',
    source: 'is24',
    cached: {
      id: 1, name_canonical: 'meyer', name_variants: [], firm_type: 'makler',
      domain: null, impressum_url: null, vermietung_url: null, email_vermietung: null,
      email_general: null, contact_persons: [], confidence: 'high', portal_only: false,
      bounce_count: 0, source: 'prewarm', last_verified_at: null, created_at: '',
    },
  });
  assert.match(input, /Quelle: is24/);
  assert.match(input, /890/);
  assert.match(input, /Wir verwalten dieses Objekt seit 2011/);
  assert.match(input, /firm_type: makler/);
});

test('Gate-Eingabe deckelt sehr lange Seiten', () => {
  const input = buildGateInput({ payload: payload(), pageText: 'x'.repeat(100_000), source: 'is24' });
  assert.ok(input.length < 30_000, `${input.length} Zeichen`);
});

// ------------------------------------------------------------------- Schema

test('gate.json ueberlebt die Uebersetzung nach Gemini', () => {
  const out = toGeminiJsonSchema(loadSchema('gate'));
  const props = out['properties'] as Record<string, Record<string, unknown>>;
  assert.equal(out['additionalProperties'], false);
  assert.deepEqual(props['risk']!['enum'], ['low', 'medium', 'high']);
  assert.ok((props['branch']!['enum'] as string[]).includes('T0'));
  assert.equal('$schema' in out, false);
});

test('das Schema laesst nur die fuenf Zweige zu', () => {
  const schema = loadSchema('gate');
  assert.equal(validateAgainst(schema, { ...VERDICT, branch: 'T_IRGENDWAS' }).valid, false);
  assert.equal(validateAgainst(schema, VERDICT).valid, true);
});
