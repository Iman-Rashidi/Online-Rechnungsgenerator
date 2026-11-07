import test from "node:test";
import assert from "node:assert/strict";
import { handleTelegramUpdate, runPolling } from "../src/poll.js";

function makeDeps(overrides = {}) {
  const replies = [];
  const documents = [];
  return {
    allowedUserIds: new Set(["123456"]),
    replies,
    documents,
    reply: async (chatId, text) => replies.push({ chatId, text }),
    sendDocument: async (chatId, pdf, filename, caption) => documents.push({ chatId, pdf, filename, caption }),
    renderInvoicePdf: async () => ({ pdf: Buffer.from("%PDF-demo"), totals: { net: 100, tax: 19, gross: 119 } }),
    getInvoiceFromNotion: async () => null,
    saveInvoiceToNotion: async () => ({ id: "notion-page", url: "https://notion.test/invoice" }),
    updateInvoiceStatus: async (_number, status) => ({ url: "https://notion.test/invoice", status }),
    ...overrides
  };
}

const message = (text, { userId = 123456, chatType = "private" } = {}) => ({
  message: { chat: { id: 987, type: chatType }, from: { id: userId }, text }
});

test("ignores group chats and users outside the allowlist", async () => {
  const deps = makeDeps();
  assert.deepEqual(await handleTelegramUpdate(message("/help", { chatType: "group" }), deps), { ignored: true, reason: "non-private" });
  assert.deepEqual(await handleTelegramUpdate(message("/help", { userId: 555 }), deps), { ignored: true, reason: "not-allowed" });
  assert.equal(deps.replies.length, 0);
});

test("sends German help for /start, /help and addressed bot commands", async () => {
  const deps = makeDeps();
  const start = await handleTelegramUpdate(message("/start@RechnioBot"), deps);
  const help = await handleTelegramUpdate(message("/help"), deps);
  assert.equal(start.action, "help");
  assert.equal(help.action, "help");
  assert.equal(deps.replies.length, 2);
  assert.match(deps.replies[0].text, /Rechnio ist bereit/);
  assert.match(deps.replies[0].text, /Rechnung als bezahlt markieren/);
});

test("does not accept JSON and explains the single-message form", async () => {
  const deps = makeDeps({ conversations: {} });
  const result = await handleTelegramUpdate(message('/invoice {"number":"RE-TEST-001"}'), deps);
  assert.equal(result.action, "invoice-command-format");
  assert.match(deps.replies[0].text, /Formular mit allen Angaben auf einmal/);
  assert.equal(deps.documents.length, 0);
});

test("updates invoice payment status using German confirmation", async () => {
  const deps = makeDeps();
  const result = await handleTelegramUpdate(message("/paid RE-TEST-001"), deps);
  assert.equal(result.status, "Paid");
  assert.match(deps.replies[0].text, /Rechnungsstatus wurde auf „Paid“ gesetzt/);
});

test("polling checks the webhook, processes updates, and persists the next offset", async () => {
  const calls = [];
  const tmp = "./data/poll-test-state.json";
  const telegramRequest = async (_token, method, payload) => {
    calls.push({ method, payload });
    if (method === "getWebhookInfo") return { url: "" };
    if (method === "getUpdates") return [
      { update_id: 50, message: message("/help").message },
      { update_id: 51, message: message("/help", { userId: 555 }).message }
    ];
    if (method === "sendMessage") return { message_id: 1 };
    throw new Error("Unexpected Telegram method: " + method);
  };
  const result = await runPolling({
    env: {
      TELEGRAM_BOT_TOKEN: "fake-token",
      TELEGRAM_ALLOWED_USER_IDS: "123456",
      NOTION_API_KEY: "fake-notion-key",
      NOTION_DATA_SOURCE_ID: "fake-data-source"
    },
    stateFile: tmp,
    telegramRequest,
    renderInvoicePdf: async () => ({ pdf: Buffer.from("%PDF-demo"), totals: { net: 0, tax: 0, gross: 0 } }),
    getInvoiceFromNotion: async () => null,
    saveInvoiceToNotion: async () => ({ skipped: true }),
    updateInvoiceStatus: async () => ({ skipped: true })
  });
  assert.deepEqual(result, {
    received: 2,
    handled: 1,
    ignored: 1,
    ignoredNonMessage: 0,
    ignoredNonPrivate: 0,
    ignoredMissingSender: 0,
    ignoredNotAllowed: 1,
    repliesSent: 1,
    replyFailures: 0,
    nextOffset: 52
  });
  assert.equal(calls[0].method, "getWebhookInfo");
  assert.equal(calls[1].method, "getUpdates");
  assert.equal(calls[1].payload.offset, undefined);
  const { readFile, unlink } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(tmp, "utf8"));
  assert.equal(saved.nextOffset, 52);
  await unlink(tmp);
});



