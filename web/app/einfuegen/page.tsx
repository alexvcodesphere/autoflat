import { PasteForm } from '@/components/paste-form';

export default function EinfuegenPage() {
  return (
    <main className="space-y-5">
      <div>
        <h1 className="font-heading text-2xl">Exposé einfügen</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Den sichtbaren Text der Inseratsseite hineinkopieren. Navigationsmüll, Cookie-Banner
          und „Ähnliche Objekte" dürfen drin bleiben — die Extraktion filtert sie.
        </p>
      </div>
      <PasteForm />
    </main>
  );
}
