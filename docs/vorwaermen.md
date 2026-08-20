# Vorwärmen — GESTOPPT, und warum

> **Stand 2026-08-20: Der nächtliche Cowork-Batch wird nicht gefahren.**
>
> §1 der Spec sagt im ersten Absatz: „Der Wettbewerbsvorteil ist **nicht
> Geschwindigkeit** … Der Vorteil ist der **Kanal**." Das Vorwärmen kauft
> ausschließlich Geschwindigkeit — 3 Sekunden statt 20 bis zur fertigen Mail.
> Bei einer E-Mail, die in einem Postfach landet, ist dieser Unterschied
> nichts wert.
>
> Drei Gründe, jeder allein ausreichend:
>
> 1. **Der Cache wärmt sich selbst, und zwar besser.** §17 vergibt Priorität 1
>    für „schon einmal in einem echten Inserat aufgetaucht" — die Spec weiß
>    also, dass das das beste Signal ist. Genau diese Firmen landen ohnehin im
>    Cache, weil jede Recherche gespeichert wird. Priorität 2–4 sind Vermutungen
>    darüber, wer irgendwann inseriert.
> 2. **Es erhöht die Abdeckung nicht.** Vorwärmen benutzt dieselbe
>    Recherche-Operation. Scheitert sie bei Bedarf, wäre sie beim Vorwärmen
>    genauso gescheitert.
> 3. **Der Aufwand ist real.** Gemessen: 1.185 Firmen, 17 bis 68 Abende
>    Handarbeit. Dagegen kostet eine Recherche bei Bedarf ~$0,01 und 11
>    Sekunden.
>
> **Was bleibt:** `seed_company` als Warteschlange für *gescheiterte*
> Recherchen (§8 Flow B, Schritt 4) und die Places-Liste als Website-Index
> für die eigene Inseratssuche (Phase 12) — nicht als Vorwärm-Warteschlange.
>
> Der Code darunter ist gebaut und getestet. Sollte sich die Recherche bei
> Bedarf als unzuverlässig erweisen, ist der Batch-Betrieb in zehn Minuten
> wieder aktiv. Der Rest dieses Dokuments beschreibt ihn.

---

## Das Problem in einem Absatz

Der teuerste Vorgang im System ist einer: aus einem **Firmennamen** die
verifizierte **Vermietungs-Mailadresse** machen. Googeln, Website finden,
Impressum lesen, zwischen `info@`, `buchhaltung@` und `vermietung@`
entscheiden. Das dauert 20–40 Sekunden.

Und es liefert für dieselbe Firma **immer dasselbe Ergebnis**. Also: einmal
machen, in `verwaltung` speichern, nie wieder machen. Das ist der
Firmen-Cache (§3).

| Schritt | Dauer | pro Inserat neu? |
|---|---|---|
| Mail formulieren | ~1 s | ja, aber billig |
| Firmenname → Adresse | 20–40 s | **nein — nur beim ersten Mal** |

Der Witz: Der Cache lässt sich **ohne Inserate** vorwärmen. Der Input ist nur
ein Firmenname. Berlin hat vielleicht 300 regelmäßig inserierende
Verwaltungen — nach zwei Wochen ist der Treffer der Normalfall.

## Die vier Begriffe

**Research** — der Lookup live, für *eine* Firma, über Gemini mit
Google-Suche. Läuft, wenn ein Inserat von einer Firma kommt, die noch nicht
im Cache steht (§8 Flow B, 25 s Budget).

**Places-Seeding** — die *Namensliste* beschaffen, ohne auf Inserate zu
warten. `scripts/seed-places.ts` fragt die Google Places API nach
„Hausverwaltung Mitte, Berlin" und so weiter. Ergebnis: einige hundert Namen
mit Adresse und Website, als To-do-Liste in `seed_company`.

**Prewarm** — diese Liste abarbeiten, aber über **Claude Cowork** statt über
die API. Cowork läuft über das Abo, die API kostet pro Aufruf. Bei 300 Firmen
ist das der Unterschied.

**Kalenderzeit** — kein Arbeitsschritt, sondern der Grund für die Eile. Pro
Cowork-Sitzung gehen nur 12–15 Firmen: 30 wären ~150 Web-Operationen, das
sprengt den Kontext und die Qualität fällt gegen Ende sichtbar ab. 250 Firmen
mit Priorität 1–2 sind also ~18 Abende. Spät angefangen ist der Cache leer,
wenn du ihn brauchst.

## Warum ein warmer Cache den Unterschied macht

Wenn ein gutes Inserat aufpoppt, hast du Minuten.

- **Cache-Treffer:** 2 Modellaufrufe, ~3 Sekunden, Mail und Empfänger stehen.
- **Cache-Miss:** 20 Sekunden Recherche, und vielleicht kommt nichts
  Belastbares heraus — dann bleibt nur das Portalformular, wo du Platz 200
  bist.

## Die Schleife, konkret

### Einmalig: Liste beschaffen

```bash
npm run seed:places -- --dry-run   # zeigt Trefferzahl und Priorisierung
npm run seed:places                # schreibt in seed_company
```

Braucht `GOOGLE_PLACES_API_KEY` in `.env` (Google Cloud Console, „Places API
(New)" aktivieren). Der Lauf bleibt im monatlichen Freikontingent.

**Ohne Google-Key zum Ausprobieren:**

```bash
npm run seed:places -- --demo      # 6 erfundene Firmen
```

### Dann jeden Abend, ~5 Minuten

```bash
npm run prewarm:batch              # 15 Firmen nach Priorität
```

Den ausgegebenen Block in `docs/cowork-prewarm-prompt.md` an der markierten
Stelle einsetzen, das Ganze in Cowork einfügen, laufen lassen. Antwort als
`ergebnis.json` speichern.

```bash
npm run prewarm:import -- ergebnis.json
```

Ausgabe zum Beispiel: `12 übernommen, 2 in Quarantäne, 1 fehlt`. Die
Quarantänezeilen sind die, bei denen etwas nicht stimmte — Adresse passt
nicht zur Domain, E-Mail bei `confidence: none`, Firma war gar nicht
angefordert. Die fehlende kommt automatisch in den nächsten Batch.

```bash
npm run prewarm:batch -- --stats   # wie weit bin ich?
npm run prewarm:import -- --quarantine
```

## Priorisierung: warum nicht alle 1.500

Places liefert überwiegend Zwei-Mann-Verwaltungen mit zwei Vermietungen im
Jahr. Alle vorzuwärmen wären ~80 Abende.

| Priorität | Kriterium | Aufwand |
|---|---|---|
| 1 | schon einmal in einem echten Inserat aufgetaucht | sofort |
| 2 | Website vorhanden **und** überdurchschnittlich viele Bewertungen | ~zusammen |
| 3 | Website vorhanden, wenige Bewertungen | ~18 Abende |
| 4 | keine Website — liefert meist `confidence: none` | bleibt liegen |

Priorität 1 vergibt das Seeding nie selbst. Die bekommt eine Firma nur, wenn
sie in einem echten Inserat auftaucht — die inseriert nachweislich.
