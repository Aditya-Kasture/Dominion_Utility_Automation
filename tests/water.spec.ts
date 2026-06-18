/**
 * Baltimore City Water Portal Automation
 * ───────────────────────────────────────
 * Modes (set WATER_MODE env var):
 *   audit      — Navigate & screenshot key pages only, no writes
 *   paperless  — Enable paperless billing for every owner-responsible unit
 *   bills      — Retrieve bill amount, due date, and consumption per unit
 *   full       — All of the above (default)
 *
 * Consumption threshold logic (from Phase Plan):
 *   < 25 units/quarter  → auto_pay
 *   25–35 units/quarter → pay_alert_pm (elevated — notify PM)
 *   > 35 units/quarter  → pay_work_order (likely leak — create work order)
 *
 * Run:
 *   WATER_MODE=full npx playwright test tests/water.spec.ts --project=chromium
 *
 * AUDIT NOTE: Water portal URL and selectors must be confirmed during the
 * Phase 1 portal audit. Run with HEADLESS=false, WATER_MODE=audit first.
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';
import * as dotenv from 'dotenv';
import { fetchWaterAccounts, logWaterRun, closePool, WaterAccount, validateEnv } from './helpers/db';
import { hideAutomationSignals, randomDelay, parseDollarAmount, parseDate, screenshot, determineWaterAction, getRandomUserAgent, detectBotBlock } from './helpers/utils';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const VALID_MODES = ['audit', 'paperless', 'bills', 'full'] as const;
type Mode = typeof VALID_MODES[number];
const rawMode = process.env.WATER_MODE ?? 'full';
if (!VALID_MODES.includes(rawMode as Mode)) throw new Error(`Invalid WATER_MODE: "${rawMode}". Must be: ${VALID_MODES.join(', ')}`);
const MODE = rawMode as Mode;
// Baltimore Water uses Azure B2C OAuth (same pattern as BGE). The redirect target
// after auth is waterbillportal.baltimorecity.gov. Override with a captured authorize
// URL in .env if BGE-style session memory is needed.
const LOGIN_URL = process.env.WATER_LOGIN_URL ?? 'https://waterbillportal.baltimorecity.gov';
const WATER_EMAIL = process.env.WATER_EMAIL ?? '';
const WATER_PASSWORD = process.env.WATER_PASSWORD ?? '';

let context: BrowserContext;
let page: Page;
let units: WaterAccount[] = [];
let loginSucceeded = false;

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'WATER_EMAIL', 'WATER_PASSWORD']);
  context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  await hideAutomationSignals(page);

  units = await fetchWaterAccounts();
  const limit = Number(process.env.WATER_LIMIT ?? 0);
  if (limit > 0 && limit < units.length) {
    units = units.filter(u => u.water_account_number).slice(0, limit);
    console.log(`[Water] WATER_LIMIT=${limit} — capping to first ${units.length} unit(s) with a water_account_number.`);
  } else {
    console.log(`[Water] Loaded ${units.length} owner-responsible units from DB.`);
  }
});

test.afterAll(async () => {
  await context?.close();
  await closePool();
});

// ─── Test 1: Login ────────────────────────────────────────────────────────────

test('Water Portal Login', async () => {
  test.setTimeout(3 * 60 * 1000);

  console.log(`[Water] Navigating to login: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // B2C custom UI loads from external blob storage and renders late.
  console.log('[Water] Waiting for page to fully load (networkidle + 3s settle)...');
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {
    console.warn('[Water] networkidle not reached in 45s — continuing anyway.');
  });
  await page.waitForTimeout(3000);

  // Broad selectors — B2C login forms use varied id/name/aria attributes.
  const EMAIL_CSS = '#signInName, #emailID, #email, input[name="signInName"], input[name="email"], input[name*="email" i], input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i], input[aria-label*="username" i]';
  const PWD_CSS   = '#password, input[type="password"], input[aria-label*="password" i]';

  const emailField = page.locator(EMAIL_CSS)
    .or(page.getByLabel(/^email|^username/i))
    .or(page.getByRole('textbox', { name: /email|username/i }))
    .first();
  const passwordField = page.locator(PWD_CSS)
    .or(page.getByLabel(/^password$/i))
    .first();
  const signOutBtn = page.getByRole('button', { name: /sign out|log out/i }).first();

  // Race for login form vs already-authenticated. (No OTP path — water doesn't ask.)
  console.log('[Water] Detecting page state...');
  let pageState: 'login' | 'auth' | 'unknown';
  try {
    pageState = await Promise.any([
      emailField.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login' as const),
      signOutBtn.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'auth' as const),
    ]);
  } catch (_) {
    pageState = 'unknown';
  }
  console.log(`[Water] Page state: ${pageState}`);

  if (pageState === 'auth') {
    console.log('[Water] Already authenticated — skipping login.');
  } else if (pageState === 'login') {
    console.log(`[Water] Auto-filling email: ${WATER_EMAIL}`);
    await emailField.scrollIntoViewIfNeeded().catch(() => null);
    await emailField.fill(WATER_EMAIL);
    await randomDelay(200, 150);

    // Combined vs stepped flow — B2C usually combines email + password on one page.
    const pwdAlreadyVisible = await passwordField.isVisible().catch(() => false);
    if (!pwdAlreadyVisible) {
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]').first();
      console.log('[Water] Stepped flow — clicking Next to reveal password screen.');
      await nextBtn.click();
      await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
    } else {
      console.log('[Water] Combined flow — password field already visible.');
    }

    console.log('[Water] Auto-filling password from .env.');
    await passwordField.scrollIntoViewIfNeeded().catch(() => null);
    await passwordField.fill(WATER_PASSWORD);
    await randomDelay(200, 150);

    const signInBtn = page.getByRole('button', { name: /^(sign in|log in|continue|next|submit)$/i }).first();
    console.log('[Water] Clicking Sign In...');
    await signInBtn.click();
    console.log('[Water] Submitted — waiting for landing page.');
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    await page.waitForTimeout(3000);
  } else {
    await screenshot(page, 'water_unknown_state');
    throw new Error(`Water portal landed on an unrecognized page. URL: ${page.url()}`);
  }

  // Verify success — landed on the portal domain and not still on a login/B2C page.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(2000);
  await screenshot(page, 'water_post_login');

  const url = page.url();
  const onPortalDomain = /waterbillportal\.baltimorecity\.gov|cityservices\.baltimorecity\.gov/i.test(url)
    && !/login|signin|b2clogin/i.test(url);

  if (!onPortalDomain) {
    const verifyAuth = await signOutBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!verifyAuth) {
      await screenshot(page, 'water_login_failed');
      throw new Error(`Water login could not be verified. URL: ${url}`);
    }
  }

  loginSucceeded = true;
  console.log(`[Water] Login successful. Landed on: ${url}`);

  if (MODE === 'audit') {
    console.log('[Water] AUDIT MODE — capturing account overview screenshot.');
    await screenshot(page, 'water_audit_overview');
    const botRisk = await detectBotBlock(page);
    if (botRisk.signals.length > 0) {
      console.warn('[Water] Bot/CAPTCHA risk signals detected:', botRisk.signals);
      await screenshot(page, 'water_audit_bot_risk');
    } else {
      console.log('[Water] No bot detection signals observed.');
    }
  }
});

// ─── Test 2: Paperless Enrollment ─────────────────────────────────────────────

test('Water Paperless Enrollment (all units)', async () => {
  // The Baltimore Water portal (DPW) does not expose a paperless toggle on the
  // account-summary page for our accounts — verified across 11 sampled accounts
  // in the 2026-05-22 run. Paperless is configured at the LLC/portfolio level
  // elsewhere, not per-account. Always skip.
  test.skip(true, 'No per-account paperless toggle on this portal.');
});

// ─── Test 3: Bill Retrieval + Threshold Logic ─────────────────────────────────

test('Water Bill Retrieval (all units)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE === 'audit' || MODE === 'paperless') {
    test.skip(true, `Mode is ${MODE} — skipping bill retrieval.`);
    return;
  }

  // Only process units we can actually look up (have a water_account_number).
  // The rest get skipped immediately to save run time.
  const actionable = units.filter(u => !!u.water_account_number);
  const skipped = units.length - actionable.length;
  console.log(`[Water] ${actionable.length} unit(s) with water_account_number; ${skipped} skipped (no account number cached).`);

  // ~25–45s per unit for bill retrieval. Budget 60s/unit, 5 min floor, 6 hr cap.
  const budgetMs = Math.max(5 * 60_000, Math.min(6 * 60 * 60_000, actionable.length * 60_000));
  test.setTimeout(budgetMs);

  // CSV output — append per-account so partial runs are still usable.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const outDir = path.resolve(__dirname, '..', 'cache');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(outDir, `water-bills-${stamp}.csv`);
  const csvHeader = [
    'timestamp','unit_id','unit_name','property_id','water_account_number',
    'street1','city','state','zip',
    'bill_amount','due_date','consumption_units','threshold_action','status','notes',
  ].join(',') + '\n';
  fs.writeFileSync(csvPath, csvHeader, 'utf8');
  console.log(`[Water] CSV: ${csvPath}`);

  const csvEscape = (v: any): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let okCount = 0, partialCount = 0, failCount = 0;

  for (const unit of actionable) {
    const address = `${unit.street1}, ${unit.city}, ${unit.state} ${unit.zip}`;
    console.log(`[Water] Retrieving bill: ${address} (${unit.unit_name})`);

    const found = await navigateToUnit(page, unit);
    if (!found) {
      failCount++;
      fs.appendFileSync(csvPath, [
        new Date().toISOString(), unit.unit_id, unit.unit_name, unit.property_id,
        unit.water_account_number, unit.street1, unit.city, unit.state, unit.zip,
        '', '', '', '', 'NAV_FAILED', 'Account not found in portal',
      ].map(csvEscape).join(',') + '\n', 'utf8');
      try { await logWaterRun({ unit_id: unit.unit_id, property_id: unit.property_id, action: 'navigate', status: 'FAILED', notes: 'Address not found in portal' }); } catch (e) { console.error(`[Water] Log failed for ${address}:`, e); }
      continue;
    }

    const bill = await retrieveWaterBill(page, address);
    const thresholdAction = determineWaterAction(bill.consumptionUnits, unit.consumption_baseline);
    const status = bill.amount !== null ? 'SUCCESS' : 'PARTIAL';
    if (status === 'SUCCESS') okCount++; else partialCount++;

    const notes = unit.consumption_baseline !== null
      ? `Baseline: ${unit.consumption_baseline} units, Actual: ${bill.consumptionUnits} -> ${thresholdAction}`
      : `No baseline on file - defaulting to auto_pay. Actual: ${bill.consumptionUnits}`;

    fs.appendFileSync(csvPath, [
      new Date().toISOString(), unit.unit_id, unit.unit_name, unit.property_id,
      unit.water_account_number, unit.street1, unit.city, unit.state, unit.zip,
      bill.amount ?? '', bill.dueDate ?? '', bill.consumptionUnits ?? '',
      thresholdAction, status, notes,
    ].map(csvEscape).join(',') + '\n', 'utf8');

    try {
      await logWaterRun({
        unit_id: unit.unit_id,
        property_id: unit.property_id,
        action: 'bill_retrieval',
        status,
        bill_amount: bill.amount,
        consumption_units: bill.consumptionUnits,
        due_date: bill.dueDate,
        threshold_action: thresholdAction,
        notes,
      });
    } catch (e) { console.error(`[Water] Log failed for ${address}:`, e); }

    if (thresholdAction === 'pay_alert_pm') {
      console.warn(`[Water] ELEVATED consumption at ${address}: ${bill.consumptionUnits} units (baseline: ${unit.consumption_baseline}). ACTION: Alert PM.`);
    } else if (thresholdAction === 'pay_work_order') {
      console.error(`[Water] POSSIBLE LEAK at ${address}: ${bill.consumptionUnits} units (baseline: ${unit.consumption_baseline}). ACTION: Create work order.`);
    }

    await randomDelay(2000, 1000);
  }

  console.log(`[Water] Bill retrieval done. SUCCESS=${okCount}, PARTIAL=${partialCount}, NAV_FAILED=${failCount}.`);
  console.log(`[Water] CSV written: ${csvPath}`);
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Navigates the Baltimore Water portal to a specific account:
 *   1. Click the global "Search an account" combobox at the top of the page
 *   2. Type the water_account_number
 *   3. Wait for the autocomplete dropdown showing "Account NNNNN / <address> / Premises"
 *   4. Click the dropdown item → lands on the per-account page (tabs: Account Summary, Billing, Usage, Requests)
 */
