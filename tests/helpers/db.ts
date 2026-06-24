/**
 * PostgreSQL/Supabase helpers.
 * Install: npm i pg @types/pg
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';

const WATER_CACHE_FILE = path.resolve(__dirname, '..', '..', 'cache', 'water-accounts.json');
const OFFLINE_LOG_DIR  = path.resolve(__dirname, '..', '..', 'cache');
const WATER_OFFLINE_LOG = path.join(OFFLINE_LOG_DIR, 'water-run-offline.jsonl');
const BGE_OFFLINE_LOG   = path.join(OFFLINE_LOG_DIR, 'bge-run-offline.jsonl');

// When set to true (auto on first ECONNRESET/ENOTFOUND etc., or explicitly via
// DB_OFFLINE=1), log writes go to a JSONL file in /cache instead of Postgres.
let dbOffline = process.env.DB_OFFLINE === '1' || process.env.DB_OFFLINE === 'true';

// WS-6 "Supabase-ready" seam: every audit/feedback write qualifies its table with
// this schema, so moving WS-6 to Supabase (June 19 decision) is a config swap
// (WS6_SCHEMA=...) rather than a code change. Defaults to the current Postgres home.
const AUDIT_SCHEMA = process.env.WS6_SCHEMA ?? 'public';

function isDbUnavailableError(err: any): boolean {
  const code = err?.code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code);
}

function appendOfflineLog(file: string, payload: any): void {
  try {
    fs.mkdirSync(OFFLINE_LOG_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...payload, run_at: new Date().toISOString() }) + '\n', 'utf8');
  } catch (e: any) {
    console.warn(`[DB] Could not write offline log line: ${e?.message ?? e}`);
  }
}

export interface BGEAccount {
  bge_account_number: string;
  property_address: string;
  property_id: number | null;   // NULL if the bge_account_property_map row doesn't have a matching hub.property
  property_name: string;
  lifecycle_stage: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
}

export interface WaterAccount {
  unit_id: number;
  appfolio_unit_id: string;
  unit_name: string;
  property_id: number;
  property_name: string;
  /** Unit-level address when present (carries the "#A"/"#2002" suffix on
   *  multi-unit properties), falling back to the property address for
   *  single-unit properties where the two are identical. */
  street1: string;
  city: string;
  state: string;
  zip: string;
  lifecycle_stage: string;
  /** Unit occupancy from AppFolio, e.g. 'occupied' | 'vacant_unrented'.
   *  May be undefined when reading a cache file written before this field existed. */
  status_code: string | null;
  /** TRUE when the parent property has more than one unit (units carry "#X" markers).
   *  May be undefined when reading a cache file written before this field existed. */
  is_multi_unit: boolean;
  consumption_baseline: number | null;
  baseline_period: string | null;
  water_account_number: string | null;
}

