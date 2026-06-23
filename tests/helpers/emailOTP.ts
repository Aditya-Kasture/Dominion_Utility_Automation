/**
 * Polls the IMAP inbox for a BGE verification email and extracts the OTP code.
 * Uses imap-simple + mailparser. Install: npm i imap-simple mailparser @types/imap
 */
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import type { Page, Locator } from '@playwright/test';

/**
 * Manual OTP entry — the script pauses and lets the user paste the code
 * into the BGE browser window themselves. Resumes automatically once BGE
 * accepts the code and the OTP field disappears.
 *
 * Requires HEADLESS=false (browser must be visible).
 */
export async function waitForManualOtp(
  page: Page,
  otpField: Locator,
  maxWaitMs = 15 * 60 * 1000
): Promise<boolean> {
  const minutes = Math.round(maxWaitMs / 60_000);
  console.log('\n' + '═'.repeat(70));
  console.log('  [OTP] MANUAL ENTRY REQUIRED');
  console.log('  1. Open Outlook and check the construction@thedominiongroup.com inbox.');
  console.log('  2. Find the BGE verification email and copy the code.');
  console.log('  3. Paste the code into the OTP field in the open BGE browser window.');
  console.log('  4. Click Verify / Continue in the browser.');
  console.log(`  Waiting up to ${minutes} minutes for OTP screen to clear...`);
  console.log('═'.repeat(70) + '\n');

  try {
    await otpField.waitFor({ state: 'hidden', timeout: maxWaitMs });
    console.log('[OTP] OTP screen cleared — login proceeding.');
    return true;
  } catch (_) {
    console.error(`[OTP] Timed out — OTP screen still showing after ${minutes} minutes.`);
    return false;
  }
}

