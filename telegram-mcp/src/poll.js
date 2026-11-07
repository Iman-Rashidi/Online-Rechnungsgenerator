import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderInvoicePdf } from "./invoice.js";
import { getInvoiceFromNotion, saveInvoiceToNotion, updateInvoiceStatus } from "./notion.js";

const HELP_TEXT = ["Rechnio ist bereit.", "", "Neue Rechnung mit einem Formular erstellen: /invoice", "Senden Sie alle Rechnungsangaben in EINER Nachricht. Netto, MwSt. und Brutto werden automatisch berechnet.", "Abbrechen: /cancel", "", "Rechnung als bezahlt markieren: /paid RE-2026-001", "Als versendet markieren: /sent RE-2026-001", "Als überfällig markieren: /overdue RE-2026-001", "Rechnung stornieren: /cancelled RE-2026-001"].join("\n");

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

const INVOICE_TEMPLATE = [
  "Absender:",
  "Adresse Absender:",
  "Empfänger:",
  "Adresse Empfänger:",
  "Rechnungsnummer:",
  "Rechnungsdatum (TT.MM.JJJJ):",
  "Fälligkeitsdatum (TT.MM.JJJJ):",
  "Beschreibung:",
  "Menge:",
  "Einzelpreis EUR:",
  "Umsatzsteuer (19, 7, 0 oder keine):"
].join("\n");

function germanDate(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  if (date.getFullYear() !== Number(match[3]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[1])) return null;
  return [match[3], match[2].padStart(2, "0"), match[1].padStart(2, "0")].join("-");
}

function parseInvoiceMessage(text) {
  const aliases = [
    ["seller", /^(?:absender|seller)$/i],
    ["sellerAddress", /^(?:adresse absender|absenderadresse|selleraddress)$/i],
    ["customer", /^(?:empfänger|empfaenger|kunde|customer)$/i],
    ["customerAddress", /^(?:adresse empfänger|adresse empfaenger|kundenadresse|customeraddress)$/i],
    ["number", /^(?:rechnungsnummer|nummer|number)$/i],
    ["date", /^(?:rechnungsdatum|datum|date)(?:\s*\(.*\))?$/i],
    ["due", /^(?:fälligkeitsdatum|faelligkeitsdatum|fällig|faellig|due)(?:\s*\(.*\))?$/i],
    ["description", /^(?:beschreibung|leistung|ware|description)$/i],
    ["quantity", /^(?:menge|quantity)$/i],
    ["unitPrice", /^(?:einzelpreis(?:\s*eur)?|preis|unitprice)$/i],
    ["taxRate", /^(?:umsatzsteuer(?:\s*\(.*\))?|mwst|steuer|taxrate)$/i]
  ];
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const pair = aliases.find(([, pattern]) => pattern.test(match[1].trim()));
    if (pair) values[pair[0]] = match[2].trim();
  }
  const required = ["seller", "sellerAddress", "customer", "customerAddress", "number", "date", "due", "description", "quantity", "unitPrice", "taxRate"];
  const missing = required.filter(key => !values[key]);
  if (missing.length) return { error: "Diese Angaben fehlen noch: " + missing.join(", ") + ". Bitte senden Sie alle 11 Zeilen in einer Nachricht." };

  values.date = germanDate(values.date);
  values.due = germanDate(values.due);
  if (!values.date || !values.due) return { error: "Bitte geben Sie beide Datumsangaben im Format TT.MM.JJJJ ein, zum Beispiel 07.11.2026." };

  const quantity = Number(values.quantity.replace(",", "."));
  const unitPrice = Number(values.unitPrice.replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) return { error: "Die Menge muss eine positive Zahl sein (maximal 10.000)." };
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return { error: "Der Einzelpreis muss eine positive Zahl sein." };

  const taxText = values.taxRate.toLowerCase();
  const taxRate = taxText === "keine" ? "none" : taxText.replace("%", "").trim();
  if (!["19", "7", "0", "none"].includes(taxRate)) return { error: "Bei Umsatzsteuer bitte 19, 7, 0 oder keine eintragen." };

  return {
    data: {
      seller: values.seller, sellerAddress: values.sellerAddress,
      customer: values.customer, customerAddress: values.customerAddress,
      number: values.number, date: values.date, due: values.due,
      items: [{ description: values.description, quantity, unitPrice }],
      taxRate, documentType: "invoice"
    }
  };
}

