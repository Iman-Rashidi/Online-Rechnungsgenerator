# Rechnio – Online-Rechnungsgenerator

**Rechnungen und Zahlungserinnerungen einfach erstellen, live ansehen und als PDF speichern.**

Rechnio ist ein browserbasierter Rechnungsgenerator mit deutscher Benutzeroberfläche. Das Projekt bietet eine übersichtliche Eingabemaske und eine direkt aktualisierte Dokumentvorschau. Es enthält außerdem einen separaten Telegram-MCP-Connector für den Betrieb mit einem eigenen Telegram-Bot.

> **Projektstatus:** Open Source, MIT-lizenziert. Beiträge und Verbesserungsvorschläge sind willkommen.

## Funktionen

### Rechnungsgenerator

- Rechnungsdaten: Nummer, Datum und Fälligkeitsdatum
- Absender- und Kundenangaben
- Optionale Firmenangaben wie Steuernummer und Umsatzsteuer-ID
- Optionale Bankverbindung und Zahlungshinweise
- Rechnungspositionen mit Beschreibung, Menge und Nettopreis
- Automatische Berechnung von Netto-, Umsatzsteuer- und Bruttobeträgen
- Auswahl der Umsatzsteueroptionen (19 %, 7 %, 0 % oder keine Umsatzsteuer)
- Drei Layouts: klassisch, modern und kompakt
- Optionales Firmenlogo
- Zahlungserinnerung mit ursprünglicher Rechnungsnummer, ursprünglichem Fälligkeitsdatum und optionaler Mahngebühr
- Drucklayout zum Speichern über die Druckfunktion des Browsers als PDF
- Responsive Oberfläche für Desktop und Mobilgeräte

### Telegram MCP Connector

Im Verzeichnis [telegram-mcp](telegram-mcp/) befindet sich ein separater MCP-Connector für einen eigenen Telegram-Bot.

Dokumentation und Einrichtung: [Telegram MCP README](telegram-mcp/README.md).

Die verfügbaren MCP-Funktionen umfassen:
- `telegram_get_me` – den konfigurierten Bot überprüfen
- `telegram_send_message` – eine Textnachricht senden
- `telegram_get_updates` – an den Bot zugestellte Updates abrufen

## Verwendung

1. Öffne die Rechnio-Webseite über die GitHub-Pages-Veröffentlichung dieses Repositorys.
2. Trage Absender, Kunde und Rechnungsdaten ein.
3. Füge eine oder mehrere Rechnungspositionen hinzu.
4. Prüfe die automatisch aktualisierte Vorschau.
5. Wähle **Drucken / Als PDF speichern** und anschließend im Druckdialog deines Browsers **Als PDF speichern**.

Für eine Zahlungserinnerung wählst du beim Dokumenttyp **Mahnung / Zahlungserinnerung** und ergänzt die Angaben zur ursprünglichen Rechnung.

## Lokal starten

Der Rechnungsgenerator ist eine statische Webanwendung. Für die lokale Vorschau genügt es, die Datei `index.html` in einem aktuellen Browser zu öffnen. Alternativ kannst du einen lokalen HTTP-Server verwenden.

Der Telegram-MCP-Connector ist ein eigenständiger Teil des Projekts und benötigt Node.js. Seine Voraussetzungen und Startanweisungen stehen in [telegram-mcp/README.md](telegram-mcp/README.md).

## Datenschutz und Sicherheit

- Behandle Rechnungen als vertrauliche Dokumente und teile sie nur mit den vorgesehenen Empfängern.
- Veröffentliche keine echten Kunden-, Bank- oder Steuerdaten in GitHub-Issues, Pull Requests oder Screenshots.
- **Committe niemals** `.env`, Bot-Tokens, MCP-Zugangstokens, Passwörter oder andere Zugangsdaten.
- Für den Telegram-Connector müssen `TELEGRAM_BOT_TOKEN` und `MCP_ACCESS_TOKEN` als Secrets bzw. Umgebungsvariablen auf dem Hosting-System hinterlegt werden. Details: [Telegram MCP Sicherheitshinweise](telegram-mcp/README.md#security).
- Prüfe die erstellten Rechnungen vor dem Versand. Rechnio ist ein Hilfswerkzeug und keine Steuer- oder Rechtsberatung. Anforderungen an Rechnungen können je nach Land und Situation unterschiedlich sein.

## Mitwirken

Beiträge sind willkommen: Fehlerberichte, Dokumentationsverbesserungen, Barrierefreiheit, Tests und neue Funktionen.

Bitte lies zuerst den [Leitfaden für Beiträge](CONTRIBUTING.md). Für größere Änderungen empfiehlt es sich, die Idee vorab als Issue zu besprechen.

- [Fehler melden oder Funktion vorschlagen](../../issues)
- [Pull Requests ansehen](../../pulls)
- [Mitwirkungsrichtlinien](CONTRIBUTING.md)

## Lizenz

Rechnio wird unter der [MIT License](LICENSE) veröffentlicht.

---

**Rechnio** – Rechnungen einfacher erstellen.
