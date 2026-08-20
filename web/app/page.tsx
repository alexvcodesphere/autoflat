/**
 * Queue (§12) — als Entscheidungsliste, nicht als Dashboard.
 *
 * Die erste Fassung zeigte drei Kennzahl-Karten und eine Tabelle mit sechs
 * Metadaten-Spalten. Beides half beim Handeln nicht: Die Frage an dieser
 * Stelle ist immer dieselbe — ist diese Mail gut genug, raus damit oder
 * nicht. Also steht pro Inserat genau das da.
 *
 * Ist nichts zu entscheiden, ist das Einfügefeld der Bildschirm. Ein leerer
 * Zustand mit einem Knopf zu einer anderen Seite ist ein Umweg.
 */
import Link from 'next/link';
import { getDb } from '../lib/server.ts';
import { listOpen } from '../../src/db/listing.ts';
import { findVerwaltung } from '../../src/db/verwaltung.ts';
import { decideSendMode } from '../../src/lib/send-mode.ts';
import { PasteForm } from '@/components/paste-form';
import { ReadinessLine, readinessOf } from '@/components/readiness';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

const BRANCH_LABEL: Record<string, string> = {
  T_VERWALTUNG: 'Hausverwaltung',
  T_MAKLER: 'Makler',
  T_NACHMIETER: 'Nachmieter',
  T_PRIVAT: 'privat',
  T0: 'Portal',
};

function relative(utc: string): string {
  const then = new Date(utc.replace(' ', 'T') + 'Z').getTime();
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} h`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

export default function QueuePage() {
  const db = getDb();
  const listings = listOpen(db);

  if (listings.length === 0) {
    return (
      <main className="space-y-6">
        <div>
          <h1 className="font-heading text-2xl">Nichts zu entscheiden</h1>
          <p className="text-muted-foreground mt-1">
            Füg ein Exposé ein, dann steht hier in ein paar Sekunden ein fertiges Anschreiben.
          </p>
        </div>
        <PasteForm />
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-heading text-2xl">
          {listings.length} {listings.length === 1 ? 'Inserat wartet' : 'Inserate warten'}
        </h1>
        <Link href="/einfuegen" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Weiteres einfügen
        </Link>
      </div>

      <ul className="space-y-3">
        {listings.map((l) => {
          const p = l.payload.listing;
          const firma = l.payload.provider.name_raw ? findVerwaltung(db, l.payload.provider.name_raw) : null;
          const decision = decideSendMode({
            branch: l.branch as never,
            risk: (l.fraud_risk ?? 'medium') as never,
            branchConfidence: (l.branch_confidence ?? 'low') as never,
            recipientConfidence: firma?.confidence ?? null,
            hasRecipient: l.recipient !== null,
          });
          const readiness = readinessOf({
            sendMode: l.send_mode, branch: l.branch, risk: l.fraud_risk,
            signals: l.fraud_signals, recipient: l.recipient, reasons: decision.reasons,
          });

          return (
            <li key={l.id}>
              <Link
                href={`/listing/${l.id}`}
                className="bg-card hover:ring-foreground/20 ring-foreground/10 block rounded-lg p-4 ring-1 transition-shadow"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <h2 className="font-heading text-lg leading-tight">
                    {[p.street, p.house_number].filter(Boolean).join(' ') || p.district || l.external_id}
                    {p.street && p.district && (
                      <span className="text-muted-foreground font-sans text-sm font-normal">, {p.district}</span>
                    )}
                  </h2>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{BRANCH_LABEL[l.branch] ?? l.branch}</Badge>
                    <span className="text-muted-foreground text-xs">{relative(l.created_at)}</span>
                  </div>
                </div>

                <p className="text-muted-foreground mt-0.5 text-sm">
                  {[
                    p.rooms ? `${p.rooms} Zi.` : null,
                    p.living_space ? `${p.living_space} m²` : null,
                    p.cold_rent ? `${p.cold_rent} € kalt` : null,
                    p.takeover_payment_eur ? `${p.takeover_payment_eur} € Abstand` : null,
                    l.payload.provider.name_raw,
                  ].filter(Boolean).join(' · ')}
                </p>

                <div className="mt-3 border-t pt-3">
                  <ReadinessLine readiness={readiness} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
