import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const { TELEGRAM_BOT_TOKEN, MCP_ACCESS_TOKEN } = process.env;
const PORT = Number(process.env.PORT || 3000);
if (!TELEGRAM_BOT_TOKEN || !MCP_ACCESS_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN and MCP_ACCESS_TOKEN.");
if (MCP_ACCESS_TOKEN.length < 32) throw new Error("MCP_ACCESS_TOKEN must contain at least 32 characters.");

async function telegram(method, payload = {}) {
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram API request failed");
  return data.result;
}
function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate), b = Buffer.from(MCP_ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createMcpServer() {
const server = new McpServer({ name: "rechnio-telegram", version: "0.1.0" });

server.registerTool("telegram_get_me", {
  title: "Get Telegram bot identity",
  description: "Show the identity of the Telegram bot configured on this server.",
  inputSchema: {}
}, async () => {
  const bot = await telegram("getMe");
  return { content: [{ type: "text", text: JSON.stringify({
    id: bot.id, is_bot: bot.is_bot, first_name: bot.first_name, username: bot.username
  }, null, 2) }] };
});

server.registerTool("telegram_send_message", {
  title: "Send Telegram message",
  description: "Send a text message from the configured bot to a chat that has started the bot.",
  inputSchema: {
    chat_id: z.union([z.string(), z.number()]).describe("Telegram chat ID"),
    text: z.string().min(1).max(4096).describe("Message text")
  }
}, async ({ chat_id, text }) => {
  const sent = await telegram("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true } });
  return { content: [{ type: "text", text: "Sent message " + sent.message_id + " to chat " + sent.chat.id }] };
});

server.registerTool("telegram_get_updates", {
  title: "Get recent bot messages",
  description: "Read recent updates delivered to this bot. This cannot read personal Telegram chats.",
  inputSchema: { limit: z.number().int().min(1).max(20).default(10) }
}, async ({ limit }) => {
  const updates = await telegram("getUpdates", { limit, timeout: 0, allowed_updates: ["message"] });
  const messages = updates.map((u) => ({
    update_id: u.update_id,
    message_id: u.message?.message_id,
    date: u.message?.date,
    chat_id: u.message?.chat?.id,
    chat_type: u.message?.chat?.type,
    sender: u.message?.from ? {
      id: u.message.from.id, first_name: u.message.from.first_name, username: u.message.from.username
    } : undefined,
    text: u.message?.text
  }));
  return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
});

return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "rechnio-telegram-mcp" }));
app.all("/mcp", async (req, res) => {
  const header = req.headers.authorization || "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokenMatches(candidate)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    const requestServer = createMcpServer();
    await requestServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});
app.listen(PORT, "0.0.0.0", () => console.log("Rechnio Telegram MCP listening on " + PORT));
