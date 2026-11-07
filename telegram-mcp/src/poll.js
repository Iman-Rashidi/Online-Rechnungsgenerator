import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderInvoicePdf } from "./invoice.js";
import { getInvoiceFromNotion, saveInvoiceToNotion, updateInvoiceStatus } from "./notion.js";

const HELP_TEXT = ["Rechnio ist bereit.", "", "Neue Rechnung Schritt für Schritt erstellen: /invoice", "Ich frage alle Angaben einzeln ab. Mehrere Rechnungspositionen sind möglich. Netto, MwSt. und Brutto werden automatisch berechnet.", "Abbrechen: /cancel", "", "Rechnung als bezahlt markieren: /paid RE-2026-001", "Als versendet markieren: /sent RE-2026-001", "Als überfällig markieren: /overdue RE-2026-001", "Rechnung stornieren: /cancelled RE-2026-001"].join("\n");

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

const WIZARD_STEPS = [
  ["seller", "Wie lautet der Name des Rechnungsausstellers (Person oder Unternehmen)?"],
  ["sellerAddress", "Wie lautet die vollständige Adresse des Rechnungsausstellers?"],
  ["customer", "Wie lautet der Name des Kunden (Person oder Unternehmen)?"],
  ["customerAddress", "Wie lautet die vollständige Adresse des Kunden?"],
  ["number", "Welche Rechnungsnummer soll verwendet werden?"],
  ["date", "Wie lautet das Rechnungsdatum? Bitte im Format TT.MM.JJJJ eingeben."],
  ["due", "Wann ist die Rechnung fällig? Bitte im Format TT.MM.JJJJ eingeben."],
  ["description", "Was wird berechnet? Bitte beschreiben Sie die erste Position."]
];

function germanDate(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  if (date.getFullYear() !== Number(match[3]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[1])) return null;
  return [match[3], match[2].padStart(2, "0"), match[1].padStart(2, "0")].join("-");
}

function formatGermanDate(value) {
  const [year, month, day] = value.split("-");
  return [day, month, year].join(".");
}

function invoiceSummary(data) {
  const netCents = data.items.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPrice * 100), 0);
  const rate = data.taxRate === "none" ? 0 : Number(data.taxRate);
  const taxCents = Math.round(netCents * rate / 100);
  const grossCents = netCents + taxCents;
  const money = cents => (cents / 100).toFixed(2);
  const positions = data.items.map((item, index) => {
    const lineCents = Math.round(item.quantity * item.unitPrice * 100);
    return (index + 1) + ". " + item.description + " | " + item.quantity + " × " +
      item.unitPrice.toFixed(2) + " EUR = " + money(lineCents) + " EUR";
  }).join("\n");
  return "🧾 Bitte prüfen Sie Ihre Rechnung:\n\n" +
    "Absender: " + data.seller + "\nAdresse: " + data.sellerAddress + "\n" +
    "Empfänger: " + data.customer + "\nAdresse: " + data.customerAddress + "\n" +
    "Rechnungsnummer: " + data.number + "\nRechnungsdatum: " + formatGermanDate(data.date) +
    "\nFälligkeitsdatum: " + formatGermanDate(data.due) + "\n\nPositionen:\n" + positions +
    "\n\nNetto: " + money(netCents) + " EUR\nMwSt.: " + money(taxCents) + " EUR (" +
    (data.taxRate === "none" ? "keine" : data.taxRate + " %") + ")\nBrutto: " + money(grossCents) +
    " EUR\n\nLayout: " + ({ classic: "klassisch", modern: "modern", compact: "kompakt" })[data.template] +
    "\nFarbe: " + ({ ocean: "ozeanblau", forest: "waldgrün", violet: "violett", charcoal: "schiefergrau" })[data.colorTheme] +
    "\n\nAntworten Sie mit JA, um die PDF-Rechnung zu erstellen, oder NEIN zum Abbrechen.";
}

function nextWizardPrompt(flow) {
  if (flow.step === "quantity") return "Wie viele Einheiten?";
  if (flow.step === "unitPrice") return "Wie hoch ist der Nettopreis pro Einheit in EUR? Beispiel: 49,90";
  if (flow.step === "moreItems") return "Möchten Sie eine weitere Rechnungsposition hinzufügen? Antworten Sie mit JA oder NEIN.";
  if (flow.step === "taxRate") return "Welcher Umsatzsteuersatz gilt? Antworten Sie mit 19, 7, 0 oder keine.";
  if (flow.step === "template") return "Welches PDF-Layout möchten Sie? Antworten Sie mit klassisch, modern oder kompakt.";
  if (flow.step === "colorTheme") return "Welche Farbe möchten Sie? Antworten Sie mit ozeanblau, waldgrün, violett oder schiefergrau.";
  const entry = WIZARD_STEPS.find(([key]) => key === flow.step);
  return entry ? entry[1] : "Bitte beantworten Sie die letzte Frage.";
}

