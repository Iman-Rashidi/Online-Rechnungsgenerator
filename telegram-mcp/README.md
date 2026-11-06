# Rechnio: Telegram- und Notion-Integration

**Sprache der Bot-Nachrichten und Dokumentation: Deutsch.** Der Dienst verwendet die vorhandene Rechnio-Webseite `index.html` in Chromium zur PDF-Erstellung. Bestehende Berechnungen und Vorlagen (Classic, Modern und Compact) bleiben erhalten. Vier Farbwelten stehen zur Auswahl: Ozeanblau, Waldgrün, Violett und Schiefergrau. Ein hochgeladenes Firmenlogo ersetzt die Rechnio-Wortmarke im Rechnungsbriefkopf und wird vor dem PDF-Export vollständig geladen.

## Telegram-Befehle

- `/start` oder `/help`: Deutsche Hilfe anzeigen.
- `/invoice {JSON}`: PDF erstellen, an Telegram senden und den Datensatz in Notion anlegen oder aktualisieren.
- `/paid RE-2026-001`: Rechnung als bezahlt markieren.
- `/sent RE-2026-001`: Rechnung als versendet markieren.
- `/overdue RE-2026-001`: Rechnung als überfällig markieren.
- `/cancelled RE-2026-001`: Rechnung stornieren.

## Beispiel für eine Testrechnung

Nur Beispieldaten verwenden. Dies ist keine echte Rechnung und begründet keine Zahlungspflicht.

```json
/invoice {
  "seller": "Musterfirma GmbH",
  "email": "rechnung@example.invalid",
  "sellerAddress": "Musterstraße 1, 50667 Köln",
  "customer": "Beispielkunde GmbH",
  "customerEmail": "kunde@example.invalid",
  "customerAddress": "Kundenweg 2, 50668 Köln",
  "number": "RE-2026-TEST-001",
  "date": "2026-11-06",
  "due": "2026-11-20",
  "taxRate": "19",
  "template": "modern",
  "colorTheme": "ocean",
  "documentType": "invoice",
  "items": [
    { "description": "Webdesign", "quantity": 2, "unitPrice": 80 }
  ],
  "paymentTerms": "Bitte innerhalb von 14 Tagen überweisen.",
  "note": "Testrechnung – nicht bezahlen."
}
```

## Mahnungen

Für eine Mahnung `"documentType":"mahnung"` verwenden, eine eigene Dokumentnummer vergeben und die Nummer der Originalrechnung in `"originalInvoice"` eintragen. Die ursprünglichen Rechnungspositionen angeben. Existiert die Originalrechnung in Notion, übernimmt der Dienst den gespeicherten Steuersatz und aktualisiert Status sowie Mahnstufe der Originalrechnung. Die Mahnung wird als eigener Datensatz gespeichert.

## Notion-Datenbank

Der Dienst verwendet die Notion Data-Source-ID und folgende Eigenschaften. Das optionale JSON-Feld `colorTheme` akzeptiert `ocean`, `forest`, `violet` oder `charcoal`; Standard ist `ocean`.

- `Invoice` (Titel), `Invoice number` (Rich Text), `Original invoice number` (Rich Text), `Document type` (Select)
- `Customer` (Rich Text), `Customer email` (E-Mail), `Invoice date` / `Due date` (Datum)
- `Net amount`, `Tax rate %`, `Gross amount` (Zahl)
- `Status` (Draft / Sent / Paid / Overdue / Cancelled)
- `Mahnung level` (None / Reminder / First Mahnung / Second Mahnung / Final Mahnung), `Notes` (Rich Text)

Das PDF wird direkt über Telegram zugestellt und nicht öffentlich gehostet. Deshalb bleibt `PDF URL` leer.

## Erforderliche Umgebungsvariablen

- `TELEGRAM_BOT_TOKEN`: Telegram-Bot-Token.
- `TELEGRAM_WEBHOOK_SECRET`: Geheimnis zur Prüfung der Telegram-Webhooks.
- `ALLOWED_TELEGRAM_USER_IDS`: erlaubte numerische Telegram-Benutzer-IDs, durch Kommas getrennt.
- `MCP_ACCESS_TOKEN`: zufälliges Geheimnis mit mindestens 32 Zeichen.
- `PUBLIC_BASE_URL`: öffentliche HTTPS-Adresse des Dienstes.
- `NOTION_API_KEY`: Notion-Integrationsschlüssel.
- `NOTION_DATA_SOURCE_ID`: ID der Rechnio-Datenquelle in Notion.
- Optional: `PORT` (Standard 3000), `STATE_FILE` (Standard `./data/telegram-updates.json`).

