/**
 * Alles hier laeuft ohne Netz: der Mock-Adapter durchlaeuft denselben
 * Validierungspfad wie Gemini. Geprueft wird die Mechanik der Stufe —
 * ob das echte Modell gut extrahiert, zeigt `npm run extract:fixtures`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { runExtract, finalizePayload, buildExtractInput, type Payload } from '../src/stages/extract.ts';
import { externalIdFromUrl, sourceFromUrl, type CaptureInput } from '../src/lib/capture.ts';
import { listFixtures, loadFixture, checkPayload, loadGateExpectation } from '../src/lib/fixtures.ts';
import { loadSchema, validateAgainst } from '../src/llm/validate.ts';
import { toGeminiJsonSchema } from '../src/llm/providers/gemini-schema.ts';

const EMPTY: Payload = {
  listing: {
    external_id: null, url: null, street: null, house_number: null, postcode: null,
    district: null, rooms: null, living_space: null, cold_rent: null, warm_rent: null,
    deposit: null, available_from: null, wbs_required: null, features: [],
    description_excerpt: null,
  },
  provider: {
    name_raw: null, contact_person_raw: null, phone_raw: null, email_raw: null,
    website_raw: null, platform_private_flag: null, self_description: null,
  },
};

const capture: CaptureInput = {
  capture_version: 'v1',
  url: 'https://www.immobilienscout24.de/expose/162345678',
  source: 'is24',
  page_text: 'Objektnummer 162345678\nMeyer & Co. Hausverwaltung GmbH',
};

function payload(over: { listing?: Partial<Payload['listing']>; provider?: Partial<Payload['provider']> }): Payload {
  return {
    listing: { ...EMPTY.listing, ...over.listing },
    provider: { ...EMPTY.provider, ...over.provider },
  };
}

// ---------------------------------------------------------------- URL-Keys

test('externalIdFromUrl ignoriert Tracking-Parameter und Slash am Ende', () => {
  const a = externalIdFromUrl('https://www.kranz-immobilien.de/angebote/3-zimmer-wedding/');
  const b = externalIdFromUrl('https://kranz-immobilien.de/angebote/3-zimmer-wedding?utm_source=push');
  assert.equal(a, 'url:kranz-immobilien.de/angebote/3-zimmer-wedding');
  assert.equal(a, b, 'dieselbe Seite muss denselben Schluessel liefern');
});

test('externalIdFromUrl behaelt bedeutungstragende Parameter', () => {
  assert.equal(
    externalIdFromUrl('https://example.de/angebot?id=77'),
    'url:example.de/angebot?id=77',
  );
});

test('externalIdFromUrl bei fehlender oder kaputter URL', () => {
  assert.equal(externalIdFromUrl(null), null);
  assert.equal(externalIdFromUrl('kein-url'), null);
});

test('sourceFromUrl leitet die Quelle aus der Domain ab', () => {
  assert.equal(sourceFromUrl('https://www.immobilienscout24.de/expose/1'), 'is24');
  assert.equal(sourceFromUrl('https://www.kleinanzeigen.de/s-anzeige/x/1'), 'kleinanzeigen');
  assert.equal(sourceFromUrl('https://www.wg-gesucht.de/x.html'), 'wg_gesucht');
  assert.equal(sourceFromUrl('https://www.immowelt.de/expose/1'), 'immowelt');
  assert.equal(sourceFromUrl('https://kranz-immobilien.de/angebote/'), 'website');
  assert.equal(sourceFromUrl(null), 'paste');
});

// ---------------------------------------------------------------- finalize

test('url kommt vom Client, nicht vom Modell', () => {
  const { payload: p } = finalizePayload(
    payload({ listing: { url: 'https://vom-modell-geraten.de' } }),
    capture,
  );
  assert.equal(p.listing.url, capture.url);
});

test('fehlende external_id wird aus der URL ersetzt', () => {
  const { payload: p, issues } = finalizePayload(payload({}), capture);
  assert.equal(p.listing.external_id, 'url:immobilienscout24.de/expose/162345678');
  assert.deepEqual(issues, ['no_provider_name']);
});

test('vorhandene external_id wird nicht ueberschrieben', () => {
  const { payload: p } = finalizePayload(payload({ listing: { external_id: '162345678' } }), capture);
  assert.equal(p.listing.external_id, '162345678');
});

test('ohne external_id und ohne URL bleibt ein Hinweis stehen', () => {
  const { payload: p, issues } = finalizePayload(payload({}), { ...capture, url: null });
  assert.equal(p.listing.external_id, null);
  assert.ok(issues.includes('no_external_id'));
});

test('fehlender Anbietername ist ein Hinweis, kein Absturz', () => {
  const { issues } = finalizePayload(
    payload({ listing: { external_id: '1' }, provider: { name_raw: 'Meyer GmbH' } }),
    capture,
  );
  assert.deepEqual(issues, []);
});

test('leere Strings werden zu null', () => {
  const { payload: p } = finalizePayload(
    payload({ listing: { external_id: '1', street: '   ' }, provider: { name_raw: 'X', email_raw: '' } }),
    capture,
  );
  assert.equal(p.listing.street, null);
  assert.equal(p.provider.email_raw, null);
});

test('features werden getrimmt und Leereintraege entfernt', () => {
  const { payload: p } = finalizePayload(
    payload({ listing: { external_id: '1', features: ['  Balkon ', '', '   ', 'EBK'] } }),
    capture,
  );
  assert.deepEqual(p.listing.features, ['Balkon', 'EBK']);
});

// ---------------------------------------------------------------- Input

test('buildExtractInput haengt JSON-LD und Seitentext an', () => {
  const input = buildExtractInput({ ...capture, json_ld: ['{"@type":"Residence"}'] });
  assert.match(input, /JSON-LD/);
  assert.match(input, /Residence/);
  assert.match(input, /Seitentext/);
  assert.match(input, /162345678/);
});

test('buildExtractInput nennt das heutige Datum, damit "ab 01.09." aufloesbar ist', () => {
  const input = buildExtractInput(capture, { today: '2026-08-20' });
  assert.match(input, /Heutiges Datum: 2026-08-20/);
});

test('buildExtractInput deckelt sehr lange Seiten', () => {
  const input = buildExtractInput({ ...capture, page_text: 'x'.repeat(100_000) });
  assert.ok(input.length < 30_000, `Input war ${input.length} Zeichen`);
});

test('html_snapshot geht nie an das Modell (§15)', () => {
  const input = buildExtractInput({ ...capture, html_snapshot: '<html>GEHEIM</html>' });
  assert.equal(input.includes('GEHEIM'), false);
  assert.equal(input.includes('<html>'), false);
});

// ---------------------------------------------------------------- Stufe

test('runExtract liefert Payload, Hinweise und Kosten', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.5-flash-lite',
    response: payload({
      listing: { external_id: '162345678', rooms: 2, cold_rent: 890 },
      provider: { name_raw: 'Meyer & Co. Hausverwaltung GmbH' },
    }),
  });
  const r = await runExtract(adapter, capture);
  assert.equal(r.ok, true);
  assert.equal(r.payload?.listing.external_id, '162345678');
  assert.equal(r.payload?.listing.url, capture.url);
  assert.deepEqual(r.issues, []);
  assert.ok(r.llm.costUsd > 0);
});

test('runExtract wirft nicht, wenn die Stufe scheitert', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.5-flash-lite',
    failWith: { kind: 'timeout', message: 'zu langsam' },
  });
  const r = await runExtract(adapter, capture);
  assert.equal(r.ok, false);
  assert.equal(r.payload, null);
  assert.equal(r.llm.error?.kind, 'timeout');
});

test('unvollstaendige Modellantwort wird vom Schema abgefangen', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.5-flash-lite',
    response: { listing: { external_id: '1' } },
  });
  const r = await runExtract(adapter, capture);
  assert.equal(r.ok, false);
  assert.equal(r.llm.error?.kind, 'schema');
});

test('erfundenes Feld wird vom Schema abgefangen', async () => {
  const p = payload({ listing: { external_id: '1' }, provider: { name_raw: 'X' } }) as unknown as Record<string, unknown>;
  (p['listing'] as Record<string, unknown>)['makler_courtage'] = '2 Monatsmieten';
  const adapter = createMockGenerateAdapter({ model: 'gemini-3.5-flash-lite', response: p });
  const r = await runExtract(adapter, capture);
  assert.equal(r.ok, false);
  assert.match(r.llm.error!.message, /makler_courtage|additional/i);
});

test('ungueltiges Datum wird abgefangen', async () => {
  const adapter = createMockGenerateAdapter({
    model: 'gemini-3.5-flash-lite',
    response: payload({ listing: { external_id: '1', available_from: 'ab sofort' }, provider: { name_raw: 'X' } }),
  });
  const r = await runExtract(adapter, capture);
  assert.equal(r.ok, false);
  assert.equal(r.llm.error?.kind, 'schema');
});

// ---------------------------------------------------------------- Schema

test('payload.json ueberlebt die Uebersetzung nach Gemini', () => {
  const out = toGeminiJsonSchema(loadSchema('payload'));
  const listing = (out['properties'] as Record<string, Record<string, unknown>>)['listing']!;
  const props = listing['properties'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(props['rooms']!['anyOf'], [{ type: 'number' }, { type: 'null' }]);
  assert.deepEqual(props['features']!['items'], { type: 'string' });
  assert.equal(listing['additionalProperties'], false, 'verhindert erfundene Felder');
  assert.equal('$schema' in out, false);
  // format:"date" muss ueberleben, es steht auf Geminis Positivliste
  const avail = props['available_from']!['anyOf'] as Array<Record<string, unknown>>;
  assert.equal(avail[0]!['format'], 'date');
});

test('ein leerer Payload mit allen null ist schemagueltig', () => {
  const { valid, errors } = validateAgainst(loadSchema('payload'), EMPTY);
  assert.equal(valid, true, errors.join('; '));
});

// ---------------------------------------------------------------- Fixtures

test('die drei geforderten Fixtures liegen vor', () => {
  const names = listFixtures();
  assert.ok(names.some((n) => n.startsWith('is24')), 'IS24-Fixture fehlt');
  assert.ok(names.some((n) => n.startsWith('kleinanzeigen')), 'Kleinanzeigen-Fixture fehlt');
  assert.ok(names.some((n) => n.startsWith('website')), 'Website-Fixture fehlt');
});

test('jedes Fixture ist wohlgeformt und hat irgendeine Zusicherung', () => {
  for (const name of listFixtures()) {
    const f = loadFixture(name);
    assert.equal(f.capture.capture_version, 'v1', `${name}: capture_version`);
    assert.ok(f.capture.page_text.length > 200, `${name}: page_text zu kurz`);
    assert.equal('html_snapshot' in f.capture, false, `${name}: Snapshot gehoert nicht ins Fixture`);

    // Ein Fixture prueft die Extraktion, das Gate, oder beides — aber es darf
    // nicht ohne jede Zusicherung herumliegen.
    const extractAssertions =
      Object.keys(f.expected.must_equal ?? {}).length +
      (f.expected.must_be_null ?? []).length +
      (f.expected.must_not_be_null ?? []).length;
    const gate = loadGateExpectation(name);
    assert.ok(
      extractAssertions >= 5 || gate !== null,
      `${name}: weder Extraktions- noch Gate-Erwartungen`,
    );
  }
});

test('Betrugs-Fixtures pruefen das Gate, nicht die Extraktion', () => {
  const fraud = listFixtures().filter((n) => n.startsWith('fraud-'));
  assert.ok(fraud.length >= 3, `§14 Phase 5 verlangt 3 Betrugs-Fixtures, gefunden: ${fraud.length}`);
  for (const name of fraud) {
    const gate = loadGateExpectation(name);
    assert.ok(gate, `${name}: keine Gate-Erwartung`);
    assert.equal(gate!.risk, 'high', `${name}: muss als high eingestuft werden`);
    assert.ok((gate!.signals_must_include ?? []).length > 0, `${name}: keine erwarteten Signale`);
    assert.equal(gate!.must_not_send, true, `${name}: muss vom Versand ausgeschlossen sein`);
  }
});

test('checkPayload erkennt ein erfundenes Feld', () => {
  const p = payload({ listing: { external_id: '1', street: 'Erfundenstraße' }, provider: { name_raw: 'X' } });
  const { failures } = checkPayload(p, { must_be_null: ['listing.street'] });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /muss null sein/);
});

test('checkPayload erkennt Werte aus einem fremden Inserat', () => {
  const p = payload({ listing: { external_id: '1', cold_rent: 1450 }, provider: { name_raw: 'X' } });
  const { failures } = checkPayload(p, { must_not_appear_anywhere: ['1450'] });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /anderen Inserat/);
});

test('checkPayload akzeptiert Schreibvarianten bei features', () => {
  const p = payload({ listing: { external_id: '1', features: ['Einbauküche'] }, provider: { name_raw: 'X' } });
  const ok = checkPayload(p, { features_include_any_of: [['EBK', 'Einbauküche']] });
  assert.deepEqual(ok.failures, []);
  const nok = checkPayload(p, { features_include_any_of: [['Balkon']] });
  assert.equal(nok.failures.length, 1);
});
