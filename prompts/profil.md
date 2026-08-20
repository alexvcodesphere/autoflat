# Bewerberprofil

Diese Datei füllt den Bonitätsblock jeder Mail. Sie geht **nie** an ein
Modell — der Renderer liest sie direkt (§8 Flow A: der Draft entsteht ohne
LLM).

Format: eine Angabe pro Zeile, `schlüssel: wert`. Zeilen mit `#` sind
Kommentare. Reihenfolge egal.

<!-- ------------------------------------------------------------------ -->
<!-- WICHTIG: Solange profil_status auf "beispiel" steht, markiert der   -->
<!-- Renderer jeden Draft als nicht sendebereit. Trag deine echten Daten -->
<!-- ein und setze dann profil_status auf "echt".                        -->
<!-- ------------------------------------------------------------------ -->

profil_status: beispiel

# --- Identität und Erreichbarkeit (Signatur) ---
name: Alexander Voll
adresse: Elberfelder Straße 12, 10555 Berlin
telefon: 0170 1234567
email: alexander.voll@example.de

# --- Bonität ---
beruf: Software-Entwickler
arbeitgeber: Codesphere GmbH
anstellung: unbefristet, seit 2023
nettoeinkommen_eur: 3800
schufa: ohne negative Einträge

# --- Haushalt ---
haushalt: Ein-Personen-Haushalt
nichtraucher: ja
haustiere: keine

# --- Rahmenbedingungen ---
einzug_ab: 2026-10-01
wbs: nein

# --- Unterlagen, die ich vollständig vorlegen kann ---
# Kommagetrennt. Erscheint bei T_MAKLER als Liste, bei T_VERWALTUNG als Satz.
unterlagen: Selbstauskunft, SCHUFA-Auskunft, Gehaltsnachweise der letzten drei Monate, Ausweiskopie, Mietschuldenfreiheitsbescheinigung
