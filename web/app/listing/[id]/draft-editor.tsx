'use client';
/**
 * Die Mail — erst lesen, dann bearbeiten.
 *
 * Ansicht ist der Standard: Die Frage hier ist, ob der Text so rausgehen
 * kann, und das entscheidet man durch Lesen. Das Textfeld erscheint auf
 * Klick.
 */
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Pencil, X } from 'lucide-react';
import { saveDraft } from '../../actions.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfidenceBadge } from '@/components/badges';

/** §13: T_VERWALTUNG darf 230 Wörter haben. */
const WORD_LIMIT = 230;

function countWords(text: string): number {
  return text.replace(/[·—–-]/g, ' ').split(/\s+/).filter((w) => /[a-zA-ZäöüÄÖÜß0-9]/.test(w)).length;
}

export function DraftEditor(props: {
  id: number; subject: string; body: string;
  recipient: string | null; recipientConfidence: string | null; editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const [pending, start] = useTransition();

  const dirty = subject !== props.subject || body !== props.body;
  const words = countWords(body);

  const save = () => {
    start(async () => {
      const res = await saveDraft(props.id, subject, body);
      if (res.ok) { toast.success('Gespeichert'); setEditing(false); }
      else toast.error(res.error ?? 'Speichern fehlgeschlagen');
    });
  };

  if (!props.body) {
    return (
      <p className="text-muted-foreground text-sm">
        Kein Anschreiben erzeugt — für diesen Zweig gibt es noch kein Template.
      </p>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-heading text-lg">Anschreiben</h2>
        {props.editable && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
            {editing ? <><X /> Abbrechen</> : <><Pencil /> Bearbeiten</>}
          </Button>
        )}
      </div>

      {/* Rahmen, der an ein Postfach erinnert: An, Betreff, dann der Text. */}
      <div className="bg-card overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <dl className="divide-y text-sm">
          <div className="flex gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground w-20 shrink-0">An</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {props.recipient
                ? <><span className="font-mono">{props.recipient}</span>
                    {props.recipientConfidence && <ConfidenceBadge confidence={props.recipientConfidence} />}</>
                : <span className="text-muted-foreground">— keine Adresse</span>}
            </dd>
          </div>
          <div className="flex gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground w-20 shrink-0">Betreff</dt>
            <dd className="flex-1">
              {editing
                ? <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-8" />
                : <span className="font-medium">{subject}</span>}
            </dd>
          </div>
        </dl>

        <div className="border-t px-4 py-4">
          {editing ? (
            <Textarea
              value={body} onChange={(e) => setBody(e.target.value)}
              rows={24} className="resize-y text-sm leading-relaxed"
            />
          ) : (
            <div className="text-sm leading-relaxed whitespace-pre-wrap">{body}</div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className={`text-xs tabular-nums ${words > WORD_LIMIT ? 'text-destructive' : 'text-muted-foreground'}`}>
          {words} von {WORD_LIMIT} Wörtern
        </p>
        {editing && (
          <Button size="lg" onClick={save} disabled={pending || !dirty}>
            {pending ? 'Speichert…' : 'Änderungen speichern'}
          </Button>
        )}
      </div>
    </section>
  );
}
