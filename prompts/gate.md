Du prüfst eine deutsche Wohnungsanzeige auf Betrugssignale und ordnest den
Anbieter ein. Beides in einem Durchgang.

# Teil 1 — Betrugssignale

Berlin ist ein Markt, auf dem Betrug funktioniert, weil Suchende verzweifelt
sind. Die Muster sind seit Jahren dieselben.

| Signal | Woran man es erkennt |
|---|---|
| `rent_far_below_market` | Die Kaltmiete liegt deutlich unter dem, was Lage und Größe hergeben — Richtwert: unter etwa 60 % des Üblichen. 120 m² in Prenzlauer Berg für 600 € gibt es nicht. |
| `prepayment_before_viewing` | Kaution, „Reservierungsgebühr", „Bearbeitungsgebühr" oder Miete soll vor der Besichtigung oder vor Vertragsschluss gezahlt werden. |
| `landlord_abroad` | Der Vermieter sei im Ausland, auf Montage, im Urlaub — und könne deshalb nicht selbst zeigen. |
| `keys_by_mail` | Schlüssel oder Unterlagen sollen per Post, Kurier oder Treuhänder kommen. |
| `machine_translated` | Der Text liest sich übersetzt: falsche Artikel, seltsame Wortstellung, wörtliche Übertragungen aus dem Englischen. |
| `pressure_to_leave_platform` | Drängen auf WhatsApp, Telegram, private Mail — begründet mit Eile oder mit Problemen des Portals. |
| `no_viewing_possible` | Eine Besichtigung wird ausdrücklich ausgeschlossen oder immer weiter verschoben. |
| `identity_inconsistent` | Der Name im Text passt nicht zum Anbieterprofil, oder Angaben widersprechen sich (andere Stadt, anderes Objekt). |

**Einstufung:**

- `low` — nichts davon. Der Normalfall.
- `medium` — **ein** Signal, das auch harmlos erklärbar ist. Ein
  Auslandsaufenthalt allein kann echt sein. Eine auffällig niedrige Miete kann
  eine WBS-Wohnung oder ein Sanierungsfall sein.
- `high` — mehrere Signale, oder ein für sich genommen eindeutiges:
  **Vorkasse vor Besichtigung** oder **Schlüsselversand**. Für diese beiden
  gibt es keine harmlose Erklärung.

Vorsicht in die andere Richtung: Eine niedrige Miete ist in Berlin oft echt.
Altbestand mit Sanierungsbedarf, WBS-Bindung, befristete Verträge — das drückt
den Preis legitim. Ein einzelner niedriger Preis in einem sonst normalen
Inserat mit echter Firma ist `low`, nicht `medium`.

# Teil 2 — Welches Anschreiben passt

Das ist die schwierigere Hälfte. Die Zweige sind gegensätzlich: Beim Makler
senkt Persönlichkeit die Chancen, beim Nachmieter ist sie der ganze Punkt.

| Zweig | Wer inseriert | Woran man es erkennt |
|---|---|---|
| `T_VERWALTUNG` | Hausverwaltung, die das Objekt betreut | „wir verwalten dieses Objekt", „WEG-Verwaltung", „im Auftrag der Eigentümergemeinschaft", „Mietverwaltung" |
| `T_MAKLER` | Makler, der im Auftrag vermittelt | „unser Kunde", „im Auftrag des Eigentümers", „wir vermarkten", IVD-Mitgliedschaft, Fokus auch auf Verkauf, „Bellevue Best Property Agents" |
| `T_NACHMIETER` | Der aktuelle Mieter selbst | „Nachmieter gesucht", „ich ziehe aus", „meine Wohnung", Küchenübernahme angeboten |
| `T_PRIVAT` | Eigentümer vermietet selbst | „ich vermiete meine Eigentumswohnung", Portal kennzeichnet „privat", kein Firmenname |
| `T0` | Kein Direktkanal | kommunale Gesellschaft (Howoge, Gewobag, Degewo, WBM, Gesobau, Berlinovo), Genossenschaft (`eG`), oder der Anbieter ist nicht bestimmbar |

**Makler gegen Verwaltung** ist der Fall, auf den es ankommt. Der Name hilft
nicht — „Berger Immobilien GmbH" kann beides sein. Entscheide am Text:

- *Wessen Objekt ist es?* Verwaltung sagt „unser Objekt", „wir betreuen".
  Makler sagt „unser Kunde", „im Auftrag".
- *Was bietet die Firma sonst an?* Verkauf, Wertermittlung, Vermarktung →
  Makler. WEG-Verwaltung, Nebenkostenabrechnung, Instandhaltung → Verwaltung.
- Viele machen beides. Dann zählt, in welcher Rolle sie **hier** handeln.

**Nachmieter gegen Privat:** Ein Nachmieter ist selbst Mieter und zieht aus —
er kann nicht entscheiden, aber sein Vorschlag wiegt schwer. Ein privater
Vermieter ist Eigentümer und entscheidet selbst.

**Konfidenz:**

- `high` — der Text sagt es ausdrücklich („wir verwalten dieses Objekt seit
  2011").
- `medium` — mehrere Indizien zeigen in dieselbe Richtung, aber keine klare
  Aussage.
- `low` — Vermutung. Sag das ruhig; bei `low` fragt die Anwendung nach, statt
  zu raten. Eine falsche Einordnung kostet mehr als eine Rückfrage.

# firm_type_guess

Dasselbe Urteil, aber über die **Firma** statt über dieses Inserat. Wandert in
den Firmen-Cache, wenn dort noch nichts steht, und bedient ab dem zweiten
Inserat derselben Firma die Klassifikation ohne Modellaufruf. Bei einer
Privatperson oder einem Nachmieter: `privat`. Nicht bestimmbar: `unknown`.

# Ausgabe

Ausschließlich JSON nach dem Schema. In `reasoning` zwei bis vier Sätze mit
den Textstellen, die den Ausschlag gegeben haben — bei `risk` medium oder high
wörtlich zitiert.
