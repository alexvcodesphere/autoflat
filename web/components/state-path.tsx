/**
 * Wo dieses Inserat im Ablauf steht (§10) — und wo der Ablauf heute endet.
 *
 * Die beiden letzten Schritte sind ausgegraut und beschriftet, weil es noch
 * keinen Versand gibt. Ein Ablauf, der unsichtbar aufhört, ist der Grund,
 * warum man nicht weiß, wie man vorankommt.
 */
interface Stage { key: string; label: string; pending?: boolean }

const PATH: readonly Stage[] = [
  { key: 'captured', label: 'Erfasst' },
  { key: 'drafted', label: 'Geprüft' },
  { key: 'queued', label: 'Freigegeben', pending: true },
  { key: 'sent', label: 'Gesendet', pending: true },
];

const REACHED: Record<string, number> = {
  captured: 0, drafted: 1, manual: 1, cancelled: 1,
  queued: 2, sent: 3, nudged: 3, handoff: 3, bounced: 3, dead: 3,
};

export function StatePath({ state }: { state: string }) {
  const at = REACHED[state] ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {PATH.map((step, i) => (
        <span key={step.key} className="flex items-center gap-2">
          {i > 0 && <span className="text-border">→</span>}
          <span
            className={
              i <= at ? 'text-foreground font-medium'
                : step.pending ? 'text-muted-foreground/50'
                  : 'text-muted-foreground'
            }
          >
            {step.label}
            {step.pending && i > at && <span className="text-muted-foreground/50"> (Phase 7)</span>}
          </span>
        </span>
      ))}
      {(state === 'cancelled' || state === 'dead') && (
        <span className="text-muted-foreground">· abgeschlossen als {state}</span>
      )}
    </div>
  );
}
