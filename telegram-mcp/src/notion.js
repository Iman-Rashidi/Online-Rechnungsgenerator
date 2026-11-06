const API = "https://api.notion.com/v1";

export async function saveInvoiceToNotion(input, totals) {
  const token = (process.env.NOTION_API_KEY || "").trim();
  const databaseId = (process.env.NOTION_INVOICES_DATABASE_ID || "").trim();
  if (!token || !databaseId) return { skipped: true, reason: "Notion credentials not configured" };
  const properties = {
    "Invoice title": { title: [{ text: { content: `${input.number} · ${input.customer}`.slice(0, 2000) } }] },
    "Customer": { rich_text: [{ text: { content: String(input.customer).slice(0, 2000) } }] },
    "Customer email": { email: input.customerEmail || null },
    "Invoice date": { date: { start: input.date } },
    "Due date": { date: { start: input.due } },
    "Net amount EUR": { number: totals.net },
    "Tax rate %": { number: input.taxRate === "none" ? 0 : Number(input.taxRate ?? 19) },
    "Gross amount EUR": { number: totals.gross },
    "Status": { select: { name: "Open" } },
    "Mahnung level": { number: input.documentType === "mahnung" ? 1 : 0 },
    "Notes": { rich_text: [{ text: { content: [input.note, input.originalInvoice ? "Original invoice: " + input.originalInvoice : ""].filter(Boolean).join("\n").slice(0, 2000) } }] }
  };
  const response = await fetch(API + "/pages", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties })
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Notion API error " + response.status + ": " + (data.message || "unknown error"));
  return { id: data.id, url: data.url };
}
