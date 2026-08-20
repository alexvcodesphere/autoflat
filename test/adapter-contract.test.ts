/**
 * Der Vertrag aus §11: eine Stufe sieht nur LlmResult, Fehler werden
 * zurückgegeben statt geworfen, und die Ausgabe ist gegen das kanonische
 * Schema geprüft — nicht nur gegen die Anbieterzusage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { classifyError } from '../src/llm/providers/gemini-generate.ts';
import { loadSchema } from '../src/llm/validate.ts';
import type { GenerateRequest } from '../src/llm/types.ts';

const schema = loadSchema('smoke');
const VALID = {
  external_id: '162345678',
  provider_name: 'Meyer & Co. Hausverwaltung GmbH',
  rooms: 2,
  cold_rent: 890,
  district: 'Neukölln',
  wbs_required: false,
  features: ['Altbau', 'Balkon'],
  firm_type_guess: 'verwaltung',
};
const req: GenerateRequest = { system: 's', input: 'i', schema };

test('gueltige Antwort => ok, data, Kosten, keine Anbieterfelder', () => {
  const a = createMockGenerateAdapter({ model: 'gemini-3.7-flash', response: VALID });
  return a.generate(req, 1000).then((r) => {
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, VALID);
    assert.ok(r.costUsd > 0);
    assert.equal(r.error, undefined);
    assert.deepEqual(
      Object.keys(r).sort(),
      ['ok', 'costUsd', 'data', 'ms', 'model', 'provider', 'raw', 'usage'].sort(),
    );
  });
});

test('raw wird immer mitgeschrieben', async () => {
  const a = createMockGenerateAdapter({ model: 'gemini-3.7-flash', response: VALID });
  const r = await a.generate(req, 1000);
  assert.ok(r.raw.length > 0);
  assert.deepEqual(JSON.parse(r.raw), VALID);
});

test('fehlendes Pflichtfeld => ok:false, kind schema, kein Wurf', async () => {
  const { rooms: _drop, ...incomplete } = VALID;
  const a = createMockGenerateAdapter({ model: 'gemini-3.7-flash', response: incomplete });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.error?.kind, 'schema');
  assert.match(r.error!.message, /rooms/);
});

test('ajv erzwingt, was Gemini nicht kann (minLength)', async () => {
  const a = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VALID, external_id: '' },
  });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'schema');
});

test('enum ausserhalb der erlaubten Werte => schema', async () => {
  const a = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VALID, firm_type_guess: 'bauherr' },
  });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'schema');
});

test('null ist bei nullable Feldern erlaubt', async () => {
  const a = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    response: { ...VALID, rooms: null, cold_rent: null, district: null, wbs_required: null },
  });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, true);
});

test('kaputtes JSON => kind schema, raw bleibt erhalten', async () => {
  const a = createMockGenerateAdapter({ model: 'gemini-3.7-flash', rawResponse: '{"a": ' });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'schema');
  assert.equal(r.raw, '{"a": ');
});

test('Timeout wird zurueckgegeben, nicht geworfen', async () => {
  const a = createMockGenerateAdapter({ model: 'gemini-3.7-flash', response: VALID, delayMs: 30 });
  const r = await a.generate(req, 10);
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'timeout');
});

test('Kosten werden auch bei Fehlschlag ausgewiesen', async () => {
  const a = createMockGenerateAdapter({
    model: 'gemini-3.7-flash',
    rawResponse: 'kein json',
    usage: { inputTokens: 1000, outputTokens: 50 },
  });
  const r = await a.generate(req, 1000);
  assert.equal(r.ok, false);
  assert.ok(r.costUsd > 0, 'ein fehlgeschlagener Aufruf kostet trotzdem Geld');
});

test('classifyError bildet Anbieterfehler auf die sechs Arten ab', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyError(abort).kind, 'timeout');

  assert.equal(classifyError(Object.assign(new Error('nope'), { status: 401 })).kind, 'auth');
  assert.equal(classifyError(Object.assign(new Error('nope'), { status: 403 })).kind, 'auth');
  assert.equal(classifyError(new Error('API key not valid')).kind, 'auth');
  assert.equal(classifyError(Object.assign(new Error('slow down'), { status: 429 })).kind, 'rate_limit');
  assert.equal(classifyError(new Error('RESOURCE_EXHAUSTED')).kind, 'rate_limit');
  assert.equal(classifyError(new Error('deadline exceeded')).kind, 'timeout');
  assert.equal(classifyError(new Error('irgendwas')).kind, 'unknown');
  assert.equal(classifyError('string statt Error').kind, 'unknown');
});

test('classifyError packt die eigentliche Netzursache aus', () => {
  // Undicis "fetch failed" allein sagt nichts; der Grund steht in cause.
  const netErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), {
      code: 'ENOTFOUND',
    }),
  });
  const classified = classifyError(netErr);
  assert.equal(classified.kind, 'unknown');
  assert.match(classified.message, /ENOTFOUND/);
  assert.match(classified.message, /fetch failed/);
});
