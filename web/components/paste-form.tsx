'use client';
/**
 * Der Eingang (§4, „Textfeld als Capture-Fallback").
 *
 * Steht bewusst auch direkt in der Queue: Wenn nichts zu entscheiden ist, ist
 * Einfügen die einzige sinnvolle Handlung — dann soll es nicht hinter einem
 * Navigationslink liegen.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { captureText } from '../app/actions.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PipelineProgress } from './pipeline-progress';

export function PasteForm({ compact = false }: { compact?: boolean }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = () => {
    start(async () => {
      const res = await captureText(text, url);
      if (!res.ok) { toast.error(res.error ?? 'Erfassung fehlgeschlagen'); return; }
      setText(''); setUrl('');
      if (res.id) router.push(`/listing/${res.id}`);
    });
  };

  if (pending) return <PipelineProgress />;

  return (
    <div className="space-y-3">
      <Textarea
        value={text} onChange={(e) => setText(e.target.value)}
        rows={compact ? 8 : 16}
        placeholder="Inseratsseite im Browser markieren, kopieren, hier einfügen. Navigationsmüll darf drin bleiben."
        className="resize-y text-sm leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="URL des Inserats (optional, hilft beim Zuordnen)"
          className="h-9 flex-1 text-sm"
        />
        <Button size="lg" onClick={submit} disabled={text.trim().length < 50}>
          Anschreiben erzeugen
        </Button>
      </div>
      {text.length > 0 && (
        <p className="text-muted-foreground text-xs tabular-nums">
          {text.length} Zeichen{text.trim().length < 50 ? ' — zu wenig für ein Exposé' : ''}
        </p>
      )}
    </div>
  );
}
