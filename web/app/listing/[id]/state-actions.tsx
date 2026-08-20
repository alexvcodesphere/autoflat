'use client';
/**
 * Die Aktionen, die ohne Mailversand auskommen. Approve und das
 * Undo-Fenster gehören zu Phase 7 — solange es keinen Versand gibt, wäre ein
 * Knopf dafür eine Lüge.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { changeState } from '../../actions.ts';
import { Button } from '@/components/ui/button';

const ACTIONS: Array<{ key: string; label: string; variant: 'outline' | 'ghost' | 'destructive'; states: string[] }> = [
  { key: 'portal', label: 'Übers Portal bewerben', variant: 'outline', states: ['drafted'] },
  { key: 'done', label: 'Erledigt', variant: 'ghost', states: ['manual'] },
  { key: 'cancel', label: 'Abbrechen', variant: 'destructive', states: ['drafted', 'queued'] },
];

export function StateActions({ id, state }: { id: number; state: string; branch: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const available = ACTIONS.filter((a) => a.states.includes(state));

  if (available.length === 0) {
    return <p className="text-muted-foreground text-xs">Keine Aktion möglich im Zustand {state}.</p>;
  }

  const run = (key: string, label: string) => {
    start(async () => {
      const res = await changeState(id, key);
      if (res.ok) { toast.success(label); router.refresh(); }
      else toast.error(res.error ?? 'Fehlgeschlagen');
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {available.map((a) => (
        <Button key={a.key} variant={a.variant} size="sm" disabled={pending}
          onClick={() => run(a.key, a.label)}>
          {a.label}
        </Button>
      ))}
    </div>
  );
}
