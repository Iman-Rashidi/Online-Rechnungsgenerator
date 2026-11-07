const { test, expect } = require('@playwright/test');

const SITE = 'http://127.0.0.1:4173/';

test('invoice and reminder interactions plus printable A4 PDF', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(SITE, { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle(/Rechnio/);
  await expect(page.locator('#documentType')).toBeVisible();
  await expect(page.locator('#items > *')).toHaveCount(1);

  await page.locator('#documentType').selectOption('mahnung');
  await expect(page.locator('#pDocumentTitle')).toHaveText('MAHNUNG');
  await expect(page.locator('#originalInvoice')).toBeVisible();
  await expect(page.locator('#originalDue')).toBeVisible();
  await expect(page.locator('#reminderFee')).toBeVisible();
  await expect(page.locator('#pReminderFeeRow')).toBeHidden();

  await page.locator('#originalInvoice').fill('TEST-001');
  await page.locator('#originalDue').fill('2026-10-01');
  await page.locator('#reminderFee').fill('5');
  await expect(page.locator('#pReminderFeeRow')).toBeVisible();
  await page.locator('#paymentLocation').fill('Viersen');
  await expect(page.locator('#pMahnungInfo')).toContainText('TEST-001');
  await expect(page.locator('#pMahnungInfo')).toContainText('01.10.2026');
  await expect(page.locator('#pReminderFee')).toContainText('5,00');
  await expect(page.locator('#pPaymentLocation')).toContainText('Viersen');

  await page.locator('#add').click();
  await expect(page.locator('#items > *')).toHaveCount(2);
  await page.locator('#items .remove').last().click();
  await expect(page.locator('#items > *')).toHaveCount(1);

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

test('rounds invoice lines and tax to cents and renders descriptions as text', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'networkidle' });
  const row = page.locator('#items .item').first();
  const description = '<img src=x onerror=window.__rechnioXss=true>';
  await row.locator('.desc').fill(description);
  await row.locator('.qty').fill('3');
  await row.locator('.price').fill('0.10');

  await expect(page.locator('#pNet')).toHaveText('0,30 €');
  await expect(page.locator('#pTax')).toHaveText('0,06 €');
  await expect(page.locator('#pTotal')).toHaveText('0,36 €');
  await expect(page.locator('#pRows')).toContainText(description);
  await expect(page.locator('#pRows img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__rechnioXss)).toBeUndefined();

  await page.locator('#taxRate').selectOption('7');
  await expect(page.locator('#pTax')).toHaveText('0,02 €');
  await expect(page.locator('#pTotal')).toHaveText('0,32 €');
});

test('uses the local calendar date and resets to a valid default document', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'networkidle' });
  const localToday = await page.evaluate(() => {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  });
  await expect(page.locator('#date')).toHaveValue(localToday);
  await page.locator('#date').fill('2020-01-02');
  await page.locator('#reset').click();
  await expect(page.locator('#date')).toHaveValue(localToday);
  await expect(page.locator('#documentType')).toHaveValue('invoice');
  await expect(page.locator('#items > *')).toHaveCount(1);
  await expect(page.locator('#items .desc')).toHaveValue('Leistung');
  await expect(page.locator('#paymentTerms')).toHaveValue(/14 Tagen/);
});

test('rejects unsupported and oversized company logos', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.locator('#companyLogo').setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  });
  await expect(page.locator('#logoStatus')).toContainText('Ungültiges Format');
  await expect(page.locator('#pCompanyLogo')).toBeHidden();

  await page.locator('#companyLogo').setInputFiles({
    name: 'large.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1)
  });
  await expect(page.locator('#logoStatus')).toContainText('höchstens 2 MB');
  await expect(page.locator('#pCompanyLogo')).toBeHidden();
});


test('applies invoice color themes and places an uploaded company logo in the header', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'networkidle' });
  const preview = page.locator('#invoicePreview');
  await expect(preview).toHaveClass(/theme-ocean/);
  await expect(page.locator('#pDocumentTitle')).toHaveCSS('text-align', 'right');

  for (const theme of ['forest', 'violet', 'charcoal', 'ocean']) {
    await page.locator('#invoiceColor').selectOption(theme);
    await expect(preview).toHaveClass(new RegExp('theme-' + theme));
  }

  // A real 2x2 RGBA PNG avoids relying on a minimal image fixture that some
  // Chromium builds may accept as a data URL but fail to decode consistently.
  const logoPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGMUS1nwn4GBgYGJAQoAHz4CHS4itLQAAAAASUVORK5CYII=', 'base64');
  await page.locator('#companyLogo').setInputFiles({ name: 'company-logo.png', mimeType: 'image/png', buffer: logoPng });
  await expect(page.locator('#logoStatus')).toHaveText('Logo erfolgreich geladen.');
  await expect(page.locator('#pCompanyLogo')).toBeVisible();
  await expect(page.locator('#pCompanyLogo')).toHaveJSProperty('naturalWidth', 2);
  await expect(page.locator('.invoice-brandmark')).toBeHidden();
  await expect(preview).toHaveClass(/has-company-logo/);
});