test("answers basic Telegram commands when the optional Notion connection is unavailable", async () => {
  const stateFile = "./data/poll-no-notion-state.json";
  const sent = [];
  const result = await runPolling({
    env: { TELEGRAM_BOT_TOKEN: "fake-token", TELEGRAM_ALLOWED_USER_IDS: "123456" },
    stateFile,
    telegramRequest: async (_token, method) => {
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "getUpdates") return [{ update_id: 80, message: message("/start").message }];
      if (method === "sendMessage") { sent.push(true); return { message_id: 1 }; }
      throw new Error("Unexpected Telegram method: " + method);
    }
  });
  assert.equal(result.handled, 1);
  assert.equal(result.repliesSent, 1);
  assert.equal(sent.length, 1);
  const { unlink } = await import("node:fs/promises");
  await unlink(stateFile);
});

test("collects all invoice details in one message, supports multiple items and confirms before PDF creation", async () => {
  let rendered;
  const deps = makeDeps({
    conversations: {},
    renderInvoicePdf: async payload => {
      rendered = payload;
      return { pdf: Buffer.from("%PDF-demo"), totals: { net: 199.6, tax: 37.92, gross: 237.52 } };
    }
  });
  const send = text => handleTelegramUpdate(message(text), deps);
  assert.equal((await send("/invoice")).action, "invoice-form-start");
  assert.match(deps.replies.at(-1).text, /Absenderadresse:/);
  assert.match(deps.replies.at(-1).text, /Positionen:/);
  const form = [
    "Absender: Musterfirma GmbH",
    "Absenderadresse: Musterstraße 1, 50667 Köln",
    "Kunde: Beispielkunde GmbH",
    "Kundenadresse: Kundenweg 2, 50668 Köln",
    "Rechnungsnummer: RE-2026-TEST-001",
    "Rechnungsdatum: 07.11.2026",
    "Fällig am: 21.11.2026",
    "Positionen:",
    "Beratung | 2 | 49,90",
    "Zusatzleistung | 1 | 99,80",
    "MwSt: 19",
    "Layout: modern",
    "Farbe: ozeanblau"
  ].join("\n");
  assert.equal((await send(form)).action, "invoice-form-review");
  const summary = deps.replies.at(-1).text;
  assert.match(summary, /Netto: 199\.60 EUR/);
  assert.match(summary, /MwSt\.: 37\.92 EUR/);
  assert.match(summary, /Brutto: 237\.52 EUR/);
  assert.equal(deps.documents.length, 0);
  assert.equal((await send("JA")).action, "invoice-created");
  assert.equal(rendered.seller, "Musterfirma GmbH");
  assert.equal(rendered.date, "2026-11-07");
  assert.equal(rendered.items.length, 2);
  assert.equal(rendered.items[0].quantity, 2);
  assert.equal(rendered.items[0].unitPrice, 49.9);
  assert.equal(rendered.template, "modern");
  assert.equal(rendered.colorTheme, "ocean");
  assert.equal(deps.documents.length, 1);
  assert.equal(deps.documents[0].filename, "RE-2026-TEST-001.pdf");
  assert.equal(Object.keys(deps.conversations).length, 0);
});

