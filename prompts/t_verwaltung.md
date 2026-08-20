{{salutation}},

{{#unless zweitkontakt}}
ich habe Ihre {{objekt}}{{ort}} entdeckt{{objektnummer_klammer}} und möchte mich hiermit sehr gerne darauf bewerben.
{{/unless}}
{{#if zweitkontakt}}
{{zweitkontakt_satz}} Nun habe ich Ihre {{objekt}}{{ort}} entdeckt{{objektnummer_klammer}} und möchte mich auch darauf sehr gerne bewerben.
{{/if}}

Kurz zu mir
- Name: {{name}}
- Beruf: {{beruf_zeile}}
- Einkommen: {{einkommen_zeile}}
- SCHUFA: {{schufa}}
- Status: {{status_zeile}}
- Einzug: ab {{einzug_ab}} möglich
{{#if hinweis_adresse}}
- Zur Adresse: {{hinweis_adresse}}
{{/if}}

{{#if hat_links}}
Einen persönlichen Eindruck finden Sie hier:
{{links_block}}

{{/if}}
Unterlagen
{{unterlagen_satz}}

Besichtigung
{{besichtigung}}

Kontakt
- E-Mail: {{email}}
- Telefon: {{telefon}}

Vielen Dank für Ihre Zeit. Über eine Rückmeldung freue ich mich.

Mit freundlichen Grüßen
{{name}}
