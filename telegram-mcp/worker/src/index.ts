import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
}

const TELEGRAM_TIMEOUT_MS = 15_000;
const MIN_ACCESS_TOKEN_LENGTH = 32;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400"
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function tokenMatches(supplied: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function telegram(env: Env, method: string, payload: Record<string, unknown> = {}) {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("Telegram bot is not configured.");

  const response = await fetch(
    "https://api.telegram.org/bot" + botToken + "/" + method,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    }
  );

  let data: { ok: boolean; result?: any; description?: string };
  try {
    data = await response.json() as { ok: boolean; result?: any; description?: string };
  } catch {
    throw new Error("Telegram API returned an invalid response.");
  }
  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram API request failed.");
  }
  return data.result;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "rechnio-telegram",
    version: "0.1.1"
  });

  server.registerTool(
    "telegram_get_me",
    {
      description: "Show the identity of the Telegram bot configured on this server."
    },
    async () => {
      const bot = await telegram(env, "getMe");
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
    }
  );

  server.registerTool(
    "telegram_send_message",
    {
      description: "Send a text message from the configured bot to a chat that has started the bot.",
      inputSchema: {
        chat_id: z.union([z.string(), z.number()]),
        text: z.string().min(1).max(4096)
      }
    },
    async ({ chat_id, text }) => {
      const sent = await telegram(env, "sendMessage", {
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
    }
  );

  server.registerTool(
    "telegram_get_updates",
    {
      description: "Read recent messages delivered to this bot. Pass offset as the last processed update_id plus 1 to avoid receiving the same updates again. This cannot read personal Telegram chats and requires that no Telegram webhook is active.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(10),
        offset: z.number().int().min(0).optional()
      }
    },
    async ({ limit, offset }) => {
      const webhook = await telegram(env, "getWebhookInfo") as { url?: string };
      if (webhook.url) {
        throw new Error("A Telegram webhook is active. getUpdates cannot be used while a webhook is configured. Disable the webhook before calling telegram_get_updates.");
      }

      const updates = await telegram(env, "getUpdates", {
        limit,
        timeout: 0,
        ...(offset !== undefined ? { offset } : {}),
        allowed_updates: ["message"]
      });
      const messages = updates.map((update: any) => ({
        update_id: update.update_id,
        message_id: update.message?.message_id,
        date: update.message?.date,
        chat_id: update.message?.chat?.id,
        chat_type: update.message?.chat?.type,
        sender: update.message?.from ? {
          id: update.message.from.id,
          first_name: update.message.from.first_name,
          username: update.message.from.username
        } : undefined,
        text: update.message?.text
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify(messages, null, 2)
        }]
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const accessToken = env.MCP_ACCESS_TOKEN?.trim() ?? "";
    const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "rechnio-telegram-mcp",
        mcp_auth_configured: accessToken.length >= MIN_ACCESS_TOKEN_LENGTH,
        telegram_configured: Boolean(botToken)
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return withCors(new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST, DELETE, OPTIONS" }
      }));
    }

    if (!accessToken) {
      return withCors(new Response("MCP access token is not configured correctly", { status: 503 }));
    }

    if (!tokenMatches(request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "", accessToken)) {
      return withCors(new Response("Unauthorized", { status: 401 }));
    }

    if (!botToken) {
      return withCors(new Response("Telegram bot is not configured", { status: 503 }));
    }

    try {
      const response = await createMcpHandler(() => createServer(env), {
        route: "/mcp",
        allowedOriginHostnames: ["glama.ai"]
      })(request, env, ctx);
      return withCors(response);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : "Unknown error");
      return withCors(new Response(JSON.stringify({ error: "MCP request failed" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      }));
    }
  }
};
