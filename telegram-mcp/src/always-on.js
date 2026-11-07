import { setTimeout as sleep } from "node:timers/promises";
import { runPolling } from "./poll.js";

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; console.log("Shutdown requested:", signal); });
}

const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "NOTION_API_KEY", "NOTION_DATA_SOURCE_ID"];
const missing = required.filter(key => !String(process.env[key] || "").trim());
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

console.log("Rechnio long-polling worker starting.");
while (!stopping) {
  try {
    const result = await runPolling({ pollTimeoutSeconds: 50 });
    if (result.received) console.log("Telegram updates processed:", result.received);
  } catch (error) {
    console.error("Polling cycle failed:", error instanceof Error ? error.message : "Unknown error");
    if (String(error?.message || "").includes("Webhook")) {
      console.error("Remove the existing Telegram webhook before starting long polling.");
      process.exit(1);
    }
    await sleep(5000);
  }
}
console.log("Rechnio polling worker stopped.");
