// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * UXArmy Contact Sales form monitor
 *  1. Field validation (required fields, email format, consent checkbox)
 *  2. Real submission + API response verification
 *
 * Env vars:
 *   TEST_EMAIL   – inbox used for the real submission (default qa+monitor@uxarmy.com)
 *   SKIP_SUBMIT  – "true" to run only validation checks (no lead created)
 */

const PAGE = '/contact-sales/';
const TEST_EMAIL = process.env.TEST_EMAIL || 'qa+monitor@uxarmy.com';
const MARKER = '[AUTOMATED MONITOR - please ignore]';

// Endpoints a WordPress form usually posts to (Elementor, CF7, WPForms, HubSpot…)
const SUBMIT_URL = /admin-ajax\.php|\/wp-json\/|hsforms|hubspot|\/submit|\/contact/i;
const SUCCESS_TEXT = /thank you|success|we.ll be in touch|received|connect with you/i;

async function openForm(page) {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

  // Dismiss cookie banner (privacy-preserving choice)
  const reject = page.getByRole('button', { name: /reject all/i }).first();
  if (await reject.isVisible({ timeout: 5000 }).catch(() => false)) await reject.click();

  // Scope to the main form (the page also has a WhatsApp chat widget form)
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: /^submit$/i }) }).first();
  await expect(form).toBeVisible();

  return {
    form,
    firstName: form.getByLabel(/first name/i),
    lastName: form.getByLabel(/last name/i),
    email: form.getByLabel(/work email/i),
    countryCode: form.getByLabel(/country code/i),
    number: form.getByLabel(/^number/i),
    message: form.getByLabel(/your message/i),
    marketing: form.getByLabel(/receive communication/i),
    consent: form.getByLabel(/consent to storing/i),
    submit: form.getByRole('button', { name: /^submit$/i }),
  };
}

/** A field is invalid if the browser says so OR the form marks it aria-invalid. */
async function isInvalid(locator) {
  return locator.evaluate(
    (el) => !el.checkValidity() || el.getAttribute('aria-invalid') === 'true'
  );
}

/** Records submission requests – an invalid form must NOT hit the API. */
function watchSubmissions(page) {
  const hits = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && SUBMIT_URL.test(req.url())) hits.push(req.url());
  });
  return hits;
}

async function fillValid(f, overrides = {}) {
  const v = {
    firstName: 'QA',
    lastName: 'Monitor',
    email: TEST_EMAIL,
    number: '9876543210',
    message: `${MARKER} Health check at ${new Date().toISOString()}`,
    ...overrides,
  };
  await f.firstName.fill(v.firstName);
  await f.lastName.fill(v.lastName);
  await f.email.fill(v.email);
  if (await f.countryCode.count()) await f.countryCode.selectOption({ label: 'India (+91)' }).catch(() => {});
  if (await f.number.count()) await f.number.fill(v.number);
  await f.message.fill(v.message);
  await f.consent.check();
}

// ---------------------------------------------------------------------------
test.describe('Contact form – field validation', () => {
  test('all required fields are enforced on empty submit', async ({ page }) => {
    const f = await openForm(page);
    const hits = watchSubmissions(page);

    await f.submit.click();

    const required = {
      firstName: f.firstName, lastName: f.lastName, email: f.email,
      message: f.message, consent: f.consent,
    };
    for (const [name, field] of Object.entries(required)) {
      expect(await isInvalid(field), `${name} should be flagged as required`).toBe(true);
    }
    await page.waitForTimeout(1500);
    expect(hits, 'empty form must not call the API').toHaveLength(0);
  });

  const badEmails = ['plainaddress', 'missing@', '@nouser.com', 'spaces in@mail.com', 'a@b@c.com'];
  for (const bad of badEmails) {
    test(`rejects invalid email: "${bad}"`, async ({ page }) => {
      const f = await openForm(page);
      const hits = watchSubmissions(page);
      await fillValid(f, { email: bad });
      await f.submit.click();

      expect(await isInvalid(f.email)).toBe(true);
      await page.waitForTimeout(1500);
      expect(hits).toHaveLength(0);
    });
  }

  test('consent checkbox is mandatory', async ({ page }) => {
    const f = await openForm(page);
    const hits = watchSubmissions(page);
    await fillValid(f);
    await f.consent.uncheck();
    await f.submit.click();

    expect(await isInvalid(f.consent)).toBe(true);
    await page.waitForTimeout(1500);
    expect(hits).toHaveLength(0);
  });

  test('marketing opt-in is optional and unchecked by default', async ({ page }) => {
    const f = await openForm(page);
    await fillValid(f);
    await expect(f.marketing).not.toBeChecked();
    expect(await isInvalid(f.marketing)).toBe(false);
  });

  test('whitespace-only required fields do not succeed', async ({ page }) => {
    const f = await openForm(page);
    await fillValid(f, { firstName: '   ', message: '   ' });
    await f.submit.click();
    await page.waitForTimeout(3000);
    await expect(page.getByText(SUCCESS_TEXT)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
test.describe('Contact form – submission & API', () => {
  test.skip(process.env.SKIP_SUBMIT === 'true', 'SKIP_SUBMIT=true');

  test('valid submission returns a successful API response', async ({ page }) => {
    const f = await openForm(page);
    await fillValid(f);

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && SUBMIT_URL.test(res.url()),
        { timeout: 20_000 }
      ),
      f.submit.click(),
    ]);

    console.log('Submit endpoint:', response.url(), '->', response.status());

    // 1. HTTP status is 2xx
    expect(response.status(), 'API status').toBeGreaterThanOrEqual(200);
    expect(response.status(), 'API status').toBeLessThan(300);

    // 2. Request payload carried our data (works for form-data, urlencoded and JSON)
    const payload = decodeURIComponent(response.request().postData() || '');
    expect(payload, 'payload should contain test email').toContain(TEST_EMAIL);

    // 3. Response body reports success (covers common WP form plugins)
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    console.log('Response body:', (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500));

    if (body && typeof body === 'object') {
      const ok =
        body.success === true ||                      // Elementor / WPForms / admin-ajax
        body.status === 'mail_sent' ||                // Contact Form 7
        !!body.inlineMessage || !!body.redirectUri;   // HubSpot
      expect(ok, `API body did not indicate success: ${JSON.stringify(body)}`).toBe(true);
    }

    // 4. User sees a confirmation message
    await expect(page.getByText(SUCCESS_TEXT).first()).toBeVisible({ timeout: 10_000 });
  });
});
