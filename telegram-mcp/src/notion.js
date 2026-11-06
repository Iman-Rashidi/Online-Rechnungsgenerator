const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const ALLOWED_STATUSES = new Set(["Draft", "Sent", "Paid", "Overdue", "Cancelled"]);
const MAHNUNG_LEVELS = ["None", "Reminder", "First Mahnung", "Second Mahnung", "Final Mahnung"];

function config() {
  const token = (process.env.NOTION_API_KEY || "").trim();
  const dataSourceId = (process.env.NOTION_DATA_SOURCE_ID || process.env.NOTION_INVOICES_DATABASE_ID || "").trim();
  return token && dataSourceId ? { token, dataSourceId } : null;
}

async function notionRequest(path, { token, method = "GET", body } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.message || data.code || "unknown error";
    throw new Error("Notion API error " + response.status + ": " + reason);
  }
  return data;
}

function textValue(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function propertyText(page, property) {
  const p = page?.properties?.[property];
  return (p?.rich_text || p?.title || []).map(part => part.plain_text || part.text?.content || "").join("");
}

function propertyNumber(page, property) {
  const value = page?.properties?.[property]?.number;
  return Number.isFinite(value) ? value : null;
}

function propertySelect(page, property) {
  return page?.properties?.[property]?.select?.name || null;
}

async function findByInvoiceNumber(invoiceNumber) {
  const cfg = config();
  if (!cfg) return { configured: false, page: null };
  const result = await notionRequest("/data_sources/" + encodeURIComponent(cfg.dataSourceId) + "/query", {
    token: cfg.token,
    method: "POST",
    body: {
      filter: {
        property: "Invoice number",
        rich_text: { equals: String(invoiceNumber).trim() }
      },
      page_size: 10
    }
  });
  return { configured: true, page: result.results?.length === 1 ? result.results[0] : null, matches: result.results || [] };
}

export async function getInvoiceFromNotion(invoiceNumber) {
  const result = await findByInvoiceNumber(invoiceNumber);
  if (!result.configured || !result.page) return null;
  return {
    id: result.page.id,
    url: result.page.url,
    customer: propertyText(result.page, "Customer"),
    taxRate: propertyNumber(result.page, "Tax rate %"),
    net: propertyNumber(result.page, "Net amount"),
    gross: propertyNumber(result.page, "Gross amount"),
    status: propertySelect(result.page, "Status"),
    mahnungLevel: propertySelect(result.page, "Mahnung level")
  };
}

function pageProperties(input, totals, { documentType, originalInvoice, mahnungLevel }) {
  const isMahnung = documentType === "mahnung";
  const rate = input.taxRate === "none" ? 0 : Number(input.taxRate ?? 19);
  const notes = [
    input.note,
    input.reminderFee ? "Mahngebühr: " + Number(input.reminderFee).toFixed(2) + " EUR" : "",
    originalInvoice ? "Bezug zur ursprünglichen Rechnung: " + originalInvoice : ""
  ].filter(Boolean).join("\n");
  return {
    "Invoice": { title: [{ text: { content: (isMahnung ? "Mahnung " : "") + textValue(input.number) + " · " + textValue(input.customer) } }] },
    "Invoice number": { rich_text: [{ text: { content: textValue(input.number) } }] },
    "Original invoice number": { rich_text: originalInvoice ? [{ text: { content: textValue(originalInvoice) } }] : [] },
    "Document type": { select: { name: isMahnung ? "Mahnung" : "Invoice" } },
    "Customer": { rich_text: [{ text: { content: textValue(input.customer) } }] },
    "Customer email": { email: input.customerEmail || null },
    "Invoice date": { date: { start: input.date } },
    "Due date": { date: { start: input.due } },
    "Net amount": { number: totals.net },
    "Tax rate %": { number: rate },
    "Gross amount": { number: totals.gross },
    "Status": { select: { name: "Draft" } },
    "Mahnung level": { select: { name: isMahnung ? mahnungLevel : "None" } },
    "Notes": { rich_text: notes ? [{ text: { content: notes.slice(0, 2000) } }] : [] }
  };
}

export async function updateInvoiceStatus(invoiceNumber, status) {
  if (!ALLOWED_STATUSES.has(status)) throw new Error("وضعیت انتخاب‌شده معتبر نیست.");
  const cfg = config();
  if (!cfg) return { skipped: true, reason: "Notion credentials not configured" };
  const result = await findByInvoiceNumber(invoiceNumber);
  if (result.matches.length !== 1) {
    throw new Error(result.matches.length ? "شماره فاکتور تکراری است؛ اصلاح دستی لازم است." : "فاکتور با این شماره در Notion پیدا نشد.");
  }
  const page = result.matches[0];
  const updated = await notionRequest("/pages/" + page.id, {
    token: cfg.token,
    method: "PATCH",
    body: { properties: { "Status": { select: { name: status } } } }
  });
  return { id: updated.id, url: updated.url, status };
}

export async function saveInvoiceToNotion(input, totals) {
  const cfg = config();
  if (!cfg) return { skipped: true, reason: "Notion credentials not configured" };

  const isMahnung = input.documentType === "mahnung";
  const existingResult = await findByInvoiceNumber(input.number);
  if (existingResult.matches.length > 1) {
    throw new Error("شماره فاکتور تکراری است؛ ابتدا رکوردهای تکراری را در Notion اصلاح کنید.");
  }
  if (existingResult.page) {
    const updated = await notionRequest("/pages/" + existingResult.page.id, {
      token: cfg.token,
      method: "PATCH",
      body: { properties: pageProperties(input, totals, {
        documentType: isMahnung ? "mahnung" : "invoice",
        originalInvoice: input.originalInvoice,
        mahnungLevel: input.mahnungLevel || "Reminder"
      }) }
    });
    return { id: updated.id, url: updated.url, updated: true };
  }

  let original = null;
  let mahnungLevel = "None";
  if (isMahnung) {
    if (!input.originalInvoice) throw new Error("شماره فاکتور اصلی برای Mahnung الزامی است.");
    const originalResult = await findByInvoiceNumber(input.originalInvoice);
    if (originalResult.matches.length !== 1) {
      throw new Error(originalResult.matches.length ? "شماره فاکتور اصلی در Notion تکراری است." : "فاکتور اصلی در Notion پیدا نشد؛ ابتدا آن را ثبت کنید.");
    }
    original = originalResult.page;
    const currentLevel = propertySelect(original, "Mahnung level") || "None";
    const currentIndex = MAHNUNG_LEVELS.indexOf(currentLevel);
    mahnungLevel = input.mahnungLevel || MAHNUNG_LEVELS[Math.min(Math.max(currentIndex, 0) + 1, MAHNUNG_LEVELS.length - 1)];
    if (!MAHNUNG_LEVELS.includes(mahnungLevel) || mahnungLevel === "None") throw new Error("سطح Mahnung معتبر نیست.");
  }

  const created = await notionRequest("/pages", {
    token: cfg.token,
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: cfg.dataSourceId },
      properties: pageProperties(input, totals, {
        documentType: isMahnung ? "mahnung" : "invoice",
        originalInvoice: input.originalInvoice,
        mahnungLevel
      })
    }
  });

  if (original) {
    try {
      await notionRequest("/pages/" + original.id, {
        token: cfg.token,
        method: "PATCH",
        body: { properties: {
          "Status": { select: { name: "Overdue" } },
          "Mahnung level": { select: { name: mahnungLevel } }
        } }
      });
    } catch (error) {
      throw new Error("Mahnung ثبت شد اما وضعیت فاکتور اصلی به‌روزرسانی نشد: " + error.message);
    }
  }
  return { id: created.id, url: created.url, updated: false };
}
