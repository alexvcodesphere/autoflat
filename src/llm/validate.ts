/**
 * schemas/*.json ist die einzige Quelle der Wahrheit (§11).
 *
 * Jeder Adapter validiert seine Ausgabe selbst gegen das kanonische Schema,
 * bevor er zurückgibt — auf keine Anbieterzusage verlassen. Schlägt die
 * Validierung fehl: ok:false, error.kind='schema', kein Retry im Adapter.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import type { JsonSchema } from './types.ts';

const SCHEMA_DIR = resolve(import.meta.dirname, '../../schemas');

// Draft 2020-12: die Schemas nutzen prefixItems und deklarieren $schema.
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
// ajv-formats ist CJS: zur Laufzeit ist der Default-Import die Funktion
// selbst, TypeScript sieht unter nodenext den Namensraum (der zusaetzlich ein
// .default traegt). Beide Formen auf die aufrufbare Signatur zurechtbiegen.
type AddFormats = (instance: typeof ajv) => unknown;
const formatsNamespace = formatsPlugin as unknown as { default?: AddFormats };
const addFormats: AddFormats = formatsNamespace.default ?? (formatsPlugin as unknown as AddFormats);
addFormats(ajv);

const compiled = new WeakMap<JsonSchema, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  let fn = compiled.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    compiled.set(schema, fn);
  }
  return fn;
}

export interface ValidationResult<T> {
  valid: boolean;
  data: T | null;
  errors: string[];
}

export function validateAgainst<T>(schema: JsonSchema, value: unknown): ValidationResult<T> {
  const fn = compile(schema);
  if (fn(value)) return { valid: true, data: value as T, errors: [] };
  const errors = (fn.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'ungültig'}`.trim(),
  );
  return { valid: false, data: null, errors };
}

const fileCache = new Map<string, JsonSchema>();

/** Lädt schemas/<name>.json und cacht es (stabile Referenz für den Compile-Cache). */
export function loadSchema(name: string): JsonSchema {
  let schema = fileCache.get(name);
  if (!schema) {
    schema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, `${name}.json`), 'utf8')) as JsonSchema;
    fileCache.set(name, schema);
  }
  return schema;
}
