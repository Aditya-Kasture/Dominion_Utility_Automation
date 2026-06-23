-- Dominion Financial – Phase 2 / WS-2 (Routing Logic Engine)
-- Run once against Abdul's PostgreSQL database, after db/ws1-orchestration.sql.
--
-- Two tables owned by scripts/ws2-route.ts:
--   1. routing_decision     – per run / per property / per utility verdict with
--                             reason code; read by WS-3 (BGE), WS-4 (water), WS-7.
--   2. consumption_anomaly  – per run consumption findings vs Podio baselines;
--                             feeds WS-6 Outlook alerts and WS-7 work orders.
--
-- Re-running WS-2 for the same run_id replaces that run's rows (idempotent).

CREATE TABLE IF NOT EXISTS routing_decision (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,                  -- matches orchestration_run.run_id
  property_id     INTEGER NOT NULL,
  property_name   TEXT NOT NULL,
  utility         TEXT NOT NULL,                  -- 'bge' | 'water'
  decision        TEXT NOT NULL,                  -- 'PAY' | 'SKIP' | 'EXCEPTION'
  reason_code     TEXT NOT NULL,                  -- see routingEngine.ts REASON
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, property_id, utility)
);

CREATE INDEX IF NOT EXISTS idx_routing_decision_run      ON routing_decision(run_id);
CREATE INDEX IF NOT EXISTS idx_routing_decision_decision ON routing_decision(run_id, decision);

-- June 12 2026 additions: per-verdict audit trail + per-property shorthand summary
-- (shown for EVERY property in the WS-7 report for trust), and the occupancy-check
-- trigger (BGE reverted to landlord on an occupied unit). Additive — safe to re-run.
ALTER TABLE routing_decision ADD COLUMN IF NOT EXISTS decision_trail           JSONB;
ALTER TABLE routing_decision ADD COLUMN IF NOT EXISTS decision_summary         TEXT;
ALTER TABLE routing_decision ADD COLUMN IF NOT EXISTS occupancy_check_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS consumption_anomaly (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  property_id     INTEGER NOT NULL,
  unit_id         INTEGER,
  utility_type    TEXT NOT NULL,                  -- 'water' | 'electric' | 'gas'
  tier            TEXT NOT NULL,                  -- 'MODERATE' | 'SEVERE'
  kind            TEXT NOT NULL,                  -- 'VACANT_USAGE' | 'POSSIBLE_LEAK' | 'MODERATE_SPIKE'
  reading         NUMERIC,
  baseline        NUMERIC,
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumption_anomaly_run  ON consumption_anomaly(run_id);
CREATE INDEX IF NOT EXISTS idx_consumption_anomaly_tier ON consumption_anomaly(run_id, tier);

-- June 12 contract tier: 'NORMAL' | 'LETTER' | 'LETTER_PLUS_WORKORDER'. Kept
-- alongside the legacy MODERATE/SEVERE tier column. Additive — safe to re-run.
ALTER TABLE consumption_anomaly ADD COLUMN IF NOT EXISTS contract_tier TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WS-7 deliverables staged by WS-2 (artifacts only — nothing is sent here).
--    tenant_letter      – cost-recovery / "bill is high" letter (1.5–3× and >3×).
--    work_order_request – physical inspection for >3× consumption.
--    Re-running WS-2 for a run_id replaces that run's rows (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_letter (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  property_id     INTEGER NOT NULL,
  unit_id         INTEGER,
  utility_type    TEXT NOT NULL,
  tier            TEXT NOT NULL,                  -- 'LETTER' | 'LETTER_PLUS_WORKORDER'
  responsibility  TEXT NOT NULL,                  -- 'landlord' | 'tenant' (drives verbiage)
  reading         NUMERIC,
  expected        NUMERIC,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_letter_run ON tenant_letter(run_id);

CREATE TABLE IF NOT EXISTS work_order_request (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  property_id     INTEGER NOT NULL,
  unit_id         INTEGER,
  utility_type    TEXT NOT NULL,
  reading         NUMERIC,
  expected        NUMERIC,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_order_request_run ON work_order_request(run_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. User feedback on routing logic (June 12 — "leave feedback" on a verdict).
--    Written by the report UI / endpoint (out of WS-2 scope); WS-2 only owns the
--    table. Lets a user flag logic they think is wrong, tied to a run + property.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_feedback (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  property_id     INTEGER NOT NULL,
  utility         TEXT,                           -- 'bge' | 'water' | NULL (whole property)
  feedback_text   TEXT NOT NULL,
  submitted_by    TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_routing_feedback_run ON routing_feedback(run_id, property_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Mid-cycle move-in / move-out proration (June 19 2026 — Method A only).
--    Baltimore water is a lien: Dominion always pays then bills the tenant back
--    for their share of a bill that spans the move date. proration_result holds
--    the system's COMPUTED split (a suggestion); proration_override holds a
--    human's final number with who/why (the computed value is always preserved).
--    Method C (area-under-curve) was ruled out on the call — bills are a single
--    monthly meter read. Re-running WS-2 for a run_id replaces that run's rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proration_result (
  id                  SERIAL PRIMARY KEY,
  run_id              TEXT NOT NULL,
  property_id         INTEGER NOT NULL,
  unit_id             INTEGER,
  utility             TEXT NOT NULL,              -- 'water' (BGE settles by name change)
  method_used         TEXT NOT NULL,             -- 'average' | 'grace_whole' | 'bge_name_change' | 'bge_exception' | 'no_split'
  days_period         INTEGER,
  days_tenant         INTEGER,
  tenant_share        NUMERIC,                   -- consumption units
  dominion_share      NUMERIC,
  computed_amount     NUMERIC,                   -- tenant $ share (null until bill amount known)
  dominion_amount     NUMERIC,
  renovation_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proration_result_run    ON proration_result(run_id);
CREATE INDEX IF NOT EXISTS idx_proration_result_review ON proration_result(run_id, needs_review);

CREATE TABLE IF NOT EXISTS proration_override (
  id              SERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  property_id     INTEGER NOT NULL,
  unit_id         INTEGER,
  computed_amount NUMERIC,                        -- what the system suggested
  final_amount    NUMERIC NOT NULL,              -- what the human entered
  changed_by      TEXT NOT NULL,                 -- who (name)
  reason          TEXT,                          -- why
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proration_override_run ON proration_override(run_id, property_id);
