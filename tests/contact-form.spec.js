// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * UXArmy Contact Sales form monitor
 *  1. Field validation (required fields, email format, consent checkbox)
 *  2. Real submission + API response verification
 *
 * The form uses custom JS validation (not native HTML5) and disables the
 * Submit button while data is invalid – the helpers below handle both.
 *
 * Env vars:
 *   TEST_EMAIL   – inbox used for the real submission (default qa+monitor@uxarmy.com)
 *   SKIP_SUBMIT  – "true" to run only validation checks (no lead created)
 */

const PAGE = '/contact-sales/';
const TEST_EMAIL = process.env.TEST_EMAIL || 'qa+monitor@uxarmy.com';
const MARKER = '[AUTOMATED MONITOR - please ignore]';

const SUBMIT_URL = /admin-ajax\.php|\/wp-json\/|hsforms|hubspot|\/submit|\/contact/i;
// NOTE: the page permanently shows "Our product experts will connect with you within one business day",
// so success is detected as a matching message that was NOT on the page before submitting.
const SUCCESS_TEXT = /thank you|thanks|success|submitted|we.ll be in touch|received|message (has been )?sent/i;

/** Texts of visible elements matching SUCCESS_TEXT right now. */
async function successTexts(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.children.length === 0 && /** @type {HTMLElement} */ (el).offsetParent !== null)
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t && t.length < 300 && re.test(t));
  }, SUCCESS_TEXT.source);
}

/** Waits up to `timeout` ms for a success message that wasn't in `baseline`. Returns it or null. */
async function waitForNewSuccess(page, baseline, timeout = 2000) {
  const end = Date.now() + timeout;
  do {
    const fresh = (await successTexts(page)).filter((t) => !baseline.includes(t));
    if (fresh.length) return fresh[0];
    await page.waitForTimeout(250);
  } while (Date.now() < end);
  return null;
}
const ERROR_SELECTOR =
  '[class*="error" i]:not(:empty), [class*="invalid" i]:not(:empty), [role="alert"]:not(:empty), [aria-live]:not(:empty)';

/** True only for the contact form's own submission – not cookie-consent logs etc. */
function isFormSubmission(req) {
  if (req.method() !== 'POST' || !SUBMIT_URL.test(req.url())) return false;
  let body = req.postData() || '';
  try { body = decodeURIComponent(body); } catch {}
  if (/uxcc_|consent_source=banner/.test(body)) return false;
  return /first|last|email|message/i.test(body);
}

