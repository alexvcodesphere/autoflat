/**
 * Stufe `research` / Modus `firma` (§8 Flow B).
 *
 * Läuft **einmal pro Firma**, nicht pro Inserat. Beim nächsten Objekt
 * derselben Firma greift der Cache und wir sind in Flow A. Das ist der
 * einzige Zweck dieses Zweigs.
 */
import { readFileSync } from 'node:fs';
import { fromRoot } from '../lib/paths.ts';
import type { LlmResult, ResearchAdapter } from '../llm/types.ts';
import { loadSchema } from '../llm/validate.ts';
import { logLlmCall } from '../llm/log.ts';

const PROMPT_PATH = fromRoot('prompts', 'research_firma.md');

export type FirmType = 'verwaltung' | 'makler' | 'gesellschaft' | 'genossenschaft' | 'privat' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface FirmaResearch {
  domain: string | null;
  impressum_url: string | null;
  vermietung_url: string | null;
  email_vermietung: string | null;
  email_general: string | null;
  contact_persons: string[];
  firm_type: FirmType;
  portal_only: boolean;
  confidence: Confidence;
  evidence: string | null;
}

export interface FirmaQuery {
  /** Firmenname, wie er im Inserat oder in seed_company steht. */
  name: string;
  /** Straße, PLZ oder Ortsteil — trennt Namensvettern. */
  addressHint?: string | null;
  /** Website, falls schon bekannt (Places liefert sie oft mit). */
  websiteHint?: string | null;
  /**
   * Die im Inserat genannte Ansprechperson.
   *
   * Deren direkte Adresse ist das beste erreichbare Ziel: Sie betreut dieses
   * Objekt, nicht irgendein Sammelpostfach.
   */
  contactPerson?: string | null;
}

/**
 * Die eine URL, die keine Vermutung ist.
 *
 * Ein früherer Entwurf hängte hier neun geratene Pfade an (/team,
 * /unternehmen/team, /ueber-uns …). Das ist eine Sollbruchstelle: Es kodiert
 * Annahmen über deutsche CMS-Konventionen, und ausgerechnet die kleinen
 * Verwaltungen — die, für die es diesen Cache überhaupt braucht — haben
 * Websites mit /wir.html oder /index.php?id=7.
 *
 * Stattdessen wird nur die tatsächlich bekannte Adresse übergeben. Das
 * urlContext-Werkzeug holt sie (es holt ausschließlich URLs, die wörtlich im
 * Prompt stehen), das Modell sieht die Navigation und findet die
 * Unterseiten über `site:`-Suchen selbst. Diese Technik hat es in der
 * Messung vom 2026-08-20 unaufgefordert eingesetzt.
 */
export interface FirmaResearchResult {
  ok: boolean;
  data: FirmaResearch | null;
  llm: LlmResult<FirmaResearch>;
}

let systemPrompt: string | null = null;
function loadSystemPrompt(): string {
  systemPrompt ??= readFileSync(PROMPT_PATH, 'utf8');
  return systemPrompt;
}

/** Ein plausibler Hostname — nicht irgendein Text mit einem Punkt darin. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Holt den Hostnamen aus dem, was im Inserat stand.
 *
 * Der Wert kommt aus `provider.website_raw`, also aus Seitentext — und der
 * ist unsauber. Gesehen: Markdown-Links
 * (`[www.firma.de](https://www.firma.de)`), Klammern, angehängte Satzzeichen,
 * "Web: firma.de". Eine frühere Fassung schnitt nur am ersten Slash und
 * lieferte für den Markdown-Fall `https://[www.firma.de](https:` — eine
 * URL, die das urlContext-Werkzeug still verwarf. Der Lauf sah trotzdem gut
 * aus, weil die site:-Suche das auffing; auffällig war nur
 * "per urlContext geholt: 0".
 *
 * Deshalb: erst den Kandidaten herausschälen, dann gegen ein echtes
 * Hostname-Muster prüfen und im Zweifel null liefern.
 */
