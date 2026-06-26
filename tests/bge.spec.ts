/**
 * BGE Portal Automation
 * ─────────────────────
 * Modes (set BGE_MODE env var):
 *   audit      — Navigate & screenshot key pages only, no writes
 *   paperless  — Enable paperless billing for every account
 *   bills      — Retrieve bill amount + due date for every account
 *   full       — All of the above (default)
 *
 * Run:
 *   BGE_MODE=full npx playwright test tests/bge.spec.ts --project=chromium
 *
 * AUDIT NOTE: Selectors throughout are best-guess from common BGE portal patterns.
 * Run in audit mode first (HEADLESS=false) to discover actual selectors, then update.
 */

import path from 'path';
import { test, expect, Page, BrowserContext } from '@playwright/test';
import * as dotenv from 'dotenv';
import {
  logBGERun, closePool, BGEAccount, validateEnv, fetchBGEAccounts,
  fetchPaymentApprovals, recordPaymentAttempt, isPaymentConfirmed, paymentIdempotencyKey,
  PaymentApproval,
} from './helpers/db';
import { fetchBGEOtp, waitForManualOtp, fetchBGEOtpFromGraph } from './helpers/emailOTP';
import { hideAutomationSignals, randomDelay, parseDollarAmount, parseDate, screenshot, getRandomUserAgent, detectBotBlock } from './helpers/utils';
import {
  writeBGEResults,
  BGEAddressRow,
  BGERunResult,
} from './helpers/addressesCsv';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
// June 19 2026: 'pay' executes approval-gated payments (see WS-3). Payment never
// fires without a payment_approval row for this RUN_ID + account.
const VALID_MODES = ['audit', 'paperless', 'bills', 'pay', 'full'] as const;
type Mode = typeof VALID_MODES[number];
const rawMode = process.env.BGE_MODE ?? 'full';
if (!VALID_MODES.includes(rawMode as Mode)) throw new Error(`Invalid BGE_MODE: "${rawMode}". Must be: ${VALID_MODES.join(', ')}`);
const MODE = rawMode as Mode;
// Run identifier — ties payments to a WS-2 run's approvals. Required for 'pay'.
const RUN_ID = process.env.RUN_ID ?? process.env.WS2_RUN_ID ?? '';
const LOGIN_URL = process.env.BGE_LOGIN_URL ?? 'https://myaccount.bge.com/sign-in';
const BGE_EMAIL = process.env.BGE_EMAIL ?? '';
const BGE_PASSWORD = process.env.BGE_PASSWORD ?? '';
const IMAP_HOST = process.env.IMAP_HOST ?? 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 993);
const IMAP_EMAIL = process.env.IMAP_EMAIL ?? BGE_EMAIL;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD ?? '';

const RESULTS_CSV = path.resolve(
  process.env.BGE_RESULTS_CSV ?? 'cache/all-dominion-addresses-results.csv'
);

let context: BrowserContext;
let page: Page;
let accounts: BGEAccount[] = [];
let allRows: BGEAddressRow[] = [];
const runResults: Map<string, BGERunResult> = new Map();
let loginSucceeded = false;

function ensureResult(acctNum: string): BGERunResult {
  let r = runResults.get(acctNum);
  if (!r) {
    r = {
      last_paperless_status: '',
      last_bill_amount:      '',
      last_due_date:         '',
      last_run_at:           '',
      last_error:            '',
    };
    runResults.set(acctNum, r);
  }
  return r;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  validateEnv(['BGE_EMAIL', 'BGE_PASSWORD']);
  context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  await hideAutomationSignals(page);

  // Source of truth = Postgres (public.bge_account_property_map), via fetchBGEAccounts().
  accounts = await fetchBGEAccounts();
  // Mirror the DB accounts into the results-CSV row shape so the per-account
  // run-results writer (afterAll) still produces its artifact.
  allRows = accounts.map(a => ({
    property_address:    a.property_address,
    bge_account_numbers: a.bge_account_number,
    entity:              a.property_name ?? '',
    qb_account_no:       '',
    sources:             'db:public.bge_account_property_map',
  }));
  console.log(`[BGE] Loaded ${accounts.length} BGE accounts from Postgres (public.bge_account_property_map).`);
  console.log(`[BGE] Results CSV: ${RESULTS_CSV}`);
});

test.afterAll(async () => {
  try {
    writeBGEResults(RESULTS_CSV, allRows, runResults);
    console.log(`[BGE] Results written to: ${RESULTS_CSV}`);
  } catch (e) {
    console.error('[BGE] Failed to write results CSV:', e);
  }
  await context?.close();
  await closePool();
});

