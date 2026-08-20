/**
 * Die Statusanzeigen, die in Queue und Draft dieselbe Bedeutung haben müssen.
 *
 * Farbe ist hier Information, nicht Dekoration: Rot heißt "geht nicht raus".
 */
import { Badge } from '@/components/ui/badge';

const RISK: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  low: { label: 'unauffällig', variant: 'outline' },
  medium: { label: 'auffällig', variant: 'secondary' },
  high: { label: 'Betrugsverdacht', variant: 'destructive' },
};

const MODE: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  undo: { label: '60-s-Fenster', variant: 'default' },
  approve: { label: 'Freigabe nötig', variant: 'secondary' },
  blocked: { label: 'gesperrt', variant: 'destructive' },
  manual: { label: 'übers Portal', variant: 'outline' },
};

const CONFIDENCE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  verified: 'default', high: 'default', medium: 'secondary', low: 'destructive', none: 'destructive',
};

export function RiskBadge({ risk }: { risk: string | null }) {
  const r = RISK[risk ?? ''] ?? { label: risk ?? 'ungeprüft', variant: 'secondary' as const };
  return <Badge variant={r.variant}>{r.label}</Badge>;
}

export function ModeBadge({ mode }: { mode: string | null }) {
  const m = MODE[mode ?? ''] ?? { label: mode ?? '—', variant: 'outline' as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function BranchBadge({ branch }: { branch: string }) {
  return <Badge variant="outline" className="font-mono text-xs">{branch}</Badge>;
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  return <Badge variant={CONFIDENCE[confidence] ?? 'secondary'}>{confidence}</Badge>;
}
