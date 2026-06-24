/**
 * WS-6 — per-run summary generator.
 *
 * buildRunSummary() aggregates the run's per-property tables (written by
 * WS-2/WS-3/WS-4) into one rollup row — the "what did we do this week" answer
 * the WS-6 Outlook digest is built from and that ops can query in run_summary.
 * persistRunSummary() upserts that row (idempotent re-run).
 *
 * All reads are keyed by run_id and reuse the shared pool from db.ts. Tables are
 * qualified with WS6_SCHEMA (the Supabase-ready seam) — same default as db.ts.
 */
import { getPool } from './db';

const AUDIT_SCHEMA = process.env.WS6_SCHEMA ?? 'public';

export interface RunSummary {
  run_id: string;
  // routing
  bge_pay: number;
  water_pay: number;
  tenant_skip: number;
  exception_count: number;
  occupancy_checks: number;
  // anomalies / WS-7 staging
  severe_anomalies: number;
  moderate_anomalies: number;
  letters: number;
  work_orders: number;
  // proration / payments
  prorations_needing_review: number;
  payments_confirmed: number;
  payments_failed: number;
  payments_skipped: number;
  amount_paid_total: number;
  // coverage (accounts routed per utility)
  bge_accounts_seen: number;
  water_accounts_seen: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function buildRunSummary(run_id: string): Promise<RunSummary> {
  const pool = getPool();

  // Routing verdicts, split by utility, plus the occupancy-check trigger count.
  const routing = await pool.query<{ utility: string; decision: string; c: string }>(
    `SELECT utility, decision, COUNT(*)::int AS c
       FROM ${AUDIT_SCHEMA}.routing_decision
      WHERE run_id = $1
      GROUP BY utility, decision`,
    [run_id]
  );
  const occ = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.routing_decision
      WHERE run_id = $1 AND occupancy_check_required`,
    [run_id]
  );

  let bge_pay = 0, water_pay = 0, tenant_skip = 0, exception_count = 0;
  let bge_accounts_seen = 0, water_accounts_seen = 0;
  for (const r of routing.rows) {
    const c = num(r.c);
    if (r.utility === 'bge') bge_accounts_seen += c;
    if (r.utility === 'water') water_accounts_seen += c;
    if (r.decision === 'PAY' && r.utility === 'bge') bge_pay += c;
    if (r.decision === 'PAY' && r.utility === 'water') water_pay += c;
    if (r.decision === 'SKIP') tenant_skip += c;
    if (r.decision === 'EXCEPTION') exception_count += c;
  }

  // Consumption anomalies by tier.
  const anomalies = await pool.query<{ tier: string; c: string }>(
    `SELECT tier, COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.consumption_anomaly
      WHERE run_id = $1 GROUP BY tier`,
    [run_id]
  );
  let severe_anomalies = 0, moderate_anomalies = 0;
  for (const r of anomalies.rows) {
    if (r.tier === 'SEVERE') severe_anomalies = num(r.c);
    if (r.tier === 'MODERATE') moderate_anomalies = num(r.c);
  }

  // WS-7 staging counts + prorations needing review.
  const letters = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.tenant_letter WHERE run_id = $1`, [run_id]);
  const workOrders = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.work_order_request WHERE run_id = $1`, [run_id]);
  const review = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.proration_result
      WHERE run_id = $1 AND needs_review`, [run_id]);

  // Payments by status + total confirmed amount.
  const payments = await pool.query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::int AS c FROM ${AUDIT_SCHEMA}.payment_attempt
      WHERE run_id = $1 GROUP BY status`,
    [run_id]
  );
  let payments_confirmed = 0, payments_failed = 0, payments_skipped = 0;
  for (const r of payments.rows) {
    const c = num(r.c);
    if (r.status === 'CONFIRMED') payments_confirmed = c;
    else if (r.status === 'FAILED') payments_failed = c;
    else if (r.status === 'SKIPPED_NO_APPROVAL') payments_skipped = c;
  }
  const paid = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ${AUDIT_SCHEMA}.payment_attempt
      WHERE run_id = $1 AND status = 'CONFIRMED'`,
    [run_id]
  );

  return {
    run_id,
    bge_pay, water_pay, tenant_skip, exception_count,
    occupancy_checks: num(occ.rows[0]?.c),
    severe_anomalies, moderate_anomalies,
    letters: num(letters.rows[0]?.c),
    work_orders: num(workOrders.rows[0]?.c),
    prorations_needing_review: num(review.rows[0]?.c),
    payments_confirmed, payments_failed, payments_skipped,
    amount_paid_total: num(paid.rows[0]?.total),
    bge_accounts_seen, water_accounts_seen,
  };
}

/** Upsert the summary row (idempotent on run_id). */
export async function persistRunSummary(s: RunSummary): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ${AUDIT_SCHEMA}.run_summary
       (run_id, generated_at, bge_pay, water_pay, tenant_skip, exception_count,
        occupancy_checks, severe_anomalies, moderate_anomalies, letters, work_orders,
        prorations_needing_review, payments_confirmed, payments_failed, payments_skipped,
        amount_paid_total, bge_accounts_seen, water_accounts_seen, detail)
     VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (run_id) DO UPDATE SET
       generated_at              = NOW(),
       bge_pay                   = EXCLUDED.bge_pay,
       water_pay                 = EXCLUDED.water_pay,
       tenant_skip               = EXCLUDED.tenant_skip,
       exception_count           = EXCLUDED.exception_count,
       occupancy_checks          = EXCLUDED.occupancy_checks,
       severe_anomalies          = EXCLUDED.severe_anomalies,
       moderate_anomalies        = EXCLUDED.moderate_anomalies,
       letters                   = EXCLUDED.letters,
       work_orders               = EXCLUDED.work_orders,
       prorations_needing_review = EXCLUDED.prorations_needing_review,
       payments_confirmed        = EXCLUDED.payments_confirmed,
       payments_failed           = EXCLUDED.payments_failed,
       payments_skipped          = EXCLUDED.payments_skipped,
       amount_paid_total         = EXCLUDED.amount_paid_total,
       bge_accounts_seen         = EXCLUDED.bge_accounts_seen,
       water_accounts_seen       = EXCLUDED.water_accounts_seen,
       detail                    = EXCLUDED.detail`,
    [
      s.run_id, s.bge_pay, s.water_pay, s.tenant_skip, s.exception_count,
      s.occupancy_checks, s.severe_anomalies, s.moderate_anomalies, s.letters, s.work_orders,
      s.prorations_needing_review, s.payments_confirmed, s.payments_failed, s.payments_skipped,
      s.amount_paid_total, s.bge_accounts_seen, s.water_accounts_seen, JSON.stringify(s),
    ]
  );
}
