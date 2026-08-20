import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
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
  dbPath: str('DB_PATH', 'data/wohnungsbot.db'),
  snapshotDir: str('SNAPSHOT_DIR', 'data/snapshots'),
  llmLogDir: str('LLM_LOG_DIR', 'data/llm-log'),
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