function invoiceSummary(data) {
  const item = data.items[0];
  const net = item.quantity * item.unitPrice;
  const rate = data.taxRate === "none" ? 0 : Number(data.taxRate);
  const tax = net * rate / 100;
  const gross = net + tax;
  return "🧾 Bitte prüfen Sie Ihre Rechnung:\n\n" +
    "Absender: " + data.seller + "\nAdresse: " + data.sellerAddress + "\n" +
    "Empfänger: " + data.customer + "\nAdresse: " + data.customerAddress + "\n" +
    "Rechnungsnummer: " + data.number + "\nDatum: " + data.date + "\nFällig: " + data.due + "\n" +
    "Beschreibung: " + item.description + "\nMenge: " + item.quantity + "\nEinzelpreis: " + item.unitPrice.toFixed(2) + " EUR\n" +
    "Netto: " + net.toFixed(2) + " EUR\nMwSt.: " + tax.toFixed(2) + " EUR (" + (data.taxRate === "none" ? "keine" : data.taxRate + " %") + ")\n" +
    "Brutto: " + gross.toFixed(2) + " EUR\n\nAntworten Sie mit JA, um die PDF-Rechnung zu erstellen, oder NEIN zum Abbrechen.";
}

async function handleInvoiceWizard(chatId, text, deps) {
  const conversations = deps.conversations || (deps.conversations = {});
  const key = String(chatId);
  let flow = conversations[key];

  if (text === "/cancel") {
    delete conversations[key];
    await deps.reply(chatId, "Die Rechnungserstellung wurde abgebrochen.");
    return { handled: true, action: "invoice-cancelled" };
  }
  if (/^\/invoice(?:@\w+)?$/i.test(text)) {
    conversations[key] = { awaitingData: true };
    await deps.reply(chatId,
      "🧾 Rechnung erstellen\n\nBitte kopieren Sie diese Vorlage, füllen Sie alle Angaben aus und senden Sie sie komplett in EINER Nachricht. Sie müssen nicht auf einzelne Fragen warten.\n\n" +
      INVOICE_TEMPLATE + "\n\nBeispiel für Zahlen: Menge 2, Einzelpreis 49,90.\nNetto, MwSt. und Brutto werden automatisch berechnet.\n\nAbbrechen: /cancel");
    return { handled: true, action: "invoice-form-start" };
  }
  if (!flow) return null;

  if (flow.awaitingConfirmation) {
    if (/^(ja|j|bestätigen|bestaetigen)$/i.test(text)) {
      delete conversations[key];
      await processInvoice(chatId, flow.data, deps);
      return { handled: true, action: "invoice-created" };
    }
    if (/^(nein|n)$/i.test(text)) {
      delete conversations[key];
      await deps.reply(chatId, "Die Rechnung wurde nicht erstellt. Mit /invoice können Sie neu beginnen.");
      return { handled: true, action: "invoice-cancelled" };
    }
    await deps.reply(chatId, "Bitte antworten Sie mit JA, um die PDF-Rechnung zu erstellen, oder NEIN zum Abbrechen.");
    return { handled: true, action: "invoice-confirm" };
  }

  if (flow.awaitingData) {
    const parsed = parseInvoiceMessage(text);
    if (parsed.error) {
      await deps.reply(chatId, "Die Angaben konnten noch nicht vollständig gelesen werden.\n" + parsed.error + "\n\nBitte senden Sie die vollständige Vorlage in einer Nachricht.");
      return { handled: true, action: "invoice-form-invalid" };
    }
    conversations[key] = { awaitingConfirmation: true, data: parsed.data };
    await deps.reply(chatId, invoiceSummary(parsed.data));
    return { handled: true, action: "invoice-form-review" };
  }
  delete conversations[key];
  return null;
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
  // Keep wizard state in the object that is persisted between scheduled polling runs.
  state.conversations ||= {};
  const api = (method, payload) => (options.telegramRequest || telegramApi)(token, method, payload);
  const webhookInfo = await api("getWebhookInfo", {});
  if (webhookInfo?.url) throw new Error("Für diesen Bot ist noch ein Webhook aktiv. Der Polling-Modus kann nicht gleichzeitig mit einem Webhook laufen.");

  const updates = await api("getUpdates", {
    ...(state.nextOffset !== undefined ? { offset: state.nextOffset } : {}),
    limit: 100, timeout: Number.isInteger(options.pollTimeoutSeconds) ? Math.min(50, Math.max(0, options.pollTimeoutSeconds)) : 0, allowed_updates: ["message"]
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