async function navigateToUnit(page: Page, unit: WaterAccount): Promise<boolean> {
  const address = `${unit.street1}, ${unit.city}`;
  if (!unit.water_account_number) {
    console.warn(`[Water] Skipping ${address} — no water_account_number in cache.`);
    return false;
  }
  const acct = unit.water_account_number;

  try {
    // The search input is in the top toolbar (placeholder "Search an account").
    // It's accessible from every page in the portal.
    const searchBox = page.getByPlaceholder(/search an account/i)
      .or(page.getByRole('combobox', { name: /search an account/i }))
      .or(page.locator('input[placeholder*="search" i][placeholder*="account" i]'))
      .first();
    await searchBox.waitFor({ state: 'visible', timeout: 20_000 });

    await searchBox.click();
    await searchBox.fill('');
    await page.waitForTimeout(300);
    await searchBox.pressSequentially(acct, { delay: 50 });

    // Dropdown shows "Account <number>" — click that entry
    const dropdownItem = page
      .getByText(new RegExp(`^\\s*Account\\s+${acct}\\b`, 'i'))
      .first();

    try {
      await expect(dropdownItem).toBeVisible({ timeout: 12_000 });
    } catch (_) {
      console.warn(`[Water] Account ${acct} dropdown did not appear after typing.`);
      await screenshot(page, `water_account_not_found_${acct}`);
      return false;
    }

    await dropdownItem.click();

    // Wait for the per-account page to render. The dashboard does not show
    // "Due balance" anywhere; the account summary page always shows it (green
    // card on the top left, regardless of $0.00 or unpaid balance). Race
    // multiple signals so we recover from minor UI variation.
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    const accountHeader   = page.getByText(new RegExp(`Account\\s+${acct}\\b`, 'i')).first();
    const dueBalanceLabel = page.getByText(/^\s*Due balance\s*$/i).first();
    const billingTab      = page.getByText(/^\s*BILLING\s*$/).first();
    const usageTab        = page.getByText(/^\s*USAGE\s*$/).first();
    const summaryTabRole  = page.getByRole('tab', { name: /account summary/i }).first();

    let landed = false;
    try {
      const winner = await Promise.any([
        accountHeader.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'header'),
        dueBalanceLabel.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'due-balance'),
        billingTab.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'billing-tab'),
        usageTab.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'usage-tab'),
        summaryTabRole.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'summary-tab'),
      ]);
      landed = true;
      console.log(`[Water] Landed on account ${acct} (signal: ${winner}).`);
    } catch (_) {
      landed = false;
    }

    if (!landed) {
      console.warn(`[Water] Did not land on per-account page for ${acct}.`);
      await screenshot(page, `water_account_landing_failed_${acct}`);
      return false;
    }

    await page.waitForTimeout(1500); // let consumption chart finish rendering
    return true;
  } catch (err: any) {
    console.error(`[Water] Error navigating to account ${acct}: ${err?.message ?? err}`);
    await screenshot(page, `water_account_not_found_${acct}`);
    return false;
  }
}

