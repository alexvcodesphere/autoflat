import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, parseStageSpec, PHASE1_STAGES, STAGES } from '../src/llm/registry.ts';

const OK_ENV = {
  STAGE_EXTRACT: 'gemini:gemini-3.5-flash-lite',
  STAGE_GATE: 'gemini:gemini-3.7-flash',
  STAGE_DRAFT: 'gemini:gemini-3.7-flash',
  STAGE_DRAFT_PRIVAT: 'gemini:gemini-3.1-pro-preview',
} as NodeJS.ProcessEnv;

test('parst provider:model', () => {
  const b = parseStageSpec('extract', 'gemini:gemini-3.5-flash-lite');
  assert.equal(b.provider, 'gemini');
  assert.equal(b.model, 'gemini-3.5-flash-lite');
  assert.equal(b.capability, 'generate');
  assert.ok(b.timeoutMs > 0);
});

test('Modell-IDs mit Doppelpunkt bleiben heil', () => {
  const b = parseStageSpec('extract', 'gemini:models/gemini-3.5-flash-lite:v2');
  assert.equal(b.provider, 'gemini');
  assert.equal(b.model, 'models/gemini-3.5-flash-lite:v2');
});

test('research-Stufen sind als research deklariert', () => {
  assert.equal(parseStageSpec('research_person', 'gemini:gemini-3.1-pro-preview').capability, 'research');
  assert.equal(parseStageSpec('research_firma', 'gemini:gemini-3.7-flash').capability, 'research');
});

test('kaputtes Format wirft', () => {
  for (const bad of ['gemini', 'gemini:', ':modell', '', '   ']) {
    assert.throws(() => parseStageSpec('extract', bad), /provider:model/, `akzeptierte ${JSON.stringify(bad)}`);
  }
});

test('unbekannter Anbieter wirft', () => {
  assert.throws(() => parseStageSpec('extract', 'openai:gpt-9'), /unbekannter Anbieter/);
});

test('laedt die Phase-1-Stufen', () => {
  const r = loadRegistry({ env: OK_ENV, stages: PHASE1_STAGES });
  assert.equal(r.bindings.extract.model, 'gemini-3.5-flash-lite');
  assert.equal(r.bindings.draft_privat.model, 'gemini-3.1-pro-preview');
});

test('fehlende Stufe => Startfehler, kein stiller Fallback', () => {
  const { STAGE_GATE: _drop, ...rest } = OK_ENV;
  assert.throws(() => loadRegistry({ env: rest as NodeJS.ProcessEnv, stages: PHASE1_STAGES }), /STAGE_GATE fehlt/);
});

test('Modell ohne Preis => Startfehler', () => {
  assert.throws(
    () => loadRegistry({ env: { ...OK_ENV, STAGE_GATE: 'gemini:gemini-erfunden' }, stages: PHASE1_STAGES }),
    /steht nicht in config\/pricing\.json/,
  );
});

test('research-Stufen binden seit Phase 4', () => {
  const r = loadRegistry({
    env: {
      ...OK_ENV,
      STAGE_RESEARCH_FIRMA: 'gemini:gemini-3.7-flash',
      STAGE_RESEARCH_PERSON: 'gemini:gemini-3.1-pro-preview',
    } as NodeJS.ProcessEnv,
    stages: ['research_firma', 'research_person'],
  });
  assert.equal(r.bindings.research_firma.model, 'gemini-3.7-flash');
  assert.equal(r.bindings.research_person.capability, 'research');
});

test('Anbieter ohne research-Adapter => Startfehler', () => {
  assert.throws(
    () =>
      loadRegistry({
        env: { ...OK_ENV, STAGE_RESEARCH_FIRMA: 'anthropic:claude-opus-5' } as NodeJS.ProcessEnv,
        stages: ['research_firma'],
      }),
    /kein research-Adapter|steht nicht in config/,
  );
});

test('research() liefert einen Adapter mit Grounding', () => {
  const r = loadRegistry({
    env: { ...OK_ENV, STAGE_RESEARCH_FIRMA: 'gemini:gemini-3.7-flash' } as NodeJS.ProcessEnv,
    stages: ['research_firma'],
  });
  const adapter = r.research('research_firma');
  assert.equal(adapter.supportsGrounding, true);
  assert.match(adapter.id, /^gemini-research:/);
});

test('anthropic ist als Anbieter bekannt, hat aber noch keinen Adapter', () => {
  assert.doesNotThrow(() => parseStageSpec('draft', 'anthropic:claude-opus-5'));
  assert.throws(
    () =>
      loadRegistry({
        env: { ...OK_ENV, STAGE_DRAFT: 'anthropic:claude-opus-5' },
        stages: ['draft'],
      }),
    /kein generate-Adapter|steht nicht in config/,
  );
});

test('meldet alle Probleme auf einmal', () => {
  try {
    loadRegistry({ env: { STAGE_EXTRACT: 'kaputt' } as NodeJS.ProcessEnv, stages: PHASE1_STAGES });
    assert.fail('haette werfen muessen');
  } catch (err) {
    const msg = (err as Error).message;
    for (const key of ['STAGE_EXTRACT', 'STAGE_GATE', 'STAGE_DRAFT', 'STAGE_DRAFT_PRIVAT']) {
      assert.ok(msg.includes(key), `${key} fehlt in der Sammelmeldung`);
    }
  }
});

test('generate() auf einer research-Stufe wirft', () => {
  const r = loadRegistry({ env: OK_ENV, stages: PHASE1_STAGES });
  assert.throws(() => r.generate('research_person'), /keine generate-Stufe/);
});

test('STAGES deckt alle Stufen aus §11 ab', () => {
  assert.deepEqual([...STAGES].sort(), [
    'draft', 'draft_privat', 'extract', 'gate', 'research_firma', 'research_person',
  ]);
});
