import { Page } from '@playwright/test';
import fs from 'fs';

/** Random delay within [base, base+jitter) ms to reduce bot detection risk. */
export function randomDelay(baseMs = 800, jitterMs = 600): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, baseMs + Math.random() * jitterMs)
  );
}

/** Parse a dollar amount from strings like "$142.50", "Amount Due: $142.50". */
export function parseDollarAmount(text: string): number | null {
  const match = text.replace(/,/g, '').match(/\$?([\d]+\.?\d{0,2})/);
  return match ? parseFloat(match[1]) : null;
}

/** Parse a date from "05/15/2026" or "May 15, 2026" format. */
export function parseDate(text: string): string | null {
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})/);
  return match ? match[1] : null;
}

/** Hides navigator.webdriver to reduce bot detection signals. */
export async function hideAutomationSignals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Spoof plugins length (headless Chrome has 0)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

/** Take a screenshot with a timestamped filename into screenshots/.
 *  Swallows "Target page, context or browser has been closed" so error-path
 *  screenshot calls don't mask the real failure. */
export async function screenshot(page: Page, label: string): Promise<void> {
  try {
    if (page.isClosed?.()) return;
    fs.mkdirSync('screenshots', { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = `screenshots/${label}_${ts}.png`;
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[Screenshot] Saved: ${filePath}`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/closed/i.test(msg) || /Target.*closed/i.test(msg)) return;
    console.warn(`[Screenshot] Failed to capture "${label}": ${msg}`);
  }
}

/**
 * Splits a unit address into its base street address and unit marker.
 *
 * Business rule (per Dominion's unit table): single-unit properties have a
 * unit address identical to the property address ("1 Glyer Ct"); units of
 * multi-unit properties carry a "#" marker ("10 E Lee St #2002", "01011
 * Hunter St # F3"). Everything after the FIRST "#" is the unit suffix.
 */
export function parseUnitAddress(address: string): {
  base: string;
  unitSuffix: string | null;
  isMultiUnit: boolean;
} {
  const trimmed = (address ?? '').trim();
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) {
    return { base: trimmed, unitSuffix: null, isMultiUnit: false };
  }
  const base = trimmed.slice(0, hashIdx).trim();
  const suffix = trimmed.slice(hashIdx + 1).trim();
  if (!suffix) {
    // Bare trailing "#" — no usable unit marker.
    return { base, unitSuffix: null, isMultiUnit: false };
  }
  return { base, unitSuffix: suffix, isMultiUnit: true };
}

/**
 * @deprecated Superseded by the WS-2 routing engine's consumption tiering
 * (routingEngine.ts detectAnomalies — NORMAL / LETTER / LETTER_PLUS_WORKORDER,
 * expected = adults×10 + children×5 per the June 12 2026 call). The hardcoded
 * 25/35 absolute thresholds here do not reflect the agreed per-occupant baseline
 * and are retained only for the legacy water.spec.ts audit-log column. Do not use
 * for new routing decisions.
 */
export function determineWaterAction(
  consumption: number | null,
  baseline: number | null
): 'auto_pay' | 'pay_alert_pm' | 'pay_work_order' {
  if (consumption === null || baseline === null) return 'auto_pay';
  if (consumption < 25) return 'auto_pay';
  if (consumption <= 35) return 'pay_alert_pm';
  return 'pay_work_order';
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export async function detectBotBlock(page: Page): Promise<{
  captchaDetected: boolean;
  blockDetected: boolean;
  signals: string[];
}> {
  const signals: string[] = [];
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  const combined = `${url} ${title} ${bodyText}`;

  if (/captcha|recaptcha/i.test(combined)) signals.push('[CAPTCHA] Keyword detected in page content');
  if (await page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"]').isVisible().catch(() => false))
    signals.push('[CAPTCHA] CAPTCHA iframe detected');
  if (await page.locator('.g-recaptcha, #recaptcha, [data-sitekey]').isVisible().catch(() => false))
    signals.push('[CAPTCHA] reCAPTCHA DOM element detected');
  if (/blocked|access denied|forbidden|bot detected|unusual traffic/i.test(bodyText))
    signals.push('[BLOCK] Block or denial language in page body');
  if (/cloudflare/i.test(bodyText) && /challenge/i.test(bodyText))
    signals.push('[BLOCK] Cloudflare challenge page detected');

  return {
    captchaDetected: signals.some(s => s.startsWith('[CAPTCHA]')),
    blockDetected: signals.some(s => s.startsWith('[BLOCK]')),
    signals,
  };
}