export function validateEnv(keys: string[]): void {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n` +
      missing.map(k => `  · ${k}`).join('\n') +
      `\nCopy .env.example to .env and fill in the values.`
    );
  }
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function fetchBGEAccounts(): Promise<BGEAccount[]> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<BGEAccount>(`
      SELECT
        bap.bge_account_number,
        bap.property_address,
        COALESCE(p.id, bap.property_id)        AS property_id,
        COALESCE(p.name, bap.property_address) AS property_name,
        COALESCE(p.lifecycle_stage, '')        AS lifecycle_stage,
        COALESCE(p.street1, bap.property_address) AS street1,
        COALESCE(p.city, '')                   AS city,
        COALESCE(p.state, '')                  AS state,
        COALESCE(p.zip, '')                    AS zip
      FROM public.bge_account_property_map bap
      LEFT JOIN hub.property p ON bap.property_id = p.id
      ORDER BY bap.bge_account_number
    `);
    return rows;
  } finally {
    client.release();
  }
}

export async function fetchWaterAccounts(): Promise<WaterAccount[]> {
  // Offline cache path: water.spec.ts is meant to run from the portal-VPN
  // network where the internal DB may not be reachable. Run
  // `npm run cache:water` from the DB-accessible network first, then this
  // function reads the JSON file instead of hitting the DB.
  if (fs.existsSync(WATER_CACHE_FILE)) {
    const raw = fs.readFileSync(WATER_CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw) as WaterAccount[];
    console.log(`[Water] Loaded ${cached.length} units from cache: ${WATER_CACHE_FILE}`);
    return cached;
  }
  console.log('[Water] No cache file found — querying DB directly. (Run "npm run cache:water" to avoid this on networks without DB access.)');

  const client = await getPool().connect();
  try {
    const { rows } = await client.query<WaterAccount>(`
      SELECT
        u.id                AS unit_id,
        u.appfolio_unit_id,
        u.unit_name,
        p.id                AS property_id,
        p.name              AS property_name,
        -- Prefer the unit-level address: on multi-unit properties it carries the
        -- "#A"/"#2002" marker; on single-unit properties unit and property
        -- addresses are identical, and the property row is the fallback.
        COALESCE(NULLIF(u.street1, ''), p.street1) AS street1,
        COALESCE(NULLIF(u.city,    ''), p.city)    AS city,
        COALESCE(NULLIF(u.state,   ''), p.state)   AS state,
        p.zip,
        p.lifecycle_stage,
        u.status_code,
        (SELECT COUNT(*) FROM hub.unit u2 WHERE u2.property_id = p.id) > 1
                            AS is_multi_unit,
        ucb.baseline_amount AS consumption_baseline,
        ucb.period_unit     AS baseline_period,
        wam.water_account_number
      FROM hub.unit u
      JOIN hub.property p ON u.property_id = p.id
      JOIN hub.unit_utility_responsibility uur
        ON uur.unit_id = u.id
        AND uur.utility_type = 'water'
        AND uur.responsibility IN ('landlord', 'dp')
      LEFT JOIN hub.unit_consumption_baseline ucb
        ON ucb.unit_id = u.id
        AND ucb.utility_type = 'water'
        AND ucb.period_unit = 'quarterly'
      LEFT JOIN public.water_account_map wam
        ON wam.unit_id = u.id
      WHERE p.is_active = TRUE
      ORDER BY p.name, u.unit_name
    `);
    return rows;
  } finally {
    client.release();
  }
}

// ─── WS-6 audit-log middleware ──────────────────────────────────────────────
// One source-agnostic writer for every portal action, replacing the two
// near-identical loggers that used to live here. Routes to the correct physical
// table by `entity`, preserves the offline-JSONL fallback, and qualifies the
// table with AUDIT_SCHEMA (the Supabase-ready seam). logBGERun / logWaterRun are
// kept as thin wrappers so existing WS-3/WS-4 call sites need no change.

export type AuditEntity = 'bge' | 'water';
export type AuditSource = 'WS-1' | 'WS-2' | 'WS-3' | 'WS-4' | 'WS-6';

export interface AuditEvent {
  source: AuditSource;
  entity: AuditEntity;          // selects the physical portal-log table
  property_id: number | null;
  action: string;
  status: string;
  // bge identity
  bge_account_number?: string;
  // water identity
  unit_id?: number;
  // shared payload
  bill_amount?: number | null;
  due_date?: string | null;
  notes?: string | null;
  // water-only payload
  consumption_units?: number | null;
  threshold_action?: string | null;
  // June 19: bill window for WS-2 proration (columns added in db/migrations.sql).
  period_start?: string | null;
  period_end?: string | null;
}

export async function logAuditEvent(e: AuditEvent): Promise<void> {
  const offlineFile = e.entity === 'bge' ? BGE_OFFLINE_LOG : WATER_OFFLINE_LOG;

  // BGE audit log requires NOT NULL property_id. If the account doesn't link to
  // a hub.property row, skip the DB log (the screenshot trail still has it).
  if (e.entity === 'bge' && e.property_id == null) {
    console.warn(`[BGE] Skipping audit-log write for ${e.bge_account_number} — no property_id (unmatched to hub.property).`);
    return;
  }
  if (dbOffline) {
    appendOfflineLog(offlineFile, e);
    return;
  }

  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    if (e.entity === 'bge') {
      await client.query(
        `INSERT INTO ${AUDIT_SCHEMA}.bge_portal_audit_log
           (bge_account_number, property_id, action, status, bill_amount, due_date, notes, run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT DO NOTHING`,
        [
          e.bge_account_number, e.property_id, e.action, e.status,
          e.bill_amount ?? null, e.due_date ?? null, e.notes ?? null,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO ${AUDIT_SCHEMA}.water_portal_audit_log
           (unit_id, property_id, action, status, bill_amount,
            consumption_units, due_date, threshold_action, notes,
            period_start, period_end, run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT DO NOTHING`,
        [
          e.unit_id, e.property_id, e.action, e.status,
          e.bill_amount ?? null, e.consumption_units ?? null,
          e.due_date ?? null, e.threshold_action ?? null, e.notes ?? null,
          e.period_start ?? null, e.period_end ?? null,
        ]
      );
    }
  } catch (err: any) {
    if (isDbUnavailableError(err)) {
      if (!dbOffline) {
        dbOffline = true;
        console.warn(`[DB] Connection lost (${err.code}). Switching to OFFLINE mode — subsequent log writes go to ${offlineFile}`);
      }
      appendOfflineLog(offlineFile, e);
      return;
    }
    throw err;
  } finally {
    client?.release();
  }
}

/** WS-3 BGE portal action → audit log. Thin wrapper over logAuditEvent. */
export function logBGERun(params: {
  bge_account_number: string;
  property_id: number | null;
  action: string;
  status: string;
  bill_amount?: number | null;
  due_date?: string | null;
  notes?: string | null;
}): Promise<void> {
  return logAuditEvent({ source: 'WS-3', entity: 'bge', ...params });
}

