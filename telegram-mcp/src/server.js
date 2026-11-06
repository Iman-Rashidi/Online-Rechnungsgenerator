import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { renderInvoicePdf, validateInvoice } from "./invoice.js";
import { getInvoiceFromNotion, saveInvoiceToNotion, updateInvoiceStatus } from "./notion.js";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const MCP_ACCESS_TOKEN = (process.env.MCP_ACCESS_TOKEN || "").trim();
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
const ALLOWED_TELEGRAM_USER_IDS = new Set((process.env.ALLOWED_TELEGRAM_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const PORT = Number(process.env.PORT || 3000);
const STATE_FILE = resolve(process.env.STATE_FILE || "./data/telegram-updates.json");
if (!TELEGRAM_BOT_TOKEN || !MCP_ACCESS_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN and MCP_ACCESS_TOKEN.");
if (MCP_ACCESS_TOKEN.length < 32) throw new Error("MCP_ACCESS_TOKEN must contain at least 32 characters.");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be a valid TCP port.");

async function telegram(method, payload = {}) {
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram API request failed.");
  return data.result;
}

async function sendDocument(chatId, pdf, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption.slice(0, 1024));
  form.append("document", new Blob([pdf], { type: "application/pdf" }), filename);
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendDocument", {
    method: "POST", body: form, signal: AbortSignal.timeout(60000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram PDF delivery failed.");
  return data.result;
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || !expected) return false;
  const a = Buffer.from(candidate.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const processed = new Set();
const inFlight = new Set();

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    for (const id of saved.processed || []) processed.add(String(id));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read webhook state.");
  }
}

async function saveState() {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tempFile = STATE_FILE + ".tmp";
  await writeFile(tempFile, JSON.stringify({ processed: [...processed].slice(-5000) }), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(tempFile, STATE_FILE);
}

async function reply(chatId, text) {
  await telegram("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

async function processInvoice(chatId, payload) {
  if (payload.documentType === "mahnung") {
    const original = await getInvoiceFromNotion(payload.originalInvoice);
    if (original) {
      if (original.taxRate !== null) payload.taxRate = String(original.taxRate);
      if (!payload.customer && original.customer) payload.customer = original.customer;
    } else if (process.env.NOTION_API_KEY && (process.env.NOTION_DATA_SOURCE_ID || process.env.NOTION_INVOICES_DATABASE_ID)) {
      throw new Error("Die Originalrechnung wurde in Notion nicht gefunden. Bitte zuerst die Originalrechnung speichern.");
    } else if (!Object.hasOwn(payload, "taxRate")) {
      throw new Error("Ohne Notion-Verbindung muss der ursprüngliche Steuersatz im JSON-Feld „taxRate“ angegeben werden.");
    }
  }

  validateInvoice(payload);
  const { pdf, totals } = await renderInvoicePdf(payload);
  const filename = (String(payload.number || "Rechnio").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70) || "Rechnio") + ".pdf";
  await sendDocument(chatId, pdf, filename, "Rechnio · PDF erstellt. Brutto: " + totals.gross.toFixed(2) + " EUR");

  try {
    const notion = await saveInvoiceToNotion(payload, totals);
    if (notion.skipped) {
      await reply(chatId, "PDF wurde gesendet. Die Notion-Verbindung ist noch nicht eingerichtet.");
    } else {
      await reply(chatId, "PDF wurde gesendet und in Notion gespeichert: " + notion.url);
    }
  } catch (error) {
    console.error("Notion save failed:", error instanceof Error ? error.message : "Unknown error");
    await reply(chatId, "PDF wurde gesendet, aber das Speichern in Notion ist fehlgeschlagen. Grund: " + String(error.message || "Unbekannter Fehler.").slice(0, 300));
  }
}

function createMcpServer() {
  const server = new McpServer({ name: "rechnio-telegram", version: "0.3.0" });
  server.registerTool("telegram_get_me", {
    title: "Get Telegram bot identity",
    description: "Show the configured Telegram bot identity.",
    inputSchema: {}
  }, async () => {
    const bot = await telegram("getMe");
    return { content: [{ type: "text", text: JSON.stringify({ id: bot.id, is_bot: bot.is_bot, first_name: bot.first_name, username: bot.username }, null, 2) }] };
  });
  server.registerTool("telegram_send_message", {
    title: "Send Telegram message",
    description: "Send a text message to a chat that has started the bot.",
    inputSchema: { chat_id: z.union([z.string(), z.number()]), text: z.string().min(1).max(4096) }
  }, async ({ chat_id, text }) => {
    const sent = await telegram("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true } });
    return { content: [{ type: "text", text: "Sent message " + sent.message_id + " to chat " + sent.chat.id }] };
  });
  server.registerTool("telegram_get_updates", {
    title: "Get recent bot messages",
    description: "Read recent updates. This is unavailable while a webhook is configured.",
    inputSchema: { limit: z.number().int().min(1).max(20).default(10) }
  }, async ({ limit }) => {
    const webhook = await telegram("getWebhookInfo");
    if (webhook.url) throw new Error("A Telegram webhook is active. getUpdates cannot be used while a webhook is configured.");
    const updates = await telegram("getUpdates", { limit, timeout: 0, allowed_updates: ["message"] });
    return { content: [{ type: "text", text: JSON.stringify(updates.map(u => ({ update_id: u.update_id, chat_id: u.message?.chat?.id, text: u.message?.text })), null, 2) }] };
  });
  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "3mb" }));

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "rechnio-telegram",
  telegram_configured: true,
  webhook_secret_configured: Boolean(TELEGRAM_WEBHOOK_SECRET),
  user_allowlist_configured: ALLOWED_TELEGRAM_USER_IDS.size > 0,
  notion_configured: Boolean(process.env.NOTION_API_KEY && (process.env.NOTION_DATA_SOURCE_ID || process.env.NOTION_INVOICES_DATABASE_ID))
}));