Die Notion-Datenbank muss für die Integration freigegeben sein. Zugangsdaten ausschließlich im Secret Manager des Hosting-Anbieters speichern. Niemals Tokens in Git, Issues, Screenshots oder Chats veröffentlichen.

## Telegram-Bot ohne eigenen Server (GitHub Actions)

Der Bot kann alternativ ohne dauerhaft laufenden Node.js-Host betrieben werden. GitHub Actions fragt Telegram alle fünf Minuten ab, erstellt PDFs mit Chromium, sendet sie an den freigegebenen privaten Telegram-Chat und aktualisiert Notion. GitHub kann geplante Läufe bei hoher Auslastung verzögern; dies ist daher kein Echtzeit-Webhook.

### Einmalige Einrichtung durch den Repository-Eigentümer oder eine erziehungsberechtigte Person

In den Repository-Einstellungen unter **Settings → Secrets and variables → Actions** folgende Werte hinzufügen:

**Repository secrets**
- `TELEGRAM_BOT_TOKEN`: Token des Telegram-Bots.
- `TELEGRAM_ALLOWED_USER_IDS`: numerische Telegram-Benutzer-ID(s), bei mehreren kommasepariert.
- `NOTION_API_KEY`: Notion-Integrationsschlüssel.

**Repository variable**
- `NOTION_DATA_SOURCE_ID`: `b2685397-3058-4bde-b9ef-4e51c8d63aa2`.

Die Notion-Integration muss ausdrücklich Zugriff auf die Rechnio-Datenquelle erhalten. Tokens gehören ausschließlich in GitHub Secrets, niemals in Chat, Quellcode oder Screenshots.

Danach die Repository-Variable `RECHNIO_TELEGRAM_POLLING_ENABLED` auf `true` setzen. Der Workflow **Rechnio Telegram bot polling** läuft dann automatisch alle fünf Minuten. Ein manueller Test ist über **Actions → Rechnio Telegram bot polling → Run workflow** möglich.

Der Workflow ist standardmäßig deaktiviert, bis diese Variable auf `true` gesetzt wird. Dadurch entstehen keine fehlgeschlagenen Läufe, solange die Secrets noch nicht eingetragen sind. Der GitHub Actions Cache speichert ausschließlich die numerische Telegram-Update-ID; keine Zugangsdaten oder Rechnungs-PDFs werden dort abgelegt.

## Bereitstellung

Benötigt werden Node.js 20+, Chromium-Unterstützung, HTTPS und ein dauerhaftes Dateisystem für `STATE_FILE`. Anschließend `npm install` und `npm start` ausführen. Der Health-Check ist unter `GET /health` erreichbar.

Nach der Bereitstellung den Webhook einmalig über einen authentifizierten POST-Aufruf an `/admin/set-webhook` aktivieren. Der Header lautet `Authorization: Bearer <MCP_ACCESS_TOKEN>`.

## Tests

`npm test` prüft Eingabevalidierung, simulierte Notion-Aufrufe, Rechnungsstatus, Mahnstufen und die PDF-Erstellung mit Playwright anhand der bestehenden Rechnio-Seite. GitHub Actions führt die Tests aus und stellt PDF-Testdateien als Artefakte bereit.

## Produktionsstatus

Der GitHub-Actions-Polling-Modus benötigt keinen dauerhaft laufenden Node.js-Host. Er bleibt deaktiviert, bis der Repository-Eigentümer die erforderlichen GitHub Secrets und Variablen hinterlegt und `RECHNIO_TELEGRAM_POLLING_ENABLED=true` setzt. Erst danach kann ein echter Telegram-zu-PDF-zu-Notion-End-to-End-Test stattfinden. Der alternative Webhook-Modus in `src/server.js` benötigt weiterhin einen Node.js-Host mit Chromium und dauerhaftem Speicher.
