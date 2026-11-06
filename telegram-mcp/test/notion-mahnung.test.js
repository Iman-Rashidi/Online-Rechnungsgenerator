import test from "node:test";
import assert from "node:assert/strict";
import { saveInvoiceToNotion } from "../src/notion.js";

test("creates a Mahnung linked to its original invoice and escalates the original record", async () => {
  const oldFetch = global.fetch;
  const oldToken = process.env.NOTION_API_KEY;
  const oldSource = process.env.NOTION_DATA_SOURCE_ID;
  process.env.NOTION_API_KEY = "test-notion-token";
  process.env.NOTION_DATA_SOURCE_ID = "test-data-source";
  const calls = [];
  const original = {
    id: "original-page",
    url: "https://www.notion.so/original-page",
    properties: {
      "Customer": { rich_text: [{ plain_text: "Musterkunde" }] },
      "Tax rate %": { number: 7 },
      "Status": { select: { name: "Overdue" } },
      "Mahnung level": { select: { name: "Reminder" } }
    }
  };

  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (String(url).endsWith("/query")) {
      const invoiceNumber = body.filter.rich_text.equals;
      return new Response(JSON.stringify({
        results: invoiceNumber === "RE-ORIGINAL-001" ? [original] : []
      }), { status: 200 });
    }
    if (String(url).endsWith("/pages") && options.method === "POST") {
      return new Response(JSON.stringify({ id: "mahnung-page", url: "https://www.notion.so/mahnung-page" }), { status: 200 });
    }
    if (String(url).endsWith("/pages/original-page") && options.method === "PATCH") {
      return new Response(JSON.stringify({ id: "original-page", url: original.url }), { status: 200 });
    }
    throw new Error("Unexpected Notion test request: " + url);
  };

  try {
    const result = await saveInvoiceToNotion({
      seller: "Test GmbH", customer: "Musterkunde", number: "MAH-TEST-001",
      date: "2026-11-06", due: "2026-11-13", originalInvoice: "RE-ORIGINAL-001",
      documentType: "mahnung", taxRate: "7",
      items: [{ description: "Leistung", quantity: 1, unitPrice: 100 }]
    }, { net: 100, tax: 7, gross: 107 });

    assert.equal(result.id, "mahnung-page");
    const create = calls.find(call => call.url.endsWith("/pages") && call.method === "POST");
    assert.equal(create.body.properties["Document type"].select.name, "Mahnung");
    assert.equal(create.body.properties["Original invoice number"].rich_text[0].text.content, "RE-ORIGINAL-001");
    assert.equal(create.body.properties["Mahnung level"].select.name, "First Mahnung");
    const patch = calls.find(call => call.url.endsWith("/pages/original-page") && call.method === "PATCH");
    assert.equal(patch.body.properties.Status.select.name, "Overdue");
    assert.equal(patch.body.properties["Mahnung level"].select.name, "First Mahnung");
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_API_KEY; else process.env.NOTION_API_KEY = oldToken;
    if (oldSource === undefined) delete process.env.NOTION_DATA_SOURCE_ID; else process.env.NOTION_DATA_SOURCE_ID = oldSource;
  }
});
