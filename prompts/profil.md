# Bewerberprofil

Füllt den Bonitätsblock jeder Mail. Geht **nie** an ein Modell — der Renderer
liest die Datei direkt (§8 Flow A: der Draft entsteht ohne LLM).

Format: eine Angabe pro Zeile, `schlüssel: wert`. Zeilen mit `#` sind
Kommentare. `link:` darf mehrfach vorkommen.

<!-- ------------------------------------------------------------------ -->
<!-- profil_status: echt  =>  Drafts sind sendebereit.                  -->
<!-- Zurück auf "beispiel" setzen, um den Versand generell zu sperren.   -->
<!-- Die Sätze hinweis_adresse und besichtigung sind von Claude          -->
<!-- formuliert, nicht von dir diktiert — einmal gegenlesen.             -->
<!-- ------------------------------------------------------------------ -->

profil_status: echt

# --- Identität und Erreichbarkeit ---
name: Alexander Voll
adresse: Johann-Clanze-Straße 28E, 81369 München
telefon: 0151 43813933
email: c.alex.voll@gmail.com

# --- Beruf ---
beruf: Technischer Produktmanager (Cloud- und Softwareinfrastruktur)
# Arbeitgeber ist optional. Leer lassen = wird nicht genannt (so wie in
# deiner Referenzmail).
arbeitgeber: Codesphere SE
anstellung: festangestellt, unbefristet, Vollzeit

# --- Einkommen ---
# Hauptverdienst und Nebenverdienst werden getrennt ausgewiesen und in der
# Mail zu einer Summe zusammengefasst.
nettoeinkommen_eur: 3500
nebeneinkommen_eur: 400
# Im Dativ — steht in der Mail hinter "aus".
nebeneinkommen_art: freiberuflicher Tätigkeit
schufa: ohne negative Einträge

# --- Haushalt ---
familienstand: ledig
haushalt: Ein-Personen-Haushalt
nichtraucher: ja
haustiere: keine

# --- Rahmenbedingungen ---
einzug_ab: 2026-10-01
wbs: nein

# --- Der Satz zur Münchner Adresse ---
# Eine Berliner Bewerbung mit Münchner Absender wirft eine Frage auf. Besser,
# sie steht beantwortet in der Mail, als dass sie unbeantwortet im Kopf des
# Empfängers bleibt.
hinweis_adresse: Nach einem beruflichen Zwischenspiel in München ziehe ich zurück nach Berlin, wo ich vorher schon gelebt habe. Der Wechsel steht fest.

# --- Besichtigung ---
besichtigung: Für eine Besichtigung komme ich jederzeit nach Berlin, auch kurzfristig und unter der Woche.

# --- Unterlagen ---
unterlagen: Gehaltsnachweise, SCHUFA-Auskunft, Mieterselbstauskunft

# --- Persönlicher Eindruck ---
# Format: link: Beschriftung | URL
# Das Kleinanzeigen-Gesuch unten sucht in München — für Berlin brauchst du
# ein neues, sonst ist der Link kontraproduktiv. Bis dahin auskommentiert.
link: LinkedIn | https://www.linkedin.com/in/alexander-voll-66a1a0184/
# link: Wohnungsgesuch | https://www.kleinanzeigen.de/s-anzeige/...
