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
  assert.deepEqual(await handleTelegramUpdate(message("/help", { chatType: "group" }), deps), { ignored: true });
  assert.deepEqual(await handleTelegramUpdate(message("/help", { userId: 555 }), deps), { ignored: true });
  assert.equal(deps.replies.length, 0);
});

test("sends German help for /start and /help", async () => {
  const deps = makeDeps();
  const result = await handleTelegramUpdate(message("/help"), deps);
  assert.equal(result.action, "help");
  assert.match(deps.replies[0].text, /Rechnio ist bereit/);
  assert.match(deps.replies[0].text, /Rechnung als bezahlt markieren/);
});

test("does not accept JSON and instructs users to use the step-by-step wizard", async () => {
  const deps = makeDeps({ conversations: {} });
  const result = await handleTelegramUpdate(message('/invoice {"number":"RE-TEST-001"}'), deps);
  assert.equal(result.action, "invoice-command-format");
  assert.match(deps.replies[0].text, /alle Fragen einzeln/);
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
    if (method === "getUpdates") return [{ update_id: 50, message: message("/help").message }];
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
  assert.deepEqual(result, { received: 1, handled: 1, nextOffset: 51 });
  assert.equal(calls[0].method, "getWebhookInfo");
  assert.equal(calls[1].method, "getUpdates");
  assert.equal(calls[1].payload.offset, undefined);
  const { readFile, unlink } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(tmp, "utf8"));
  assert.equal(saved.nextOffset, 51);
  await unlink(tmp);
});


test("collects invoice details one question at a time, supports multiple items and confirms before PDF creation", async () => {
  let rendered;
  const deps = makeDeps({
    conversations: {},
    renderInvoicePdf: async payload => {
      rendered = payload;
      return { pdf: Buffer.from("%PDF-demo"), totals: { net: 199.6, tax: 37.92, gross: 237.52 } };
    }
  });
  const send = text => handleTelegramUpdate(message(text), deps);
  const answers = [
    ["/invoice", /Name des Rechnungsausstellers/],
    ["Musterfirma GmbH", /vollständige Adresse des Rechnungsausstellers/],
    ["Musterstraße 1, 50667 Köln", /Name des Kunden/],
    ["Beispielkunde GmbH", /vollständige Adresse des Kunden/],
    ["Kundenweg 2, 50668 Köln", /Rechnungsnummer/],
    ["RE-2026-TEST-001", /Rechnungsdatum/],
    ["07.11.2026", /Rechnung fällig/],
    ["21.11.2026", /erste Position/],
    ["Beratung", /Wie viele Einheiten/],
    ["2", /Nettopreis pro Einheit/],
    ["49,90", /weitere Rechnungsposition/],
    ["JA", /erste Position/],
    ["Zusatzleistung", /Wie viele Einheiten/],
    ["1", /Nettopreis pro Einheit/],
    ["99,80", /weitere Rechnungsposition/],
    ["NEIN", /Umsatzsteuersatz/],
    ["19", /PDF-Layout/],
    ["modern", /Welche Farbe/],
    ["ozeanblau", /Bitte prüfen Sie Ihre Rechnung/]
  ];
  for (const [answer, expected] of answers) {
    await send(answer);
    assert.match(deps.replies.at(-1).text, expected);
  }
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

test("persists the step-by-step invoice wizard across polling runs", async () => {
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
  assert.equal(saved.conversations["987"].step, "sellerAddress");
  assert.equal(saved.conversations["987"].data.seller, "Musterfirma GmbH");
  await unlink(stateFile);
});

test("rejects invalid dates, quantities and tax rates without creating a PDF", async () => {
  const deps = makeDeps({ conversations: {} });
  const send = text => handleTelegramUpdate(message(text), deps);
  await send("/invoice");
  await send("Test GmbH");
  await send("Teststraße 1");
  await send("Kunde");
  await send("Kundenstraße 2");
  await send("RE-1");
  const invalidDate = await send("31.02.2026");
  assert.equal(invalidDate.action, "invoice-wizard-invalid");
  assert.match(deps.replies.at(-1).text, /Datumsformat/);
  await send("07.11.2026");
  await send("21.11.2026");
  await send("Dienstleistung");
  const invalidQuantity = await send("0");
  assert.equal(invalidQuantity.action, "invoice-wizard-invalid");
  assert.equal(deps.documents.length, 0);
});
