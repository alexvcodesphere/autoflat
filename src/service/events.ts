/**
 * Event-Bus für die Live-Ansicht (§12: "Server-rendered plus SSE").
 *
 * Bewusst winzig: ein Prozess, ein Nutzer, ein paar offene Verbindungen. Kein
 * Redis, keine Queue.
 */
export type ServerEvent =
  | { type: 'pipeline'; listingId: number; step: string; message: string }
  | { type: 'listing'; listingId: number }
  | { type: 'verwaltung'; id: number };

type Subscriber = (event: ServerEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publish(event: ServerEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // Ein kaputter Abonnent darf die Pipeline nicht aufhalten.
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}