// ─── Test 1: Login ────────────────────────────────────────────────────────────

test('BGE Login (email + password + OTP)', async () => {
  // Automated login: fills email + password from .env, then fetches the OTP
  // from the construction@thedominiongroup.com mailbox via Microsoft Graph and
  // submits it. Falls back to a long manual-entry wait if any step fails.
  test.setTimeout(20 * 60 * 1000);

  console.log(`[BGE] Navigating to login: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => null);
  await page.waitForTimeout(2000);

  // ── Email + password auto-fill ──────────────────────────────────────────────
  const EMAIL_CSS = '#signInName, #emailID, #email, input[name="signInName"], input[name="email"], input[name*="email" i], input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i], input[aria-label*="username" i]';
  const PWD_CSS   = '#password, input[type="password"], input[aria-label*="password" i]';

  const emailField = page.locator(EMAIL_CSS)
    .or(page.getByLabel(/^email|^username/i))
    .or(page.getByRole('textbox', { name: /email|username/i }))
    .first();
  const passwordField = page.locator(PWD_CSS)
    .or(page.getByLabel(/^password$/i))
    .first();
  const signedInMarker = page.getByRole('button', { name: /sign out|log out/i }).first();

  let pageState: 'login' | 'auth' | 'unknown';
  try {
    pageState = await Promise.any([
      emailField.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login' as const),
      signedInMarker.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'auth' as const),
    ]);
  } catch (_) {
    pageState = 'unknown';
  }
  console.log(`[BGE] Page state: ${pageState}`);

  // Mark the moment login is submitted; OTP must arrive AFTER this.
  let loginSubmittedAt = new Date();

  if (pageState === 'auth') {
    console.log('[BGE] Already authenticated — skipping login.');
  } else if (pageState === 'login') {
    console.log(`[BGE] Auto-filling email: ${BGE_EMAIL}`);
    await emailField.fill(BGE_EMAIL);
    await randomDelay(200, 100);

    // Combined vs stepped flow — try clicking Next if password isn't yet visible
    const pwdVisible = await passwordField.isVisible().catch(() => false);
    if (!pwdVisible) {
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => null);
        await passwordField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null);
      }
    }

    console.log('[BGE] Auto-filling password from .env.');
    await passwordField.fill(BGE_PASSWORD);
    await randomDelay(200, 100);

    const signInBtn = page.getByRole('button', { name: /sign in|continue|log\s*in/i }).first()
      .or(page.locator('button[type="submit"]').first());
    console.log('[BGE] Clicking Sign In...');
    loginSubmittedAt = new Date();
    await signInBtn.click().catch(() => null);

    // ── OTP step ─────────────────────────────────────────────────────────────
    // After submit, BGE shows an OTP form (B2C custom UI). Detect the OTP
    // field, fetch the code from the shared mailbox, and submit it.
    const otpField = page
      .locator(
        'input[id*="otp" i], input[name*="otp" i], input[aria-label*="code" i], ' +
        'input[aria-label*="verification" i], input[placeholder*="code" i], ' +
        'input[autocomplete="one-time-code"], input[inputmode="numeric"]'
      )
      .or(page.getByLabel(/verification code|one[-\s]?time|otp/i))
      .first();

    const dashboardReached = page.waitForURL(
      u => /^https:\/\/secure\.bge\.com\//i.test(u.toString())
        && !/B2C_1A_SignIn|sign[-_]?in|\/login/i.test(u.toString()),
      { timeout: 5 * 60_000 }
    ).then(() => 'dashboard' as const);

    const otpVisible = otpField.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'otp' as const);

    let nextStep: 'otp' | 'dashboard';
    try {
      nextStep = await Promise.any([otpVisible, dashboardReached]);
    } catch (_) {
      nextStep = 'otp';
    }

    if (nextStep === 'otp') {
      console.log('[BGE] OTP field detected — fetching code from Graph API...');
      const code = await fetchBGEOtpFromGraph({
        since: new Date(loginSubmittedAt.getTime() - 30_000), // 30s grace window
        maxWaitMs: 3 * 60_000,
        pollIntervalMs: 5_000,
      });

      if (code) {
        console.log('[BGE] Filling OTP...');
        await otpField.fill(code);
        // Blur to trigger B2C client-side validation, then small settle delay
        await otpField.blur().catch(() => null);
        await randomDelay(500, 200);

        // Find the Continue button by exact text first (B2C uses "Continue").
        // Fall back to other common labels and finally to button[type=submit].
        const continueBtn = page.locator('button:has-text("Continue")').first()
          .or(page.locator('button:has-text("Verify")').first())
          .or(page.locator('button:has-text("Submit")').first())
          .or(page.locator('button[type="submit"]').first());

        let clicked = false;
        try {
          await continueBtn.waitFor({ state: 'visible', timeout: 8_000 });
          await continueBtn.click({ timeout: 8_000 });
          clicked = true;
          console.log('[BGE] Clicked Continue.');
        } catch (e: any) {
          console.warn(`[BGE] Continue click failed (${e?.message ?? e}). Falling back to pressing Enter.`);
        }

        if (!clicked) {
          await otpField.press('Enter').catch(err =>
            console.warn(`[BGE] Enter-key fallback also failed: ${err?.message ?? err}`)
          );
        }

        // Confirm the OTP screen is gone (either field hides or URL moves on).
        try {
          await Promise.any([
            otpField.waitFor({ state: 'hidden', timeout: 60_000 }),
            page.waitForURL(
              u => /^https:\/\/secure\.bge\.com\//i.test(u.toString())
                && !/B2C_1A_SignIn|sign[-_]?in|\/login/i.test(u.toString()),
              { timeout: 60_000 }
            ),
          ]);
          console.log('[BGE] OTP accepted — moving on.');
        } catch (_) {
          console.warn('[BGE] OTP submit did not advance the page within 60s — falling through to final URL wait.');
        }
      } else {
        console.warn('[BGE] OTP auto-fetch failed — falling back to manual paste. Open Outlook, copy the code, paste into the open browser window.');
        await waitForManualOtp(page, otpField, 15 * 60_000);
      }
    } else {
      console.log('[BGE] No OTP step detected — proceeding to dashboard.');
    }
  } else {
    console.warn('[BGE] Could not auto-detect login form — falling back to manual login. You have 20 minutes.');
  }

  // Final landing check — same as before
  try {
    await page.waitForURL(
      u => /^https:\/\/secure\.bge\.com\//i.test(u.toString())
        && !/B2C_1A_SignIn|sign[-_]?in|\/login/i.test(u.toString()),
      { timeout: 20 * 60 * 1000 }
    );
  } catch (_) {
    await screenshot(page, 'bge_login_timeout');
    throw new Error('Login did not complete within 20 minutes. Re-run when ready.');
  }

  await screenshot(page, 'bge_post_login');
  loginSucceeded = true;
  console.log(`[BGE] Login successful. Landed on: ${page.url()}`);

  if (MODE === 'audit') {
    console.log('[BGE] AUDIT MODE — capturing homepage screenshot. No further actions.');
    await screenshot(page, 'bge_audit_home');
    const botRisk = await detectBotBlock(page);
    if (botRisk.signals.length > 0) {
      console.warn('[BGE] Bot/CAPTCHA risk signals detected:', botRisk.signals);
      await screenshot(page, 'bge_audit_bot_risk');
    } else {
      console.log('[BGE] No bot detection signals observed.');
    }
  }
});

// ─── Test 2: Paperless Enrollment ─────────────────────────────────────────────

test('BGE Paperless Enrollment (all accounts)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE === 'audit' || MODE === 'bills' || MODE === 'pay') {
    test.skip(true, `Mode is ${MODE} — skipping paperless enrollment.`);
    return;
  }

  // ~86 accounts × ~60-90s each + safety. Cap at 2.5 hours.
  test.setTimeout(150 * 60 * 1000);

  console.log(`[BGE] Starting paperless enrollment for ${accounts.length} accounts.`);

  for (const account of accounts) {
    const { bge_account_number: acctNum, property_id: propId, property_name: propName } = account;
    console.log(`[BGE] Processing paperless for ${acctNum} (${propName})`);

    const result = ensureResult(acctNum);
    result.last_run_at = new Date().toISOString();

    const found = await navigateToAccount(page, acctNum);
    if (!found) {
      result.last_paperless_status = 'FAILED';
      result.last_error            = 'Account not found in portal';
      try { await logBGERun({ bge_account_number: acctNum, property_id: propId, action: 'navigate', status: 'FAILED', notes: 'Account not found in portal' }); } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }
      continue;
    }

    const ok = await enablePaperless(page, acctNum);
    result.last_paperless_status = ok ? 'SUCCESS' : 'FAILED';
    try {
      await logBGERun({
        bge_account_number: acctNum,
        property_id: propId,
        action: 'paperless_enrollment',
        status: ok ? 'SUCCESS' : 'FAILED',
      });
    } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }

    await randomDelay(2000, 1000);
  }
});

// ─── Test 3: Bill Retrieval ───────────────────────────────────────────────────

test('BGE Bill Retrieval (all accounts)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE === 'audit' || MODE === 'paperless' || MODE === 'pay') {
    test.skip(true, `Mode is ${MODE} — skipping bill retrieval.`);
    return;
  }

  test.setTimeout(150 * 60 * 1000);

  console.log(`[BGE] Starting bill retrieval for ${accounts.length} accounts.`);

  for (const account of accounts) {
    const { bge_account_number: acctNum, property_id: propId, property_name: propName } = account;
    console.log(`[BGE] Retrieving bill for ${acctNum} (${propName})`);

    const result = ensureResult(acctNum);
    result.last_run_at = new Date().toISOString();

    const found = await navigateToAccount(page, acctNum);
    if (!found) {
      result.last_error = result.last_error || 'Account not found in portal';
      try { await logBGERun({ bge_account_number: acctNum, property_id: propId, action: 'navigate', status: 'FAILED', notes: 'Account not found in portal' }); } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }
      continue;
    }

    const bill = await retrieveBill(page, acctNum);
    result.last_bill_amount = bill.amount !== null ? String(bill.amount) : '';
    result.last_due_date    = bill.dueDate ?? '';
    try {
      await logBGERun({
        bge_account_number: acctNum,
        property_id: propId,
        action: 'bill_retrieval',
        status: bill.amount !== null ? 'SUCCESS' : 'PARTIAL',
        bill_amount: bill.amount,
        due_date: bill.dueDate,
      });
    } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }

    await randomDelay(2000, 1000);
  }
});

// ─── Test 4: Payment (approved accounts only) ─────────────────────────────────

test('BGE Payment (approved accounts only)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE !== 'pay' && MODE !== 'full') {
    test.skip(true, `Mode is ${MODE} — skipping payment.`);
    return;
  }
  if (!RUN_ID) {
    throw new Error('RUN_ID (or WS2_RUN_ID) is required for pay mode — payments are gated per WS-2 run.');
  }
  test.setTimeout(150 * 60 * 1000);

  // Approval gate (June 19): pay ONLY accounts with a payment_approval row for
  // this run. No approval → SKIPPED_NO_APPROVAL, never submit.
  const approvals = await fetchPaymentApprovals(RUN_ID, 'bge');
  console.log(`[BGE] Payment run ${RUN_ID}: ${approvals.size} approved account(s) of ${accounts.length}.`);

  let paid = 0, skipped = 0, failed = 0;

  for (const account of accounts) {
    const { bge_account_number: acctNum, property_id: propId, property_name: propName } = account;
    const approval: PaymentApproval | undefined = approvals.get(String(acctNum));

    if (!approval) {
      skipped++;
      await recordPaymentAttempt({
        run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
        amount: null, status: 'SKIPPED_NO_APPROVAL',
      });
      continue;
    }

    // Idempotency: if this exact payment is already CONFIRMED, never re-submit.
    const key = paymentIdempotencyKey(RUN_ID, 'bge', acctNum, approval.approved_amount ?? null);
    if (await isPaymentConfirmed(key)) {
      console.log(`[BGE] ${acctNum} already CONFIRMED — skipping (idempotent).`);
      continue;
    }

    console.log(`[BGE] Paying ${acctNum} (${propName})`);
    const found = await navigateToAccount(page, acctNum);
    if (!found) {
      failed++;
      await recordPaymentAttempt({
        run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
        amount: approval.approved_amount ?? null, status: 'FAILED', error: 'Account not found in portal',
      });
      continue;
    }

    // Amount: approved amount if given, else whatever the dashboard bill shows.
    let amount = approval.approved_amount;
    if (amount == null) {
      const bill = await retrieveBill(page, acctNum);
      amount = bill.amount;
    }
    if (amount == null || amount <= 0) {
      skipped++;
      await recordPaymentAttempt({
        run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
        amount, status: 'FAILED',
        error: 'No payable amount (approved_amount null and bill amount unreadable/zero)',
      });
      continue;
    }

    await recordPaymentAttempt({
      run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
      amount, status: 'SUBMITTED',
    });

    const res = await submitPayment(page, acctNum, amount);
    if (res.ok) {
      paid++;
      await recordPaymentAttempt({
        run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
        amount, status: 'CONFIRMED', confirmation_ref: res.confirmationRef,
      });
    } else {
      failed++;
      await recordPaymentAttempt({
        run_id: RUN_ID, property_id: propId, utility: 'bge', account_number: acctNum,
        amount, status: 'FAILED', error: res.error,
      });
    }
    try {
      await logBGERun({
        bge_account_number: acctNum, property_id: propId, action: 'payment',
        status: res.ok ? 'SUCCESS' : 'FAILED', bill_amount: amount,
        notes: res.ok ? `Paid $${amount} (conf ${res.confirmationRef ?? 'n/a'})` : `Payment failed: ${res.error}`,
      });
    } catch (e) { console.error(`[BGE] Payment log failed for ${acctNum}:`, e); }

    await randomDelay(2000, 1000);
  }

  console.log(`[BGE] Payment done. PAID=${paid}, SKIPPED_NO_APPROVAL/zero=${skipped}, FAILED=${failed}.`);
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Submits a one-time payment for the currently-open BGE account. Approval-gated
 * by the caller. Best-effort selectors — run BGE_MODE=audit HEADLESS=false first
 * to confirm the Pay flow, then refine. Returns ok=false (never throws) so one
 * failure can't abort the batch; the caller records the attempt either way.
 *
 * Flow: "Pay" / "Make a Payment" → amount field (prefilled or typed) → choose
 * saved payment method → confirm → capture confirmation number.
 */
async function submitPayment(
  page: Page, accountNumber: string, amount: number
): Promise<{ ok: boolean; confirmationRef: string | null; error?: string }> {
  try {
    await dismissPopups(page, accountNumber);
    const payBtn = page.getByRole('link', { name: /^(pay|pay bill|make a payment|pay now)$/i })
      .or(page.getByRole('button', { name: /^(pay|pay bill|make a payment|pay now)$/i }))
      .first();
    if (!(await payBtn.isVisible({ timeout: 8_000 }).catch(() => false))) {
      await screenshot(page, `bge_no_pay_button_${accountNumber}`);
      return { ok: false, confirmationRef: null, error: 'Pay button not found' };
    }
    await payBtn.click();
    await page.waitForTimeout(2000);
    await dismissPopups(page, accountNumber);

    // Amount field — usually prefilled with the balance; set it when editable.
    const amountField = page.getByLabel(/amount/i)
      .or(page.locator('input[name*="amount" i], input[id*="amount" i]'))
      .first();
    if (await amountField.isVisible({ timeout: 4_000 }).catch(() => false)) {
      const editable = await amountField.isEditable().catch(() => false);
      if (editable) {
        await amountField.fill(String(amount.toFixed(2)));
        await randomDelay(300, 200);
      }
    }

    const continueBtn = page.getByRole('button', {
      name: /^(continue|next|review|review payment|submit payment|pay \$?[\d.,]+)$/i,
    }).first();
    if (await continueBtn.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(2000);
    }

    const confirmBtn = page.getByRole('button', {
      name: /^(confirm|submit|submit payment|authorize|pay now|make payment)$/i,
    }).first();
    if (!(await confirmBtn.isVisible({ timeout: 6_000 }).catch(() => false))) {
      await screenshot(page, `bge_no_confirm_button_${accountNumber}`);
      return { ok: false, confirmationRef: null, error: 'Payment confirm button not found' };
    }
    await confirmBtn.click();
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const confMatch = bodyText.match(/confirmation\s*(?:number|#|no\.?|code)?[:\s]+([A-Z0-9-]{4,})/i);
    const succeeded = /payment.*(?:successful|received|submitted|scheduled|complete)|thank you/i.test(bodyText) || !!confMatch;
    await screenshot(page, `bge_payment_${succeeded ? 'success' : 'unconfirmed'}_${accountNumber}`);

    if (!succeeded) return { ok: false, confirmationRef: null, error: 'No success/confirmation indicator after submit' };
    return { ok: true, confirmationRef: confMatch ? confMatch[1] : null };
  } catch (err: any) {
    await screenshot(page, `bge_payment_error_${accountNumber}`);
    return { ok: false, confirmationRef: null, error: err?.message ?? String(err) };
  }
}

/**
 * Navigates to a specific BGE account via the ChangeAccount.aspx picker:
 *   1. Ensure we're on /Pages/ChangeAccount.aspx
 *   2. Type the account number into the "Account Number Search:" box
 *   3. Wait for the DataTables grid to filter down to the matching row
 *   4. Click that row's "View" button (accessible name: "Select account for <address>")
 *   5. Wait for navigation off ChangeAccount.aspx onto the account dashboard
 */
async function navigateToAccount(page: Page, accountNumber: string): Promise<boolean> {
  try {
    if (!/ChangeAccount\.aspx/i.test(page.url())) {
      await page.goto('https://secure.bge.com/Pages/ChangeAccount.aspx', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null);
    }

    // The "Account Number Search:" input — DataTables filter.
    const searchBox = page.getByRole('searchbox', { name: /account number search/i }).first();
    await searchBox.waitFor({ state: 'visible', timeout: 20_000 });

    // Clear, then type one character at a time. pressSequentially fires real
    // keystroke events (DataTables listens for keyup); plain fill() can miss them.
    await searchBox.click();
    await searchBox.fill('');
    await page.waitForTimeout(300);
    await searchBox.pressSequentially(accountNumber, { delay: 60 });

    // Wait for the row containing the account number to actually appear in
    // the filtered grid. expect() auto-retries up to the timeout.
    const matchingRow = page.getByRole('row').filter({ hasText: accountNumber }).first();
    try {
      await expect(matchingRow).toBeVisible({ timeout: 15_000 });
    } catch (_) {
      console.warn(`[BGE] Account ${accountNumber} did not appear in the filtered grid after 15s.`);
      await screenshot(page, `bge_account_not_found_${accountNumber}`);
      return false;
    }

    // Click the row's View button. Its accessible name is "Select account for <address>",
    // or just "View" on some accounts.
    const viewBtn = matchingRow.getByRole('button', { name: /^select account for|^view$/i }).first();
    await viewBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await viewBtn.click();

    // Selecting an account navigates off ChangeAccount.aspx onto the dashboard.
    // Give it generous time to settle — dashboard renders late and the
    // "Welcome, set up your profile" modal usually appears a moment after.
    await page.waitForURL(u => !/ChangeAccount\.aspx/i.test(u.toString()), { timeout: 30_000 }).catch(() => null);
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(3500);

    // Dismiss the "Welcome / Set up your profile" modal (and any other
    // pop-ups) that BGE shows on the account dashboard before we can interact.
    await dismissPopups(page, accountNumber);

    return true;
  } catch (err: any) {
    console.error(`[BGE] Error navigating to account ${accountNumber}: ${err?.message ?? err}`);
    await screenshot(page, `bge_account_not_found_${accountNumber}`);
    return false;
  }
}

/**
 * Best-effort dismissal of pop-up modals on the BGE dashboard.
 * The main offender is the "Welcome, set up your profile" wizard with an
 * X button at the top-right of the modal. Tries common close-button patterns;
 * silent no-op if nothing matches.
 */
async function dismissPopups(page: Page, accountNumber?: string): Promise<number> {
  const candidates = [
    // ARIA-correct close buttons on modal dialogs
    page.locator('[role="dialog"] button[aria-label*="close" i]'),
    page.locator('[role="dialog"] button[aria-label*="dismiss" i]'),
    // Generic close buttons named "Close" / "Dismiss" / "No thanks"
    page.getByRole('button', { name: /^close$|^dismiss$|^no thanks$|^not now$|^skip$/i }),
    // BGE's welcome-modal X (rendered as a plain × / ✕ character)
    page.locator('button:has-text("×"), button:has-text("✕"), button:has-text("✖")'),
    // Top-banner "ant Reminder" notices with a separate X near the top of the page
    page.locator('button[aria-label*="close" i]:visible'),
  ];

  let dismissed = 0;
  for (const loc of candidates) {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        // Screenshot BEFORE clicking so we have visual evidence of what BGE showed.
        const tag = accountNumber ? `bge_popup_${accountNumber}_${dismissed + 1}` : `bge_popup_${Date.now()}_${dismissed + 1}`;
        await screenshot(page, tag).catch(() => null);
        await el.click({ timeout: 2_000 }).catch(() => null);
        dismissed++;
        await page.waitForTimeout(400);
      }
    }
  }
  if (dismissed > 0) {
    const ctx = accountNumber ? ` for ${accountNumber}` : '';
    console.log(`[BGE] Dismissed ${dismissed} pop-up(s) on dashboard${ctx} (screenshots saved as bge_popup_*).`);
  }
  return dismissed;
}

/**
 * Enables paperless billing for the currently visible account.
 *
 * BGE shows two dashboard layouts depending on the account:
 *   Layout A — modern: blue-bordered "Enroll Me in Paperless eBill" button
 *              in the "Billing and Payment Options" card on the right.
 *   Layout B — classic My Bill & Usage page: a row labeled "eBill: Not Enrolled"
 *              with a "+ Enroll" button next to it.
 * If the button is missing in both layouts the account is already enrolled,
 * which is also treated as success.
 */
async function enablePaperless(page: Page, accountNumber: string): Promise<boolean> {
  try {
    // Defensive: dismiss any pop-up that may have rendered late.
    await dismissPopups(page, accountNumber);

    // Layout A — modern dashboard button
    const layoutABtn = page.getByRole('link', { name: /enroll me in paperless ebill/i })
      .or(page.getByRole('button', { name: /enroll me in paperless ebill/i }))
      .first();

    // Layout B — "eBill: Not Enrolled  + Enroll" row on My Bill & Usage page.
    // The same page also has rows for Auto Pay and Budget Bill, each with their
    // own + Enroll button. Scope to the row that contains "eBill" AND an Enroll
    // button, but NOT "Auto Pay" or "Budget Bill" (which would only be true for
    // the outer container that wraps all three rows).
    const ebillRow = page
      .locator('tr, div, li, section, article')
      .filter({ hasText: 'eBill' })
      .filter({ hasNotText: /Auto[\s-]*Pay/i })
      .filter({ hasNotText: /Budget\s*Bill/i })
      .filter({ has: page.getByRole('button', { name: /enroll/i }) })
      .first();
    const layoutBBtn = ebillRow.getByRole('button', { name: /enroll/i }).first();

    const layoutAVisible = await layoutABtn.isVisible({ timeout: 5_000 }).catch(() => false);
    const layoutBVisible = !layoutAVisible
      ? await layoutBBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      : false;

    if (!layoutAVisible && !layoutBVisible) {
      // Already enrolled? The Layout A dashboard shows "Enrolled in eBill" with
      // a green check; Layout B shows "eBill: Enrolled".
      const alreadyEnrolled = await page
        .getByText(/enrolled\s+in\s+ebill|ebill\s*:?\s*enrolled|you'?re enrolled.*paperless|paperless.*active/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (alreadyEnrolled) {
        console.log(`[BGE] Paperless already enrolled for ${accountNumber}.`);
        await screenshot(page, `bge_paperless_already_${accountNumber}`);
        return true;
      }
      console.warn(`[BGE] No paperless enrollment button found for ${accountNumber} (neither layout).`);
      await screenshot(page, `bge_no_paperless_button_${accountNumber}`);
      return false;
    }

    if (layoutAVisible) {
      console.log(`[BGE] Layout A — clicking "Enroll Me in Paperless eBill" for ${accountNumber}.`);
      await layoutABtn.click();
    } else {
      console.log(`[BGE] Layout B — clicking eBill "+ Enroll" for ${accountNumber}.`);
      await layoutBBtn.click();
    }

    // ── After the dashboard click, BGE can land us on one of three pages: ──
    //   (a) Confirmation modal with body "You are (about|eligible) to enroll..."
    //       → we click the modal's Enroll button to finish enrollment
    //   (b) Paperless eBill management page showing "Enrollment Status: Enrolled"
    //       plus an "Unenroll" button → account is already enrolled, treat as success
    //   (c) Nothing recognized → fall through to text-based heuristic
    const modalText = page.getByText(/you are (?:about|eligible) to enroll in paperless ebill/i).first();
    const alreadyEnrolledIndicator = page
      .getByRole('button', { name: /^unenroll$/i })
      .or(page.getByRole('link', { name: /^unenroll$/i }))
      .or(page.getByText(/enrollment status[:\s]*\s*enrolled/i))
      .first();

    let postClickState: 'modal' | 'already_enrolled' | 'unknown';
    try {
      postClickState = await Promise.any([
        modalText.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'modal' as const),
        alreadyEnrolledIndicator.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'already_enrolled' as const),
      ]);
    } catch (_) {
      postClickState = 'unknown';
    }

    if (postClickState === 'already_enrolled') {
      console.log(`[BGE] ${accountNumber} → landed on Paperless eBill management page showing "Enrolled" / Unenroll button. Already enrolled.`);
      await screenshot(page, `bge_paperless_already_${accountNumber}`);
      return true;
    }

    if (postClickState === 'modal') {
      // After the dashboard "Enroll Me in Paperless eBill" click, the only
      // button on the page with the EXACT accessible name "Enroll" is the
      // one inside this modal. The dashboard's button is named "Enroll Me in
      // Paperless eBill"; AutoPay/Budget Bill use "Enroll in AutoPay" etc.
      const enrollInModalBtn = page.getByRole('button', { name: 'Enroll', exact: true }).first();
      await enrollInModalBtn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);
      console.log(`[BGE] Clicking "Enroll" in confirmation modal for ${accountNumber}.`);
      await enrollInModalBtn.click({ timeout: 5_000 });

      // Success = the modal body text disappears.
      const modalClosed = await modalText
        .waitFor({ state: 'hidden', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);

      await page.waitForTimeout(2500);
      await dismissPopups(page, accountNumber);

      if (modalClosed) {
        console.log(`[BGE] Paperless enrolled for ${accountNumber} (confirmation modal closed).`);
        await screenshot(page, `bge_paperless_success_${accountNumber}`);
        return true;
      }
      console.warn(`[BGE] Confirmation modal did not close after Enroll click for ${accountNumber}.`);
      await screenshot(page, `bge_paperless_modal_stuck_${accountNumber}`);
      return false;
    }

    // No modal appeared — maybe BGE enrolled silently, maybe nothing happened.
    // Look for success text or check whether the dashboard button is now gone.
    await page.waitForTimeout(2500);
    await dismissPopups(page, accountNumber);
    const successHint = page
      .getByText(/successfully enroll|thank you.*paperless|enrollment\s*confirmed|eBill\s*:?\s*Enrolled|you are enrolled/i)
      .first();
    const successVisible = await successHint.isVisible({ timeout: 5_000 }).catch(() => false);
    const buttonGoneA    = !(await layoutABtn.isVisible().catch(() => false));
    const buttonGoneB    = !(await layoutBBtn.isVisible().catch(() => false));

    const confirmed = successVisible || (layoutAVisible ? buttonGoneA : buttonGoneB);

    if (confirmed) {
      console.log(`[BGE] Paperless enrolled for ${accountNumber} (no modal, success indicator found).`);
      await screenshot(page, `bge_paperless_success_${accountNumber}`);
    } else {
      console.warn(`[BGE] Paperless enrollment unconfirmed for ${accountNumber} (no modal appeared).`);
      await screenshot(page, `bge_paperless_unconfirmed_${accountNumber}`);
    }
    return confirmed;
  } catch (err: any) {
    console.error(`[BGE] Error enabling paperless for ${accountNumber}: ${err?.message ?? err}`);
    await screenshot(page, `bge_paperless_error_${accountNumber}`);
    return false;
  }
}

/**
 * Reads the current bill amount and due date directly off the BGE dashboard.
 *
 * No navigation to a separate billing page — the dashboard already shows:
 *   "Total Amount Due  $1,870.11"
 *   "You have a bill due on Wednesday, Jun 3rd."   (or "due immediately" if overdue)
 *   "AMOUNT DUE / AMOUNT OVERDUE  $X" in the top-right Account Options card
 *
 * Regex-based on body text — far more robust than CSS class guesses, since
 * BGE's classes vary between Layout A and Layout B dashboards.
 */
async function retrieveBill(
  page: Page,
  accountNumber: string
): Promise<{ amount: number | null; dueDate: string | null }> {
  const result = { amount: null as number | null, dueDate: null as string | null };
  try {
    await dismissPopups(page, accountNumber);

    const bodyText = await page.locator('body').innerText();

    // Amount: prefer "Total Amount Due" then top-right "Amount Due/Overdue" card.
    const amountPatterns = [
      /Total Amount Due\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /Amount\s+(?:Due|Overdue)\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /Current Amount Due[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /\$([\d,]+\.\d{2})/, // last-resort fallback: first $X.XX on the page
    ];
    for (const re of amountPatterns) {
      const m = bodyText.match(re);
      if (m) {
        result.amount = parseDollarAmount(m[1]);
        if (result.amount !== null) break;
      }
    }

    // Due date: handle natural-language ("due on Monday, Jun 1st"),
    // numeric ("Due by 06/03/2026"), and the overdue case ("due immediately").
    const dueDatePatterns = [
      /bill due on\s+([A-Z][a-z]+,?\s+[A-Z][a-z]+\s+\d+(?:st|nd|rd|th)?)/i,
      /Due\s*(?:Date|by)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      /(\d{1,2}\/\d{1,2}\/\d{4})/, // any MM/DD/YYYY on the page
      /(due\s+immediately)/i,
    ];
    for (const re of dueDatePatterns) {
      const m = bodyText.match(re);
      if (m) {
        result.dueDate = re.source.includes('immediately') ? 'OVERDUE' : (parseDate(m[1]) ?? m[1]);
        if (result.dueDate) break;
      }
    }

    console.log(`[BGE] ${accountNumber} — Amount: $${result.amount ?? 'N/A'}, Due: ${result.dueDate ?? 'N/A'}`);
  } catch (err: any) {
    console.error(`[BGE] Error retrieving bill for ${accountNumber}: ${err?.message ?? err}`);
    await screenshot(page, `bge_bill_error_${accountNumber}`);
  }
  return result;
}
