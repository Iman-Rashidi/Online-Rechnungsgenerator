# Rechnio Telegram + Notion integration

This service connects Telegram to the **existing Rechnio website**. It opens the repository's existing `index.html` in headless Chromium and prints that exact UI to PDF, so the original tax calculations and the classic, modern and compact templates are retained.

## Telegram commands

- `/start` or `/help`: show the command guide.
- `/invoice {JSON}`: create a PDF using the existing Rechnio form, send it to Telegram, and create/update its Notion row.
- `/paid RE-2026-001`: mark an invoice as paid in Notion.
- `/sent RE-2026-001`: mark an invoice as sent to the customer.
- `/overdue RE-2026-001`: mark an invoice as overdue.
- `/cancelled RE-2026-001`: cancel an invoice.

Example (dummy data only):

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
  "documentType": "invoice",
  "items": [
    { "description": "Webdesign", "quantity": 2, "unitPrice": 80 }
  ],
  "paymentTerms": "Bitte innerhalb von 14 Tagen überweisen.",
  "note": "Testrechnung, nicht bezahlen."
}
```

For a Mahnung, set `"documentType":"mahnung"`, give the reminder its own `number`, set `"originalInvoice"` to the exact number of the original invoice, and include the original invoice's line items. When the original invoice exists in Notion, its stored tax rate is inherited automatically, and the original row is updated to `Overdue` with the next Mahnung level. The reminder is stored as a separate Notion row. Reusing a document number updates its existing Notion row instead of creating a duplicate.

## Notion database

The service uses the Notion **data source ID**, not a database title. Its property names and types are aligned with the connected Rechnio database:

- `Invoice` (title), `Invoice number` (rich text), `Original invoice number` (rich text), `Document type` (select)
- `Customer` (rich text), `Customer email` (email), `Invoice date` / `Due date` (date)
- `Net amount`, `Tax rate %`, `Gross amount` (number)
- `Status` (Draft / Sent / Paid / Overdue / Cancelled)
- `Mahnung level` (None / Reminder / First Mahnung / Second Mahnung / Final Mahnung), `Notes` (rich text)

The PDF itself is delivered to Telegram. `PDF URL` remains empty because this service does not publish customer invoices to a public file host.

## Environment variables

- `TELEGRAM_BOT_TOKEN`: token for the bot.
- `TELEGRAM_WEBHOOK_SECRET`: secret used to verify Telegram webhook requests.
- `ALLOWED_TELEGRAM_USER_IDS`: comma-separated numeric user IDs. Required; only these private chats can use the bot.
- `MCP_ACCESS_TOKEN`: random secret of at least 32 characters for the MCP and admin endpoints.
- `PUBLIC_BASE_URL`: public HTTPS origin of the deployed service.
- `NOTION_API_KEY`: Notion integration secret.
- `NOTION_DATA_SOURCE_ID`: ID from the Rechnio invoice data source.
- Optional: `PORT` (default 3000), `STATE_FILE` (default `./data/telegram-updates.json`).

Share the invoice database with the Notion integration and grant it read/write access. Do not paste credentials into a chat, commit them to Git, or put them in screenshots. Keep all real secrets in the hosting provider's secret manager.

## Run and deploy

Requires Node.js 20+, Chromium support, HTTPS, and persistent disk for `STATE_FILE`. Run `npm install`, then `npm start`. The service responds to `GET /health`.

After deployment, activate the Telegram webhook once by sending an authenticated POST to `/admin/set-webhook` with `Authorization: Bearer <MCP_ACCESS_TOKEN>`. The service then registers `/telegram/webhook` with Telegram.

The webhook verifies the Telegram secret header and private-chat allowlist. Update IDs are stored in `STATE_FILE` to reduce duplicate processing across restarts. Mount a persistent volume for the containing directory.

## Tests

`npm test` runs:
- payload validation and invalid-date / invalid-tax / invalid-reminder cases
- mocked Notion data-source create, lookup and payment-status calls
- Playwright PDF generation against the original Rechnio page for both an invoice and a Mahnung

GitHub Actions installs Chromium and runs these tests for the pull request and the integration branch.

## Production status

Source code and database schema are prepared, but the service is not live until a trusted account owner configures the Telegram and Notion secrets and deploys the Node.js service to a persistent host. The real Telegram -> PDF -> Notion flow cannot be verified without those external credentials and a live bot.
