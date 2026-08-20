/**
 * Kanonisches JSON Schema -> Geminis `responseJsonSchema`-Teilmenge (§11).
 *
 * Gemini unterstützt laut SDK-Doku (@google/genai 2.18.0) nur:
 *   $id $defs $ref $anchor type format title description enum items
 *   prefixItems minItems maxItems minimum maximum anyOf oneOf properties
 *   additionalProperties required   (+ nicht-standard propertyOrdering)
 *
 * Alles andere — pattern, minLength, const, default, $schema, allOf, not —
 * wird hier entfernt statt durchgereicht, weil ein nicht unterstütztes
 * Keyword den Request mit 400 abweisen kann. Die *kanonische* Fassung bleibt
 * unangetastet und wird nach dem Aufruf von ajv geprüft: was Gemini nicht
 * erzwingen kann, fängt die Validierung ab.
 */
import type { JsonSchema } from '../types.ts';

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$id', '$defs', '$ref', '$anchor',
  'type', 'format', 'title', 'description', 'enum',
  'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum',
  'anyOf', 'oneOf',
  'properties', 'additionalProperties', 'required',
  'propertyOrdering',
]);

/** Keywords, die zum konkreten Typ gehören und beim Aufsplitten mitwandern. */
const TYPE_BOUND_KEYWORDS = [
  'enum', 'format', 'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum', 'properties', 'required', 'additionalProperties',
  'propertyOrdering',
] as const;

const SUBSCHEMA_MAPS = new Set(['properties', '$defs']);
const SUBSCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'prefixItems']);
const SUBSCHEMA_SINGLE = new Set(['items', 'additionalProperties']);

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (node === null || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (!SUPPORTED_KEYWORDS.has(key)) continue;

    if (SUBSCHEMA_MAPS.has(key) && value !== null && typeof value === 'object') {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) mapped[k] = convert(v);
      out[key] = mapped;
    } else if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map(convert);
    } else if (SUBSCHEMA_SINGLE.has(key) && value !== null && typeof value === 'object') {
      out[key] = convert(value);
    } else {
      out[key] = value;
    }
  }

  return splitUnionType(out);
}

/**
 * `{"type": ["string", "null"]}` -> `{"anyOf": [{"type":"string"},{"type":"null"}]}`.
 *
 * Der Payload-Vertrag (§5) besteht fast nur aus nullable Feldern. Ob Gemini
 * Typ-Arrays akzeptiert, ist nicht dokumentiert; anyOf ist es.
 */
function splitUnionType(out: Record<string, unknown>): Record<string, unknown> {
  const type = out['type'];
  if (!Array.isArray(type)) return out;

  delete out['type'];

  // Pathologischer Fall: Typ-Array UND eigenes anyOf. Dann gewinnt das
  // vorhandene anyOf, der Typ entfällt ersatzlos.
  if (Array.isArray(out['anyOf'])) return out;

  const branchProps: Record<string, unknown> = {};
  for (const key of TYPE_BOUND_KEYWORDS) {
    if (key in out) {
      branchProps[key] = out[key];
      delete out[key];
    }
  }

  out['anyOf'] = (type as string[]).map((t) =>
    t === 'null' ? { type: 'null' } : { type: t, ...branchProps },
  );
  return out;
}

export function toGeminiJsonSchema(schema: JsonSchema): JsonSchema {
  return convert(schema) as JsonSchema;
}
