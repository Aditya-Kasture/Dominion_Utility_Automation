-- Dominion Financial – Base Schema
-- Creates the core property management tables that migrations.sql depends on.
-- Run this ONCE before migrations.sql on a fresh database.

CREATE TABLE IF NOT EXISTS property (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  lifecycle_stage TEXT NOT NULL DEFAULT 'vacant',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  street1         TEXT NOT NULL,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_lifecycle ON property(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_property_active    ON property(is_active);

CREATE TABLE IF NOT EXISTS unit (
  id               SERIAL PRIMARY KEY,
  appfolio_unit_id TEXT,
  unit_name        TEXT NOT NULL,
  property_id      INTEGER NOT NULL REFERENCES property(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unit_property_id ON unit(property_id);

CREATE TABLE IF NOT EXISTS unit_utility_responsibility (
  id             SERIAL PRIMARY KEY,
  unit_id        INTEGER NOT NULL REFERENCES unit(id),
  utility_type   TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uur_unit_id      ON unit_utility_responsibility(unit_id);
CREATE INDEX IF NOT EXISTS idx_uur_utility_type ON unit_utility_responsibility(utility_type);

CREATE TABLE IF NOT EXISTS unit_consumption_baseline (
  id              SERIAL PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES unit(id),
  utility_type    TEXT NOT NULL,
  period_unit     TEXT NOT NULL,
  baseline_amount NUMERIC(10, 3),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, utility_type, period_unit)
);

CREATE INDEX IF NOT EXISTS idx_ucb_unit_id ON unit_consumption_baseline(unit_id);
