/**
 * Fixture-Harness für die extract-Stufe (§14 Phase 2).
 *
 * Ein Fixture ist eine gespeicherte Capture (`<name>.json`) plus eine
 * Erwartungsdatei (`<name>.expected.json`). Die Erwartung beschreibt keinen
 * vollständigen Soll-Payload — das wäre bei jeder Prompt-Änderung kaputt —
 * sondern nur die Aussagen, die wirklich zählen:
 *
 *   must_equal                exakte Werte, die dastehen
 *   must_be_null              Felder, die NICHT dastehen  <- "keine erfundenen Felder"
 *   must_not_be_null          Felder, die das Modell finden muss
 *   features_include_any_of   je Gruppe mindestens eine Schreibweise
 *   features_must_not_include verneinte Merkmale ("Einen Balkon gibt es nicht")
 *   must_contain              Teilstring, wenn der genaue Wortlaut schwankt
 *   must_not_appear_anywhere  Zahlen aus "Ähnliche Objekte" o. ä.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CaptureInput } from './capture.ts';
import type { Payload } from '../stages/extract.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures');

export interface FixtureExpectation {
  note?: string;
  must_equal?: Record<string, unknown>;
  must_be_null?: string[];
  must_not_be_null?: string[];
  must_contain?: Record<string, string>;
  features_include_any_of?: string[][];
  features_must_not_include?: string[];
  must_not_appear_anywhere?: string[];
}

export interface Fixture {
  name: string;
  capture: CaptureInput;
  expected: FixtureExpectation;
}

/** Beidateien zu einem Fixture. Alles andere ist ein Fixture. */
const SIDECAR_SUFFIXES = ['.expected.json', '.gate.json'];

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && !SIDECAR_SUFFIXES.some((sfx) => f.endsWith(sfx)))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * Erwartungen an das Gate-Urteil. Wie bei checkPayload absichtlich kein
 * Soll-Objekt, sondern nur die Aussagen, die zählen.
 */
export interface GateExpectation {
  note?: string;
  risk?: 'low' | 'medium' | 'high';
  /** Mindestens diese Signale müssen erkannt werden. */
  signals_must_include?: string[];
  /** Diese Signale dürfen NICHT gemeldet werden — gegen Fehlalarme. */
  signals_must_not_include?: string[];
  branch?: string;
  firm_type_guess?: string;
  /** true = dieses Inserat darf unter keinen Umständen in den Versandpfad. */
  must_not_send?: boolean;
}

export function loadGateExpectation(name: string): GateExpectation | null {
  try {
    return JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, `${name}.gate.json`), 'utf8'),
    ) as GateExpectation;
  } catch {
    return null;
  }
}

export interface GateCheckInput {
  risk: string;
  signals: string[];
  branch: string;
  firmTypeGuess?: string;
  wouldSend: boolean;
}

export function checkGate(actual: GateCheckInput, expected: GateExpectation): CheckResult {
  const failures: string[] = [];
  let passed = 0;

  if (expected.risk !== undefined) {
    if (actual.risk === expected.risk) passed++;
    else failures.push(`risk: erwartet ${expected.risk}, bekommen ${actual.risk}`);
  }
  for (const signal of expected.signals_must_include ?? []) {
    if (actual.signals.includes(signal)) passed++;
    else failures.push(`Signal "${signal}" nicht erkannt (erkannt: ${actual.signals.join(', ') || 'keine'})`);
  }
  for (const signal of expected.signals_must_not_include ?? []) {
    if (!actual.signals.includes(signal)) passed++;
    else failures.push(`Signal "${signal}" ist ein Fehlalarm`);
  }
  if (expected.branch !== undefined) {
    if (actual.branch === expected.branch) passed++;
    else failures.push(`branch: erwartet ${expected.branch}, bekommen ${actual.branch}`);
  }
  if (expected.firm_type_guess !== undefined) {
    if (actual.firmTypeGuess === expected.firm_type_guess) passed++;
    else failures.push(`firm_type_guess: erwartet ${expected.firm_type_guess}, bekommen ${actual.firmTypeGuess}`);
  }
  if (expected.must_not_send === true) {
    if (!actual.wouldSend) passed++;
    else failures.push('Inserat waere in den Versandpfad gegangen — das ist der schlimmste Fehler hier');
  }

  return { passed, failures };
}

export function loadFixture(name: string): Fixture {
  const capture = JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8'),
  ) as CaptureInput;
  let expected: FixtureExpectation = {};
  try {
    expected = JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, `${name}.expected.json`), 'utf8'),
    ) as FixtureExpectation;
  } catch {
    // Erwartungsdatei ist optional: eine frisch erfasste Seite darf erst
    // einmal ohne Zusicherungen im Verzeichnis liegen.
  }
  return { name, capture, expected };
}

function at(payload: Payload, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc !== null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      payload,
    );
}

function show(value: unknown): string {
  return value === undefined ? '(fehlt)' : JSON.stringify(value);
}

export interface CheckResult {
  passed: number;
  failures: string[];
}

export function checkPayload(payload: Payload, expected: FixtureExpectation): CheckResult {
  const failures: string[] = [];
  let passed = 0;

  for (const [path, want] of Object.entries(expected.must_equal ?? {})) {
    const got = at(payload, path);
    if (JSON.stringify(got) === JSON.stringify(want)) passed++;
    else failures.push(`${path}: erwartet ${show(want)}, bekommen ${show(got)}`);
  }

  for (const path of expected.must_be_null ?? []) {
    const got = at(payload, path);
    if (got === null) passed++;
    else failures.push(`${path}: muss null sein (steht nicht auf der Seite), ist ${show(got)}`);
  }

  for (const path of expected.must_not_be_null ?? []) {
    const got = at(payload, path);
    if (got !== null && got !== undefined && got !== '') passed++;
    else failures.push(`${path}: haette gefunden werden muessen, ist ${show(got)}`);
  }

  for (const [path, needle] of Object.entries(expected.must_contain ?? {})) {
    const got = at(payload, path);
    if (typeof got === 'string' && got.toLowerCase().includes(needle.toLowerCase())) passed++;
    else failures.push(`${path}: muss "${needle}" enthalten, ist ${show(got)}`);
  }

  const features = payload.listing.features ?? [];
  for (const group of expected.features_include_any_of ?? []) {
    const hit = group.some((needle) =>
      features.some((f) => f.toLowerCase().includes(needle.toLowerCase())),
    );
    if (hit) passed++;
    else failures.push(`features: keine Variante von [${group.join(', ')}] in [${features.join(', ')}]`);
  }

  for (const needle of expected.features_must_not_include ?? []) {
    const hit = features.find((f) => f.toLowerCase().includes(needle.toLowerCase()));
    if (!hit) passed++;
    else failures.push(`features: "${hit}" — das Inserat verneint dieses Merkmal ausdrücklich`);
  }

  const haystack = JSON.stringify(payload);
  for (const needle of expected.must_not_appear_anywhere ?? []) {
    if (!haystack.includes(needle)) passed++;
    else failures.push(`"${needle}" stammt aus einem anderen Inserat und darf nicht im Payload stehen`);
  }

  return { passed, failures };
}
