/**
 * Winziger Template-Renderer für prompts/t_*.md.
 *
 * Kann absichtlich fast nichts: `{{name}}`, `{{#if key}}…{{/if}}` und
 * `{{#unless key}}…{{/unless}}`. Alles Anspruchsvollere — Anrede,
 * Objektbezeichnung, Zahlformate — entsteht in src/render/german.ts und
 * kommt hier als fertige Zeichenkette an. Ein Template soll lesbar bleiben
 * wie ein Brief, nicht wie Code.
 *
 * Eine nicht aufgelöste Variable ist ein Fehler, kein leerer String: ein
 * "{{beruf}}" mitten in einer Mail an eine Hausverwaltung wäre peinlich.
 */

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

export class TemplateError extends Error {}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return true;
  return Boolean(value);
}

function applyBlocks(template: string, vars: TemplateVars): string {
  const block = /\{\{#(if|unless)\s+([a-z_0-9]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  let out = template;
  let guard = 0;
  while (block.test(out)) {
    block.lastIndex = 0;
    out = out.replace(block, (_m, kind: string, key: string, body: string) => {
      const keep = kind === 'if' ? truthy(vars[key]) : !truthy(vars[key]);
      return keep ? body : '';
    });
    if (++guard > 10) throw new TemplateError('Template zu tief verschachtelt');
  }
  return out;
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  let out = applyBlocks(template, vars);

  const unresolved: string[] = [];
  out = out.replace(/\{\{([a-z_0-9]+)\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      unresolved.push(key);
      return '';
    }
    return String(value);
  });

  if (unresolved.length > 0) {
    throw new TemplateError(`Unaufgelöste Platzhalter: ${[...new Set(unresolved)].join(', ')}`);
  }

  // Mehr als eine Leerzeile hintereinander entsteht durch weggefallene
  // Blöcke und sieht in einer Mail nach Fehler aus.
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function countWords(text: string): number {
  return text
    .replace(/[·—–-]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-zA-ZäöüÄÖÜß0-9]/.test(w)).length;
}
