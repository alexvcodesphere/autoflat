/**
 * Firmen (§12) — ein Reparaturwerkzeug, keine Tabellenkalkulation.
 *
 * §12 nennt diese Ansicht "wichtiger als sie klingt": Hier korrigiere ich
 * falsche Recherche-Ergebnisse, und eine Korrektur von Hand setzt
 * `confidence = 'verified'` — die einzige Stufe, die kein Recherchelauf
 * überschreibt (§6). Ohne sie gibt es keinen Weg, eine falsche Adresse
 * dauerhaft loszuwerden.
 *
 * Die erste Fassung war eine Tabelle mit neun Spalten dauerhaft editierbarer
 * Eingabefelder. Sie zeigte den internen Schlüssel als Überschrift, schnitt
 * die E-Mail-Adressen ab und schob Konfidenz und Aktionen aus dem Bild.
 * Jetzt: zuerst das, was einen Blick braucht, Adressen in voller Breite,
 * Bearbeiten auf Klick.
 */
import { getDb } from '../../lib/server.ts';
import { listVerwaltung, isWeakerThan, type Verwaltung } from '../../../src/db/verwaltung.ts';
import { openQuarantine, seedStats } from '../../../src/db/seed.ts';
import { FirmCard } from './firm-card';
import { QuarantineCard } from './quarantine-card';

export const dynamic = 'force-dynamic';

/**
 * Was einen Blick braucht: keine Adresse, schwach belegte Adresse,
 * unbestimmte Art, oder eine Mail ist zurückgekommen. Alles andere ist
 * erledigt und darf leise sein.
 */
function needsAttention(f: Verwaltung): boolean {
  const hasEmail = Boolean(f.email_vermietung ?? f.email_general);
  return !hasEmail
    || f.bounce_count > 0
    || f.firm_type === 'unknown'
    || isWeakerThan(f.confidence, 'high');
}

/** Der lesbare Name, nicht der Normalisierungsschlüssel. */
export function displayName(f: Verwaltung): string {
  const longest = [...f.name_variants].sort((a, b) => b.length - a.length)[0];
  return longest ?? f.name_canonical;
}

export default function FirmenPage() {
  const db = getDb();
  const all = listVerwaltung(db);
  const quarantine = openQuarantine(db);
  const seed = seedStats(db);

  const attention = all.filter(needsAttention);
  const settled = all.filter((f) => !needsAttention(f));

  return (
    <main className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl">Firmen</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {all.length} im Cache
          {seed.pending > 0 && <> · {seed.pending} warten auf Recherche</>}
          . Eine Korrektur von Hand gilt als bestätigt und wird von keiner Recherche
          mehr überschrieben.
        </p>
      </div>

      {quarantine.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-destructive text-lg">
            Aus dem Import zurückgehalten ({quarantine.length})
          </h2>
          <p className="text-muted-foreground text-sm">
            Diese Zeilen haben die Prüfung nicht bestanden und stehen <em>nicht</em> im
            Cache (§17). Erst dein Klick übernimmt sie.
          </p>
          {quarantine.map((q) => (
            <QuarantineCard
              key={q.id} id={q.id} name={q.name_input}
              reasons={q.reasons} payload={q.payload as Record<string, unknown>}
            />
          ))}
        </section>
      )}

      {attention.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-lg">Brauchen einen Blick ({attention.length})</h2>
          <ul className="space-y-2">
            {attention.map((f) => (
              <li key={f.id}><FirmCard firma={{ ...f, displayName: displayName(f) }} /></li>
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-muted-foreground text-lg">
            Erledigt ({settled.length})
          </h2>
          <ul className="space-y-2">
            {settled.map((f) => (
              <li key={f.id}><FirmCard firma={{ ...f, displayName: displayName(f) }} quiet /></li>
            ))}
          </ul>
        </section>
      )}

      {all.length === 0 && quarantine.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Noch keine Firma im Cache. Der erste Eintrag entsteht, wenn ein Inserat erfasst
          und die Firma recherchiert wird.
        </p>
      )}
    </main>
  );
}
