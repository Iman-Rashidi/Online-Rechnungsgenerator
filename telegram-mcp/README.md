# Rechnio Telegram MCP Connector (starter)

A small, self-hostable MCP server that connects ChatGPT-compatible MCP clients to **your own Telegram bot** using the official Telegram Bot API.

## Free-first setup

- Source code: GitHub (free for a public repository).
- Telegram Bot API: no charge for ordinary bot use.
- Hosting: choose a free hosting tier if available; free tiers may sleep, impose limits, or change.
- ChatGPT custom MCP availability depends on the user's ChatGPT plan and workspace settings. A server alone does not enable custom connectors in every account.

## Security

- Never commit your Telegram bot token or the MCP access token.
- Set both as environment variables on the host:
  - `TELEGRAM_BOT_TOKEN`
  - `MCP_ACCESS_TOKEN`
- The server only controls the configured bot. It cannot read personal Telegram chats.
- Start with a private bot chat. Do not add the bot to groups until its privacy and permissions are understood.

## Planned tools

1. `telegram_get_me` - verify which bot is configured.
2. `telegram_send_message` - send a text message to a chat ID.
3. `telegram_get_updates` - read messages delivered to the bot.

The first implementation is intentionally small. It does not send messages automatically, access personal accounts, or store message history.

## Local development

Requirements: Node.js 20+.

```bash
cd telegram-mcp
npm install
cp .env.example .env
# Fill the two secrets locally; never commit .env
npm run dev
```

The server exposes an MCP Streamable HTTP endpoint at `/mcp`. Deploy behind HTTPS before connecting a remote client.
