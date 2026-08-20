# Wohnungsbot

Aus einer Wohnungsanzeige in Berlin wird eine sendefertige deutsche
Bewerbungsmail. Die maßgebliche Spec ist das Projektdokument; Verweise wie
„§11" beziehen sich darauf. Leg sie als `docs/spec.md` ab, damit sie
mitversioniert wird.

**Stand: Phase 5 gebaut, Modelllauf steht aus.** Die Bauphasen stehen in der Spec, §14.

---

## Schnellstart

```bash
npm install
cp .env.example .env        # GEMINI_API_KEY eintragen
npm run db:init
npm test
npm run llm:smoke -- --mock # ohne API-Key
npm run llm:smoke           # echter Aufruf
```

| Befehl | Zweck |
|---|---|
| `npm run db:init` | legt `data/wohnungsbot.db` an, idempotent |
| `npm run db:reset` | löscht die DB und legt sie neu an |
| `npm test` | Unit-Tests (`node --test`, kein Framework) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run llm:smoke` | ein Adapteraufruf gegen `schemas/smoke.json` |
| `npm run extract:fixtures` | Extraktion über alle Fixtures, mit Zusicherungen |
| `npm run draft:render` | T_VERWALTUNG aus gecachten Payloads, ohne Modell |
| `npm run research:firma -- "Name"` | Firmenrecherche mit Grounding (§8 Flow B) |
| `npm run grounding:check` | prüft, ob die Google-Suche tatsächlich feuert |
| `npm run gate:fixtures` | Betrugsprüfung und Klassifikation über alle Fixtures |
| `npm run pipeline -- <datei>` | die ganze Kette an einem Inserat |
| `npm run seed:places` | füllt `seed_company` aus der Places API (§17) |
| `npm run prewarm:batch` | nächste 15 Firmen für Cowork, `--stats` zeigt die Queue |
| `npm run prewarm:import -- x.json` | Cowork-Ergebnis einlesen, `--quarantine` zeigt Offene |

Erster echter Aufruf am 20.08.2026 gegen `gemini-3.5-flash-lite`: 1089 ms,
203 In / 114 Out, $0,00034590, Schema sauber validiert.

## Voraussetzungen

**Node ≥ 22.18.** Die Spec (§16) nennt Node ≥ 20; die tatsächliche Untergrenze
liegt höher, weil TypeScript hier ohne Build-Schritt läuft — Node führt die
`.ts`-Dateien direkt aus (Type-Stripping, seit 22.18 ohne Flag). Damit
entfallen `tsx`, ein `dist/`-Verzeichnis und der Schritt „vergessen zu bauen".
Getestet auf Node 24.12.

---

## Aufbau

```
config/pricing.json    Preise. Bewusst außerhalb des Adaptercodes (§11).
db/schema.sql          SQLite-Schema (§6), idempotent.
schemas/               Kanonische JSON Schemas. Einzige Quelle der Wahrheit.
prompts/extract.md     Systemprompt der extract-Stufe.
fixtures/              Eingefrorene Inseratsseiten + Zusicherungen. Siehe docs/fixtures.md.
src/stages/extract.ts  Stufe extract: page_text -> Payload (§5).
src/lib/capture.ts     Was der Client schickt; URL-Ersatzschluessel.
src/lib/fixtures.ts    Fixture-Harness.
src/lib/profile.ts     Liest prompts/profil.md. Geht nie an ein Modell.
src/render/            Draft-Erzeugung ohne LLM: Template, Anrede, Betreff.
prompts/profil.md      Bewerberprofil (Bonitätsblock).
prompts/t_verwaltung.md  Template T_VERWALTUNG.
data/payloads/         Gecachte Extraktionen, Eingabe für draft:render.
src/db/verwaltung.ts   Firmen-Cache (§3), Konfidenz-Ordnung.
src/db/seed.ts         Warteschlange fürs Vorwärmen + Quarantäne.
src/lib/prewarm-import.ts  Validierung der Cowork-Ausgabe (§17).
src/stages/research-firma.ts  Firmenrecherche mit Grounding.
src/stages/gate.ts     Betrugsprüfung + Klassifikation in einem Aufruf.
src/lib/classify.ts    Harte Signale (§7 Stufe 1). Bewusst kein Regex-Klassifikator.
docs/cowork-prewarm-prompt.md  Die Cowork-Aufgabe, mitversioniert.
src/config/env.ts      .env-Zugriff an genau einer Stelle.
src/db/                Verbindung + Schema.
src/lib/normalize.ts   Namensnormalisierung (§6). Überall dieselbe Funktion.
src/llm/types.ts       generate / research. Nur LlmResult verlässt den Adapter.
src/llm/registry.ts    Stufe -> provider:model aus .env.
src/llm/pricing.ts     usage -> USD.
src/llm/validate.ts    ajv gegen das kanonische Schema.
src/llm/log.ts         Rohausgaben nach data/llm-log/*.jsonl.
src/llm/providers/     gemini-generate, gemini-schema, mock-generate.
```

---

## Abweichungen von der Spec

Die Spec bittet ausdrücklich darum, Modell-IDs gegen die aktuelle Doku zu
prüfen. Ergebnis der Prüfung am **2026-08-20** gegen
`ai.google.dev/gemini-api/docs/models`, `/pricing` und `/changelog`, jeweils
englisch und deutsch.

> **Zur Modellliste:** Die deutschsprachigen Doku-Seiten sind rund eine Woche
> im Rückstand. `gemini-3.7-flash` erschien am 13.08.2026 und steht dort noch
> nicht — wohl aber in der englischen Modell- und Preisliste und im
> Changelog. Wer die IDs nachschlägt, sollte die englische Fassung nehmen.

**1. `gemini-3.1-pro` existiert nicht als API-ID.**
Die Spec verdrahtet sie für `STAGE_DRAFT_PRIVAT` und `STAGE_RESEARCH_PERSON`.
Die Modellliste kennt nur **`gemini-3.1-pro-preview`**; ein Pro-Modell der
3.1-Familie ohne `-preview` gibt es nicht. `.env.example` verwendet deshalb
`gemini-3.1-pro-preview`. Das ist ein Preview-Modell — vor Phase 10
(Hook-Eval) prüfen, ob es inzwischen eine stabile ID gibt.

**2. Preise — zwei Korrekturen nach Gegenprüfung.**
Geprüft gegen die **englische und die deutsche** Fassung der Preisseite. Die
lokalisierten Seiten hinken nach: `gemini-3.7-flash` (Start 13.08.2026) fehlt
in der deutschen Fassung am 20.08.2026 noch ganz. Die englische Fassung
gruppiert dafür 3.6 und 3.7 Flash in einer Zeile, was in die Irre führt.

Korrigiert gegenüber dem ersten Anlauf:

| Modell | falsch | richtig |
|---|---|---|
| `gemini-3.6-flash` | $0,75 / $3,75 | **$1,50 / $7,50** — Einführungspreis mit dem Start von 3.7 ausgelaufen |
| `gemini-3.1-flash-lite` | $0,30 / $2,50 | **$0,25 / $1,50** — günstiger als 3.5 Flash-Lite, nicht gleich teuer |

Unverändert bestätigt: 3.7 Flash $0,75/$3,75 (Einführungspreis bis
31.12.2026), 3.5 Flash $1,50/$9, 3.5 Flash-Lite $0,30/$2,50, 3.1 Pro Preview
$2/$12 bis 200K Input und $4/$18 darüber, 2.5 Pro $1,25/$10, Grounding 5.000
Suchanfragen pro Monat frei über die gesamte 3.x-Familie, danach $14 pro
1.000. Flash-Modelle haben **keine** 200K-Stufe, die gibt es nur bei Pro.

Der Nachfolgepreis von 3.7 Flash ab 01.01.2027 bleibt `"provisional": true` —
die Preisseite nennt nur das Ende des Einführungspreises. Gestützt wird der
Wert jetzt dadurch, dass 3.6 Flash nach Ablauf seines Einführungspreises
genau bei $1,50/$7,50 liegt, also der Verdopplung aus Spec §11.

`test/pricing.test.ts` friert jeden dieser Sätze als Zusicherung ein.

**Nicht modelliert:** Audio-Input hat bei mehreren Modellen einen eigenen,
höheren Satz. Dieses System schickt ausschließlich Text.

**3. Node-Untergrenze auf 22.18 angehoben** (siehe oben).

**4. Das Schema-Keyword-Problem war größer als erwartet.**
Gemini akzeptiert bei `responseJsonSchema` nur eine Teilmenge von JSON Schema:
`$id $defs $ref $anchor type format title description enum items prefixItems
minItems maxItems minimum maximum anyOf oneOf properties additionalProperties
required`. `pattern`, `minLength`, `const`, `default`, `allOf` und `$schema`
fehlen. `src/llm/providers/gemini-schema.ts` übersetzt deshalb und entfernt
alles Unbekannte, statt es durchzureichen (ein unbekanntes Keyword kann den
Request mit 400 abweisen). Zusätzlich werden Typ-Unionen (`["string","null"]`)
zu `anyOf` umgeschrieben — der Payload-Vertrag (§5) besteht fast nur aus
nullable Feldern, und ob Gemini Typ-Arrays akzeptiert, ist nicht dokumentiert.

Das macht die Doppelvalidierung aus §11 zur Pflicht statt zur Vorsicht:
`minLength` kann Gemini nicht erzwingen, ajv schon. `schemas/smoke.json`
enthält genau deshalb ein `minLength`, und `test/adapter-contract.test.ts`
prüft, dass ajv es abfängt.

---

## Entscheidungen

**`node --test` statt Jest/Vitest.** Kein Framework, kein Transpiler, keine
Konfiguration. 62 Tests laufen in ~0,3 s.

**`better-sqlite3`, nicht `node:sqlite`.** Das eingebaute `node:sqlite` wäre
abhängigkeitsfrei, existiert aber erst ab Node 22.5 und ist als experimentell
markiert. Für einen Dienst, der später dauerhaft Crons fährt, ist die stabile
Bibliothek die ruhigere Wahl. Ein Prebuild war vorhanden, kein Compiler nötig.

**Ein Mock-Adapter ab Phase 1.** `src/llm/providers/mock-generate.ts` läuft
durch denselben Validierungs- und Preispfad wie der echte Adapter. Damit
testet Phase 2 die Extraktionslogik gegen Fixtures, ohne Tokens zu verbrennen
und ohne Netz.

**Fehlender Preis ist ein Startfehler.** Die Spec verlangt einen Startfehler
bei unbekanntem Anbieter. Dieselbe Behandlung gilt hier für ein Modell ohne
Eintrag in `pricing.json`: sonst wäre `costUsd` still 0 und das Tagesbudget
aus §16 wirkungslos.

**Rohausgaben als JSONL, nicht als Tabelle.** §11 verlangt, `raw` immer
mitzuschreiben. `data/llm-log/YYYY-MM-DD.jsonl` ist Wegwerfmaterial; die
abrechnungsrelevanten Zahlen gehen nach `listing_event`. Abschaltbar über
`LLM_LOG=0`.

## Phase 2 — Entscheidungen

**`url` setzt der Dienst, nicht das Modell.** Der Client kennt die URL sicher;
das Modell müsste sie aus dem Seitentext raten. Das Schema verlangt sie
trotzdem als Feld (Vertragstreue zu §5), der Prompt sagt „immer null", und
`finalizePayload` trägt die echte ein.

**Fehlende `external_id` ist kein Fehler.** §5 nennt sie als Pflichtfeld, §4
sagt, dass manche Quellen keine haben. Auflösung: das Modell darf `null`
liefern — eine erfundene Objektnummer wäre der schlimmere Ausgang — und
`finalizePayload` bildet den Ersatzschlüssel aus der normalisierten URL
(`url:kranz-immobilien.de/angebote/3-zimmer-wedding`). Tracking-Parameter und
Slash am Ende fallen dabei weg, damit dieselbe Seite denselben Schlüssel
ergibt.

**Fehlender Anbietername stürzt nicht ab, sondern meldet sich.**
`ExtractResult.issues` trägt `no_provider_name`; ohne Namen gibt es keinen
Cache-Lookup und keinen Empfänger, das Inserat gehört nach T0 (§8 Flow B).

**`additionalProperties: false` überall.** Das ist der maschinelle Teil von
„keine erfundenen Felder": ein Feld, das nicht im Vertrag steht, lässt die
Validierung scheitern, statt still durchzurutschen.

**Erwartungen statt Soll-Payloads.** `fixtures/<name>.expected.json` hält nicht
den kompletten erwarteten Payload fest — der wäre nach jeder Prompt-Änderung
kaputt — sondern nur die Aussagen, die zählen. Die wichtigste Liste ist
`must_be_null`: die Felder, die *nicht* auf der Seite stehen. Dazu
`must_not_appear_anywhere` für Zahlen aus dem Abschnitt „Ähnliche Objekte",
der auf jedem Portal danebensteht und die häufigste Verwechslungsquelle ist.

**Die Erwartungsdateien werden selbst geprüft.**
`test/fixtures-satisfiable.test.ts` enthält je Fixture den von Hand gelesenen
Soll-Payload und stellt sicher, dass er die eigenen Zusicherungen erfüllt.
Sonst sähe ein Tippfehler in der Erwartung wie ein Modellfehler aus.

## Was der erste Lauf gegen echte Inserate gezeigt hat

Fünf Fixtures, davon zwei echte IS24-Seiten (Nachmietergesuche von privat),
`gemini-3.5-flash-lite`, ~$0,0017 und ~1,9 s pro Inserat. Echte Portalseiten
sind mit ~3.700 Input-Tokens etwa doppelt so groß wie meine gebauten.

Richtig erkannt wurden Objektnummern, Adressen, alle Preise, die Kaution, die
Portal-Kennzeichnung „von privat" und der Verzicht auf eine erfundene Straße,
wo die Seite nur den Ortsteil nennt.

**Ein Feld fiel systematisch aus: `provider.self_description`** — in allen
Privat- und Nachmieterfällen `null`. Ausgerechnet das Feld, das nach §7 die
Einordnung Makler/Verwaltung/Privat trägt.

Ursache war die Formulierung im Prompt: Ich hatte das Feld als Satz
beschrieben, in dem „der Anbieter beschreibt, wer er ist" — mit Beispielen im
Firmenton („wir verwalten dieses Objekt seit 2011"). Das Modell hat daraufhin
nur den Anbieterblock durchsucht. Tatsächlich steht der Satz bei Privatleuten
**im Titel oder im Beschreibungstext**: „Nachmieter für wunderschöne
2-Zimmer-Altbauwohnung in Berlin-Pankow gesucht".

Behoben durch eine Rollentabelle im Prompt (Verwaltung / Makler / Nachmieter /
Privat, je mit typischem Wortlaut) und den ausdrücklichen Hinweis, den ganzen
Text zu lesen. Lehre fürs Weitere: Ein Feld, dessen Beschreibung eine
*Fundstelle* impliziert, wird auch nur dort gesucht.

**Zusätzlich:** Ein Inserat schrieb „ab 01.09." ohne Jahr, das Modell gab
korrekt `null` zurück, statt zu raten — und damit ging der Wunschtermin
verloren, den `T_NACHMIETER` (§13) braucht. Der Input enthält jetzt das
heutige Datum, und der Prompt lässt das nächste Vorkommen einsetzen. Das ist
Kalenderrechnen mit einem genannten Datum, kein Raten.

**Bekannte Lücke:** Kein Fixture verlangt `self_description: null`. Ein Modell,
das dort immer etwas hineinschreibt, käme durch. Ein Inserat ganz ohne
Rollenaussage wäre dafür nötig — falls dir eines unterkommt, ist es wertvoll.

## Phase 3 — Entscheidungen

**Anrede wird nie geraten.** Persönlich angeredet wird nur, wenn „Frau" oder
„Herr" wörtlich im Inserat steht. Aus „Tobias" oder „Andrea Kranz" das
Geschlecht zu erschließen geht regelmäßig schief, und eine falsche Anrede
kostet mehr, als die persönliche einbringt. Sonst „Sehr geehrte Damen und
Herren".

**Nur Merkmale, die der Wohnung gehören.** Erst standen Aufzug, Keller und
Stellplatz mit auf der Liste — „die 3-Zimmer-Wohnung mit Fahrstuhl" liest
sich falsch, der Aufzug gehört zum Haus. Übrig bleiben Balkon, Terrasse,
Loggia, Garten, Einbauküche, Gäste-WC. Findet sich keines, bleibt der Satz
ohne Merkmal: kein Merkmal ist besser als ein schiefes.

**Der URL-Ersatzschlüssel darf nicht in den Betreff.** „Anfrage
url:kranz-immobilien.de/angebote/3-zimmer-wedding – …" wäre unbrauchbar.
Fehlt eine echte Objektnummer, entfällt sie ersatzlos, und die Adresse trägt
die Betreffzeile allein.

**Ein unaufgelöster Platzhalter ist ein Fehler, kein leerer String.** Ein
`{{beruf}}` mitten in einer Mail an eine Hausverwaltung wäre peinlich, ein
stillschweigend leerer Satz auch. Der Renderer wirft.

**Zwei Sperren statt stiller Fehler.** Solange `prompts/profil.md` auf
`beispiel` steht, ist jeder Draft als nicht sendebereit markiert. Verlangt
ein Inserat einen WBS und das Profil hat keinen, ebenso. Beides landet in
`Draft.blockers` und später in der UI.

### Zwei bewusste Abweichungen von §13

**Die Wortgrenze steht bei 230 statt 100.** Die 100-Wort-Fassung war die erste
Umsetzung und wurde als „zu nackt" verworfen. Maßstab ist jetzt eine
Bewerbungsmail, mit der Alexander in München tatsächlich eine Wohnung bekommen
hat — rund 200 Wörter. Der Zugewinn steckt in dem, was Vertrauen herstellt:
die aufgeschlüsselte Einkommensangabe statt einer behaupteten Summe, ein Link
auf ein echtes Profil, die Erklärung der auswärtigen Adresse. Nichts davon
passt in 100 Wörter. Die Grenze bleibt trotzdem hart, damit das Template nicht
unbemerkt ausufert.

**Der Zweitkontakt wiederholt alle Angaben.** §13 will die Selbstvorstellung
weglassen. Der Empfänger müsste dann aber in einer alten Mail nachsehen —
Aufwand, den man einem überlaufenen Postfach nicht zumutet. Geändert hat sich
nur der erste Satz, der den Vorkontakt benennt. Der Lookup auf `verwaltung_id`
in `listing_event` kommt in Phase 6; der Renderer nimmt den Vorkontakt als
Parameter und bleibt damit rein und testbar.

### Der Satz zur Münchner Adresse

Eine Berliner Bewerbung mit Münchner Absender wirft beim Empfänger eine Frage
auf. Besser, sie steht beantwortet in der Mail, als dass sie unbeantwortet im
Kopf bleibt. Der Satz steht als `hinweis_adresse` im Profil und ist frei
formulierbar; fehlt er, entfällt die Zeile ersatzlos.

## Phase 5 — Entscheidungen

**Kein Regex-Klassifikator.** §7 verbietet ihn ausdrücklich, und die
Begründung trägt: „Berger Immobilien GmbH" kann Makler oder Verwaltung sein,
und „Hausverwaltung Schmidt" bricht jede Token-Regel. In `classify.ts` stehen
deshalb nur Signale, die wirklich hart sind — ein Cache-Eintrag, eine
Portal-Kennzeichnung, eine namentliche Liste kommunaler Gesellschaften.
Alles Urteilhafte macht das Gate am Volltext.

**Harte Signale kennen zwei Stärken.** `decisive: true` beendet die
Klassifikation: ein `portal_only`-Eintrag, ein recherchierter `firm_type`,
eine Genossenschaft. `decisive: false` ist ein starkes Indiz, dem das Gate
widersprechen darf — aber nur mit `branch_confidence: high`. Beispiel: Das
Portal kennzeichnet „von privat", der Text sagt „Nachmieter gesucht". Beides
stimmt; der Zweig ist `T_NACHMIETER`, und das erkennt nur das Gate.

**Signale als Codes, nicht als Freitext.** §11 skizziert `signals: ["..."]`.
Ein kontrolliertes Vokabular (`prepayment_before_viewing`, `keys_by_mail`, …)
ist testbar und in der UI konsistent; die Prosa steht in `reasoning`.

**Zwei Signale sind allein schon `high`:** Vorkasse vor Besichtigung und
Schlüsselversand. Für beide gibt es keine harmlose Erklärung. Umgekehrt
mahnt der Prompt zur Vorsicht bei niedrigen Mieten — Altbestand mit
Sanierungsbedarf und WBS-Bindung drücken den Preis in Berlin legitim.

**Der Fallback ist T0.** Scheitert das Gate, gibt es keine Betrugsprüfung —
dann kein Versand, Text zum Kopieren, ich bewerbe mich selbst. Ein
entscheidendes hartes Signal bleibt gültig, aber `risk` steht auf `medium`
statt `low`: ohne Prüfung wird nichts als harmlos durchgewinkt.

**Das Behelfsstück in `scripts/pipeline.ts` ist weg.** Dort riet vorher eine
`guessBranch()` den Zweig aus harten Signalen. Jetzt läuft das echte Gate.

## Das Vorwärmen wird nicht betrieben

Gebaut, getestet — und nach dem ersten echten Places-Lauf bewusst stillgelegt.
§1 sagt: „Der Wettbewerbsvorteil ist nicht Geschwindigkeit … Der Vorteil ist
der Kanal." Das Vorwärmen kauft nur Geschwindigkeit (3 s statt 20 s bis zur
Mail), und die ist bei einer E-Mail nichts wert. Begründung im Detail in
`docs/vorwaermen.md`.

Der entscheidende Punkt: §17 vergibt Priorität 1 für „schon einmal in einem
echten Inserat aufgetaucht" — die Spec kennt das beste Signal also selbst.
Genau diese Firmen landen ohnehin im Cache, weil jede Recherche gespeichert
wird. **Der Cache wärmt sich selbst, mit besserer Auswahl als die Places-Liste.**

Was bleibt: `seed_company` als Warteschlange für *gescheiterte* Recherchen
(§8 Flow B, Schritt 4), und die 1.185 Berliner Firmen mit Website als
**Website-Index für Phase 12** — den Crawl der eigenen Angebotsseiten. §15
erlaubt das ausdrücklich („Keine Massen-Mails an den Index" verbietet Mails,
nicht das Crawlen).

## Phase 4 — Entscheidungen und Funde

### Grounding und JSON schließen sich aus — der teuerste Fund der Phase

Die Doku und mehrere Quellen behaupten, Gemini 3 könne strukturierte Ausgabe
mit der Google-Suche kombinieren. **Für `generateContent` stimmt das nicht.**
Gemessen am 2026-08-20 mit `npm run grounding:check`:

| Konfiguration | Suchanfragen | Chunks |
|---|---|---|
| `googleSearch` + `responseJsonSchema` | 0 | 0 |
| `googleSearch`, freier Text | **3** | **3** |
| `googleSearch` + JSON-Modus ohne Schema | 0 | 0 |

Nicht das strikte Schema ist das Problem, sondern **jede** JSON-Ausgabe. Und
es gibt keinen Fehler: das Werkzeug fällt still weg.

Was dabei herauskommt, ist schlimmer als ein Absturz. Drei Läufe gegen
dieselbe Firma lieferten **drei verschiedene E-Mail-Adressen** — jeweils nach
dem Muster `vorname.nachname@domain` erfunden — samt Belegprosa über Seiten,
die nie geöffnet wurden („Das Impressum von … bestätigt", „Auf der Teamseite
werden … aufgeführt"). Mit `confidence: "high"`.

**Konsequenz 1: der Adapter macht zwei Aufrufe.** Erst gegroundet in Prosa
recherchieren, dann ohne Werkzeuge in das Schema übertragen. Der
Strukturierungsschritt hat einen eigenen Systemprompt, der ihm ausdrücklich
verbietet, Lücken aus eigenem Wissen zu füllen — sonst wäre die Trennung
wertlos.

**Konsequenz 2: keine Werkzeugspur ist ein Fehlschlag.** Findet der Adapter
keine `groundingMetadata`, gibt er `ok: false` zurück, statt die
Erinnerungsantwort durchzureichen. Die Stufe leitet das nach T0 (§8 Flow B).
Abschaltbar über `requireGrounding: false`, aber nur für die Diagnose.

**Konsequenz 3: keine geratenen URL-Pfade.** Ein Zwischenstand hängte neun
vermutete Pfade an (`/team`, `/unternehmen/team`, `/ueber-uns` …), weil
`urlContext` nur URLs holt, die wörtlich im Prompt stehen. Das war eine
Sollbruchstelle: Ausgerechnet die kleinen Verwaltungen, für die es diesen
Cache gibt, haben `/wir.html` oder `/index.php?id=7`, und ein geratener Pfad
läuft still ins Leere. Übergeben wird jetzt nur die **bekannte** Adresse aus
dem Inserat; die Unterseiten findet das Modell über `site:`-Suchen — eine
Technik, die es in der Messung unaufgefordert selbst benutzt hat. Ist gar
keine Website bekannt, ist das Auffinden der Domain der erste Arbeitsschritt,
inklusive Rückfall auf Branchenverzeichnisse mit `confidence: "low"`.

**Konsequenz 4: die Recherche bekommt mehr Zeit, als §8 vorsieht** — 90 s
statt 20 s, die Personenrecherche 180 s. Der Portal-Wettlauf rechtfertigt
Eile beim *Senden*, nicht beim Recherchieren: `research_firma` läuft einmal
pro Firma, das Ergebnis liegt danach dauerhaft im Cache, und eine fehlende
Adresse kostet den ganzen Direktkanal. Für Flow C argumentiert §8 selbst so
(„Budget in Minuten, nicht Sekunden"). Überschreibbar per
`STAGE_TIMEOUT_RESEARCH_FIRMA` in `.env`. Mehr Zeit allein hilft allerdings
nicht — der Prompt muss Gründlichkeit auch einfordern, deshalb der Abschnitt
„Gründlichkeit" in `prompts/research_firma.md`.

**Konsequenz 5 für Phase 10:** Die Personenrecherche steht vor demselben
Problem, mit höherem Einsatz. Ein erfundener „Anknüpfungspunkt" in einer Mail
an eine Privatperson ist der peinlichste denkbare Ausgang. Die Hook-Eval muss
mitprüfen, ob überhaupt gesucht wurde — nicht nur, ob die Antwort plausibel
klingt.

**Der Places-Lauf ist gratis, nicht zweistellig.** §17 rechnet mit einem
„zweistelligen" Betrag. Text Search hat ein monatliches Freikontingent
(1.000 bzw. 5.000 Anfragen je SKU); die 36 Anfragen aus
`config/places-queries.json` bleiben weit darunter.

**Text Search liefert höchstens 60 Treffer je Anfrage.** Deshalb wird nach
Bezirk und Suchbegriff aufgeteilt, statt einmal „Hausverwaltung Berlin" zu
fragen. Reicht die Ausbeute nicht, lassen sich in
`config/places-queries.json` Ortsteile oder PLZ ergänzen — dedupliziert wird
ohnehin über `name_canonical`.

**Batch-Export und Import laufen als CLI, nicht als HTTP-Endpoint.** §14
nennt für Phase 4 einen „Import-Endpoint", die fünfte harte Abhängigkeit sagt
aber: „Phasen 1–5 laufen über Fixtures und CLI. Der HTTP-Service kommt erst in
Phase 6." Die Logik liegt deshalb in `src/lib/prewarm-import.ts` und
`src/db/seed.ts`; Phase 6 hängt `GET /prewarm/batch` und
`POST /prewarm/import` davor, ohne dass sich etwas ändern muss.

**Ein zweiter Recherche-Versuch kostet trotzdem.** Schlägt der erste fehl und
greift der Adressversuch (§8 Flow B, Schritt 2), werden beide Aufrufe zu einem
`LlmResult` zusammengeführt — sonst unterschlüge die Tagesabrechnung (§16) den
ersten.

**Schema v2**: `prewarm_quarantine` kam dazu. §6 kennt die Tabelle nicht, §17
verlangt sie („Quarantänezeilen erscheinen in der Firmen-Ansicht zur
Sichtprüfung").

## Offene Punkte für spätere Phasen

- **Grounding-Freikontingent.** `priceCall` rechnet Suchanfragen konservativ
  immer ab. Die 5.000 freien Prompts pro Monat brauchen einen Zähler in der
  DB — gehört zu Phase 4, wenn der `research`-Adapter kommt.
- **Cache-Treffer-Preis.** Gecachte Input-Tokens werden derzeit zum vollen
  Input-Satz abgerechnet. Die Schätzung liegt damit zu hoch statt zu niedrig.
- **Thinking-Tokens.** Werden als `candidatesTokenCount + thoughtsTokenCount`
  abgerechnet, weil Gemini beide getrennt meldet. Der Adapter prüft das jetzt
  selbst gegen `totalTokenCount` und warnt einmal pro Prozess, wenn die Summen
  nicht aufgehen. Ein Aufruf mit tatsächlichen thinking-Tokens (also gegen
  3.7 Flash oder 3.1 Pro, nicht Flash-Lite) steht noch aus.

## Hinweis zur lokalen npm-Installation

`npm install` scheiterte auf diesem Rechner mit `EPERM` auf
`/Users/almi/.npm/_cacache` — der npm-Cache gehört root (bekannter Fehler
älterer npm-Versionen). Umgangen über ein `.npmrc` mit projektlokalem Cache
(`.npm-cache/`, beides gitignored). Dauerhaft behebt es:

```bash
sudo chown -R 501:20 "$HOME/.npm"
```

Danach kann `.npmrc` weg. Ebenfalls offen: `git init` ließ sich aus meiner
Sandbox nicht ausführen, das Verzeichnis ist noch kein Repository.
