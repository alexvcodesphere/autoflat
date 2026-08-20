/**
 * Draft (§12). Die Mail so, wie sie beim Empfänger ankommt — Bearbeiten ist
 * der zweite Modus, nicht der erste.
 *
 * Die erste Fassung zeigte ein Monospace-Textfeld. Man konnte nicht auf einen
 * Blick sehen, ob die Mail gut ist, und genau das ist hier die einzige Frage.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getDb } from '../../../lib/server.ts';
import { getListing } from '../../../../src/db/listing.ts';
import { findVerwaltung } from '../../../../src/db/verwaltung.ts';
import { decideSendMode } from '../../../../src/lib/send-mode.ts';
import { DraftEditor } from './draft-editor';
import { StateActions } from './state-actions';
import { ReadinessLine, readinessOf } from '@/components/readiness';
import { StatePath } from '@/components/state-path';
import { ConfidenceBadge } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

const BRANCH_LABEL: Record<string, string> = {
  T_VERWALTUNG: 'Hausverwaltung', T_MAKLER: 'Makler', T_NACHMIETER: 'Nachmieter',
  T_PRIVAT: 'privat', T0: 'Portal',
};

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const listing = getListing(db, Number(id));
  if (!listing) notFound();

  const firma = listing.payload.provider.name_raw
    ? findVerwaltung(db, listing.payload.provider.name_raw) : null;

  const decision = decideSendMode({
    branch: listing.branch as never,
    risk: (listing.fraud_risk ?? 'medium') as never,
    branchConfidence: (listing.branch_confidence ?? 'low') as never,
    recipientConfidence: firma?.confidence ?? null,
    hasRecipient: listing.recipient !== null,
  });
  const readiness = readinessOf({
    sendMode: listing.send_mode, branch: listing.branch, risk: listing.fraud_risk,
    signals: listing.fraud_signals, recipient: listing.recipient, reasons: decision.reasons,
  });

  const p = listing.payload.listing;
  const editable = listing.state === 'drafted' || listing.state === 'manual';

  return (
    <main className="space-y-8">
      <div>
        <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">← Queue</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="font-heading text-2xl leading-tight">
              {[p.street, p.house_number].filter(Boolean).join(' ') || p.district || listing.external_id}
            </h1>
            <p className="text-muted-foreground text-sm">
              {[
                p.district, p.rooms ? `${p.rooms} Zi.` : null,
                p.living_space ? `${p.living_space} m²` : null,
                p.cold_rent ? `${p.cold_rent} € kalt` : null,
                p.warm_rent ? `${p.warm_rent} € warm` : null,
                p.deposit ? `${p.deposit} € Kaution` : null,
                p.takeover_payment_eur ? `${p.takeover_payment_eur} € Abstand` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Badge variant="outline">{BRANCH_LABEL[listing.branch] ?? listing.branch}</Badge>
        </div>
      </div>

      <div className="bg-muted/40 space-y-3 rounded-lg p-4">
        <ReadinessLine readiness={readiness} />
        {decision.reasons.length > 1 && (
          <ul className="text-muted-foreground ml-6 space-y-0.5 text-xs">
            {decision.reasons.slice(1).map((r) => <li key={r}>· {r}</li>)}
          </ul>
        )}
        <StatePath state={listing.state} />
      </div>

      <DraftEditor
        id={listing.id}
        subject={listing.draft_subject ?? ''}
        body={listing.draft_body ?? ''}
        recipient={listing.recipient}
        recipientConfidence={firma?.confidence ?? null}
        editable={editable}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <StateActions id={listing.id} state={listing.state} branch={listing.branch} />
        <div className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums">
          {firma && <span>Firma: <ConfidenceBadge confidence={firma.confidence} /></span>}
          <span>${listing.cost_usd.toFixed(4)}</span>
          {listing.url && (
            <a href={listing.url} className={buttonVariants({ variant: 'ghost', size: 'xs' })}
              target="_blank" rel="noreferrer">Inserat öffnen</a>
          )}
        </div>
      </div>
    </main>
  );
}