interface OTPReaderConfig {
  host: string;
  port: number;
  email: string;
  password: string;
  senderFilter?: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export async function fetchBGEOtp(config: OTPReaderConfig): Promise<string | null> {
  const {
    host,
    port,
    email,
    password,
    senderFilter = 'noreply@bge.com',
    maxWaitMs = 120_000,
    pollIntervalMs = 5_000,
  } = config;

  const imapConfig = {
    imap: {
      host,
      port,
      tls: true,
      user: email,
      password,
      authTimeout: 10_000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let connection: imaps.ImapSimple | null = null;
    try {
      connection = await imaps.connect(imapConfig);
      await connection.openBox('INBOX');

      const searchCriteria = ['UNSEEN', ['FROM', senderFilter]];
      const fetchOptions = { bodies: [''], markSeen: false };
      const messages = await connection.search(searchCriteria, fetchOptions);

      if (messages.length > 0) {
        // Take the most recent
        const latest = messages[messages.length - 1];
        const raw = latest.parts.find((p: imaps.Message['parts'][number]) => p.which === '')?.body ?? '';
        const parsed = await simpleParser(raw as string);
        const body = parsed.text ?? parsed.html ?? '';

        const otp = extractOtp(body.toString());
        if (otp) {
          // Mark as read so we don't re-process it
          const uid = latest.attributes.uid;
          await connection.addFlags(uid, '\\Seen');
          await connection.end();
          console.log(`[OTP] Code found (first 2 chars): ${otp.substring(0, 2)}****`);
          return otp;
        }
      }

      await connection.end();
    } catch (err) {
      console.error('[OTP] IMAP error:', err);
      try { await connection?.end(); } catch (_) {}
    }

    if (Date.now() < deadline) {
      console.log(`[OTP] Not found yet — retrying in ${pollIntervalMs / 1000}s...`);
      await sleep(pollIntervalMs);
    }
  }

  console.error('[OTP] Timed out waiting for BGE OTP email.');
  return null;
}

function extractOtp(body: string): string | null {
  const patterns = [
    /(?:code|otp|pin|verification)[:\s]+(\d{4,8})/i,
    /(?:Your|Enter)[^.]{0,60}?(\d{6})/i,
    /\b(\d{6})\b/,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Microsoft Graph OTP path ─────────────────────────────────────────────────
// Reads the BGE verification email from the construction@thedominiongroup.com
// shared mailbox via the Graph API using app-only (client credentials) auth.
//
// Required env vars (accepts several common naming conventions):
//   AZURE_TENANT_ID  | GRAPH_TENANT_ID  | MS_TENANT_ID  | TENANT_ID
//   AZURE_CLIENT_ID  | GRAPH_CLIENT_ID  | MS_CLIENT_ID  | CLIENT_ID
//   AZURE_CLIENT_SECRET | GRAPH_CLIENT_SECRET | MS_CLIENT_SECRET | CLIENT_SECRET
// Optional:
//   BGE_OTP_MAILBOX  (default: construction@thedominiongroup.com)
//   BGE_OTP_SENDER   (default: no-reply@bge.com)

function envFirst(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

interface GraphTokenCache {
  token: string;
  expiresAt: number; // epoch ms
}
let graphTokenCache: GraphTokenCache | null = null;

async function getGraphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  if (graphTokenCache && graphTokenCache.expiresAt > Date.now() + 60_000) {
    return graphTokenCache.token;
  }
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[OTP/Graph] Token request failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  graphTokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return graphTokenCache.token;
}

interface GraphOtpConfig {
  /** Poll until this many ms have elapsed. Default 3 min. */
  maxWaitMs?: number;
  /** Poll interval. Default 5 s. */
  pollIntervalMs?: number;
  /** Only consider messages with receivedDateTime > this Date. */
  since?: Date;
  /** Override mailbox / sender via parameter instead of env. */
  mailbox?: string;
  sender?: string;
}

/**
 * Generic Graph OTP reader. BGE and Water both deliver their verification codes
 * to the same shared Outlook mailbox (construction@thedominiongroup.com) — only
 * the sender differs — so the only per-portal difference is the `sender` filter.
 * Callers pass { sender, mailbox } (or set per-portal env vars); the default
 * mailbox + BGE sender preserve the original BGE behaviour.
 */
export async function fetchOtpFromGraph(config: GraphOtpConfig = {}): Promise<string | null> {
  const tenantId     = envFirst('AZURE_TENANT_ID', 'GRAPH_TENANT_ID', 'MS_TENANT_ID', 'TENANT_ID');
  const clientId     = envFirst('AZURE_CLIENT_ID', 'GRAPH_CLIENT_ID', 'MS_CLIENT_ID', 'APPLICATION_ID', 'CLIENT_ID');
  const clientSecret = envFirst('AZURE_CLIENT_SECRET', 'GRAPH_CLIENT_SECRET', 'MS_CLIENT_SECRET', 'SECRET_ID', 'CLIENT_SECRET');

  if (!tenantId || !clientId || !clientSecret) {
    console.error('[OTP/Graph] Missing Azure credentials. Set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (or compatible aliases) in .env.');
    return null;
  }

  const mailbox = config.mailbox ?? process.env.BGE_OTP_MAILBOX ?? 'construction@thedominiongroup.com';
  const sender  = (config.sender  ?? process.env.BGE_OTP_SENDER  ?? 'no-reply@bge.com').toLowerCase();
  const maxWaitMs = config.maxWaitMs ?? 3 * 60_000;
  const pollIntervalMs = config.pollIntervalMs ?? 5_000;
  const since = config.since ?? new Date(Date.now() - 5 * 60_000); // last 5 min

  console.log(`[OTP/Graph] Polling ${mailbox} for messages from ${sender} (since ${since.toISOString()})...`);

  let token: string;
  try {
    token = await getGraphToken(tenantId, clientId, clientSecret);
  } catch (err: any) {
    console.error(`[OTP/Graph] Could not acquire token: ${err?.message ?? err}`);
    return null;
  }

  const sinceIso = since.toISOString();
  // Filter on receivedDateTime + sender. Take the most recent 5.
  const listUrl =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$top=5&$orderby=${encodeURIComponent('receivedDateTime desc')}` +
    `&$select=${encodeURIComponent('id,subject,from,receivedDateTime,bodyPreview,body,isRead')}`;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        graphTokenCache = null;
        token = await getGraphToken(tenantId, clientId, clientSecret);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[OTP/Graph] List failed (${res.status}): ${text.slice(0, 200)}`);
      } else {
        const data = await res.json() as { value: any[] };
        for (const msg of data.value ?? []) {
          const fromAddr = String(msg.from?.emailAddress?.address ?? '').toLowerCase();
          if (fromAddr !== sender) continue;
          const text = (msg.body?.content ?? '') + ' ' + (msg.bodyPreview ?? '');
          // Strip HTML tags for a cleaner body match
          const stripped = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
          const code = extractOtp(stripped);
          if (code) {
            console.log(`[OTP/Graph] Code found in message from ${fromAddr} received ${msg.receivedDateTime} (first 2: ${code.substring(0, 2)}****).`);
            // Mark read so it isn't reused
            await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${msg.id}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ isRead: true }),
            }).catch(() => null);
            return code;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[OTP/Graph] Poll error: ${err?.message ?? err}`);
    }

    if (Date.now() < deadline) {
      console.log(`[OTP/Graph] Not found yet — retry in ${pollIntervalMs / 1000}s...`);
      await sleep(pollIntervalMs);
    }
  }

  console.error(`[OTP/Graph] Timed out waiting for OTP email from ${sender}.`);
  return null;
}

/** BGE OTP via Graph — thin wrapper preserving the original signature/defaults. */
export function fetchBGEOtpFromGraph(config: GraphOtpConfig = {}): Promise<string | null> {
  return fetchOtpFromGraph({
    ...config,
    mailbox: config.mailbox ?? process.env.BGE_OTP_MAILBOX ?? 'construction@thedominiongroup.com',
    sender: config.sender ?? process.env.BGE_OTP_SENDER ?? 'no-reply@bge.com',
  });
}

/** Baltimore Water OTP via Graph — same shared mailbox, different sender.
 *  Override sender/mailbox via WATER_OTP_SENDER / WATER_OTP_MAILBOX. */
export function fetchWaterOtpFromGraph(config: GraphOtpConfig = {}): Promise<string | null> {
  return fetchOtpFromGraph({
    ...config,
    mailbox: config.mailbox ?? process.env.WATER_OTP_MAILBOX ?? process.env.BGE_OTP_MAILBOX ?? 'construction@thedominiongroup.com',
    sender: config.sender ?? process.env.WATER_OTP_SENDER ?? 'no-reply@baltimorecity.gov',
  });
}
