import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../../index.html");
const VALID_TAX_RATES = new Set(["19", "7", "0", "none"]);
const VALID_TEMPLATES = new Set(["classic", "modern", "compact"]);
const VALID_MAHNUNG_LEVELS = new Set(["Reminder", "First Mahnung", "Second Mahnung", "Final Mahnung"]);

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateInvoice(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("فرمت اطلاعات فاکتور معتبر نیست.");
  for (const key of ["seller", "customer", "number", "date", "due"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error("فیلد الزامی وارد نشده: " + key);
    if (input[key].length > 200) throw new Error("طول یکی از فیلدهای اصلی بیش از حد مجاز است.");
  }
  if (!isIsoDate(input.date) || !isIsoDate(input.due)) throw new Error("تاریخ فاکتور یا سررسید معتبر نیست.");
  if (input.due < input.date) throw new Error("تاریخ سررسید نمی‌تواند قبل از تاریخ فاکتور باشد.");
  if (input.originalDue && !isIsoDate(input.originalDue)) throw new Error("تاریخ سررسید اصلی معتبر نیست.");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new Error("فاکتور باید بین ۱ تا ۱۰۰ ردیف داشته باشد.");
  for (const [i, item] of input.items.entries()) {
    if (!item || typeof item.description !== "string" || !item.description.trim() || item.description.length > 500) throw new Error("شرح ردیف " + (i + 1) + " ناقص یا بیش از حد طولانی است.");
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || Number(item.quantity) > 10000) throw new Error("تعداد ردیف " + (i + 1) + " معتبر نیست.");
    if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0 || Number(item.unitPrice) > 100000) throw new Error("قیمت ردیف " + (i + 1) + " معتبر نیست.");
  }
  if (!VALID_TAX_RATES.has(String(input.taxRate ?? "19"))) throw new Error("نرخ مالیات نامعتبر است.");
  if (input.documentType && !["invoice", "mahnung"].includes(input.documentType)) throw new Error("نوع سند نامعتبر است.");
  if (input.documentType === "mahnung") {
    if (typeof input.originalInvoice !== "string" || !input.originalInvoice.trim()) throw new Error("برای Mahnung شماره فاکتور اصلی لازم است.");
    if (input.mahnungLevel && !VALID_MAHNUNG_LEVELS.has(input.mahnungLevel)) throw new Error("سطح Mahnung نامعتبر است.");
  }
  if (input.template && !VALID_TEMPLATES.has(input.template)) throw new Error("قالب فاکتور نامعتبر است.");
  if (input.reminderFee !== undefined && (!Number.isFinite(Number(input.reminderFee)) || Number(input.reminderFee) < 0 || Number(input.reminderFee) > 1000000)) {
    throw new Error("مبلغ جریمه Mahnung معتبر نیست.");
  }
  if (input.logoDataUrl !== undefined && typeof input.logoDataUrl !== "string") throw new Error("دادهٔ لوگو معتبر نیست.");
  if (input.logoDataUrl && input.logoDataUrl.length > 2_800_000) throw new Error("لوگو حداکثر باید ۲ مگابایت باشد.");
  return input;
}

export async function renderInvoicePdf(raw) {
  const input = validateInvoice(raw);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage({ locale: "de-DE" });
    await page.goto(pathToFileURL(appPath).href, { waitUntil: "load" });
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
    const firstRow = page.locator("#items .item").first();
    await firstRow.locator(".desc").fill(input.items[0].description);
    await firstRow.locator(".qty").fill(String(input.items[0].quantity));
    await firstRow.locator(".price").fill(String(input.items[0].unitPrice));
    for (const item of input.items.slice(1)) {
      await page.locator("#add").click();
      const row = page.locator("#items .item").last();
      await row.locator(".desc").fill(item.description);
      await row.locator(".qty").fill(String(item.quantity));
      await row.locator(".price").fill(String(item.unitPrice));
    }
    if (input.logoDataUrl) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input.logoDataUrl);
      if (!match) throw new Error("فرمت لوگو معتبر نیست.");
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length > 2 * 1024 * 1024) throw new Error("لوگو حداکثر باید ۲ مگابایت باشد.");
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      await page.locator("#companyLogo").setInputFiles({ name: "logo." + extension, mimeType: "image/" + match[1], buffer });
    }
    await page.waitForTimeout(200);
    const pdf = await page.pdf({
      format: "A4", printBackground: true, preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" }
    });
    const net = input.items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.unitPrice) * 100), 0);
    const rate = input.taxRate === "none" ? 0 : Number(input.taxRate ?? 19);
    const tax = Math.round(net * rate / 100);
    const fee = input.documentType === "mahnung" ? Math.round(Number(input.reminderFee || 0) * 100) : 0;
    return {
      pdf,
      totals: { net: net / 100, tax: tax / 100, gross: (net + tax + fee) / 100 },
      documentType: input.documentType || "invoice"
    };
  } finally {
    await browser.close();
  }
}
