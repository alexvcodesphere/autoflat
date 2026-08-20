# Cowork-Aufgabe: Firmen-Cache vorwärmen

Diese Datei ist die Aufgabe, die in Claude Cowork eingefügt wird (§17). Sie
läuft über das Abo, nicht über die API — deshalb taucht sie im Kostenbudget
(§16) nicht auf.

## Ablauf

```bash
npm run prewarm:batch          # gibt 15 Firmen aus, markiert sie in_progress
```

Den ausgegebenen Block unten bei **Firmenliste** einsetzen, alles hier in
Cowork einfügen, laufen lassen. Das Ergebnis als `ergebnis.json` speichern:

```bash
npm run prewarm:import -- ergebnis.json
```

Nicht mehr als 15 Firmen pro Lauf: 30 wären ~150 Web-Operationen in einer
Sitzung, das sprengt den Kontext und die Qualität fällt gegen Ende sichtbar ab.

---

## Ab hier: der Prompt für Cowork

Du recherchierst für jede Firma in der Liste unten die E-Mail-Adresse, an die
eine **Mietanfrage** gehört. Alle Firmen sitzen in Berlin.

### Für jede Firma

1. Suche nach dem Firmennamen zusammen mit „Berlin" und dem Adresshinweis.
2. Öffne die Website und dort das **Impressum**. Dort stehen die belastbaren
   Angaben.
3. Sieh nach, ob es eine eigene Seite mit Mietangeboten gibt („Aktuelle
   Angebote", „Vermietung", „Objekte").
4. Bestimme, was die Firma ist: Verwaltung, Makler, Gesellschaft oder
   Genossenschaft.

### Die Identitätsfrage kommt zuerst

Firmennamen in dieser Branche ähneln sich stark. „Berger Immobilien GmbH" in
Berlin ist nicht dieselbe wie in Bergisch Gladbach, und „Hausverwaltung
Schmidt" gibt es dutzendfach.

Prüfe: Stimmt der Ort? Passt der Adresshinweis? Bist du unsicher, gib
`confidence: "none"` und schreib in `evidence`, woran es scheitert.
**Eine falsche Adresse ist schlechter als keine.**

### Welche Adresse die richtige ist

Nach absteigender Eignung:

1. `vermietung@`, `immobilien@`, `wohnen@`, `mieten@`
2. Die namentliche Adresse der für Vermietung zuständigen Person
3. `info@` oder `kontakt@` — die gehört nach `email_general`

**Niemals**: `buchhaltung@`, `hausgeld@`, `technik@`, `hausmeister@`,
`bewerbung@`, `presse@`, `datenschutz@`, `widerruf@`.

### Konfidenz

| Wert | Wann |
|---|---|
| `high` | Adresse stand als `mailto:`-Link im Impressum |
| `medium` | Adresse stand als Text auf der Seite, auch mit „(at)" umschrieben |
| `low` | Erschlossen, etwa aus dem Muster anderer Adressen derselben Domain |
| `none` | Nichts Belastbares gefunden, oder die Identität ist unklar |

Erfinde keine Adresse aus Firmenname plus Domain.

### firm_type

- **verwaltung** — „Hausverwaltung", „WEG-Verwaltung", „Mietverwaltung",
  „wir verwalten … Einheiten"
- **makler** — „Immobilienmakler", „Verkauf und Vermietung", „wir vermarkten",
  IVD-Mitgliedschaft, Fokus auf Kaufobjekte
- **gesellschaft** — kommunale Wohnungsbaugesellschaft
- **genossenschaft** — `eG`, „Mitgliedschaft", „Geschäftsanteile"
- **unknown** — nicht belegbar

Machen beide Seiten etwas: was die Website in den Vordergrund stellt.

### portal_only

Nur `true`, wenn die Website ausdrücklich sagt, dass Anfragen ausschließlich
über ein Portal oder Formular laufen. Ein Kontaktformular allein genügt nicht.

### Ausgabe

Ein einziges JSON-Array, ein Objekt pro Firma, **in der Reihenfolge der
Liste**. Keine Erklärungen davor oder danach.

`name_input` muss **wörtlich** der Name aus der Liste sein — daran wird die
Antwort der Anfrage zugeordnet. Schreib ihn nicht um und korrigiere ihn nicht.

```json
[
  {
    "name_input": "Meyer & Co. Hausverwaltung GmbH",
    "domain": "meyer-hausverwaltung.de",
    "impressum_url": "https://meyer-hausverwaltung.de/impressum",
    "vermietung_url": "https://meyer-hausverwaltung.de/angebote",
    "email_vermietung": "vermietung@meyer-hausverwaltung.de",
    "email_general": "info@meyer-hausverwaltung.de",
    "contact_persons": ["Frau S. Kruse"],
    "firm_type": "verwaltung",
    "portal_only": false,
    "confidence": "high",
    "evidence": "mailto-Link im Impressum; Adresse und Ort stimmen mit dem Hinweis überein."
  }
]
```

Findest du zu einer Firma nichts, gib sie trotzdem aus — mit `null` in allen
Feldern, `firm_type: "unknown"`, `confidence: "none"` und einer Begründung in
`evidence`. **Lass keine Zeile weg**, sonst wandert die Firma in den nächsten
Batch und wird doppelt recherchiert.

### Firmenliste

```
<<< HIER DEN BLOCK AUS `npm run prewarm:batch` EINFÜGEN >>>
```
