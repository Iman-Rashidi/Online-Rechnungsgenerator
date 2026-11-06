import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../src/invoice.js";

const good = {
  seller: "Example GmbH", customer: "Testkunde", number: "RE-TEST-001",
  date: "2026-11-06", due: "2026-11-20",
  items: [{ description: "Webdesign", quantity: 2, unitPrice: 10 }],
  taxRate: "19", template: "modern"
};

test("accepts a complete invoice payload", () => assert.equal(validateInvoice(good), good));
test("rejects missing required fields", () => assert.throws(() => validateInvoice({ ...good, customer: "" }), /customer/));
test("rejects empty or excessive item lists", () => assert.throws(() => validateInvoice({ ...good, items: [] }), /۱ تا ۱۰۰/));
test("rejects negative quantities", () => assert.throws(() => validateInvoice({ ...good, items: [{ ...good.items[0], quantity: -1 }] }), /تعداد/));
test("rejects malformed dates and due dates before invoice date", () => {
  assert.throws(() => validateInvoice({ ...good, date: "2026-02-30" }), /تاریخ/);
  assert.throws(() => validateInvoice({ ...good, due: "2026-11-01" }), /سررسید/);
});
test("rejects unknown templates and tax rates", () => {
  assert.throws(() => validateInvoice({ ...good, template: "unknown" }), /قالب/);
  assert.throws(() => validateInvoice({ ...good, taxRate: "25" }), /مالیات/);
});
test("requires original invoice number and valid fee for reminders", () => {
  assert.throws(() => validateInvoice({ ...good, documentType: "mahnung" }), /شماره فاکتور اصلی/);
  assert.throws(() => validateInvoice({ ...good, documentType: "mahnung", originalInvoice: "RE-1", reminderFee: -1 }), /مبلغ جریمه/);
});
