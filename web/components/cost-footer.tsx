/**
 * Kosten und Kontingente (§16) — eine Zeile am Fuß statt drei Karten oben.
 *
 * Sie sind wichtig, aber sie sind nie der Grund, warum man die Seite öffnet.
 */
import { getDb } from '../lib/server.ts';
import { costToday } from '../../src/db/listing.ts';
import { groundingStats } from '../../src/db/grounding.ts';
import { seedStats } from '../../src/db/seed.ts';
import { env } from '../../src/config/env.ts';

export function CostFooter() {
  const db = getDb();
  const spent = costToday(db);
  const grounding = groundingStats(db);
  const seed = seedStats(db);
  const warn = spent > env.costWarnUsdPerDay;

  return (
    <footer className="text-muted-foreground mt-12 flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-xs tabular-nums">
      <span className={warn ? 'text-destructive' : undefined}>
        Heute ${spent.toFixed(4)} von ${env.costStopUsdPerDay}
      </span>
      <span>{grounding.freeRemaining} freie Suchanfragen</span>
      {seed.pending > 0 && <span>{seed.pending} Firmen in der Warteschlange</span>}
    </footer>
  );
}
