'use client';
/**
 * Eine zurückgehaltene Importzeile (§17).
 *
 * Der Grund steht groß, die vorgeschlagenen Werte darunter — man soll in
 * zwei Sekunden entscheiden können, ob die Prüfung recht hatte.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { acceptQuarantine, rejectQuarantine } from '../actions.ts';
import { Button } from '@/components/ui/button';

const FIELD_LABEL: Record<string, string> = {
  domain: 'Domain', email_vermietung: 'Vermietung', email_general: 'Allgemein',
  firm_type: 'Art', confidence: 'Konfidenz', impressum_url: 'Impressum',
  vermietung_url: 'Angebotsseite', evidence: 'Beleg',
};

export function QuarantineCard(props: {
  id: number; name: string; reasons: string[]; payload: Record<string, unknown>;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: (id: number) => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    start(async () => {
      const res = await fn(props.id);
      if (res.ok) { toast.success(msg); router.refresh(); }
      else toast.error(res.error ?? 'Fehlgeschlagen');
    });
  };

  const fields = Object.entries(props.payload)
    .filter(([k, v]) => k !== 'name_input' && v !== null && v !== undefined && v !== '');

  return (
    <div className="bg-card ring-destructive/30 rounded-lg p-4 ring-1">
      <h3 className="font-medium">{props.name}</h3>
      <ul className="text-destructive mt-1.5 space-y-0.5 text-sm">
        {props.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {fields.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="text-muted-foreground w-24 shrink-0">{FIELD_LABEL[key] ?? key}</dt>
            <dd className="font-mono break-all">{String(value)}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={pending}
          onClick={() => run(acceptQuarantine, 'Übernommen und bestätigt')}>
          Trotzdem übernehmen
        </Button>
        <Button size="sm" variant="ghost" disabled={pending}
          onClick={() => run(rejectQuarantine, 'Verworfen')}>
          Verwerfen
        </Button>
      </div>
    </div>
  );
}
