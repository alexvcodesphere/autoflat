/**
 * Zugriff auf den Node-Teil des Projekts aus Next heraus.
 *
 * DB und Registry sind teuer und dürfen nicht pro Anfrage neu entstehen. Im
 * Dev-Modus lädt Next Module bei jeder Änderung neu, deshalb hängen beide an
 * `globalThis` — sonst öffnet jeder Reload eine weitere SQLite-Verbindung.
 */
import 'server-only';
import { openDb, applySchema, type Db } from '../../src/db/index.ts';
import { loadRegistry, STAGES, type Registry } from '../../src/llm/registry.ts';

declare global {
  // eslint-disable-next-line no-var
  var __autoflatDb: Db | undefined;
  // eslint-disable-next-line no-var
  var __autoflatRegistry: Registry | undefined;
}

export function getDb(): Db {
  if (!globalThis.__autoflatDb) {
    const db = openDb();
    applySchema(db);
    globalThis.__autoflatDb = db;
  }
  return globalThis.__autoflatDb;
}

/**
 * Wirft bei fehlerhafter .env — genau wie §11 es verlangt: "Unbekannter
 * Anbieter oder fehlender Adapter => Startfehler, kein stiller Fallback."
 * Die Seiten fangen das ab und zeigen die Meldung, statt weiß zu bleiben.
 */
export function getRegistry(): Registry {
  globalThis.__autoflatRegistry ??= loadRegistry({ stages: STAGES });
  return globalThis.__autoflatRegistry;
}
