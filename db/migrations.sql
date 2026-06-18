-- Dominion Financial – Phase 1 DB Migrations
-- Run this once against Abdul's PostgreSQL database before executing any Playwright scripts.
-- Tables: BGE account map, BGE audit log, Water audit log

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. BGE Account → Property mapping
--    Populated from Jack's spreadsheet (Step 5 of Phase 1).
--    One row per BGE account number, linked to a property in the PROPERTY table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bge_account_property_map (
  id                  SERIAL PRIMARY KEY,
  bge_account_number  TEXT NOT NULL UNIQUE,
  property_address    TEXT NOT NULL,
  property_id         INTEGER NOT NULL REFERENCES property(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bge_map_property_id ON bge_account_property_map(property_id);

-- June 12 2026: PS / common-area BGE accounts (foyer/hallway lighting) are the
-- landlord's; all other unit-level gas/electric is always the tenant's. Seeded
-- from Jack's BGE list. Additive — safe to re-run.
ALTER TABLE bge_account_property_map ADD COLUMN IF NOT EXISTS is_ps_account BOOLEAN NOT NULL DEFAULT FALSE;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BGE portal run audit log
--    Written by bge.spec.ts after every action (navigate, paperless, bill retrieval).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bge_portal_audit_log (
  id                  SERIAL PRIMARY KEY,
  bge_account_number  TEXT NOT NULL,
  property_id         INTEGER NOT NULL REFERENCES property(id),
  action              TEXT NOT NULL,       -- 'navigate' | 'paperless_enrollment' | 'bill_retrieval'
  status              TEXT NOT NULL,       -- 'SUCCESS' | 'FAILED' | 'PARTIAL'
  bill_amount         NUMERIC(10, 2),
  due_date            TEXT,
  notes               TEXT,
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bge_log_account ON bge_portal_audit_log(bge_account_number);
CREATE INDEX IF NOT EXISTS idx_bge_log_run_at  ON bge_portal_audit_log(run_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Water portal run audit log
--    Written by water.spec.ts. Includes consumption + threshold decision.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS water_portal_audit_log (
  id                SERIAL PRIMARY KEY,
  unit_id           INTEGER NOT NULL REFERENCES unit(id),
  property_id       INTEGER NOT NULL REFERENCES property(id),
  action            TEXT NOT NULL,         -- 'navigate' | 'paperless_enrollment' | 'bill_retrieval'
  status            TEXT NOT NULL,         -- 'SUCCESS' | 'FAILED' | 'PARTIAL'
  bill_amount       NUMERIC(10, 2),
  consumption_units NUMERIC(10, 3),        -- HCF/CCF/gallons — unit confirmed during audit
  due_date          TEXT,
  threshold_action  TEXT,                  -- 'auto_pay' | 'pay_alert_pm' | 'pay_work_order'
  notes             TEXT,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_water_log_unit_id ON water_portal_audit_log(unit_id);
CREATE INDEX IF NOT EXISTS idx_water_log_run_at  ON water_portal_audit_log(run_at DESC);
CREATE INDEX IF NOT EXISTS idx_water_log_threshold ON water_portal_audit_log(threshold_action)
  WHERE threshold_action IN ('pay_alert_pm', 'pay_work_order');


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Water Account → Unit/Property mapping
--    Populated via scripts/import-water-mapping.ts
--    One row per water account number, linked to a unit (and its parent property).
--    unit_id is nullable — single-unit properties may omit it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS water_account_map (
  id                   SERIAL PRIMARY KEY,
  water_account_number TEXT NOT NULL UNIQUE,
  property_address     TEXT NOT NULL,
  property_id          INTEGER NOT NULL REFERENCES property(id),
  unit_id              INTEGER REFERENCES unit(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_water_map_property_id ON water_account_map(property_id);
CREATE INDEX IF NOT EXISTS idx_water_map_unit_id     ON water_account_map(unit_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Unit table parity with production (Abdul-hosted DB)
--    Production hub.unit carries per-unit address + occupancy columns that the
--    local base schema lacks. Single-unit properties: unit address equals the
--    property address. Multi-unit properties: street1/unit_name carry a
--    "#A"/"#B"/"#2002" marker. Idempotent — safe to re-run anywhere.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE unit ADD COLUMN IF NOT EXISTS status_code VARCHAR(30);   -- 'occupied' | 'vacant_unrented' | ...
ALTER TABLE unit ADD COLUMN IF NOT EXISTS bedrooms    INTEGER;
ALTER TABLE unit ADD COLUMN IF NOT EXISTS bathrooms   NUMERIC(4,2);
ALTER TABLE unit ADD COLUMN IF NOT EXISTS market_rent NUMERIC(18,4);
ALTER TABLE unit ADD COLUMN IF NOT EXISTS street1     VARCHAR(300);  -- unit-level address (with "#X" on multi-unit)
ALTER TABLE unit ADD COLUMN IF NOT EXISTS city        VARCHAR(100);
ALTER TABLE unit ADD COLUMN IF NOT EXISTS state       CHAR(2);
