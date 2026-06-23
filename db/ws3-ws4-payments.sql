-- Dominion Financial – Phase 2 / WS-3 (BGE) + WS-4 (Water) payment execution.
-- Run once against Abdul's PostgreSQL database, after db/ws2-routing.sql.
--
-- Payment stays gated behind explicit approval (June 19 2026: "no payment or
-- bill-back happens without your approval"). Two tables:
--   1. payment_approval – one row = authorization to pay a single account for a
--      run. Written today by scripts/approve-payments.ts (a stand-in for the WS-7
--      approve-link, which is out of scope here). The BGE/Water agents ONLY pay
--      accounts that have a matching approval row.
--   2. payment_attempt  – every submission attempt, keyed by an idempotency_key
--      so a re-run can never double-pay (ON CONFLICT DO NOTHING).
--
-- Safe to re-run (idempotent DDL).

CREATE TABLE IF NOT EXISTS payment_approval (
  id               SERIAL PRIMARY KEY,
  run_id           TEXT NOT NULL,                 -- matches routing_decision.run_id
  property_id      INTEGER,
  utility          TEXT NOT NULL,                 -- 'bge' | 'water'
  account_number   TEXT NOT NULL,                 -- BGE account # or water account #
  approved_amount  NUMERIC,                       -- NULL = pay whatever the bill shows
  approved_by      TEXT NOT NULL,                 -- who authorized (name)
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, utility, account_number)
);
CREATE INDEX IF NOT EXISTS idx_payment_approval_run ON payment_approval(run_id, utility);

CREATE TABLE IF NOT EXISTS payment_attempt (
  id               SERIAL PRIMARY KEY,
  run_id           TEXT NOT NULL,
  property_id      INTEGER,
  unit_id          INTEGER,
  utility          TEXT NOT NULL,                 -- 'bge' | 'water'
  account_number   TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,          -- sha256(run_id|utility|account|amount)
  amount           NUMERIC,
  status           TEXT NOT NULL,                 -- PENDING|SUBMITTED|CONFIRMED|FAILED|SKIPPED_NO_APPROVAL
  confirmation_ref TEXT,                          -- portal confirmation number, when captured
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_attempt_run    ON payment_attempt(run_id, utility);
CREATE INDEX IF NOT EXISTS idx_payment_attempt_status ON payment_attempt(run_id, status);