async function handleInvoiceWizard(chatId, text, deps) {
  const conversations = deps.conversations || (deps.conversations = {});
  const key = String(chatId);
  let flow = conversations[key];
  const input = text.trim();

  if (input === "/cancel") {
    delete conversations[key];
    await deps.reply(chatId, "Die Rechnungserstellung wurde abgebrochen.");
    return { handled: true, action: "invoice-cancelled" };
  }
  if (/^\/invoice(?:@\w+)?$/i.test(input)) {
    conversations[key] = { step: "seller", data: { items: [] }, item: {} };
    await deps.reply(chatId, "🧾 Wir erstellen Ihre Rechnung Schritt für Schritt.\nSie können mehrere Positionen hinzufügen. Netto, MwSt. und Brutto berechne ich automatisch.\n\n" + nextWizardPrompt(conversations[key]) + "\n\nAbbrechen: /cancel");
    return { handled: true, action: "invoice-form-start" };
  }
  if (!flow) return null;
  if (/^\/(?:start|help)(?:@\w+)?$/i.test(input)) return null;
  if (input.startsWith("/")) {
    await deps.reply(chatId, "Bitte beantworten Sie die aktuelle Frage oder senden Sie /cancel zum Abbrechen.\n\n" + nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-prompt" };
  }

  if (flow.awaitingConfirmation) {
    if (/^(ja|j|bestätigen|bestaetigen)$/i.test(input)) {
      delete conversations[key];
      await processInvoice(chatId, flow.data, deps);
      return { handled: true, action: "invoice-created" };
    }
    if (/^(nein|n|abbrechen)$/i.test(input)) {
      delete conversations[key];
      await deps.reply(chatId, "Die Rechnung wurde nicht erstellt. Mit /invoice können Sie neu beginnen.");
      return { handled: true, action: "invoice-cancelled" };
    }
    await deps.reply(chatId, "Bitte antworten Sie mit JA zum Erstellen oder NEIN zum Abbrechen.");
    return { handled: true, action: "invoice-confirm" };
  }

  const value = input.trim();
  if (!value) {
    await deps.reply(chatId, "Die Eingabe darf nicht leer sein.\n\n" + nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-invalid" };
  }

  const fieldIndex = WIZARD_STEPS.findIndex(([key]) => key === flow.step);
  if (fieldIndex >= 0) {
    const [field] = WIZARD_STEPS[fieldIndex];
    if (field === "date" || field === "due") {
      const date = germanDate(value);
      if (!date) {
        await deps.reply(chatId, "Bitte verwenden Sie das Datumsformat TT.MM.JJJJ, zum Beispiel 07.11.2026.");
        return { handled: true, action: "invoice-wizard-invalid" };
      }
      if (field === "due" && flow.data.date && date < flow.data.date) {
        await deps.reply(chatId, "Das Fälligkeitsdatum darf nicht vor dem Rechnungsdatum liegen. Bitte geben Sie ein späteres Datum ein.");
        return { handled: true, action: "invoice-wizard-invalid" };
      }
      flow.data[field] = date;
    } else if (field === "description") {
      flow.item.description = value;
      flow.step = "quantity";
      await deps.reply(chatId, nextWizardPrompt(flow));
      return { handled: true, action: "invoice-wizard-next" };
    } else {
      flow.data[field] = value;
    }
    if (field === "due") flow.step = "description";
    else flow.step = WIZARD_STEPS[fieldIndex + 1]?.[0] || "description";
    await deps.reply(chatId, nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-next" };
  }

  if (flow.step === "quantity" || flow.step === "unitPrice") {
    const number = Number(value.replace(",", "."));
    if (!Number.isFinite(number) || number <= 0 || (flow.step === "quantity" && number > 10000)) {
      await deps.reply(chatId, flow.step === "quantity" ? "Bitte geben Sie eine positive Menge bis maximal 10.000 ein." : "Bitte geben Sie einen positiven Nettopreis ein, zum Beispiel 49,90.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
    flow.item[flow.step] = number;
    if (flow.step === "quantity") flow.step = "unitPrice";
    else {
      flow.data.items.push(flow.item);
      flow.item = {};
      flow.step = "moreItems";
    }
    await deps.reply(chatId, nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-next" };
  }

  if (flow.step === "moreItems") {
    if (/^(ja|j)$/i.test(value)) flow.step = "description";
    else if (/^(nein|n)$/i.test(value)) flow.step = "taxRate";
    else {
      await deps.reply(chatId, "Bitte antworten Sie mit JA oder NEIN.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
    await deps.reply(chatId, nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-next" };
  }

  if (flow.step === "taxRate") {
    const taxText = value.toLowerCase().replace("%", "").trim();
    const taxRate = taxText === "keine" ? "none" : taxText;
    if (!["19", "7", "0", "none"].includes(taxRate)) {
      await deps.reply(chatId, "Bitte wählen Sie 19, 7, 0 oder keine.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
    flow.data.taxRate = taxRate;
    flow.step = "template";
    await deps.reply(chatId, nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-next" };
  }

  if (flow.step === "template") {
    const templates = { "klassisch": "classic", "classic": "classic", "modern": "modern", "kompakt": "compact", "compact": "compact" };
    const template = templates[value.toLowerCase()];
    if (!template) {
      await deps.reply(chatId, "Bitte wählen Sie klassisch, modern oder kompakt.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
    flow.data.template = template;
    flow.step = "colorTheme";
    await deps.reply(chatId, nextWizardPrompt(flow));
    return { handled: true, action: "invoice-wizard-next" };
  }

  if (flow.step === "colorTheme") {
    const colors = {
      "ozeanblau": "ocean", "ocean": "ocean",
      "waldgrün": "forest", "waldgruen": "forest", "forest": "forest",
      "violett": "violet", "violet": "violet",
      "schiefergrau": "charcoal", "charcoal": "charcoal"
    };
    const colorTheme = colors[value.toLowerCase()];
    if (!colorTheme) {
      await deps.reply(chatId, "Bitte wählen Sie ozeanblau, waldgrün, violett oder schiefergrau.");
      return { handled: true, action: "invoice-wizard-invalid" };
    }
    flow.data.colorTheme = colorTheme;
    flow.awaitingConfirmation = true;
    delete flow.step;
    await deps.reply(chatId, invoiceSummary(flow.data));
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
    if (/^\/invoice(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(command)) {
      await deps.reply(chat.id, "Bitte starten Sie die Rechnungserstellung nur mit /invoice. Danach stelle ich Ihnen alle Fragen einzeln.");
      return { handled: true, action: "invoice-command-format" };
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
