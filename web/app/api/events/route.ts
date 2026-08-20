/**
 * GET /api/events — Live-Updates per SSE (§12).
 *
 * Die Pipeline läuft je Inserat mehrere Sekunden; ohne Strom von Ereignissen
 * müsste die UI pollen oder blind warten.
 */
import { subscribe } from '../../../../src/service/events.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      send(': verbunden\n\n');

      const unsubscribe = subscribe((event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      // Kommentarzeilen halten die Verbindung offen, wenn lange nichts passiert.
      const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* schon zu */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
