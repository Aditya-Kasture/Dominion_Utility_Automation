/**
 * WS-1 — QuickBooks Desktop CSV shared-folder watcher.
 *
 * Per the Phase 2 plan, N8N "watches a shared folder for any new QuickBooks Desktop
 * CSV exports for manual reconciliation". This module is the ingestion node's logic:
 * it scans QB_CSV_DIR, fingerprints each .csv by content hash, records previously
 * unseen files in the qb_csv_import ledger, and returns the count of new exports.
 *
 * It only stages/records arrivals — mapping QB rows into journal entries is WS-8.
 * Re-dropping an identical file is a no-op (hash already in the ledger); an edited
 * file (new hash) re-ingests as a fresh row.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getPool } from './db';

export interface QbIngestResult {
  dir: string | null;
  scanned: number;
  newlyIngested: number;
  files: string[];   // basenames of newly ingested files
}

/** Count data rows in a QB CSV (excludes header, blank lines, and IIF markers). */
function countDataRows(filePath: string): number {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  let count = 0;
  let sawHeader = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('!') || line === 'ENDTRNS') continue;
    if (!sawHeader) { sawHeader = true; continue; } // first non-marker line is the header
    if (/^total/i.test(line.trim())) continue;
    count++;
  }
  return count;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Scan the QuickBooks shared folder and record any new exports against `runId`.
 * If QB_CSV_DIR is unset or missing, this is a no-op (returns scanned: 0) — the
 * folder watcher is optional and must not fail the weekly run.
 */
export async function ingestQuickBooksFolder(runId: string): Promise<QbIngestResult> {
  const dir = process.env.QB_CSV_DIR;
  if (!dir || !fs.existsSync(dir)) {
    if (dir) console.warn(`[WS-1] QB_CSV_DIR "${dir}" does not exist — skipping QuickBooks ingestion.`);
    return { dir: dir ?? null, scanned: 0, newlyIngested: 0, files: [] };
  }

  const csvFiles = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => path.join(dir, f));

  const pool = getPool();
  const newFiles: string[] = [];

  for (const filePath of csvFiles) {
    const hash = sha256(filePath);
    const rowCount = countDataRows(filePath);
    // ON CONFLICT on the unique content_hash makes re-seen files a no-op.
    const res = await pool.query(
      `INSERT INTO public.qb_csv_import (file_name, content_hash, row_count, run_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING id`,
      [path.basename(filePath), hash, rowCount, runId]
    );
    if ((res.rowCount ?? 0) > 0) newFiles.push(path.basename(filePath));
  }

  return { dir, scanned: csvFiles.length, newlyIngested: newFiles.length, files: newFiles };
}
