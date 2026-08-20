import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiJsonSchema } from '../src/llm/providers/gemini-schema.ts';
import { loadSchema } from '../src/llm/validate.ts';

test('entfernt Keywords, die Gemini nicht kennt', () => {
  const out = toGeminiJsonSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      a: { type: 'string', minLength: 3, pattern: '^x', default: 'x', description: 'bleibt' },
    },
    required: ['a'],
    unevaluatedProperties: false,
  });
  assert.equal('$schema' in out, false);
  assert.equal('unevaluatedProperties' in out, false);
  const a = (out['properties'] as Record<string, Record<string, unknown>>)['a']!;
  assert.equal('minLength' in a, false);
  assert.equal('pattern' in a, false);
  assert.equal('default' in a, false);
  assert.equal(a['description'], 'bleibt');
  assert.equal(a['type'], 'string');
});

test('behaelt unterstuetzte Keywords', () => {
  const out = toGeminiJsonSchema({
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 9 },
    minItems: 1,
    maxItems: 4,
    title: 't',
  });
  assert.equal(out['minItems'], 1);
  assert.equal(out['maxItems'], 4);
  assert.equal(out['title'], 't');
  assert.deepEqual(out['items'], { type: 'integer', minimum: 1, maximum: 9 });
});

test('Typ-Union wird zu anyOf', () => {
  const out = toGeminiJsonSchema({ type: ['string', 'null'], description: 'd' });
  assert.equal('type' in out, false);
  assert.equal(out['description'], 'd', 'description bleibt oben stehen');
  assert.deepEqual(out['anyOf'], [{ type: 'string' }, { type: 'null' }]);
});

test('typgebundene Keywords wandern in den passenden anyOf-Zweig', () => {
  const out = toGeminiJsonSchema({
    type: ['string', 'null'],
    enum: ['a', 'b'],
    description: 'd',
  });
  assert.equal('enum' in out, false);
  assert.deepEqual(out['anyOf'], [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }]);
});

test('Union in verschachtelten properties', () => {
  const out = toGeminiJsonSchema({
    type: 'object',
    properties: { rooms: { type: ['number', 'null'] } },
  });
  const rooms = (out['properties'] as Record<string, Record<string, unknown>>)['rooms']!;
  assert.deepEqual(rooms['anyOf'], [{ type: 'number' }, { type: 'null' }]);
});

test('vorhandenes anyOf gewinnt gegen Typ-Array', () => {
  const out = toGeminiJsonSchema({
    type: ['string', 'null'],
    anyOf: [{ type: 'string' }, { type: 'number' }],
  });
  assert.equal('type' in out, false);
  assert.deepEqual(out['anyOf'], [{ type: 'string' }, { type: 'number' }]);
});

test('$ref und $defs ueberleben', () => {
  const out = toGeminiJsonSchema({
    $defs: { s: { type: 'string', minLength: 2 } },
    type: 'object',
    properties: { a: { $ref: '#/$defs/s' } },
  });
  const defs = out['$defs'] as Record<string, Record<string, unknown>>;
  assert.equal(defs['s']!['type'], 'string');
  assert.equal('minLength' in defs['s']!, false, 'auch in $defs wird gestrippt');
  const props = out['properties'] as Record<string, Record<string, unknown>>;
  assert.equal(props['a']!['$ref'], '#/$defs/s');
});

test('mutiert das kanonische Schema nicht', () => {
  const canonical = { type: ['string', 'null'], minLength: 1 } as Record<string, unknown>;
  const before = JSON.stringify(canonical);
  toGeminiJsonSchema(canonical);
  assert.equal(JSON.stringify(canonical), before);
});

test('smoke.json uebersetzt und enthaelt kein unbekanntes Keyword', () => {
  const out = toGeminiJsonSchema(loadSchema('smoke'));
  const SUPPORTED = new Set([
    '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description',
    'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
    'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering',
  ]);

  /** Prueft eine Schema-Ebene und steigt nur ueber echte Sub-Schemas ab. */
  const checkSchema = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
      assert.ok(SUPPORTED.has(keyword), `unerwartetes Keyword ${keyword} bei ${path || '/'}`);
      if (keyword === 'properties' || keyword === '$defs') {
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          checkSchema(sub, `${path}/${keyword}/${name}`);
        }
      } else if (keyword === 'anyOf' || keyword === 'oneOf' || keyword === 'prefixItems') {
        (value as unknown[]).forEach((sub, i) => checkSchema(sub, `${path}/${keyword}/${i}`));
      } else if (keyword === 'items' || keyword === 'additionalProperties') {
        checkSchema(value, `${path}/${keyword}`);
      }
    }
  };

  checkSchema(out, '');
  assert.equal('$schema' in out, false);
  // minLength stand im kanonischen Schema und darf als Keyword weg sein.
  // (Im description-Text taucht das Wort weiterhin auf — deshalb strukturell pruefen.)
  const canonical = loadSchema('smoke');
  const canonicalProps = canonical['properties'] as Record<string, Record<string, unknown>>;
  assert.equal('minLength' in canonicalProps['external_id']!, true, 'Vorbedingung');
  // nullable Felder sind zu anyOf geworden
  const props = out['properties'] as Record<string, Record<string, unknown>>;
  assert.equal('minLength' in props['external_id']!, false);
  assert.deepEqual(props['rooms']!['anyOf'], [{ type: 'number' }, { type: 'null' }]);
  assert.equal(props['firm_type_guess']!['type'], 'string');
});
