import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../../index.html");

export function validateInvoice(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("فرمت اطلاعات فاکتور معتبر نیست.");
  const required = ["seller", "customer", "number", "date", "due", "items"];
  for (const key of required) if (!input[key]) throw new Error(`فیلد الزامی وارد نشده: ${key}`);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new Error("فاکتور باید بین ۱ تا ۱۰۰ ردیف داشته باشد.");
  for (const [i, item] of input.items.entries()) {
    if (!item || typeof item.description !== "string" || !item.description.trim()) throw new Error(`شرح ردیف ${i + 1} ناقص است.`);
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || Number(item.quantity) > 10000) throw new Error(`تعداد ردیف ${i + 1} معتبر نیست.`);
    if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0 || Number(item.unitPrice) > 100000) throw new Error(`قیمت ردیف ${i + 1} معتبر نیست.`);
  }
  if (!["19", "7", "0", "none"].includes(String(input.taxRate ?? "19"))) throw new Error("نرخ مالیات نامعتبر است.");
  if (input.documentType && !["invoice", "mahnung"].includes(input.documentType)) throw new Error("نوع سند نامعتبر است.");
  if (input.documentType === "mahnung" && !input.originalInvoice) throw new Error("برای Mahnung شماره فاکتور اصلی لازم است.");
  return input;
}

export async function renderInvoicePdf(raw) {
  const input = validateInvoice(raw);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ locale: "de-DE" });
    await page.goto(new URL(`file://${appPath}`).href, { waitUntil: "load" });
    const textFields = {
      seller: input.seller, email: input.email, sellerAddress: input.sellerAddress,
      taxNumber: input.taxNumber, vatId: input.vatId, bankName: input.bankName,
      accountHolder: input.accountHolder, iban: input.iban, bic: input.bic,
      paymentTerms: input.paymentTerms, paymentLocation: input.paymentLocation,
      customer: input.customer, customerAddress: input.customerAddress,
      number: input.number, date: input.date, due: input.due, note: input.note || "",
      originalInvoice: input.originalInvoice || "", originalDue: input.originalDue || "",
      reminderFee: String(input.reminderFee ?? 0)
    };
    for (const [id, value] of Object.entries(textFields)) await page.locator("#" + id).fill(String(value ?? ""));
    await page.locator("#documentType").selectOption(input.documentType || "invoice");
    await page.locator("#taxRate").selectOption(String(input.taxRate ?? "19"));
    await page.locator("#invoiceTemplate").selectOption(input.template || "classic");
    await page.locator("#items").locator(".item").first().locator(".desc").fill(input.items[0].description);
    await page.locator("#items").locator(".item").first().locator(".qty").fill(String(input.items[0].quantity));
    await page.locator("#items").locator(".item").first().locator(".price").fill(String(input.items[0].unitPrice));
    for (const item of input.items.slice(1)) {
      await page.locator("#add").click();
      const row = page.locator("#items .item").last();
      await row.locator(".desc").fill(item.description);
      await row.locator(".qty").fill(String(item.quantity));
      await row.locator(".price").fill(String(item.unitPrice));
    }
    if (input.logoDataUrl && /^data:image\/(png|jpeg|webp);base64,/.test(input.logoDataUrl)) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input.logoDataUrl);
      if (!match) throw new Error("فرمت لوگو معتبر نیست.");
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length > 2 * 1024 * 1024) throw new Error("لوگو حداکثر باید ۲ مگابایت باشد.");
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      await page.locator("#companyLogo").setInputFiles({ name: "logo." + extension, mimeType: "image/" + match[1], buffer });
    }
    await page.waitForTimeout(150);
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
    const net = input.items.reduce((sum, x) => sum + Math.round(Number(x.quantity) * Number(x.unitPrice) * 100), 0);
    const rate = input.taxRate === "none" ? 0 : Number(input.taxRate ?? 19);
    const tax = Math.round(net * rate / 100);
    const fee = input.documentType === "mahnung" ? Math.round(Number(input.reminderFee || 0) * 100) : 0;
    return { pdf, totals: { net: net / 100, tax: tax / 100, gross: (net + tax + fee) / 100 }, documentType: input.documentType || "invoice" };
  } finally {
    await browser.close();
  }
}
