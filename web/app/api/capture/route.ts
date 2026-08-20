/**
 * POST /api/capture (§4).
 *
 * Der maschinenlesbare Eingang: Chrome-Extension, iOS-Shortcut, curl. Die
 * Logik steckt in src/service/capture.ts, damit sie ohne HTTP testbar bleibt.
 */
import { handleCapture, type CaptureBody } from '../../../../src/service/capture.ts';
import { getDb, getRegistry } from '../../../lib/server.ts';

export const dynamic = 'force-dynamic';
/** Flow B darf bis zu 90 s recherchieren (§8, angehoben). */
export const maxDuration = 120;

export async function POST(request: Request) {
  let body: CaptureBody;
  try {
    body = (await request.json()) as CaptureBody;
  } catch {
    return Response.json({ error: 'Body ist kein JSON' }, { status: 400 });
  }

  let result;
  try {
    result = await handleCapture(getDb(), getRegistry(), body);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
  return Response.json(result.body, { status: result.status });
}
