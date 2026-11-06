import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { renderInvoicePdf } from "./invoice.js";
import { saveInvoiceToNotion } from "./notion.js";

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
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
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
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendDocument", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram PDF delivery failed.");
  return data.result;
}
function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || !expected) return false;
  const a = Buffer.from(candidate.trim(), "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
const processed = new Set();
async function loadState() {
  try { const saved = JSON.parse(await readFile(STATE_FILE, "utf8")); for (const id of saved.processed || []) processed.add(String(id)); }
  catch (error) { if (error.code !== "ENOENT") console.error("Could not read webhook state."); }
}
async function saveState() {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ processed: [...processed].slice(-5000) }), { mode: 0o600 });
}
function createMcpServer() {
  const server = new McpServer({ name: "rechnio-telegram", version: "0.2.0" });
  server.registerTool("telegram_get_me", { title: "Get Telegram bot identity", description: "Show the configured Telegram bot identity.", inputSchema: {} }, async () => {
    const bot = await telegram("getMe");
    return { content: [{ type: "text", text: JSON.stringify({ id: bot.id, is_bot: bot.is_bot, first_name: bot.first_name, username: bot.username }, null, 2) }] };
  });
  server.registerTool("telegram_send_message", { title: "Send Telegram message", description: "Send a text message to a chat that has started the bot.", inputSchema: { chat_id: z.union([z.string(), z.number()]), text: z.string().min(1).max(4096) } }, async ({ chat_id, text }) => {
    const sent = await telegram("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true } });
    return { content: [{ type: "text", text: "Sent message " + sent.message_id + " to chat " + sent.chat.id }] };
  });
  server.registerTool("telegram_get_updates", { title: "Get recent bot messages", description: "Read recent updates. This is unavailable while a webhook is configured.", inputSchema: { limit: z.number().int().min(1).max(20).default(10) } }, async ({ limit }) => {
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
app.get("/health", (_req, res) => res.json({ ok: true, service: "rechnio-telegram", telegram_configured: true, webhook_secret_configured: Boolean(TELEGRAM_WEBHOOK_SECRET), user_allowlist_configured: ALLOWED_TELEGRAM_USER_IDS.size > 0, notion_configured: Boolean(process.env.NOTION_API_KEY && process.env.NOTION_INVOICES_DATABASE_ID) }));
app.post("/telegram/webhook", async (req, res) => {
  if (!tokenMatches(req.get("x-telegram-bot-api-secret-token") || "", TELEGRAM_WEBHOOK_SECRET)) return res.sendStatus(401);
  const update = req.body || {};
  const updateId = String(update.update_id ?? "");
  if (!updateId || processed.has(updateId)) return res.sendStatus(200);
  const message = update.message;
  const chat = message?.chat;
  const sender = message?.from;
  if (!message || chat?.type !== "private" || !sender || !ALLOWED_TELEGRAM_USER_IDS.has(String(sender.id))) {
    processed.add(updateId); await saveState(); return res.sendStatus(200);
  }
  processed.add(updateId);
  await saveState();
  res.sendStatus(200);
  try {
    const text = String(message.text || "").trim();
    if (text === "/start" || text === "/help") {
      await telegram("sendMessage", { chat_id: chat.id, text: "Rechnio آماده است. برای ساخت فاکتور، دستور /invoice را همراه با JSON اطلاعات بفرستید. نمونه در README مخزن موجود است." });
      return;
    }
    if (!text.startsWith("/invoice")) {
      await telegram("sendMessage", { chat_id: chat.id, text: "برای ساخت PDF از دستور /invoice همراه اطلاعات JSON استفاده کنید. برای راهنما /help را بفرستید." });
      return;
    }
    const raw = text.slice("/invoice".length).trim();
    if (!raw) {
      await telegram("sendMessage", { chat_id: chat.id, text: "بعد از /invoice اطلاعات JSON فاکتور را قرار دهید. نمونهٔ کامل در README موجود است." });
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { await telegram("sendMessage", { chat_id: chat.id, text: "JSON قابل خواندن نیست. ساختار نمونهٔ README را رعایت کنید." }); return; }
    const { pdf, totals } = await renderInvoicePdf(payload);
    const notion = await saveInvoiceToNotion(payload, totals);
    const filename = (String(payload.number || "Rechnio").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70) || "Rechnio") + ".pdf";
    await sendDocument(chat.id, pdf, filename, "Rechnio · PDF erstellt. Brutto: " + totals.gross.toFixed(2) + " EUR");
    if (notion.skipped) await telegram("sendMessage", { chat_id: chat.id, text: "Hinweis: PDF wurde gesendet. Notion ist noch nicht verbunden, daher wurde kein Datensatz gespeichert." });
    else await telegram("sendMessage", { chat_id: chat.id, text: "Auch in Notion gespeichert: " + notion.url });
  } catch (error) {
    console.error("Invoice processing failed:", error instanceof Error ? error.message : "Unknown error");
    try { await telegram("sendMessage", { chat_id: chat.id, text: "Die Rechnung konnte nicht erstellt werden. Bitte Eingaben prüfen oder später erneut versuchen." }); } catch {}
  }
});
app.post("/admin/set-webhook", async (req, res) => {
  const auth = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (!tokenMatches(auth?.[1] || "", MCP_ACCESS_TOKEN)) return res.sendStatus(401);
  if (!TELEGRAM_WEBHOOK_SECRET || !process.env.PUBLIC_BASE_URL) return res.status(400).json({ error: "Set TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL first." });
  try {
    const url = new URL("/telegram/webhook", process.env.PUBLIC_BASE_URL).href;
    const result = await telegram("setWebhook", { url, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: false });
    res.json({ ok: Boolean(result), webhook_url: url });
  } catch (error) { res.status(502).json({ error: error.message }); }
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