app.post("/telegram/webhook", async (req, res) => {
  if (!tokenMatches(req.get("x-telegram-bot-api-secret-token") || "", TELEGRAM_WEBHOOK_SECRET)) return res.sendStatus(401);
  const update = req.body || {};
  const updateId = String(update.update_id ?? "");
  if (!updateId || processed.has(updateId)) return res.sendStatus(200);
  if (inFlight.has(updateId)) return res.sendStatus(503);

  const message = update.message;
  const chat = message?.chat;
  const sender = message?.from;
  if (!message || chat?.type !== "private" || !sender || !ALLOWED_TELEGRAM_USER_IDS.has(String(sender.id))) {
    processed.add(updateId);
    await saveState();
    return res.sendStatus(200);
  }

  inFlight.add(updateId);
  try {
    const command = String(message.text || "").trim();
    if (command === "/start" || command === "/help") {
      await reply(chat.id, "Rechnio ist bereit.\n\nPDF-Rechnung erstellen:\n/invoice gefolgt von den vollständigen Rechnungsdaten als JSON\n\nRechnung als bezahlt markieren:\n/paid RE-2026-001\n\nAls an den Kunden versendet markieren:\n/sent RE-2026-001\n\nAls überfällig markieren:\n/overdue RE-2026-001\n\nRechnung stornieren:\n/cancelled RE-2026-001\n\nEin vollständiges JSON-Beispiel finden Sie in der README des GitHub-Projekts.");
    } else {
      const statusCommand = /^\/(paid|sent|overdue|cancelled)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9._/-]{1,80})$/i.exec(command);
      if (statusCommand) {
        const status = ({ paid: "Paid", sent: "Sent", overdue: "Overdue", cancelled: "Cancelled" })[statusCommand[1].toLowerCase()];
        const updated = await updateInvoiceStatus(statusCommand[2], status);
        await reply(chat.id, updated.skipped ? "Die Notion-Verbindung ist noch nicht eingerichtet." : "Der Rechnungsstatus wurde auf „" + status + "“ gesetzt: " + updated.url);
      } else if (command.startsWith("/invoice")) {
        const raw = command.slice("/invoice".length).trim();
        if (!raw) {
          await reply(chat.id, "Bitte senden Sie nach /invoice die Rechnungsdaten als JSON. Ein vollständiges Beispiel finden Sie in der README.");
        } else {
          let payload;
          try { payload = JSON.parse(raw); }
          catch { await reply(chat.id, "Das JSON-Format ist ungültig. Bitte verwenden Sie die Struktur aus dem README-Beispiel."); payload = null; }
          if (payload) await processInvoice(chat.id, payload);
        }
      } else {
        await reply(chat.id, "Für Hilfe senden Sie /help.");
      }
    }
    processed.add(updateId);
    await saveState();
    res.sendStatus(200);
  } catch (error) {
    console.error("Telegram update failed:", error instanceof Error ? error.message : "Unknown error");
    try {
      await reply(chat.id, "Der Vorgang ist fehlgeschlagen: " + String(error.message || "Unbekannter Fehler.").slice(0, 300));
      processed.add(updateId);
      await saveState();
      res.sendStatus(200);
    } catch {
      res.sendStatus(503);
    }
  } finally {
    inFlight.delete(updateId);
  }
});

app.post("/admin/set-webhook", async (req, res) => {
  const auth = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (!tokenMatches(auth?.[1] || "", MCP_ACCESS_TOKEN)) return res.sendStatus(401);
  if (!TELEGRAM_WEBHOOK_SECRET || !process.env.PUBLIC_BASE_URL) {
    return res.status(400).json({ error: "Set TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL first." });
  }
  if (ALLOWED_TELEGRAM_USER_IDS.size === 0) {
    return res.status(400).json({ error: "Set ALLOWED_TELEGRAM_USER_IDS before enabling the webhook." });
  }
  try {
    const url = new URL("/telegram/webhook", process.env.PUBLIC_BASE_URL).href;
    const result = await telegram("setWebhook", {
      url, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: false
    });
    res.json({ ok: Boolean(result), webhook_url: url });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.all("/mcp", async (req, res) => {
  const auth = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (!tokenMatches(auth?.[1] || "", MCP_ACCESS_TOKEN)) return res.status(401).json({ error: "Unauthorized" });
  if (!["GET", "POST", "DELETE"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    const requestServer = createMcpServer();
    await requestServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error instanceof Error ? error.message : "Unknown error");
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

await loadState();
app.listen(PORT, "0.0.0.0", () => console.log("Rechnio Telegram service listening on " + PORT));
