-- Dominion Financial – Phase 2 / WS-6 (Audit Log & Alerting)
-- Run once against the database, after db/ws2-routing.sql and db/ws3-ws4-payments.sql.
--
-- One row per weekly run: the "what did we do this week" rollup that the WS-6
-- Outlook digest is built from and that ops can query directly. Written by
-- scripts/ws6-summary.ts (buildRunSummary aggregates the per-run tables; the
-- script upserts on run_id so a re-run replaces the row).
--
-- June 19 2026: WS-6 is slated to move to Supabase (Yaseen scope). This DDL is
-- portable Postgres; the WS6_SCHEMA env var lets the writer target a different
-- schema without code changes. Safe to re-run (idempotent DDL).

CREATE TABLE IF NOT EXISTS run_summary (
  id                        SERIAL PRIMARY KEY,
  run_id                    TEXT NOT NULL UNIQUE,      -- matches orchestration_run.run_id
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- routing verdict counts
  bge_pay                   INTEGER NOT NULL DEFAULT 0,
  water_pay                 INTEGER NOT NULL DEFAULT 0,
  tenant_skip               INTEGER NOT NULL DEFAULT 0,
  exception_count           INTEGER NOT NULL DEFAULT 0,
  occupancy_checks          INTEGER NOT NULL DEFAULT 0,
  -- consumption anomalies + WS-7 staging
  severe_anomalies          INTEGER NOT NULL DEFAULT 0,
  moderate_anomalies        INTEGER NOT NULL DEFAULT 0,
  letters                   INTEGER NOT NULL DEFAULT 0,
  work_orders               INTEGER NOT NULL DEFAULT 0,
  -- proration + payments
  prorations_needing_review INTEGER NOT NULL DEFAULT 0,
  payments_confirmed        INTEGER NOT NULL DEFAULT 0,
  payments_failed           INTEGER NOT NULL DEFAULT 0,
  payments_skipped          INTEGER NOT NULL DEFAULT 0,
  amount_paid_total         NUMERIC NOT NULL DEFAULT 0,
  -- coverage (accounts routed per utility this run)
  bge_accounts_seen         INTEGER NOT NULL DEFAULT 0,
  water_accounts_seen       INTEGER NOT NULL DEFAULT 0,
  -- full breakdown used to render the digest body
  detail                    JSONB
);

CREATE INDEX IF NOT EXISTS idx_run_summary_run ON run_summary(run_id);
