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

test("reports malformed invoice JSON in German without rendering", async () => {
  const deps = makeDeps();
  const result = await handleTelegramUpdate(message("/invoice {bad json"), deps);
  assert.equal(result.action, "invalid-json");
  assert.match(deps.replies[0].text, /JSON-Format ist ungültig/);
  assert.equal(deps.documents.length, 0);
});

test("creates a PDF, sends it to Telegram and records the invoice in Notion", async () => {
  const deps = makeDeps();
  const result = await handleTelegramUpdate(message('/invoice {"number":"RE-TEST-001"}'), deps);
  assert.equal(result.action, "invoice");
  assert.equal(deps.documents.length, 1);
  assert.equal(deps.documents[0].filename, "RE-TEST-001.pdf");
  assert.match(deps.replies.at(-1).text, /in Notion gespeichert/);
});

test("uses the stored tax rate and customer for Mahnungen", async () => {
  const deps = makeDeps({
    getInvoiceFromNotion: async number => {
      assert.equal(number, "RE-ORIGINAL-001");
      return { customer: "Musterkunde GmbH", taxRate: 7 };
    },
    renderInvoicePdf: async payload => {
      assert.equal(payload.taxRate, "7");
      assert.equal(payload.customer, "Musterkunde GmbH");
      return { pdf: Buffer.from("%PDF-demo"), totals: { net: 100, tax: 7, gross: 107 } };
    }
  });
  const result = await handleTelegramUpdate(message('/invoice {"documentType":"mahnung","originalInvoice":"RE-ORIGINAL-001","number":"MAH-001"}'), deps);
  assert.equal(result.action, "invoice");
  assert.equal(deps.documents.length, 1);
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
