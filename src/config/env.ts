import { config as loadDotenv } from 'dotenv';
import { isAbsolute } from 'node:path';
import { fromRoot } from '../lib/paths.ts';

/**
 * Ausdrücklich aus der Projektwurzel, nicht relativ zum Arbeitsverzeichnis.
 *
 * dotenv sucht standardmäßig `${cwd}/.env`. Die CLI läuft im Repo und findet
 * sie, Next läuft in `web/` und findet sie nicht — die Registry scheiterte
 * dann mit "STAGE_EXTRACT fehlt in .env", obwohl die Datei existiert.
 */
loadDotenv({ path: fromRoot('.env'), quiet: true });

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * Relative Pfade gegen die Projektwurzel auflösen, nicht gegen das
 * Arbeitsverzeichnis.
 *
 * `DB_PATH=data/autoflat.db` meint immer dieselbe Datei. Ohne diese
 * Umrechnung öffnete die CLI `./data/…` im Repo und Next `web/data/…` — zwei
 * getrennte Datenbanken, und der Firmen-Cache war in der einen leer, obwohl
 * er in der anderen gefüllt war. Ein absoluter Pfad in .env bleibt unberührt.
 */
function pathFromRoot(key: string, fallback: string): string {
  const value = str(key, fallback);
  return isAbsolute(value) ? value : fromRoot(value);
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env ${key} ist keine Zahl: ${JSON.stringify(v)}`);
  }
  return parsed;
}

export const env = {
  dbPath: pathFromRoot('DB_PATH', 'data/autoflat.db'),
  snapshotDir: pathFromRoot('SNAPSHOT_DIR', 'data/snapshots'),
  llmLogDir: pathFromRoot('LLM_LOG_DIR', 'data/llm-log'),
  llmLogEnabled: str('LLM_LOG', '1') !== '0',
  geminiApiKey: process.env['GEMINI_API_KEY'] ?? '',
  costWarnUsdPerDay: num('COST_WARN_USD_PER_DAY', 2),
  costStopUsdPerDay: num('COST_STOP_USD_PER_DAY', 5),
};

/** Wirft mit klarer Meldung, statt den Adapter in einen 401 laufen zu lassen. */
export function requireGeminiApiKey(): string {
  if (!env.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY fehlt. Trage ihn in .env ein (Vorlage: .env.example). ' +
        'Key erzeugen unter https://aistudio.google.com/apikey',
    );
  }
  return env.geminiApiKey;
}