test("validates the complete one-message form and rejects invalid positions", async () => {
  const deps = makeDeps({ conversations: {} });
  const send = text => handleTelegramUpdate(message(text), deps);
  await send("/invoice");
  const invalid = await send([
    "Absender: Test GmbH", "Absenderadresse: Teststraße 1", "Kunde: Kunde",
    "Kundenadresse: Kundenstraße 2", "Rechnungsnummer: RE-1",
    "Rechnungsdatum: 07.11.2026", "Fällig am: 21.11.2026",
    "Positionen:", "Dienstleistung | 0 | 20,00",
    "MwSt: 19", "Layout: modern", "Farbe: ozeanblau"
  ].join("\n"));
  assert.equal(invalid.action, "invoice-wizard-invalid");
  assert.match(deps.replies.at(-1).text, /Position/);
  assert.equal(deps.documents.length, 0);
});
test("persists the one-message invoice form across polling runs", async () => {
  const stateFile = "./data/poll-first-run-state.json";
  const sentMessages = [];
  const updates = [
    { update_id: 50, message: { chat: { id: 987, type: "private" }, from: { id: 123456 }, text: "/invoice" } },
    { update_id: 51, message: { chat: { id: 987, type: "private" }, from: { id: 123456 }, text: "Musterfirma GmbH" } }
  ];
  const telegramRequest = async (_token, method) => {
    if (method === "getWebhookInfo") return { url: "" };
    if (method === "getUpdates") return updates;
    if (method === "sendMessage") {
      sentMessages.push("sent");
      return { message_id: sentMessages.length };
    }
    throw new Error("Unexpected Telegram method: " + method);
  };
  await runPolling({
    env: {
      TELEGRAM_BOT_TOKEN: "fake-token",
      TELEGRAM_ALLOWED_USER_IDS: "123456",
      NOTION_API_KEY: "fake-notion-key",
      NOTION_DATA_SOURCE_ID: "fake-data-source"
    },
    stateFile,
    telegramRequest,
    renderInvoicePdf: async () => ({ pdf: Buffer.from("%PDF-demo"), totals: { net: 0, tax: 0, gross: 0 } }),
    getInvoiceFromNotion: async () => null,
    saveInvoiceToNotion: async () => ({ skipped: true }),
    updateInvoiceStatus: async () => ({ skipped: true })
  });
  assert.equal(sentMessages.length, 2);
  const { readFile, unlink } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.conversations["987"].step, "all-fields");
  await unlink(stateFile);
});

test("rejects invalid dates and invalid quantities in the one-message form", async () => {
  const deps = makeDeps({ conversations: {} });
  const send = text => handleTelegramUpdate(message(text), deps);
  await send("/invoice");
  const invalidDate = await send([
    "Absender: Test GmbH", "Absenderadresse: Teststraße 1", "Kunde: Kunde",
    "Kundenadresse: Kundenstraße 2", "Rechnungsnummer: RE-1",
    "Rechnungsdatum: 31.02.2026", "Fällig am: 21.11.2026",
    "Positionen:", "Dienstleistung | 1 | 20,00",
    "MwSt: 19", "Layout: modern", "Farbe: ozeanblau"
  ].join("\n"));
  assert.equal(invalidDate.action, "invoice-wizard-invalid");
  assert.match(deps.replies.at(-1).text, /Format TT\.MM\.JJJJ/);
  const invalidQuantity = await send([
    "Absender: Test GmbH", "Absenderadresse: Teststraße 1", "Kunde: Kunde",
    "Kundenadresse: Kundenstraße 2", "Rechnungsnummer: RE-1",
    "Rechnungsdatum: 07.11.2026", "Fällig am: 21.11.2026",
    "Positionen:", "Dienstleistung | 0 | 20,00",
    "MwSt: 19", "Layout: modern", "Farbe: ozeanblau"
  ].join("\n"));
  assert.equal(invalidQuantity.action, "invoice-wizard-invalid");
  assert.match(deps.replies.at(-1).text, /Position/);
  assert.equal(deps.documents.length, 0);
});


test("accepts a complete invoice form even when /invoice was not sent first", async () => {
  const deps = makeDeps({ conversations: {} });
  const form = [
    "Absender: Max Mustermann",
    "Absenderadresse: Musterstraße 12, 41747 Viersen",
    "Kunde: Anna Schmidt",
    "Kundenadresse: Hauptstraße 25, 41061 Mönchengladbach",
    "Rechnungsnummer: RE-2026-001",
    "Rechnungsdatum: 07.11.2026",
    "Fällig am: 21.11.2026",
    "Positionen:",
    "Webdesign | 2 | 49,90",
    "Logo-Erstellung | 1 | 99,80",
    "MwSt: 19",
    "Layout: modern",
    "Farbe: ozeanblau"
  ].join("\\n");
  const result = await handleTelegramUpdate(message(form), deps);
  assert.equal(result.action, "invoice-form-review");
  assert.match(deps.replies.at(-1).text, /Brutto:/);
  assert.match(deps.replies.at(-1).text, /JA/);
  assert.equal(deps.documents.length, 0);
});