/**
 * Enables paperless billing on the account-summary page.
 *
 * Portal layout: the right-side "Preferences" card contains a row
 * "Sign up for paperless billing" with a toggle switch.
 */
async function enableWaterPaperless(page: Page, address: string): Promise<boolean> {
  try {
    // Make sure we're on the Account Summary tab (which has the Preferences card).
    const summaryTab = page.getByRole('tab', { name: /account summary/i }).first();
    if (await summaryTab.isVisible().catch(() => false)) {
      const selected = await summaryTab.getAttribute('aria-selected').catch(() => null);
      if (selected !== 'true') {
        await summaryTab.click();
        await page.waitForTimeout(1000);
      }
    }

    // Locate the toggle next to "Sign up for paperless billing".
    const paperlessRow = page
      .locator('div, section, li')
      .filter({ hasText: /sign\s*up\s*for\s*paperless\s*billing/i })
      .last();
    const toggle = paperlessRow
      .getByRole('switch')
      .or(paperlessRow.locator('input[type="checkbox"]'))
      .or(paperlessRow.locator('[role="switch"]'))
      .first();

    if (!(await toggle.isVisible({ timeout: 5_000 }).catch(() => false))) {
      console.warn(`[Water] No paperless toggle found for ${address}.`);
      await screenshot(page, 'water_no_paperless_toggle');
      return false;
    }

    const alreadyEnabled = await toggle.isChecked().catch(async () =>
      (await toggle.getAttribute('aria-checked')) === 'true'
    );
    if (alreadyEnabled) {
      console.log(`[Water] Paperless already active for ${address}.`);
      return true;
    }

    await toggle.click();
    await randomDelay(800, 400);

    // Some portals show a confirmation modal/dialog after toggling.
    const confirmBtn = page.getByRole('button', {
      name: /^(confirm|save|enroll|agree|i agree|yes|submit|continue)$/i,
    }).first();
    if (await confirmBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }

    // Verify the toggle is now in the ON state.
    const enabled = await toggle.isChecked().catch(async () =>
      (await toggle.getAttribute('aria-checked')) === 'true'
    );

    if (enabled) {
      console.log(`[Water] Paperless enabled for ${address}.`);
      await screenshot(page, `water_paperless_success_${address.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}`);
      return true;
    }
    console.warn(`[Water] Paperless toggle did not switch to ON for ${address}.`);
    await screenshot(page, 'water_paperless_unconfirmed');
    return false;
  } catch (err: any) {
    console.error(`[Water] Error enabling paperless for ${address}: ${err?.message ?? err}`);
    await screenshot(page, 'water_paperless_error');
    return false;
  }
}

