const { test, expect } = require('@playwright/test');

const SITE = 'https://iman-rashidi.github.io/Online-Rechnungsgenerator/';

test('invoice and reminder interactions plus printable A4 PDF', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(SITE, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Rechnung erstellen' })).toBeVisible();
  await expect(page.locator('.item')).toHaveCount(1);

  await page.locator('#documentType').selectOption('mahnung');
  await expect(page.locator('#pDocumentTitle')).toHaveText('MAHNUNG');
  await expect(page.locator('#originalInvoice')).toBeVisible();
  await expect(page.locator('#originalDue')).toBeVisible();
  await expect(page.locator('#reminderFee')).toBeVisible();

  await page.locator('#originalInvoice').fill('TEST-001');
  await page.locator('#originalDue').fill('2026-10-01');
  await page.locator('#reminderFee').fill('5');
  await page.locator('#paymentLocation').fill('Viersen');
  await expect(page.locator('#pMahnungInfo')).toContainText('TEST-001');
  await expect(page.locator('#pMahnungInfo')).toContainText('01.10.2026');
  await expect(page.locator('#pReminderFee')).toContainText('5,00');
  await expect(page.locator('#pPayment')).toContainText('Viersen');

  await page.locator('#add').click();
  await expect(page.locator('.item')).toHaveCount(2);
  await page.locator('.item .remove').last().click();
  await expect(page.locator('.item')).toHaveCount(1);

  await page.evaluate(() => {
    window.__rechnioPrintCalled = false;
    window.print = () => { window.__rechnioPrintCalled = true; };
  });
  await page.locator('#print').click();
  expect(await page.evaluate(() => window.__rechnioPrintCalled)).toBe(true);

  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(1000);
  expect(pageErrors).toEqual([]);
});
