# Rechnio: Telegram- und Notion-Integration

**Sprache der Bot-Nachrichten und Dokumentation: Deutsch.** Der Dienst verwendet die vorhandene Rechnio-Webseite `index.html` in Chromium zur PDF-Erstellung. Bestehende Berechnungen und Vorlagen (Classic, Modern und Compact) bleiben erhalten. Vier Farbwelten stehen zur Auswahl: Ozeanblau, Waldgrün, Violett und Schiefergrau. Das Firmenlogo kann derzeit in der Weboberfläche hochgeladen werden; der Telegram-Dialog bietet noch keine Logo-Übermittlung.

## Telegram-Befehle

- `/start` oder `/help`: Deutsche Hilfe anzeigen.
- `/invoice`: Eine Rechnung vollständig im Dialog erstellen. Der Bot fragt Absender, Kunde, Rechnungsdaten, jede Rechnungsposition, Umsatzsteuer, Layout und Farbe einzeln ab. Es sind keine technischen Kenntnisse und keine JSON-Eingaben nötig.
- `/cancel`: Eine laufende Rechnungserstellung abbrechen.
- Nach der Zusammenfassung mit `JA` bestätigen oder mit `NEIN` abbrechen. Danach erstellt der Bot das PDF und speichert den Datensatz in Notion.
- `/paid RE-2026-001`: Rechnung als bezahlt markieren.
- `/sent RE-2026-001`: Rechnung als versendet markieren.
- `/overdue RE-2026-001`: Rechnung als überfällig markieren.
- `/cancelled RE-2026-001`: Rechnung stornieren.

## Rechnung im Telegram-Dialog erstellen

1. Senden Sie `/invoice`.
2. Beantworten Sie die Fragen des Bots nacheinander. Jede Antwort kommt als normale Textnachricht.
3. Für jede Rechnungsposition geben Sie Beschreibung, Menge und Nettopreis an. Danach können Sie weitere Positionen hinzufügen.
4. Wählen Sie Umsatzsteuersatz, PDF-Layout und Farbe.
5. Prüfen Sie die Zusammenfassung und antworten Sie mit `JA`, um das PDF erstellen zu lassen, oder mit `NEIN`, um abzubrechen.
6. Mit `/cancel` können Sie den Vorgang jederzeit abbrechen.

Der Bot berechnet Netto, Umsatzsteuer und Brutto automatisch. Die Eingaben werden über die Polling-Läufe hinweg gespeichert, sodass Sie nicht alle Antworten innerhalb eines einzigen Bot-Laufs senden müssen. Der GitHub-Actions-Zeitplan kann Antworten um einige Minuten verzögern.

## Mahnungen

Die Notion-Integration unterstützt Mahnungsdatensätze und Mahnstufen technisch. Der aktuelle Telegram-Dialog enthält jedoch noch keinen Ablauf zum Erstellen einer Mahnung. Über Telegram können vorhandene Rechnungen mit `/overdue`, `/paid`, `/sent` und `/cancelled` verwaltet werden.

## Notion-Datenbank

Der Dienst verwendet die Notion Data-Source-ID und folgende Eigenschaften. Das optionale JSON-Feld `colorTheme` akzeptiert `ocean`, `forest`, `violet` oder `charcoal`; Standard ist `ocean`.

- `Invoice` (Titel), `Invoice number` (Rich Text), `Original invoice number` (Rich Text), `Document type` (Select)
- `Customer` (Rich Text), `Customer email` (E-Mail), `Invoice date` / `Due date` (Datum)
- `Net amount`, `Tax rate %`, `Gross amount` (Zahl)
- `Status` (Draft / Sent / Paid / Overdue / Cancelled)
- `Mahnung level` (None / Reminder / First Mahnung / Second Mahnung / Final Mahnung), `Notes` (Rich Text)

Das PDF wird direkt über Telegram zugestellt und nicht öffentlich gehostet. Deshalb bleibt `PDF URL` leer.

## Konfiguration und erforderliche Variablen

### Empfohlener Betrieb: GitHub-Actions-Polling

Für den hostfreien Polling-Modus werden ausschließlich diese drei Repository-Secrets benötigt:

**Pflicht-Secrets:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `NOTION_API_KEY`. Für einen zweiten Bot kommt optional `TELEGRAM_BOT_TOKEN1` hinzu.

Weitere Repository-Variablen sind nicht erforderlich. Die Notion Data-Source-ID ist bereits im GitHub-Actions-Workflow hinterlegt.

Die genauen Einrichtungsschritte stehen im Abschnitt „Telegram-Bot ohne eigenen Server (GitHub Actions)“. Die Notion-Integration muss ausdrücklich Zugriff auf die Rechnio-Datenquelle erhalten.

### Nur für den alternativen Node.js-Webhook-/MCP-Betrieb

