import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceCall, hasPricing, knownModels } from '../src/llm/pricing.ts';

const AT_2026 = new Date('2026-08-20T12:00:00Z');

test('rechnet Input und Output getrennt ab', () => {
  const c = priceCall(
    'gemini-3.5-flash-lite',
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    { at: AT_2026 },
  );
  assert.equal(c.inputUsd, 0.3);
  assert.equal(c.outputUsd, 2.5);
  assert.equal(c.totalUsd, 2.8);
});

test('thinking-Tokens werden zum Output-Satz abgerechnet, nicht ersetzt', () => {
  const ohne = priceCall('gemini-3.7-flash', { inputTokens: 0, outputTokens: 1000 }, { at: AT_2026 });
  const mit = priceCall(
    'gemini-3.7-flash',
    { inputTokens: 0, outputTokens: 1000, thinkingTokens: 1000 },
    { at: AT_2026 },
  );
  assert.equal(ohne.billedOutputTokens, 1000);
  assert.equal(mit.billedOutputTokens, 2000);
  assert.ok(Math.abs(mit.outputUsd - 2 * ohne.outputUsd) < 1e-12);
});

test('Einfuehrungspreis 3.7 Flash gilt 2026, vorlaeufiger Preis ab 2027', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const y2026 = priceCall('gemini-3.7-flash', usage, { at: new Date('2026-12-31T23:00:00Z') });
  assert.equal(y2026.inputPerM, 0.75);
  assert.equal(y2026.outputPerM, 3.75);
  assert.equal(y2026.provisional, false);

  const y2027 = priceCall('gemini-3.7-flash', usage, { at: new Date('2027-01-01T00:00:00Z') });
  assert.equal(y2027.inputPerM, 1.5);
  assert.equal(y2027.outputPerM, 7.5);
  assert.equal(y2027.provisional, true, 'Preis ab 2027 ist abgeleitet, nicht bestaetigt');
});

test('Pro wechselt oberhalb 200k Input in die hoehere Stufe', () => {
  const unten = priceCall(
    'gemini-3.1-pro-preview',
    { inputTokens: 200_000, outputTokens: 0 },
    { at: AT_2026 },
  );
  assert.equal(unten.inputPerM, 2.0);
  assert.equal(unten.outputPerM, 12.0);

  const oben = priceCall(
    'gemini-3.1-pro-preview',
    { inputTokens: 200_001, outputTokens: 0 },
    { at: AT_2026 },
  );
  assert.equal(oben.inputPerM, 4.0);
  assert.equal(oben.outputPerM, 18.0);
});

test('Personenrecherche bei ~95k Input liegt in der unteren Stufe (§11)', () => {
  const c = priceCall(
    'gemini-3.1-pro-preview',
    { inputTokens: 95_000, outputTokens: 2_000 },
    { at: AT_2026 },
  );
  assert.equal(c.inputPerM, 2.0);
  assert.ok(Math.abs(c.totalUsd - (0.095 * 2.0 + 0.002 * 12.0)) < 1e-12);
});

test('Grounding-Suchen werden gezaehlt und abgerechnet', () => {
  const c = priceCall(
    'gemini-3.7-flash',
    { inputTokens: 0, outputTokens: 0, searchQueries: 3 },
    { at: AT_2026 },
  );
  assert.ok(Math.abs(c.groundingUsd - (3 / 1000) * 14) < 1e-12);

  const frei = priceCall(
    'gemini-3.7-flash',
    { inputTokens: 0, outputTokens: 0, searchQueries: 3 },
    { at: AT_2026, groundingBillable: false },
  );
  assert.equal(frei.groundingUsd, 0);
});

test('ohne Suchanfragen keine Grounding-Kosten', () => {
  const c = priceCall('gemini-3.7-flash', { inputTokens: 10, outputTokens: 10 }, { at: AT_2026 });
  assert.equal(c.groundingUsd, 0);
});

test('konkrete Rechnung Ende zu Ende', () => {
  // 1240 In, 176 Out, 64 thinking auf Flash-Lite
  const c = priceCall(
    'gemini-3.5-flash-lite',
    { inputTokens: 1240, outputTokens: 176, thinkingTokens: 64 },
    { at: AT_2026 },
  );
  assert.ok(Math.abs(c.inputUsd - 0.000372) < 1e-12);
  assert.ok(Math.abs(c.outputUsd - 0.0006) < 1e-12);
  assert.ok(Math.abs(c.totalUsd - 0.000972) < 1e-12);
});

test('Preistabelle entspricht der Preisseite vom 2026-08-20', () => {
  // Ein Satz pro Modell, gegen ai.google.dev/gemini-api/docs/pricing geprueft.
  // Bricht absichtlich, wenn jemand die Tabelle aus dem Gedaechtnis "korrigiert".
  const erwartet: Array<[string, number, number]> = [
    ['gemini-3.7-flash', 0.75, 3.75],       // Einfuehrungspreis bis 31.12.2026
    ['gemini-3.6-flash', 1.5, 7.5],         // Einfuehrungspreis ausgelaufen
    ['gemini-3.5-flash', 1.5, 9.0],
    ['gemini-3.5-flash-lite', 0.3, 2.5],
    ['gemini-3.1-flash-lite', 0.25, 1.5],   // billiger als 3.5 Flash-Lite
    ['gemini-3.1-pro-preview', 2.0, 12.0],  // <= 200k Input
    ['gemini-2.5-flash', 0.3, 2.5],
    ['gemini-2.5-flash-lite', 0.1, 0.4],
    ['gemini-2.5-pro', 1.25, 10.0],
  ];
  for (const [model, inPerM, outPerM] of erwartet) {
    const c = priceCall(model, { inputTokens: 1000, outputTokens: 1000 }, { at: AT_2026 });
    assert.equal(c.inputPerM, inPerM, `${model} Input`);
    assert.equal(c.outputPerM, outPerM, `${model} Output`);
  }
});

test('3.1 Flash-Lite ist guenstiger als 3.5 Flash-Lite', () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000 };
  const alt = priceCall('gemini-3.1-flash-lite', usage, { at: AT_2026 });
  const neu = priceCall('gemini-3.5-flash-lite', usage, { at: AT_2026 });
  assert.ok(alt.totalUsd < neu.totalUsd);
});

test('unbekanntes Modell wirft statt still 0 zu liefern', () => {
  assert.equal(hasPricing('gemini-4-imaginaer'), false);
  assert.throws(
    () => priceCall('gemini-4-imaginaer', { inputTokens: 1, outputTokens: 1 }),
    /Kein Preis/,
  );
});

test('alle in .env.example verdrahteten Modelle haben einen Preis', () => {
  for (const model of [
    'gemini-3.5-flash-lite',
    'gemini-3.7-flash',
    'gemini-3.1-pro-preview',
  ]) {
    assert.ok(hasPricing(model), `${model} fehlt in pricing.json (bekannt: ${knownModels().join(', ')})`);
  }
});
