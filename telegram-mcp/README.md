# Rechnio Telegram + Notion service

This service adds a private Telegram webhook to the existing Rechnio web app. It uses the repository's original `index.html` in headless Chromium to render PDFs, preserving the current invoice preview, tax calculations and three templates.

## Telegram command

Start a private chat with the bot, then send `/invoice` followed by a JSON object. Example:

```json
/invoice {
  "seller": "Musterfirma GmbH",
  "email": "rechnung@example.de",
  "sellerAddress": "Musterstraße 1, 50667 Köln",
  "customer": "Beispielkunde",
  "customerEmail": "kunde@example.de",
  "customerAddress": "Kundenweg 2, 50668 Köln",
  "number": "RE-2026-001",
  "date": "2026-11-06",
  "due": "2026-11-20",
  "taxRate": "19",
  "template": "modern",
  "documentType": "invoice",
  "items": [
    { "description": "Webdesign", "quantity": 2, "unitPrice": 80 }
  ],
  "paymentTerms": "Bitte innerhalb von 14 Tagen überweisen.",
  "iban": "DE...",
  "note": "Vielen Dank für Ihren Auftrag."
}
```

For a payment reminder, use `"documentType":"mahnung"`, set `"originalInvoice"`, optionally `"originalDue"` and `"reminderFee"`, and supply the tax rate that applied to the original invoice. The bot validates the payload, renders the existing Rechnio page to A4 PDF, sends the PDF, then creates a Notion row when Notion is configured.

## Required environment variables

- `TELEGRAM_BOT_TOKEN`: bot token from BotFather.
- `MCP_ACCESS_TOKEN`: random secret, minimum 32 characters, for the MCP and admin endpoints.
- `TELEGRAM_WEBHOOK_SECRET`: 1-256 chars using Telegram's allowed secret-token characters (A-Z, a-z, 0-9, underscore, hyphen).
- `ALLOWED_TELEGRAM_USER_IDS`: comma-separated numeric Telegram user IDs allowed to create documents. **Required for production.**
- `PUBLIC_BASE_URL`: public HTTPS origin of this service, without a trailing route, e.g. `https://your-service.example`.
- `NOTION_API_KEY`: Notion integration secret.
- `NOTION_DATA_SOURCE_ID`: ID of the Rechnio invoice database. Share that database with the Notion integration.
- Optional: `PORT` (default 3000), `STATE_FILE` (default `./data/telegram-updates.json`).

Never put secrets in GitHub, chat messages, source files, or screenshots. Configure them as hosting-provider secrets. Restrict access to a private Telegram chat and only add trusted user IDs to the allowlist.

## Deploy and activate webhook

Use a Node.js 20+ host with Chromium support and persistent disk for `STATE_FILE`. Install dependencies with `npm install`, then start with `npm start`. The health endpoint is `GET /health`.

After deployment, activate Telegram's webhook once by making an authenticated POST request to `/admin/set-webhook` with header `Authorization: Bearer <MCP_ACCESS_TOKEN>`. The service calls Telegram `setWebhook` using `PUBLIC_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET`. Telegram then posts updates to `/telegram/webhook`.

The webhook acknowledges an update before rendering so Telegram does not wait for a long PDF operation. Processed update IDs are stored in `STATE_FILE`; mount persistent storage at the state file directory to retain deduplication across restarts. Back up this state file.

## Notion database

The integration expects the database property names created for Rechnio:
`Invoice title` (title), `Customer` (rich text), `Customer email` (email), `Invoice date` (date), `Due date` (date), `Net amount EUR` (number), `Tax rate %` (number), `Gross amount EUR` (number), `Status` (select), `Mahnung level` (number), and `Notes` (rich text). If the Notion property names differ, update `src/notion.js` to match them. Notion failures do not prevent PDF delivery; the bot reports that the Notion save failed.

## Local checks

- `npm test` runs payload validation tests.
- `npm start` requires the Telegram and MCP secrets.
- Test first with dummy customer data, verify the PDF, totals and Notion row, then use real data.

## Important limitations

- The Telegram flow currently accepts structured JSON after `/invoice`; it is not yet a conversational question-by-question form.
- Mahnung tax rate must be supplied from the original invoice; the service does not look up the original invoice automatically yet.
- The service does not store PDFs or customer data beyond the configured hosting state file; use a host with suitable privacy controls and persistent storage.
- The webhook allowlist must be configured. If it is empty, no user can create invoices.
- This is an implementation candidate, not a deployed/verified production service. Hosting credentials, Telegram secrets, Notion integration sharing and end-to-end tests are still required.
