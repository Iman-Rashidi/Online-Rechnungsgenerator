import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { runPolling } from "./poll.js";

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    console.log("Shutdown requested:", signal);
  });
}

const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"];
const missing = required.filter(key => !String(process.env[key] || "").trim());
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "rechnio-telegram-long-polling",
      telegramConfigured: true,
      notionConfigured: Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATA_SOURCE_ID)
    }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

const port = Number(process.env.PORT || 10000);
server.listen(port, "0.0.0.0", () => {
  console.log("Rechnio health endpoint listening on port", port);
  console.log("Rechnio long-polling worker starting. Notion integration is optional.");
});

try {
  while (!stopping) {
    try {
      const result = await runPolling({ pollTimeoutSeconds: 50 });
      if (result.received) console.log("Telegram updates processed:", result.received);
    } catch (error) {
      console.error("Polling cycle failed:", error instanceof Error ? error.message : "Unknown error");
      if (String(error?.message || "").includes("Webhook")) {
        console.error("Remove the existing Telegram webhook before starting long polling.");
        process.exitCode = 1;
        break;
      }
      await sleep(5000);
    }
  }
} finally {
  server.close();
  console.log("Rechnio polling worker stopped.");
}
