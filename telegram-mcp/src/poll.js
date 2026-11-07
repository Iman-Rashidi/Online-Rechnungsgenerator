import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderInvoicePdf } from "./invoice.js";
import { getInvoiceFromNotion, saveInvoiceToNotion, updateInvoiceStatus } from "./notion.js";

const HELP_TEXT = ["Rechnio ist bereit.", "", "Neue Rechnung Schritt für Schritt erstellen: /invoice", "Sie brauchen kein JSON. Antworten Sie einfach auf die Fragen des Bots.", "Abbrechen: /cancel", "", "Rechnung als bezahlt markieren: /paid RE-2026-001", "Als versendet markieren: /sent RE-2026-001", "Als überfällig markieren: /overdue RE-2026-001", "Rechnung stornieren: /cancelled RE-2026-001"].join("\n");

function safeError(error) {
  return String(error instanceof Error ? error.message : "Unbekannter Fehler.").slice(0, 300);
}

function telegramApi(token, method, payload = {}) {
  return fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000)
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || "Die Telegram-API-Anfrage ist fehlgeschlagen.");
    return data.result;
  });
}

async function sendTelegramDocument(token, chatId, pdf, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption.slice(0, 1024));
  form.append("document", new Blob([pdf], { type: "application/pdf" }), filename);
  const response = await fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
    method: "POST", body: form, signal: AbortSignal.timeout(60_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || "Die PDF-Zustellung über Telegram ist fehlgeschlagen.");
  return data.result;
}

async function processInvoice(chatId, payload, deps) {
  if (payload?.documentType === "mahnung") {
    const original = await deps.getInvoiceFromNotion(payload.originalInvoice);
    if (!original) throw new Error("Die Originalrechnung wurde in Notion nicht gefunden. Bitte zuerst die Originalrechnung speichern.");
    if (original.taxRate !== null && original.taxRate !== undefined) payload.taxRate = String(original.taxRate);
    if (!payload.customer && original.customer) payload.customer = original.customer;
  }
  const { pdf, totals } = await deps.renderInvoicePdf(payload);
  const filename = (String(payload.number || "Rechnio").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70) || "Rechnio") + ".pdf";
  await deps.sendDocument(chatId, pdf, filename, "Rechnio · PDF erstellt. Brutto: " + totals.gross.toFixed(2) + " EUR");
  try {
    const notion = await deps.saveInvoiceToNotion(payload, totals);
    await deps.reply(chatId, notion.skipped ? "PDF wurde gesendet. Die Notion-Verbindung ist noch nicht eingerichtet." : "PDF wurde gesendet und in Notion gespeichert: " + notion.url);
  } catch (error) {
    await deps.reply(chatId, "PDF wurde gesendet, aber das Speichern in Notion ist fehlgeschlagen. Grund: " + safeError(error));
  }
}

const WIZARD_FIELDS = [
  ["seller", "Name/Firma des Absenders:"],
  ["sellerAddress", "Adresse des Absenders:"],
  ["customer", "Name/Firma des Kunden:"],
  ["customerAddress", "Adresse des Kunden:"],
  ["number", "Rechnungsnummer (z. B. RE-2026-001):"],
  ["date", "Rechnungsdatum (TT.MM.JJJJ):"],
  ["due", "Fälligkeitsdatum (TT.MM.JJJJ):"],
  ["description", "Beschreibung der Leistung oder Ware:"],
  ["quantity", "Menge:"],
  ["unitPrice", "Einzelpreis in EUR (z. B. 49,90):"],
  ["taxRate", "Umsatzsteuer? Bitte 19, 7, 0 oder keine eingeben:"]
];

function germanDate(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  if (date.getFullYear() !== Number(match[3]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[1])) return null;
  return [match[3], match[2].padStart(2, "0"), match[1].padStart(2, "0")].join("-");
}

