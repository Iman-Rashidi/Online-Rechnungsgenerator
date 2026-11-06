import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const MCP_ACCESS_TOKEN = (process.env.MCP_ACCESS_TOKEN || "").trim();
const PORT = Number(process.env.PORT || 3000);
if (!TELEGRAM_BOT_TOKEN || !MCP_ACCESS_TOKEN) {
  throw new Error("Set TELEGRAM_BOT_TOKEN and MCP_ACCESS_TOKEN.");
}
if (MCP_ACCESS_TOKEN.length < 32) {
  throw new Error("MCP_ACCESS_TOKEN must contain at least 32 characters.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

async function telegram(method, payload = {}) {
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram API request failed.");
  }
  return data.result;
}

function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const supplied = Buffer.from(candidate.trim(), "utf8");
  const expected = Buffer.from(MCP_ACCESS_TOKEN, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function createMcpServer() {
  const server = new McpServer({ name: "rechnio-telegram", version: "0.1.1" });

  server.registerTool("telegram_get_me", {
    title: "Get Telegram bot identity",
    description: "Show the identity of the Telegram bot configured on this server.",
    inputSchema: {}
  }, async () => {
    const bot = await telegram("getMe");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: bot.id,
          is_bot: bot.is_bot,
          first_name: bot.first_name,
          username: bot.username
        }, null, 2)
      }]
    };
  });

  server.registerTool("telegram_send_message", {
    title: "Send Telegram message",
    description: "Send a text message from the configured bot to a chat that has started the bot.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat ID"),
      text: z.string().min(1).max(4096).describe("Message text")
    }
  }, async ({ chat_id, text }) => {
    const sent = await telegram("sendMessage", {
      chat_id,
      text,
      link_preview_options: { is_disabled: true }
    });
    return {
      content: [{
        type: "text",
        text: "Sent message " + sent.message_id + " to chat " + sent.chat.id
      }]
    };
  });

  server.registerTool("telegram_get_updates", {
    title: "Get recent bot messages",
    description: "Read recent updates delivered to this bot. This cannot read personal Telegram chats and requires that no Telegram webhook is active.",
    inputSchema: { limit: z.number().int().min(1).max(20).default(10) }
  }, async ({ limit }) => {
    const webhook = await telegram("getWebhookInfo");
    if (webhook.url) {
      throw new Error("A Telegram webhook is active. getUpdates cannot be used while a webhook is configured. Disable the webhook before calling telegram_get_updates.");
    }
    const updates = await telegram("getUpdates", {
      limit,
      timeout: 0,
      allowed_updates: ["message"]
    });
    const messages = updates.map(u => ({
      update_id: u.update_id,
      message_id: u.message?.message_id,
      date: u.message?.date,
      chat_id: u.message?.chat?.id,
      chat_type: u.message?.chat?.type,
      sender: u.message?.from ? {
        id: u.message.from.id,
        first_name: u.message.from.first_name,
        username: u.message.from.username
      } : undefined,
      text: u.message?.text
    }));
    return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
  });

  return server;
}

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Max-Age": "86400"
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "rechnio-telegram-mcp",
  mcp_auth_configured: MCP_ACCESS_TOKEN.length >= 32,
  telegram_configured: Boolean(TELEGRAM_BOT_TOKEN)
}));
app.all("/mcp", async (req, res) => {
  const authorization = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!tokenMatches(match?.[1] || "")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.set("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
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
app.listen(PORT, "0.0.0.0", () => console.log("Rechnio Telegram MCP listening on " + PORT));