Dieser eigenständig gehostete Modus in `src/server.js` verwendet zusätzlich `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM_USER_IDS`, `MCP_ACCESS_TOKEN` (mindestens 32 Zeichen), `PUBLIC_BASE_URL`, optional `PORT` (Standard 3000) und `STATE_FILE` (Standard `./data/telegram-updates.json`). Die Notion-Verbindung verwendet weiterhin `NOTION_API_KEY` und `NOTION_DATA_SOURCE_ID`.

Zugangsdaten ausschließlich in GitHub Secrets oder im Secret Manager des jeweiligen Hosting-Anbieters speichern. Niemals Tokens in Git, Issues, Screenshots oder Chats veröffentlichen.

## Telegram-Bot ohne eigenen Server (GitHub Actions)

Der Bot kann ohne dauerhaft laufenden Node.js-Host betrieben werden. GitHub Actions prüft Telegram ungefähr alle fünf Minuten, erstellt PDFs mit Chromium aus der bestehenden Rechnio-Seite, sendet sie an den freigegebenen privaten Telegram-Chat und aktualisiert Notion. Geplante GitHub-Läufe können bei hoher Auslastung verspätet starten; der Bot arbeitet daher nicht sekundengenau.

### Einmalige Einrichtung durch den Repository-Eigentümer oder eine erziehungsberechtigte Person

In den Repository-Einstellungen unter **Settings → Secrets and variables → Actions** müssen nur diese drei **Repository secrets** hinterlegt werden:

- `TELEGRAM_BOT_TOKEN`: Token des ersten Telegram-Bots.
- `TELEGRAM_BOT_TOKEN1`: optionaler Token des zweiten Telegram-Bots. Der Workflow fragt beide Bots nacheinander ab und speichert ihre Telegram-Update-IDs getrennt.
- `TELEGRAM_ALLOWED_USER_IDS`: numerische Telegram-Benutzer-ID(s), bei mehreren kommasepariert. Diese Freigabeliste gilt für beide Bots.
- `NOTION_API_KEY`: Notion-Integrationsschlüssel.

Die Notion-Integration muss ausdrücklich Zugriff auf die Rechnio-Datenquelle erhalten. Die Datenquellen-ID ist bereits im Workflow eingetragen. Zugangsdaten ausschließlich als GitHub Secrets speichern, niemals in Chat, Quellcode oder Screenshots veröffentlichen.

Sobald alle drei Secrets vorhanden sind, erkennt der Workflow dies automatisch und startet beim nächsten Zeitplan. Es ist keine zusätzliche Repository-Variable oder manuelle Aktivierung nötig. Ein manueller Test ist über **Actions → Rechnio Telegram bot polling → Run workflow** möglich. Solange Secrets fehlen, prüft GitHub nur deren Vorhandensein, zeigt ausschließlich die fehlenden Namen an und überspringt den Bot-Lauf. Secret-Werte werden niemals ausgegeben.

Der Workflow speichert die numerische Telegram-Update-ID jedes Bots in einer eigenen Datei im GitHub-Actions-Cache; keine Zugangsdaten oder PDF-Rechnungen werden dort abgelegt. Beide Bots reagieren ausschließlich auf private Chats von explizit freigegebenen Benutzer-IDs. Ohne `TELEGRAM_BOT_TOKEN1` läuft nur der erste Bot.


## Bereitstellung des alternativen Webhook-/MCP-Servers

Dieser Abschnitt gilt nur, wenn statt GitHub-Actions-Polling ein dauerhaft laufender Node.js-Dienst verwendet werden soll. Benötigt werden Node.js 20+, Chromium-Unterstützung, HTTPS und ein dauerhaftes Dateisystem für `STATE_FILE`. Anschließend `npm install` und `npm start` ausführen. Der Health-Check ist unter `GET /health` erreichbar.

Nach der Bereitstellung den Webhook einmalig über einen authentifizierten POST-Aufruf an `/admin/set-webhook` aktivieren. Der Header lautet `Authorization: Bearer <MCP_ACCESS_TOKEN>`. Webhook und Polling dürfen für denselben Telegram-Bot nicht gleichzeitig aktiv sein. Für den empfohlenen GitHub-Actions-Polling-Modus ist diese Serverbereitstellung nicht erforderlich.

## Tests

`npm test` prüft Eingabevalidierung, simulierte Notion-Aufrufe, Rechnungsstatus, Mahnstufen und die PDF-Erstellung mit Playwright anhand der bestehenden Rechnio-Seite. GitHub Actions führt die Tests aus und stellt PDF-Testdateien als Artefakte bereit.

## Produktionsstatus

Der GitHub-Actions-Polling-Modus benötigt keinen dauerhaft laufenden Node.js-Host. Er startet automatisch, sobald die drei beschriebenen Repository Secrets hinterlegt sind. Bis zum ersten echten Telegram-zu-PDF-zu-Notion-End-to-End-Test bleibt die Produktionsverbindung unbestätigt. Der alternative Webhook-Modus in `src/server.js` benötigt weiterhin einen Node.js-Host mit Chromium und dauerhaftem Speicher.
