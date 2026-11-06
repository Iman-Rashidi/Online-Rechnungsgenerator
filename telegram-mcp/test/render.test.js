import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderInvoicePdf } from "../src/invoice.js";

test("renders invoice and Mahnung PDFs using the existing Rechnio page", async () => {
  const base = {
    seller: "Rechnio Test GmbH",
    sellerAddress: "Teststraße 1, 50667 Köln",
    customer: "Musterkunde GmbH",
    customerAddress: "Beispielweg 2, 50668 Köln",
    number: "RE-TEST-001",
    date: "2026-11-06",
    due: "2026-11-20",
    items: [
      { description: "Webdesign", quantity: 2, unitPrice: 10 },
      { description: "Wartung", quantity: 1, unitPrice: 5 }
    ],
    taxRate: "19",
    template: "modern",
    colorTheme: "forest",
    logoDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6fcAAAAASUVORK5CYII=",
    paymentTerms: "Bitte innerhalb von 14 Tagen überweisen."
  };

  const invoice = await renderInvoicePdf(base);
  assert.ok(invoice.pdf.subarray(0, 5).toString("ascii") === "%PDF-");
  const artifactsDir = resolve(process.cwd(), "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(resolve(artifactsDir, "rechnio-demo-invoice.pdf"), invoice.pdf);
  assert.deepEqual(invoice.totals, { net: 25, tax: 4.75, gross: 29.75 });
  assert.equal(invoice.documentType, "invoice");

  const reminder = await renderInvoicePdf({
    ...base,
    number: "MAH-TEST-001",
    documentType: "mahnung",
    originalInvoice: "RE-TEST-001",
    originalDue: "2026-11-20",
    reminderFee: 5,
    taxRate: "19",
    template: "compact",
    colorTheme: "charcoal"
  });
  assert.ok(reminder.pdf.subarray(0, 5).toString("ascii") === "%PDF-");
  await writeFile(resolve(artifactsDir, "rechnio-demo-mahnung.pdf"), reminder.pdf);
  assert.deepEqual(reminder.totals, { net: 25, tax: 4.75, gross: 34.75 });
  assert.equal(reminder.documentType, "mahnung");
});
