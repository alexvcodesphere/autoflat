'use client';
/**
 * Eine Firma. Lesen ist der Standard, Bearbeiten ein Klick.
 *
 * Die Adressen stehen in voller Breite und in Monospace — sie sind der Grund,
 * warum man hier ist, und ein abgeschnittenes "info@." ist nutzlos.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil, X, AlertTriangle, MailX } from 'lucide-react';
import { fixVerwaltung, type FirmFix } from '../actions.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfidenceBadge } from '@/components/badges';

const FIRM_TYPES = ['verwaltung', 'makler', 'gesellschaft', 'genossenschaft', 'privat', 'unknown'] as const;

const FIRM_TYPE_LABEL: Record<string, string> = {
  verwaltung: 'Hausverwaltung', makler: 'Makler', gesellschaft: 'kommunale Gesellschaft',
  genossenschaft: 'Genossenschaft', privat: 'privat', unknown: 'unbestimmt',
};

export interface FirmData {
  id: number;
  displayName: string;
  name_canonical: string;
  firm_type: string;
  email_vermietung: string | null;
  email_general: string | null;
  confidence: string;
  portal_only: boolean;
  bounce_count: number;
  domain: string | null;
}

export function FirmCard({ firma, quiet = false }: { firma: FirmData; quiet?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [firmType, setFirmType] = useState(firma.firm_type);
  const [vermietung, setVermietung] = useState(firma.email_vermietung ?? '');
  const [general, setGeneral] = useState(firma.email_general ?? '');
  const [portalOnly, setPortalOnly] = useState(firma.portal_only);
  const [pending, start] = useTransition();
  const router = useRouter();

  const target = firma.email_vermietung ?? firma.email_general;

  const save = () => {
    const fix: FirmFix = {
      firm_type: firmType as FirmFix['firm_type'],
      email_vermietung: vermietung.trim() || null,
      email_general: general.trim() || null,
      portal_only: portalOnly,
    };
    start(async () => {
      const res = await fixVerwaltung(firma.id, fix);
      if (res.ok) { toast.success('Bestätigt — keine Recherche überschreibt das mehr'); setEditing(false); router.refresh(); }
      else toast.error(res.error ?? 'Speichern fehlgeschlagen');
    });
  };

  const selectClass =
    'border-input bg-transparent h-9 w-full rounded-md border px-2.5 text-sm ' +
    'focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-2 outline-none';

  return (
    <div className={`bg-card rounded-lg p-4 ring-1 ${quiet ? 'ring-foreground/5' : 'ring-foreground/10'}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="leading-snug font-medium">{firma.displayName}</h3>
          <p className="text-muted-foreground text-xs">
            {FIRM_TYPE_LABEL[firma.firm_type] ?? firma.firm_type}
            {firma.domain && <> · {firma.domain}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConfidenceBadge confidence={firma.confidence} />
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(!editing)}
            aria-label={editing ? 'Bearbeiten abbrechen' : 'Bearbeiten'}>
            {editing ? <X /> : <Pencil />}
          </Button>
        </div>
      </div>

      {!editing && (
        <div className="mt-3 space-y-1.5 text-sm">
          {target ? (
            <p className="font-mono break-all">{target}</p>
          ) : (
            <p className="text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" /> keine Adresse hinterlegt
            </p>
          )}
          {firma.email_vermietung && firma.email_general && (
            <p className="text-muted-foreground font-mono text-xs break-all">
              allgemein: {firma.email_general}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {firma.portal_only && <Badge variant="outline">nur über Portal</Badge>}
            {firma.bounce_count > 0 && (
              <Badge variant="destructive" className="gap-1">
                <MailX className="size-2.5" /> {firma.bounce_count}× zurückgekommen
              </Badge>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-4 space-y-3 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`type-${firma.id}`}>Art</Label>
              <select id={`type-${firma.id}`} value={firmType}
                onChange={(e) => setFirmType(e.target.value)} className={selectClass}>
                {FIRM_TYPES.map((t) => <option key={t} value={t}>{FIRM_TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <Button variant={portalOnly ? 'secondary' : 'outline'} size="lg"
                className="w-full" onClick={() => setPortalOnly(!portalOnly)}>
                {portalOnly ? 'Nur über Portal — an' : 'Nur über Portal — aus'}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`verm-${firma.id}`}>Adresse für Mietanfragen</Label>
            <Input id={`verm-${firma.id}`} value={vermietung} onChange={(e) => setVermietung(e.target.value)}
              placeholder="vermietung@firma.de" className="h-9 font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`gen-${firma.id}`}>Allgemeine Adresse</Label>
            <Input id={`gen-${firma.id}`} value={general} onChange={(e) => setGeneral(e.target.value)}
              placeholder="info@firma.de" className="h-9 font-mono text-sm" />
          </div>
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-muted-foreground text-xs">
              Schlüssel im Cache: <span className="font-mono">{firma.name_canonical}</span>
            </p>
            <Button size="lg" onClick={save} disabled={pending}>
              {pending ? 'Speichert…' : 'Speichern und bestätigen'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
