# Wohnungsbot

Aus einer Wohnungsanzeige in Berlin wird eine sendefertige deutsche
Bewerbungsmail. Die maßgebliche Spec ist das Projektdokument; Verweise wie
„§11" beziehen sich darauf. Leg sie als `docs/spec.md` ab, damit sie
mitversioniert wird.

**Stand: Phase 1 abgeschlossen.** Die Bauphasen stehen in der Spec, §14.

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

## Offene Punkte für spätere Phasen

- **Grounding-Freikontingent.** `priceCall` rechnet Suchanfragen konservativ
  immer ab. Die 5.000 freien Prompts pro Monat brauchen einen Zähler in der
  DB — gehört zu Phase 4, wenn der `research`-Adapter kommt.
- **Cache-Treffer-Preis.** Gecachte Input-Tokens werden derzeit zum vollen
  Input-Satz abgerechnet. Die Schätzung liegt damit zu hoch statt zu niedrig.
- **Thinking-Tokens.** Werden als `candidatesTokenCount + thoughtsTokenCount`
  abgerechnet, weil Gemini beide getrennt meldet. Beim ersten echten Aufruf
  gegen `totalTokenCount` gegenprüfen.

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