/**
 * Reads bill amount, due date, and consumption directly off the Account Summary
 * page. The Baltimore Water portal shows:
 *   - "$207.64 Due balance" (top-left card)
 *   - "There are due bills." (if amount > 0)
 *   - "Billed usage" card: "Total amount: USD 264.27", "Total consumption: CCF 60.00"
 *
 * No navigation needed — all three fields are visible on the summary page.
 */
async function retrieveWaterBill(
  page: Page,
  address: string
): Promise<{ amount: number | null; dueDate: string | null; consumptionUnits: number | null }> {
  const result = { amount: null as number | null, dueDate: null as string | null, consumptionUnits: null as number | null };
  try {
    const bodyText = await page.locator('body').innerText();

    // Amount: "Due balance" — appears as "$207.64\nDue balance" or "Due balance\n$207.64"
    const amountPatterns = [
      /\$\s*([\d,]+\.\d{2})\s*\n?\s*Due balance/i,
      /Due balance\s*\n?\s*\$\s*([\d,]+\.\d{2})/i,
      /Due balance[^$]*\$\s*([\d,]+\.\d{2})/i,
    ];
    for (const re of amountPatterns) {
      const m = bodyText.match(re);
      if (m) {
        result.amount = parseDollarAmount(m[1]);
        if (result.amount !== null) break;
      }
    }

    // Due-date heuristics. The summary page only shows "There are due bills."
    // without an explicit date. If a real due-balance is present we click the
    // BILLING tab and try to read the most recent date from the bills list.
    const hasDueBills = /there are due bills/i.test(bodyText);
    const allPaid     = /all bills are paid/i.test(bodyText);

    if (allPaid) {
      result.dueDate = 'ALL_PAID';
    } else if (hasDueBills) {
      result.dueDate = 'HAS_DUE_BILLS';
    }

    // First try to find a date anywhere on the summary page
    let dateMatch = bodyText.match(/Due\s*(?:Date|by)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
                 || bodyText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);

    // If the summary didn't reveal one and there ARE due bills, drill into BILLING.
    if (!dateMatch && hasDueBills) {
      try {
        const billingTab = page.getByRole('tab', { name: /^billing$/i }).first()
          .or(page.getByText(/^\s*BILLING\s*$/).first());
        await billingTab.click({ timeout: 8_000 });
        await page.waitForTimeout(1500);
        const billingText = await page.locator('body').innerText();
        dateMatch = billingText.match(/Due\s*(?:Date|by)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
                 || billingText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      } catch (_) {
        // BILLING tab failed — keep the HAS_DUE_BILLS marker
      }
    }

    if (dateMatch) {
      const parsed = parseDate(dateMatch[1]) ?? dateMatch[1];
      if (parsed) result.dueDate = parsed;
    }

    // Consumption: "Total consumption: CCF 60.00" — also matches HCF/gallons
    const consumptionPatterns = [
      /Total consumption[:\s]+(?:CCF|HCF|gallons?|units?)[:\s]+([\d.,]+)/i,
      /Total consumption[:\s]+([\d.,]+)\s*(?:CCF|HCF|gallons?|units?)?/i,
      /(?:CCF|HCF|gallons?)\s+([\d.,]+)/i,
    ];
    for (const re of consumptionPatterns) {
      const m = bodyText.match(re);
      if (m) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(v)) {
          result.consumptionUnits = v;
          break;
        }
      }
    }

    console.log(
      `[Water] ${address} — Amount: $${result.amount ?? 'N/A'}, ` +
      `Due: ${result.dueDate ?? 'N/A'}, Consumption: ${result.consumptionUnits ?? 'N/A'} units`
    );
  } catch (err) {
    console.error(`[Water] Error retrieving bill for ${address}:`, err);
    await screenshot(page, 'water_bill_error');
  }
  return result;
}
