'use client';
/**
 * Was gerade passiert, während die Pipeline läuft.
 *
 * Ein Lauf dauert je nach Flow 3 bis 90 Sekunden (§8). Ohne diese Anzeige
 * sieht man einen Knopf, der nichts tut — der häufigste Grund, warum man
 * nicht weiß, ob man vorankommt.
 */
import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

interface Step { key: string; label: string; optional?: boolean }

const STEPS: readonly Step[] = [
  { key: 'extract', label: 'Daten aus dem Text lesen' },
  { key: 'cache', label: 'Firma im Cache suchen' },
  { key: 'research', label: 'Adresse recherchieren', optional: true },
  { key: 'gate', label: 'Prüfen und einordnen' },
  { key: 'draft', label: 'Anschreiben bauen' },
];

export function PipelineProgress() {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string>('extract');
  const [note, setNote] = useState<string>('');

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { step?: string; message?: string };
        if (!data.step) return;
        setDone((prev) => new Set(prev).add(data.step!));
        setNote(data.message ?? '');
        const idx = STEPS.findIndex((s) => s.key === data.step);
        const next = STEPS[idx + 1];
        setCurrent(next ? next.key : 'draft');
      } catch { /* Kommentarzeilen */ }
    };
    return () => source.close();
  }, []);

  return (
    <div className="space-y-3 py-2">
      <ol className="space-y-2">
        {STEPS.map((step) => {
          const isDone = done.has(step.key);
          const isCurrent = !isDone && step.key === current;
          return (
            <li key={step.key} className="flex items-center gap-2.5 text-sm">
              <span className="flex size-5 shrink-0 items-center justify-center">
                {isDone
                  ? <Check className="text-primary size-4" />
                  : isCurrent
                    ? <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    : <span className="bg-border size-1.5 rounded-full" />}
              </span>
              <span className={isDone || isCurrent ? '' : 'text-muted-foreground'}>
                {step.label}
                {step.optional && <span className="text-muted-foreground"> (nur bei Cache-Miss)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {note && <p className="text-muted-foreground border-l-2 pl-3 text-xs">{note}</p>}
    </div>
  );
}