async function openForm(page) {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

  // Reject cookies and let the consent-log request finish before touching the form
  const reject = page.getByRole('button', { name: /reject all/i }).first();
  if (await reject.isVisible({ timeout: 5000 }).catch(() => false)) {
    await Promise.all([
      page.waitForResponse(
        (r) => (r.request().postData() || '').includes('uxcc_log_consent'),
        { timeout: 5000 }
      ).catch(() => {}),
      reject.click(),
    ]);
  }

  const form = page.locator('form').filter({ has: page.getByRole('button', { name: /^submit$/i }) }).first();
  await expect(form).toBeVisible();

  // Save the form's HTML in the report – handy when selectors need adjusting
  await test.info().attach('form.html', { body: await form.innerHTML(), contentType: 'text/html' });

  return {
    page,
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

/** Records form submissions – a blocked form must NOT hit the API. */
function watchSubmissions(page) {
  const hits = [];
  page.on('request', (req) => { if (isFormSubmission(req)) hits.push(req.url()); });
  return hits;
}

/** Field is flagged by native validity, aria-invalid, an error class, or an error message next to it. */
async function isFlagged(field) {
  return field.evaluate((el, errSel) => {
    const input = /** @type {HTMLInputElement} */ (el);
    if (typeof input.checkValidity === 'function' && !input.checkValidity()) return true;
    if (input.getAttribute('aria-invalid') === 'true') return true;
    if (/error|invalid/i.test(input.className)) return true;
    // look for a visible error message in the field's wrapper (up to 3 levels up)
    let node = input.parentElement;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
      const errs = [...node.querySelectorAll(errSel)].filter(
        (e) => e !== input && /** @type {HTMLElement} */ (e).offsetParent !== null
      );
      if (errs.length) return true;
      if (/error|invalid/i.test(node.className)) return true;
    }
    return false;
  }, ERROR_SELECTOR);
}

/**
 * Tries to submit. Returns { blockedBy } describing how the form refused:
 * 'disabled-button' | 'validation' | null (null = it was NOT blocked).
 */
async function attemptSubmit(f, hits) {
  if (await f.submit.isDisabled()) return { blockedBy: 'disabled-button' };
  const baseline = await successTexts(f.page);
  await f.submit.click();
  const successMsg = await waitForNewSuccess(f.page, baseline, 2500);
  if (hits.length || successMsg) {
    console.log('NOT blocked →', { apiCalls: hits, successMsg });
    return { blockedBy: null };
  }
  return { blockedBy: 'validation' };
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
  await f.email.blur(); // trigger on-blur validation
  if (await f.countryCode.count()) await f.countryCode.selectOption({ label: 'India (+91)' }).catch(() => {});
  if (await f.number.count()) await f.number.fill(v.number);
  await f.message.fill(v.message);
  await f.consent.check();
  await f.consent.blur();
}

// ---------------------------------------------------------------------------
test.describe('Contact form – field validation', () => {
  test('empty form cannot be submitted', async ({ page }) => {
    const f = await openForm(page);
    const hits = watchSubmissions(page);

    const { blockedBy } = await attemptSubmit(f, hits);
    expect(blockedBy, 'empty form must be blocked').not.toBeNull();
    expect(hits, 'empty form must not call the API').toHaveLength(0);

    // If the button was clickable, the form should now show which fields are missing
    if (blockedBy === 'validation') {
      const flagged = {};
      for (const [name, field] of Object.entries({
        firstName: f.firstName, lastName: f.lastName, email: f.email, message: f.message, consent: f.consent,
      })) flagged[name] = await isFlagged(field);
      console.log('Fields flagged after empty submit:', flagged);
      expect(Object.values(flagged).some(Boolean), 'at least one required-field error should be shown').toBe(true);
      for (const [name, ok] of Object.entries(flagged)) expect.soft(ok, `${name} should show an error`).toBe(true);
    }
  });

  const badEmails = ['plainaddress', 'missing@', '@nouser.com', 'spaces in@mail.com', 'a@b@c.com'];
  for (const bad of badEmails) {
    test(`rejects invalid email: "${bad}"`, async ({ page }) => {
      const f = await openForm(page);
      const hits = watchSubmissions(page);
      await fillValid(f, { email: bad });

      const { blockedBy } = await attemptSubmit(f, hits);
      console.log(`"${bad}" blocked by:`, blockedBy);
      expect(blockedBy, `invalid email "${bad}" must be blocked`).not.toBeNull();
      expect(hits).toHaveLength(0);
    });
  }

  test('consent checkbox is mandatory', async ({ page }) => {
    const f = await openForm(page);
    const hits = watchSubmissions(page);
    await fillValid(f);
    await f.consent.uncheck();
    await expect(f.consent, 'consent should be unchecked before submit').not.toBeChecked();

    const { blockedBy } = await attemptSubmit(f, hits);
    console.log('Unchecked consent blocked by:', blockedBy);
    expect(blockedBy, 'form must be blocked without consent').not.toBeNull();
    expect(hits).toHaveLength(0);
    if (blockedBy === 'validation') expect.soft(await isFlagged(f.consent), 'consent should show an error').toBe(true);
  });

  test('marketing opt-in is optional and unchecked by default', async ({ page }) => {
    const f = await openForm(page);
    await expect(f.marketing).not.toBeChecked();
    await fillValid(f);
    await expect(f.submit, 'valid form without marketing opt-in should be submittable').toBeEnabled();
  });

  test('whitespace-only required fields are rejected', async ({ page }) => {
    const f = await openForm(page);
    const hits = watchSubmissions(page);
    await fillValid(f, { firstName: '   ', message: '   ' });

    const { blockedBy } = await attemptSubmit(f, hits);
    console.log('Whitespace fields blocked by:', blockedBy);
    expect(blockedBy, 'whitespace-only fields must be blocked').not.toBeNull();
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
test.describe('Contact form – submission & API', () => {
  test.skip(process.env.SKIP_SUBMIT === 'true', 'SKIP_SUBMIT=true');
  test.describe.configure({ retries: 0 }); // a retry would send a second real lead

  test('valid submission returns a successful API response', async ({ page }) => {
    const f = await openForm(page);
    await fillValid(f);
    await expect(f.submit, 'submit should be enabled for valid data').toBeEnabled();
    const baseline = await successTexts(page);
    const urlBefore = page.url();

    const [response] = await Promise.all([
      page.waitForResponse((res) => isFormSubmission(res.request()), { timeout: 20_000 }),
      f.submit.click(),
    ]);

    const req = response.request();
    console.log('Submit endpoint:', req.method(), response.url(), '->', response.status());

    // 1. HTTP status is 2xx
    expect(response.status(), 'API status').toBeGreaterThanOrEqual(200);
    expect(response.status(), 'API status').toBeLessThan(300);

    // 2. Request payload carried our data
    let payload = req.postData() || '';
    try { payload = decodeURIComponent(payload.replace(/\+/g, ' ')); } catch {}
    const emailUser = TEST_EMAIL.split('@')[0].replace('+', '');
    expect(payload.replace(/[+\s]/g, ''), 'payload should contain test email').toContain(emailUser);

    // 3. Response body reports success
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    console.log('Response body:', (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500));
    await test.info().attach('api-response.txt', { body: text, contentType: 'text/plain' });

    if (body && typeof body === 'object') {
      const ok =
        body.success === true ||                      // Elementor / WPForms / custom admin-ajax
        body.status === 'mail_sent' ||                // Contact Form 7
        !!body.inlineMessage || !!body.redirectUri;   // HubSpot
      expect(ok, `API body did not indicate success: ${JSON.stringify(body)}`).toBe(true);
    }

    // 4. User gets a confirmation: new message, redirect, or the form is hidden/replaced
    let confirmation = null;
    const end = Date.now() + 10_000;
    while (!confirmation && Date.now() < end) {
      const msg = await waitForNewSuccess(page, baseline, 500);
      if (msg) confirmation = `message: "${msg}"`;
      else if (page.url() !== urlBefore) confirmation = `redirect: ${page.url()}`;
      else if (!(await f.form.isVisible().catch(() => false))) confirmation = 'form hidden/replaced';
      else if (!(await f.submit.isVisible().catch(() => false))) confirmation = 'submit button removed';
      else if ((await f.firstName.inputValue().catch(() => 'x')) === '' &&
               (await f.email.inputValue().catch(() => 'x')) === '') confirmation = 'form reset after submit';
    }
    await test.info().attach('after-submit.png', {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });
    await test.info().attach('after-submit-form.html', {
      body: await f.form.innerHTML().catch(() => '(form gone)'), contentType: 'text/html',
    });
    console.log('Confirmation:', confirmation);
    expect(confirmation, 'a confirmation should appear after submit (see after-submit.png)').not.toBeNull();
  });
});
