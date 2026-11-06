import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceFromNotion, saveInvoiceToNotion, updateInvoiceStatus } from "../src/notion.js";

test("creates an invoice with schema-matching Notion properties and updates payment status", async () => {
  const oldFetch = global.fetch;
  const oldToken = process.env.NOTION_API_KEY;
  const oldSource = process.env.NOTION_DATA_SOURCE_ID;
  process.env.NOTION_API_KEY = "test-notion-token";
  process.env.NOTION_DATA_SOURCE_ID = "test-data-source";
  const calls = [];
  let queryResults = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/query")) {
      return new Response(JSON.stringify({ results: queryResults }), { status: 200 });
    }
    if (String(url).endsWith("/pages") && options.method === "POST") {
      return new Response(JSON.stringify({ id: "created-page", url: "https://www.notion.so/created-page" }), { status: 200 });
    }
    if (String(url).includes("/pages/") && options.method === "PATCH") {
      return new Response(JSON.stringify({ id: "existing-page", url: "https://www.notion.so/existing-page" }), { status: 200 });
    }
    throw new Error("Unexpected Notion test request: " + url);
  };

  try {
    const input = {
      seller: "Test GmbH", customer: "Musterkunde", number: "RE-TEST-001",
      date: "2026-11-06", due: "2026-11-20",
      items: [{ description: "Leistung", quantity: 1, unitPrice: 100 }],
      taxRate: "19", customerEmail: "test@example.invalid"
    };
    const created = await saveInvoiceToNotion(input, { net: 100, tax: 19, gross: 119 });
    assert.equal(created.id, "created-page");
    const createCall = calls.find(call => call.url.endsWith("/pages") && call.method === "POST");
    assert.equal(createCall.body.parent.data_source_id, "test-data-source");
    assert.equal(createCall.body.properties.Invoice.number, undefined);
    assert.equal(createCall.body.properties["Invoice number"].rich_text[0].text.content, "RE-TEST-001");
    assert.equal(createCall.body.properties.Status.select.name, "Draft");
    assert.equal(createCall.body.properties["Mahnung level"].select.name, "None");

    queryResults = [{
      id: "existing-page",
      url: "https://www.notion.so/existing-page",
      properties: {
        "Customer": { rich_text: [{ plain_text: "Musterkunde" }] },
        "Tax rate %": { number: 7 },
        "Net amount": { number: 100 },
        "Gross amount": { number: 107 },
        "Status": { select: { name: "Draft" } },
        "Mahnung level": { select: { name: "None" } }
      }
    }];
    const original = await getInvoiceFromNotion("RE-TEST-001");
    assert.equal(original.taxRate, 7);
    assert.equal(original.customer, "Musterkunde");
    const updated = await updateInvoiceStatus("RE-TEST-001", "Paid");
    assert.equal(updated.status, "Paid");
    const patch = calls.find(call => call.url.endsWith("/existing-page") && call.method === "PATCH");
    assert.equal(patch.body.properties.Status.select.name, "Paid");
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_API_KEY; else process.env.NOTION_API_KEY = oldToken;
    if (oldSource === undefined) delete process.env.NOTION_DATA_SOURCE_ID; else process.env.NOTION_DATA_SOURCE_ID = oldSource;
  }
});
