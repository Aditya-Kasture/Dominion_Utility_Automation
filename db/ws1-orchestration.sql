-- Dominion Financial – Phase 2 / WS-1 (N8N Orchestration Layer)
-- Run once against Abdul's PostgreSQL database, after base-schema.sql + migrations.sql.
--
-- Adds two tables that the weekly orchestrator (scripts/ws1-orchestrate.ts) owns:
--   1. orchestration_run   – one row per weekly run; the run ledger N8N + WS-6 read.
--   2. qb_csv_import        – ledger of QuickBooks Desktop CSV exports already ingested,
--                            so the shared-folder watcher stays idempotent across runs.
--
-- These tables hold orchestration metadata only. The structured property payload
-- handed to WS-2 is written to disk (cache/ws1-latest.json) and referenced here by
-- payload_path; it is intentionally not stored as a blob in Postgres.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Weekly orchestration run ledger
--    Written by scripts/ws1-orchestrate.ts at run start (PENDING) and again at the
--    end (SUCCESS | FAILED | EMPTY). N8N reads the final status to decide whether to
--    fire WS-2 (success) or a WS-6 Outlook alert (failed/empty).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orchestration_run (
  id                 SERIAL PRIMARY KEY,
  run_id             TEXT NOT NULL UNIQUE,          -- e.g. 'ws1-2026-06-08T1200Z'
  status             TEXT NOT NULL,                 -- 'PENDING' | 'SUCCESS' | 'EMPTY' | 'FAILED'
  property_count     INTEGER NOT NULL DEFAULT 0,
  appfolio_source    TEXT,                          -- 'db' | 'api'
  podio_source       TEXT,                          -- 'db' | 'api' | 'absent'
  qb_csv_ingested    INTEGER NOT NULL DEFAULT 0,    -- # of new CSV exports picked up this run
  payload_path       TEXT,                          -- path to the WS-2 handoff JSON on disk
  error              TEXT,                          -- populated when status = 'FAILED'
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orch_run_started ON orchestration_run(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_orch_run_status  ON orchestration_run(status);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. QuickBooks Desktop CSV ingestion ledger
--    One row per export file the WS-1 watcher has seen. content_hash makes
--    re-dropping the same file a no-op; a changed file (new hash) re-ingests.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qb_csv_import (
  id              SERIAL PRIMARY KEY,
  file_name       TEXT NOT NULL,
  content_hash    TEXT NOT NULL UNIQUE,             -- sha256 of the file bytes
  row_count       INTEGER NOT NULL DEFAULT 0,
  run_id          TEXT REFERENCES orchestration_run(run_id),
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qb_csv_import_run ON qb_csv_import(run_id);
