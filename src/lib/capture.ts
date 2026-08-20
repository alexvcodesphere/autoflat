/**
 * Was der Client schickt (§4). Der Client parst nichts — er liefert Rohtext,
 * JSON-LD und (nur auf Platte) den HTML-Snapshot.
 */

export type CaptureSource = 'is24' | 'immowelt' | 'kleinanzeigen' | 'wg_gesucht' | 'website' | 'paste';

export interface CaptureInput {
  capture_version: string;
  url: string | null;
  source: CaptureSource | string;
  page_text: string;
  json_ld?: string[];
  /** §15: bleibt lokal. Nie an ein Modell, nie in ein Log. */
  html_snapshot?: string;
}

/**
 * Ersatzschlüssel, wenn das Inserat keine eigene ID ausweist (§4).
 *
 * Normalisiert so, dass derselbe Aufruf mit Tracking-Parametern oder
 * abweichendem Slash am Ende denselben Schlüssel liefert — sonst erfasse ich
 * dasselbe Exposé zweimal.
 */
export function externalIdFromUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|ref|referrer|source)/i.test(key)) url.searchParams.delete(key);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const query = url.searchParams.toString();
  const host = url.hostname.replace(/^www\./, '');
  return `url:${host}${path}${query ? `?${query}` : ''}`;
}

/** Quelle aus der Domain ableiten, wenn der Client sie nicht mitschickt (§4). */
export function sourceFromUrl(rawUrl: string | null): CaptureSource {
  if (!rawUrl) return 'paste';
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'paste';
  }
  if (host.endsWith('immobilienscout24.de')) return 'is24';
  if (host.endsWith('immowelt.de') || host.endsWith('immonet.de')) return 'immowelt';
  if (host.endsWith('kleinanzeigen.de') || host.endsWith('ebay-kleinanzeigen.de')) return 'kleinanzeigen';
  if (host.endsWith('wg-gesucht.de')) return 'wg_gesucht';
  return 'website';
}
