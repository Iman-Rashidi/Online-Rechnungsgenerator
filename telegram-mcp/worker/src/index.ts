import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
}

async function telegram(env: Env, method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json() as { ok: boolean; result?: any; description?: string };
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram API request failed");
  return data.result;
}

function createServer(env: Env) {
  const server = new McpServer({ name: "rechnio-telegram", version: "0.1.0" });

  server.registerTool("telegram_get_me", {
    description: "Show the identity of the Telegram bot configured on this server."
  }, async () => {
    const bot = await telegram(env, "getMe");
    return { content: [{ type: "text", text: JSON.stringify({
      id: bot.id, is_bot: bot.is_bot, first_name: bot.first_name, username: bot.username
    }, null, 2) }] };
  });

  server.registerTool("telegram_send_message", {
    description: "Send a text message from the configured bot to a chat that has started the bot.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]),
      text: z.string().min(1).max(4096)
    }
  }, async ({ chat_id, text }) => {
    const sent = await telegram(env, "sendMessage", {
      chat_id, text, link_preview_options: { is_disabled: true }
    });
    return { content: [{ type: "text", text: "Sent message " + sent.message_id + " to chat " + sent.chat.id }] };
  });

  server.registerTool("telegram_get_updates", {
    description: "Read recent messages delivered to this bot. This cannot read personal Telegram chats.",
    inputSchema: { limit: z.number().int().min(1).max(20).default(10) }
  }, async ({ limit }) => {
    const updates = await telegram(env, "getUpdates", {
      limit, timeout: 0, allowed_updates: ["message"]
    });
    const messages = updates.map((u: any) => ({
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "rechnio-telegram-mcp" });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const supplied = request.headers.get("Authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
    if (!env.MCP_ACCESS_TOKEN || supplied !== env.MCP_ACCESS_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!env.TELEGRAM_BOT_TOKEN) return new Response("Telegram bot is not configured", { status: 503 });

    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
      responseMode: "json"
    });
    return handler(request, env, ctx);
  }
};