async function handleInvoiceWizard(chatId, text, deps) {
  const conversations = deps.conversations || (deps.conversations = {});
  let flow = conversations[String(chatId)];
  if (text === "/cancel") {
    delete conversations[String(chatId)];
    await deps.reply(chatId, "Die Rechnungserstellung wurde abgebrochen.");
    return { handled: true, action: "invoice-cancelled" };
  }
  if (/^\/invoice(?:@\w+)?$/i.test(text)) {
    flow = { step: 0, data: {} };
    conversations[String(chatId)] = flow;
    await deps.reply(chatId, "🧾 Rechnung erstellen\n\nWir gehen die Angaben Schritt für Schritt durch. Sie brauchen kein JSON.\n\n" + WIZARD_FIELDS[0][1] + "\n\nZum Abbrechen: /cancel");
    return { handled: true, action: "invoice-wizard-start" };
  }
  if (!flow) return null;
  if (flow.step === WIZARD_FIELDS.length) {
    if (/^(ja|j|bestätigen|bestaetigen)$/i.test(text)) {
      delete conversations[String(chatId)];
      await processInvoice(chatId, flow.data, deps);
      return { handled: true, action: "invoice-wizard-created" };
    }
    if (/^(nein|n)$/i.test(text)) {
      delete conversations[String(chatId)];
      await deps.reply(chatId, "Die Rechnung wurde nicht erstellt. Mit /invoice können Sie neu beginnen.");
      return { handled: true, action: "invoice-wizard-cancelled" };
    }
    await deps.reply(chatId, "Bitte antworten Sie mit JA, um die PDF-Rechnung zu erstellen, oder NEIN zum Abbrechen.");
    return { handled: true, action: "invoice-wizard-confirm" };
  }
  const [field] = WIZARD_FIELDS[flow.step];
  let value = text.trim();
  if (!value) {
    await deps.reply(chatId, "Bitte geben Sie einen Wert ein. " + WIZARD_FIELDS[flow.step][1]);
    return { handled: true, action: "invoice-wizard-invalid" };
  }
  if (field === "date" || field === "due") {
    value = germanDate(value);
    if (!value) {
      await deps.reply(chatId, "Bitte verwenden Sie das Format TT.MM.JJJJ, zum Beispiel 07.11.2026.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
  }
  if (field === "quantity" || field === "unitPrice") {
    value = Number(value.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0 || (field === "quantity" && value > 10000)) {
      await deps.reply(chatId, "Bitte geben Sie eine gültige positive Zahl ein.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
  }
  if (field === "taxRate") {
    const normalized = value.toLowerCase();
    value = normalized === "keine" ? "none" : normalized;
    if (!["19", "7", "0", "none"].includes(value)) {
      await deps.reply(chatId, "Bitte wählen Sie 19, 7, 0 oder keine.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
  }
  flow.data[field] = value;
  flow.step += 1;
  if (flow.step < WIZARD_FIELDS.length) {
    await deps.reply(chatId, "Danke!\n\n" + WIZARD_FIELDS[flow.step][1]);
  } else {
    flow.data.items = [{ description: flow.data.description, quantity: flow.data.quantity, unitPrice: flow.data.unitPrice }];
    delete flow.data.description;
    delete flow.data.quantity;
    delete flow.data.unitPrice;
    flow.data.documentType = "invoice";
    const d = flow.data;
    await deps.reply(chatId,
      "🧾 Bitte prüfen Sie Ihre Angaben:\n\n" +
      "Absender: " + d.seller + "\nAdresse: " + d.sellerAddress + "\n" +
      "Kunde: " + d.customer + "\nKundenadresse: " + d.customerAddress + "\n" +
      "Rechnungsnummer: " + d.number + "\nDatum: " + d.date + "\nFällig: " + d.due + "\n" +
      "Position: " + d.items[0].description + "\nMenge: " + d.items[0].quantity + "\nEinzelpreis: " + d.items[0].unitPrice + " EUR\n" +
      "Umsatzsteuer: " + (d.taxRate === "none" ? "Keine" : d.taxRate + " %") +
      "\n\nAntworten Sie mit JA, um die PDF zu erstellen, oder NEIN zum Abbrechen."
    );
  }
  return { handled: true, action: "invoice-wizard-step", step: flow.step };
}

export async function handleTelegramUpdate(update, deps) {
  const message = update?.message;
  const chat = message?.chat;
  const sender = message?.from;
  if (!message || chat?.type !== "private" || !sender || !deps.allowedUserIds.has(String(sender.id))) return { ignored: true };

  const command = String(message.text || "").trim();
  try {
    const wizardResult = await handleInvoiceWizard(chat.id, command, deps);
    if (wizardResult) return wizardResult;
    if (command === "/start" || command === "/help") {
      await deps.reply(chat.id, HELP_TEXT);
      return { handled: true, action: "help" };
    }
    const statusCommand = /^\/(paid|sent|overdue|cancelled)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9._/-]{1,80})$/i.exec(command);
    if (statusCommand) {
      const status = ({ paid: "Paid", sent: "Sent", overdue: "Overdue", cancelled: "Cancelled" })[statusCommand[1].toLowerCase()];
      const updated = await deps.updateInvoiceStatus(statusCommand[2], status);
      await deps.reply(chat.id, updated.skipped ? "Die Notion-Verbindung ist noch nicht eingerichtet." : "Der Rechnungsstatus wurde auf „" + status + "“ gesetzt: " + updated.url);
      return { handled: true, action: "status", status };
    }
    const invoiceCommand = /^\/invoice(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(command);
    if (invoiceCommand) {
      const raw = (invoiceCommand[1] || "").trim();
      if (!raw) {
        return { handled: true, action: "invoice-help" };
      }
      let payload;
      try { payload = JSON.parse(raw); }
      catch {
        await deps.reply(chat.id, "Das JSON-Format ist ungültig. Bitte verwenden Sie die Struktur aus dem README-Beispiel.");
        return { handled: true, action: "invalid-json" };
      }
      await processInvoice(chat.id, payload, deps);
      return { handled: true, action: "invoice" };
    }
    await deps.reply(chat.id, "Für Hilfe senden Sie /help.");
    return { handled: true, action: "unknown-command" };
  } catch (error) {
    await deps.reply(chat.id, "Der Vorgang ist fehlgeschlagen: " + safeError(error));
    return { handled: true, action: "error" };
  }
}

async function readState(stateFile) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return { nextOffset: Number.isSafeInteger(state.nextOffset) && state.nextOffset >= 0 ? state.nextOffset : undefined, conversations: state.conversations && typeof state.conversations === "object" ? state.conversations : {} };
  } catch (error) {
    if (error.code === "ENOENT") return { nextOffset: undefined };
    throw new Error("Der Telegram-Status konnte nicht gelesen werden: " + safeError(error));
  }
}

async function writeState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporaryFile = stateFile + ".tmp";
  await writeFile(temporaryFile, JSON.stringify(state), { mode: 0o600 });
  await rename(temporaryFile, stateFile);
}

export async function runPolling(options = {}) {
  const env = options.env || process.env;
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const allowedUserIds = new Set(String(env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map(value => value.trim()).filter(Boolean));
  const notionConfigured = Boolean(String(env.NOTION_API_KEY || "").trim() && String(env.NOTION_DATA_SOURCE_ID || env.NOTION_INVOICES_DATABASE_ID || "").trim());
  if (!token) throw new Error("Das GitHub-Secret TELEGRAM_BOT_TOKEN fehlt.");
  if (allowedUserIds.size === 0) throw new Error("Das GitHub-Secret TELEGRAM_ALLOWED_USER_IDS fehlt.");
  if (!notionConfigured) throw new Error("NOTION_API_KEY und NOTION_DATA_SOURCE_ID müssen eingerichtet sein.");

  const stateFile = resolve(options.stateFile || env.STATE_FILE || "./data/telegram-updates.json");
  const state = await readState(stateFile);
  const api = (method, payload) => (options.telegramRequest || telegramApi)(token, method, payload);
  const webhookInfo = await api("getWebhookInfo", {});
  if (webhookInfo?.url) throw new Error("Für diesen Bot ist noch ein Webhook aktiv. Der Polling-Modus kann nicht gleichzeitig mit einem Webhook laufen.");

  const updates = await api("getUpdates", {
    ...(state.nextOffset !== undefined ? { offset: state.nextOffset } : {}),
    limit: 100, timeout: 0, allowed_updates: ["message"]
  });
  const deps = {
    allowedUserIds,
    conversations: state.conversations,
    reply: (chatId, text) => api("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    sendDocument: (chatId, pdf, filename, caption) => (options.sendDocument || sendTelegramDocument)(token, chatId, pdf, filename, caption),
    renderInvoicePdf: options.renderInvoicePdf || renderInvoicePdf,
    getInvoiceFromNotion: options.getInvoiceFromNotion || getInvoiceFromNotion,
    saveInvoiceToNotion: options.saveInvoiceToNotion || saveInvoiceToNotion,
    updateInvoiceStatus: options.updateInvoiceStatus || updateInvoiceStatus
  };
  let handled = 0;
  for (const update of updates || []) {
    await handleTelegramUpdate(update, deps);
    if (Number.isSafeInteger(update.update_id)) {
      state.nextOffset = update.update_id + 1;
      await writeState(stateFile, state);
    }
    handled += 1;
  }
  if (state.nextOffset === undefined) await writeState(stateFile, state);
  return { received: (updates || []).length, handled, nextOffset: state.nextOffset ?? null };
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entrypoint && import.meta.url === entrypoint) {
  runPolling()
    .then(result => console.log("Rechnio Telegram-Polling abgeschlossen:", JSON.stringify(result)))
    .catch(error => {
      console.error("Rechnio Telegram-Polling fehlgeschlagen:", safeError(error));
      process.exitCode = 1;
    });
}
