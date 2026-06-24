/**
 * WS-6 — weekly run summary + Outlook digest.
 *
 *   npm run ws6:summary -- --run <run_id>     # or RUN_ID=<run_id> npm run ws6:summary
 *
 * Runs after WS-3/WS-4 retrieval+payment so the digest reflects the full cycle:
 *   1. Aggregates the run's per-property tables into one rollup (buildRunSummary).
 *   2. Upserts it into run_summary (idempotent on run_id) for ops to query.
 *   3. Writes cache/ws6-summary-<run_id>.json.
 *   4. Sends ONE batched Outlook digest (WS-6 channel) — even on a clean run.
 *
 * Exit contract (read by the N8N IF node downstream):
 *   exit 0 → SUCCESS.  exit 1 → FAILED (missing run_id, DB error).
 * On non-zero exit one JSON line goes to stderr: { run_id, status, error }.
 *
 * A missing OUTLOOK_WEBHOOK_URL is non-fatal — the digest logs and the run still
 * exits 0 (alerting must never take down the weekly cycle).
 */
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { closePool, validateEnv } from '../tests/helpers/db';
import { buildRunSummary, persistRunSummary } from '../tests/helpers/runSummary';
import { buildRunDigest, sendOutlookAlert } from '../tests/helpers/outlookAlert';

dotenv.config();

const CACHE_DIR = process.env.WS1_PAYLOAD_DIR ?? path.resolve(__dirname, '..', 'cache');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(runId: string, message: string): never {
  process.stderr.write(JSON.stringify({ run_id: runId, status: 'FAILED', error: message }) + '\n');
  console.error(`[WS-6] FAILED: ${message}`);
  process.exit(1);
}

/** Run id from --run / RUN_ID, else the latest WS-2 result in cache (so the N8N
 *  node can run with no args at the tail of the weekly cycle). */
function resolveRunId(): string | undefined {
  const explicit = argValue('--run') ?? process.env.RUN_ID;
  if (explicit) return explicit;
  const latest = path.join(CACHE_DIR, 'ws2-latest.json');
  if (fs.existsSync(latest)) {
    try { return JSON.parse(fs.readFileSync(latest, 'utf8'))?.run_id; } catch { /* ignore */ }
  }
  return undefined;
}

async function main(): Promise<void> {
  const run_id = resolveRunId();
  if (!run_id) fail('unknown', 'No run id — pass --run <run_id>, set RUN_ID, or run after WS-2 (cache/ws2-latest.json).');

  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);

  const summary = await buildRunSummary(run_id);
  await persistRunSummary(summary);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const outFile = path.join(CACHE_DIR, `ws6-summary-${run_id}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[WS-6] Summary persisted for run ${run_id} → run_summary + ${outFile}`);

  const sent = await sendOutlookAlert(buildRunDigest(summary));
  console.log(`[WS-6] Digest ${sent ? 'sent' : 'logged only (no webhook)'}.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    await closePool().catch(() => {});
    fail(resolveRunId() ?? 'unknown', err?.message ?? String(err));
  });
