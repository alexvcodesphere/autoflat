# Fixtures — was das ist und wie du eine anlegst

## Was ist ein Fixture?

Eine **eingefrorene Kopie einer echten Inseratsseite**. Konkret: eine
JSON-Datei mit dem sichtbaren Text der Seite, so wie ihn der Browser anzeigt.

Wozu:

- **Testen ohne die Seite zu besuchen.** Ein Inserat ist nach drei Tagen weg.
  Ohne Kopie ist jeder Testlauf nicht wiederholbar.
- **Prompts vergleichbar ändern.** Wenn ich `prompts/extract.md` anfasse, muss
  ich sehen, ob es besser oder schlechter wird — bei *demselben* Eingabetext.
  Mit wechselnden Live-Seiten misst man nur Rauschen.
- **Kein Portal-Zugriff nötig.** Kein Bot-Schutz, kein Rate-Limit, keine
  IP-Sperre.

Die drei Dateien, die schon im Verzeichnis liegen, habe ich **selbst
geschrieben**. Sie sind realistisch gebaut, aber ausgedacht. Deshalb der
Wunsch nach echten: an einer erfundenen Seite lässt sich nicht beurteilen, wie
das Modell mit dem echten Navigationsmüll von ImmoScout zurechtkommt — und
genau das ist die Arbeit dieser Stufe.

## Wie du eine anlegst (ca. 30 Sekunden)

1. Inserat in Chrome öffnen.
2. DevTools öffnen: **Cmd + Alt + I**, dann Reiter **Console**.
3. Das hier einfügen und Enter drücken (`source` anpassen, siehe Tabelle):

```js
copy(JSON.stringify({
  capture_version: "v1",
  url: location.href,
  source: "is24",
  page_text: document.body.innerText,
  json_ld: [...document.querySelectorAll('script[type="application/ld+json"]')]
             .map(s => s.textContent)
}, null, 2))
```

4. Der Inhalt liegt jetzt in der Zwischenablage (`copy()` ist ein
   DevTools-Helfer). Neue Datei anlegen unter
   `fixtures/<quelle>-<kiez>.json`, einfügen, speichern.

Beim ersten Mal fragt Chrome eventuell nach; dann einmal `allow pasting`
eintippen und Enter.

### Werte für `source`

| Portal | `source` |
|---|---|
| ImmobilienScout24 | `is24` |
| Immowelt / Immonet | `immowelt` |
| Kleinanzeigen | `kleinanzeigen` |
| WG-Gesucht | `wg_gesucht` |
| Website einer Verwaltung | `website` |

### Namensvorschlag

`fixtures/is24-neukoelln.json`, `fixtures/kleinanzeigen-wedding.json` — Quelle,
Bindestrich, Kiez. Der Name taucht in der Testausgabe auf.

## Nützlich sind vor allem die unbequemen Fälle

Ein Inserat, in dem alles sauber dasteht, testet wenig. Wertvoll sind:

- eines **ohne Adresse** (nur „Neukölln") — prüft, ob das Modell eine Straße
  erfindet
- eines **ohne Objektnummer** — prüft den Ersatzschlüssel aus der URL
- eines von einem **Privatanbieter** — prüft `platform_private_flag`
- eines von einem **Makler** — der Unterschied zur Verwaltung ist die
  schwierigste Unterscheidung im ganzen System (§7)
- eine **eigene Website einer Hausverwaltung** — ganz anderes Seitenlayout

## Und dann?

```bash
npm run extract:fixtures
```

Läuft die Extraktion über alle Fixtures und zeigt pro Datei, wie viele
Zusicherungen erfüllt sind.

Eine Erwartungsdatei ist **optional**. Ohne sie läuft das Fixture trotzdem,
es wird nur nichts geprüft — nützlich, um erst mal zu sehen, was rauskommt:

```bash
npm run extract:fixtures -- --json meine-neue-datei
```

Willst du danach Zusicherungen festhalten, leg
`fixtures/<name>.expected.json` an. Format siehe die vorhandenen Dateien; die
wichtigste Liste ist `must_be_null` — die Felder, die **nicht** auf der Seite
stehen. Genau dort zeigt sich, ob das Modell etwas erfindet.
