/**
 * Die eine Zeile, die sagt, was mit diesem Inserat zu tun ist.
 *
 * Ersetzt die Badge-Sammlung aus der ersten Fassung. Dort standen Zweig,
 * Risiko und Modus als drei gleich aussehende Pillen nebeneinander — man
 * musste sie erst zusammenrechnen, um zu wissen, ob man etwas tun kann.
 */
import { CheckCircle2, AlertTriangle, Ban, ExternalLink } from 'lucide-react';

export interface Readiness {
  tone: 'ready' | 'attention' | 'blocked' | 'manual';
  headline: string;
  detail: string | null;
}

const TONE = {
  ready: { icon: CheckCircle2, className: 'text-primary' },
  attention: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-500' },
  blocked: { icon: Ban, className: 'text-destructive' },
  manual: { icon: ExternalLink, className: 'text-muted-foreground' },
} as const;

const SIGNAL_LABEL: Record<string, string> = {
  rent_far_below_market: 'Miete weit unter Markt',
  prepayment_before_viewing: 'Vorkasse vor Besichtigung',
  landlord_abroad: 'Vermieter im Ausland',
  keys_by_mail: 'Schlüsselversand',
  machine_translated: 'Text wirkt übersetzt',
  pressure_to_leave_platform: 'Drängen auf Plattformwechsel',
  no_viewing_possible: 'keine Besichtigung möglich',
  identity_inconsistent: 'widersprüchliche Angaben',
  other: 'Sonstiges',
};

export function readinessOf(input: {
  sendMode: string | null;
  branch: string;
  risk: string | null;
  signals: string[];
  recipient: string | null;
  reasons?: string[];
}): Readiness {
  if (input.risk === 'high') {
    return {
      tone: 'blocked',
      headline: 'Betrugsverdacht — geht nicht raus',
      detail: input.signals.map((s) => SIGNAL_LABEL[s] ?? s).join(', ') || null,
    };
  }
  if (input.sendMode === 'manual' || input.branch === 'T0') {
    return {
      tone: 'manual',
      headline: 'Kein Direktkanal — übers Portalformular bewerben',
      detail: 'Text kopieren, selbst einreichen, danach als erledigt markieren',
    };
  }
  if (input.sendMode === 'blocked' || !input.recipient) {
    return {
      tone: 'blocked',
      headline: 'Keine Empfängeradresse',
      detail: 'Die Recherche hat nichts Belastbares gefunden',
    };
  }
  if (input.sendMode === 'approve') {
    return {
      tone: 'attention',
      headline: 'Braucht deine ausdrückliche Freigabe',
      detail: input.reasons?.[0] ?? null,
    };
  }
  return { tone: 'ready', headline: 'Anschreiben bereit', detail: input.recipient };
}

export function ReadinessLine({ readiness }: { readiness: Readiness }) {
  const { icon: Icon, className } = TONE[readiness.tone];
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className={`mt-0.5 size-4 shrink-0 ${className}`} />
      <div>
        <span className={readiness.tone === 'ready' ? '' : className}>{readiness.headline}</span>
        {readiness.detail && (
          <span className="text-muted-foreground block text-xs">{readiness.detail}</span>
        )}
      </div>
    </div>
  );
}
