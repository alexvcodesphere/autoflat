/**
 * Wegwerf-Prüfseite. Beantwortet eine einzige Frage: Löst Next einen Import
 * mit .ts-Endung aus dem bestehenden src/-Baum auf?
 *
 * TypeScript tut es (eine Zeile in tsconfig.json). Ob der Bundler es auch
 * tut, konnte ich nicht messen — Turbopack braucht dafür einen Port, und
 * meine Sandbox verbietet das.
 *
 *   cd web && npm run dev   ->  http://localhost:3000/probe
 *
 * Steht dort "meyer", ist die Antwort ja und die Migration nach Next kostet
 * fast nichts. Danach kann diese Datei weg.
 */
import { normalizeCompanyName } from '../../../src/lib/normalize.ts';
import { buildSubject } from '../../../src/render/german.ts';

export default function Probe() {
  const listing = {
    external_id: '162345678', url: null, street: 'Sonnenallee', house_number: '104',
    postcode: '12045', district: 'Neukölln', rooms: 2, living_space: null,
    cold_rent: null, warm_rent: null, deposit: null, takeover_payment_eur: null,
    takeover_note: null, available_from: null, wbs_required: null,
    features: [], description_excerpt: null,
  };
  return (
    <main style={{ padding: 32, fontFamily: 'monospace', lineHeight: 1.8 }}>
      <p>normalizeCompanyName: <b>{normalizeCompanyName('Meyer &amp; Co. Hausverwaltung GmbH')}</b></p>
      <p>buildSubject: <b>{buildSubject(listing)}</b></p>
      <p>Beide Werte aus src/ — wenn sie hier stehen, trägt der Bundler die .ts-Endungen.</p>
    </main>
  );
}
