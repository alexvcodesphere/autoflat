/**
 * Projektwurzel, unabhängig davon, wer den Code lädt.
 *
 * `import.meta.dirname` funktioniert nur, solange Node die Datei direkt
 * ausführt. Sobald ein Bundler das Modul einpackt — Next/Turbopack tut das —
 * ist es `undefined`, und `resolve(undefined, ...)` wirft
 * `ERR_INVALID_ARG_TYPE`. Gemessen am 2026-08-20 beim ersten Versuch, die
 * DB-Schicht in eine Server Component zu importieren.
 *
 * Nebeneffekt, der die Änderung auch ohne Next rechtfertigt: Vorher trug
 * jedes Modul seine eigene `../../`-Tiefe. Wer eine Datei verschiebt, bricht
 * still einen Dateizugriff. Jetzt hängt alles an einem Punkt.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

/** Datei, die es nur in der Wurzel dieses Projekts gibt. */
const MARKER = join('db', 'schema.sql');

let cached: string | null = null;

function search(from: string): string | null {
  let dir = resolve(from);
  for (let up = 0; up < 12; up++) {
    if (existsSync(join(dir, MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Sucht von `process.cwd()` aufwärts. Trägt in beiden Welten: die CLI läuft
 * im Repo, Next läuft in `web/`.
 *
 * Überschreibbar per `AUTOFLAT_ROOT`, falls der Dienst je aus einem
 * fremden Arbeitsverzeichnis gestartet wird.
 */
export function projectRoot(): string {
  if (cached) return cached;

  const override = process.env['AUTOFLAT_ROOT'];
  if (override) {
    const abs = resolve(override);
    if (!existsSync(join(abs, MARKER))) {
      throw new Error(`AUTOFLAT_ROOT=${override} enthält kein ${MARKER}`);
    }
    cached = abs;
    return cached;
  }

  const found = search(process.cwd());
  if (!found) {
    throw new Error(
      `Projektwurzel nicht gefunden: von ${process.cwd()} aufwärts gibt es kein ${MARKER}. ` +
        `Setze AUTOFLAT_ROOT, wenn du aus einem fremden Verzeichnis startest.`,
    );
  }
  cached = found;
  return cached;
}

/** `fromRoot('prompts', 'gate.md')` -> absoluter Pfad. */
export function fromRoot(...segments: string[]): string {
  return resolve(projectRoot(), ...segments);
}