export function knownSiteUrl(website: string | null | undefined): string | null {
  if (typeof website !== 'string') return null;
  let text = website.trim();
  if (text === '') return null;

  // Markdown-Link: das Ziel in den runden Klammern gewinnt.
  const markdown = /\]\(([^)]+)\)/.exec(text);
  if (markdown) text = markdown[1]!.trim();

  // Wortweise durchgehen: "Web: firma.de" und "Homepage www.firma.de"
  // kommen so vor. Der erste Token, der als Hostname durchgeht, gewinnt.
  for (const token of text.toLowerCase().split(/\s+/)) {
    const host = token
      .replace(/^[^a-z0-9]+/, '')      // führende [ ( < " usw. — VOR dem Protokoll,
      .replace(/^https?:\/\//, '')     // sonst zerlegt der Split gleich das "https://"
      .split(/[/?#]/)[0]!              // Pfad, Query, Fragment
      .replace(/[^a-z0-9]+$/, '');     // angehängte ) ] > , . ! und Schlusspunkt

    if (host.includes('@')) continue;  // eine Mailadresse ist keine Website
    const bare = host.replace(/^www\./, '');
    if (!HOSTNAME_RE.test(bare)) continue;
    // Eine TLD aus einem Zeichen gibt es nicht — fängt "firma.d" ab.
    if (!/\.[a-z]{2,}$/.test(bare)) continue;
    return `https://${host}`;
  }
  return null;
}

/** Domain ohne Protokoll und www — für `site:`-Suchen. */
export function bareDomain(website: string | null | undefined): string | null {
  const url = knownSiteUrl(website);
  return url ? url.replace(/^https:\/\//, '').replace(/^www\./, '') : null;
}

export function buildFirmaTask(query: FirmaQuery): string {
  const lines = [`Firma: ${query.name}`];
  if (query.addressHint) lines.push(`Adresshinweis: ${query.addressHint}`);
  if (query.contactPerson) lines.push(`Im Inserat genannte Ansprechperson: ${query.contactPerson}`);
  lines.push('Ort: Berlin');

  const site = knownSiteUrl(query.websiteHint);
  const domain = bareDomain(query.websiteHint);
  if (site) lines.push(`Bekannte Website: ${site}`);

  lines.push('');
  lines.push('Finde die E-Mail-Adresse, an die eine Mietanfrage an diese Firma gehört.');

  if (domain) {
    lines.push('');
    lines.push('Die Unterseiten dieser Website kennst du nicht — rate sie nicht, such sie:');
    lines.push(`  site:${domain} Impressum`);
    lines.push(`  site:${domain} Kontakt`);
    lines.push(`  site:${domain} Team OR Mitarbeiter OR Ansprechpartner`);
    lines.push(`  site:${domain} Vermietung OR Mietangebote`);
    if (query.contactPerson) {
      lines.push(`  "${query.contactPerson.replace(/^(Herr|Frau)\s+/i, '')}" ${domain}`);
    }
    lines.push('');
    lines.push(
      'Die Trefferliste nennt dir die echten URLs. Erst danach weißt du, wie ' +
      'die Seiten dieser Website heißen.',
    );
  } else {
    // Kein Website-Hinweis im Inserat — das ist der Normalfall bei
    // Kleinanzeigen und bei privaten Anbietern. Dann ist das Finden der
    // Website selbst der erste Arbeitsschritt.
    lines.push('');
    lines.push('Die Website dieser Firma ist nicht bekannt. Finde sie zuerst:');
    lines.push(`  "${query.name}" Berlin`);
    lines.push(`  "${query.name}" Impressum`);
    if (query.addressHint) {
      lines.push(`  Hausverwaltung "${query.addressHint}"`);
    }
    if (query.contactPerson) {
      lines.push(`  "${query.contactPerson.replace(/^(Herr|Frau)\s+/i, '')}" "${query.name}"`);
    }
    lines.push('');
    lines.push(
      'Sobald du die Domain hast, such deren Unterseiten mit site:<domain> — ' +
      'rate keine Pfade.',
    );
    lines.push(
      'Hat die Firma gar keine Website, sieh in Branchenverzeichnissen nach ' +
      '(IVD, VDIV, Das Örtliche, Gelbe Seiten). Dort steht manchmal eine ' +
      'Mailadresse — die ist aber schwächer belegt als ein Impressum und ' +
      'rechtfertigt höchstens confidence "low".',
    );
  }
  return lines.join('\n');
}

/**
 * Zweiter Versuch über die Adresse statt den Namen (§8 Flow B, Schritt 2).
 *
 * Greift, wenn der Firmenname nichts hergibt — kleine Verwaltungen ohne
 * Website sind über „Hausverwaltung + Straße" manchmal trotzdem auffindbar,
 * etwa über Nachbarhäuser derselben Eigentümergesellschaft.
 */
/**
 * Zweiter Versuch über die Adresse statt den Namen (§8 Flow B, Schritt 2).
 *
 * Greift, wenn der Firmenname nichts hergibt — kleine Verwaltungen ohne
 * Website sind über „Hausverwaltung + Straße" manchmal trotzdem auffindbar,
 * etwa über Nachbarhäuser derselben Eigentümergesellschaft.
 */
export function buildFallbackTask(query: FirmaQuery): string {
  return [
    `Die Suche nach dem Firmennamen "${query.name}" war erfolglos.`,
    query.addressHint
      ? `Suche stattdessen über die Adresse: welche Hausverwaltung betreut "${query.addressHint}" in Berlin?`
      : 'Suche nach Schreibvarianten des Namens, etwa mit und ohne Rechtsform.',
    '',
    'Findest du auch so nichts Belastbares, gib confidence "none" zurück.',
  ].join('\n');
}

export interface ResearchFirmaOptions {
  timeoutMs?: number;
  /** Zweiten Versuch über die Adresse zulassen (§8 Flow B). */
  allowFallback?: boolean;
}

function isUseful(data: FirmaResearch | null): boolean {
  return Boolean(data && data.confidence !== 'none' && (data.email_vermietung ?? data.email_general));
}

export async function researchFirma(
  adapter: ResearchAdapter,
  query: FirmaQuery,
  opts: ResearchFirmaOptions = {},
): Promise<FirmaResearchResult> {
  const system = loadSystemPrompt();
  const schema = loadSchema('research_firma');
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const task = buildFirmaTask(query);
  let llm = await adapter.research<FirmaResearch>({ system, task, schema, allowFetch: true }, timeoutMs);
  logLlmCall({ stage: 'research_firma', adapter: adapter.id, system, input: task, result: llm });

  if (opts.allowFallback && (!llm.ok || !isUseful(llm.data))) {
    const fallbackTask = `${task}\n\n---\n${buildFallbackTask(query)}`;
    const second = await adapter.research<FirmaResearch>(
      { system, task: fallbackTask, schema, allowFetch: true },
      timeoutMs,
    );
    logLlmCall({
      stage: 'research_firma', adapter: adapter.id, system, input: fallbackTask, result: second,
    });
    // Kosten beider Versuche zusammenführen — sonst unterschlägt die
    // Tagesabrechnung (§16) den ersten.
    if (second.ok && isUseful(second.data)) {
      llm = {
        ...second,
        costUsd: llm.costUsd + second.costUsd,
        ms: llm.ms + second.ms,
        usage: {
          inputTokens: llm.usage.inputTokens + second.usage.inputTokens,
          outputTokens: llm.usage.outputTokens + second.usage.outputTokens,
          thinkingTokens: (llm.usage.thinkingTokens ?? 0) + (second.usage.thinkingTokens ?? 0),
          cachedInputTokens: (llm.usage.cachedInputTokens ?? 0) + (second.usage.cachedInputTokens ?? 0),
          searchQueries: (llm.usage.searchQueries ?? 0) + (second.usage.searchQueries ?? 0),
        },
      };
    } else {
      llm = { ...llm, costUsd: llm.costUsd + second.costUsd, ms: llm.ms + second.ms };
    }
  }

  return { ok: llm.ok && llm.data !== null, data: llm.data, llm };
}
