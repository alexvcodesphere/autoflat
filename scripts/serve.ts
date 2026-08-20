#!/usr/bin/env node
/**
 * npm run api          startet den Dienst auf PORT (Default 8787)
 * npm run api -- --no-research   Cache-Miss nicht recherchieren
 */
import { build } from '../src/service/server.ts';
import { env } from '../src/config/env.ts';
import { loadRegistry, STAGES } from '../src/llm/registry.ts';

const port = Number(process.env['PORT'] ?? 8787);
const research = !process.argv.includes('--no-research');

let app;
try {
  // Registry vorab laden, damit ein Konfigurationsfehler den Start abbricht
  // und nicht erst beim ersten Inserat auffällt (§11).
  loadRegistry({ stages: STAGES, eager: false });
  app = build({ research });
} catch (err) {
  console.error(`\nStart abgebrochen:\n  ${(err as Error).message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

try {
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`Wohnungsbot-API auf http://127.0.0.1:${port}`);
  console.log(`  POST /capture          Inserat erfassen`);
  console.log(`  GET  /api/queue        offene Inserate`);
  console.log(`  GET  /events           Live-Updates (SSE)`);
  console.log(`  GET  /api/stats        Kosten, Kontingente, Modellzuordnung`);
  console.log(`\nDB: ${env.dbPath}${research ? '' : '   [Recherche aus]'}`);
} catch (err) {
  console.error(`Konnte Port ${port} nicht binden: ${(err as Error).message}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
