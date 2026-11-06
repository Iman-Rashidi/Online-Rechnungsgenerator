import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../src/invoice.js";

const good = { seller: "Example GmbH", customer: "Testkunde", number: "RE-1", date: "2026-11-06", due: "2026-11-20", items: [{ description: "Leistung", quantity: 2, unitPrice: 10 }], taxRate: "19" };

test("accepts a complete invoice payload", () => assert.equal(validateInvoice(good), good));
test("rejects missing required fields", () => assert.throws(() => validateInvoice({ ...good, customer: "" }), /Kunde/));
test("rejects empty or excessive item lists", () => assert.throws(() => validateInvoice({ ...good, items: [] }), /۱ تا ۱۰۰/));
test("rejects negative quantities", () => assert.throws(() => validateInvoice({ ...good, items: [{ ...good.items[0], quantity: -1 }] }), /تعداد/));
test("requires original invoice number for reminders", () => assert.throws(() => validateInvoice({ ...good, documentType: "mahnung" }), /شماره فاکتور اصلی/));
