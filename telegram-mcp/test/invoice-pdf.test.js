import test from "node:test";
import assert from "node:assert/strict";
import { renderInvoicePdf } from "../src/invoice.js";

test("renders a real German invoice PDF and calculates net, tax and gross totals", async () => {
  const result = await renderInvoicePdf({
    seller: "Musterfirma GmbH",
    sellerAddress: "Musterstraße 1, 50667 Köln",
    customer: "Beispielkunde GmbH",
    customerAddress: "Kundenweg 2, 50668 Köln",
    number: "RE-2026-TEST-001",
    date: "2026-11-07",
    due: "2026-11-21",
    items: [{ description: "Testleistung", quantity: 2, unitPrice: 49.90 }],
    taxRate: "19",
    documentType: "invoice"
  });
  assert.ok(Buffer.isBuffer(result.pdf));
  assert.ok(result.pdf.length > 1000);
  assert.equal(result.pdf.subarray(0, 4).toString("ascii"), "%PDF");
  assert.deepEqual(result.totals, { net: 99.8, tax: 18.96, gross: 118.76 });
});