/** WS-4 Water portal action → audit log. Thin wrapper over logAuditEvent. */
export function logWaterRun(params: {
  unit_id: number;
  property_id: number;
  action: string;
  status: string;
  bill_amount?: number | null;
  consumption_units?: number | null;
  due_date?: string | null;
  threshold_action?: string | null;
  notes?: string | null;
  period_start?: string | null;
  period_end?: string | null;
}): Promise<void> {
  return logAuditEvent({ source: 'WS-4', entity: 'water', ...params });
}

/** WS-6 feedback hook — records a user's disagreement with a routing verdict.
 *  Writes the existing routing_feedback table (db/ws2-routing.sql). The WS-7
 *  report UI can call this same function once it exists. */
export async function recordRoutingFeedback(params: {
  run_id: string;
  property_id: number;
  utility?: string | null;       // 'bge' | 'water' | null (whole property)
  feedback_text: string;
  submitted_by?: string | null;
}): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    await client.query(
      `INSERT INTO ${AUDIT_SCHEMA}.routing_feedback
         (run_id, property_id, utility, feedback_text, submitted_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [params.run_id, params.property_id, params.utility ?? null,
       params.feedback_text, params.submitted_by ?? null]
    );
  } finally {
    client?.release();
  }
}

// ─── WS-3 / WS-4 payment execution (approval-gated + idempotent) ────────────────
// Payment never fires without an explicit payment_approval row (June 19 2026).
// recordPaymentAttempt() is keyed by an idempotency_key so a re-run can never
// double-pay. See db/ws3-ws4-payments.sql.

export type PaymentUtility = 'bge' | 'water';

export interface PaymentApproval {
  property_id: number | null;
  utility: PaymentUtility;
  account_number: string;
  approved_amount: number | null;
  approved_by: string;
}

export type PaymentStatus =
  | 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'SKIPPED_NO_APPROVAL';

/** Deterministic idempotency key for a payment — a second submit with the same
 *  run/utility/account/amount collides and is rejected by the UNIQUE index. */
export function paymentIdempotencyKey(
  run_id: string, utility: PaymentUtility, account_number: string, amount: number | null
): string {
  return crypto.createHash('sha256')
    .update(`${run_id}|${utility}|${account_number}|${amount ?? ''}`)
    .digest('hex');
}

/** Approvals for a run+utility, keyed by account_number. Empty map (no approvals)
 *  is the safe default — the agent then SKIPs every account. */
export async function fetchPaymentApprovals(
  run_id: string, utility: PaymentUtility
): Promise<Map<string, PaymentApproval>> {
  const out = new Map<string, PaymentApproval>();
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    const { rows } = await client.query<PaymentApproval>(
      `SELECT property_id, utility, account_number, approved_amount, approved_by
         FROM public.payment_approval
        WHERE run_id = $1 AND utility = $2`,
      [run_id, utility]
    );
    for (const r of rows) out.set(String(r.account_number), { ...r, approved_amount: r.approved_amount == null ? null : Number(r.approved_amount) });
  } catch (err: any) {
    console.warn(`[DB] Could not load payment approvals (${err?.message ?? err}) — treating as NO approvals (all skipped).`);
  } finally {
    client?.release();
  }
  return out;
}

/** True if this exact payment has already been CONFIRMED (idempotent re-run guard). */
export async function isPaymentConfirmed(idempotency_key: string): Promise<boolean> {
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM public.payment_attempt WHERE idempotency_key = $1`,
      [idempotency_key]
    );
    return rows.some(r => r.status === 'CONFIRMED');
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

/** Insert/advance a payment attempt. UNIQUE(idempotency_key) makes a duplicate
 *  submit a no-op; status transitions are recorded via updated_at on conflict for
 *  the SAME key only when moving a PENDING/SUBMITTED row to a terminal state. */
export async function recordPaymentAttempt(params: {
  run_id: string;
  property_id: number | null;
  unit_id?: number | null;
  utility: PaymentUtility;
  account_number: string;
  amount: number | null;
  status: PaymentStatus;
  confirmation_ref?: string | null;
  error?: string | null;
}): Promise<void> {
  const key = paymentIdempotencyKey(params.run_id, params.utility, params.account_number, params.amount);
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    await client.query(
      `INSERT INTO public.payment_attempt
         (run_id, property_id, unit_id, utility, account_number, idempotency_key,
          amount, status, confirmation_ref, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status           = EXCLUDED.status,
             confirmation_ref = COALESCE(EXCLUDED.confirmation_ref, public.payment_attempt.confirmation_ref),
             error            = EXCLUDED.error,
             updated_at       = NOW()
         WHERE public.payment_attempt.status NOT IN ('CONFIRMED')`,
      [params.run_id, params.property_id, params.unit_id ?? null, params.utility,
       params.account_number, key, params.amount, params.status,
       params.confirmation_ref ?? null, params.error ?? null]
    );
  } catch (err: any) {
    console.error(`[DB] Failed to record payment_attempt for ${params.account_number}: ${err?.message ?? err}`);
  } finally {
    client?.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
