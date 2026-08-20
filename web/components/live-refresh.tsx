'use client';
/**
 * Hält die Server Components frisch, ohne Polling.
 *
 * Die Pipeline läuft je Inserat mehrere Sekunden und meldet jeden Schritt
 * über SSE. Bei jedem Ereignis wird die Seite neu von Server geholt — bei
 * Server Components ist das billig und ersetzt jede Zustandsverwaltung im
 * Browser.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function LiveRefresh() {
  const router = useRouter();
  const [last, setLast] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { step?: string; message?: string };
        if (data.step) setLast(`${data.step}: ${data.message ?? ''}`);
      } catch { /* Kommentarzeilen ignorieren */ }
      router.refresh();
    };
    return () => source.close();
  }, [router]);

  if (!last) return null;
  return (
    <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
      {last}
    </p>
  );
}
