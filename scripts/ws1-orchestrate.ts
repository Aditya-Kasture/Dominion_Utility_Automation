/**
 * WS-1 — N8N Orchestration Layer entry point.
 *
 *   npm run ws1:run            # invoked by the N8N "WS-1 Orchestrate" Execute Command node
 *   npx tsx scripts/ws1-orchestrate.ts [--dry-run]
 *
 * Every Monday 8:00 AM ET the N8N cron fires this script. It:
 *   1. Opens (and ledgers) a weekly orchestration run in Postgres.
 *   2. Pulls the active property list (AppFolio vacancy + responsibility flags) and
 *      consumption baselines from the DB.
 *   3. Pulls Podio manual overrides (if configured) and merges them in.
 *   4. Watches the QuickBooks Desktop shared folder and ledgers any new CSV exports.
 *   5. Writes the structured WS-2 handoff payload to disk and stamps the run row.
 *
 * Exit contract (read by the N8N IF node downstream):
 *   exit 0  → SUCCESS, payload written; N8N proceeds to WS-2.
 *   exit 2  → EMPTY, no active properties found; N8N fires a WS-6 Outlook alert and halts.
 *   exit 1  → FAILED (API down, expired creds, DB error); N8N fires a WS-6 Outlook alert.
 * On any non-zero exit a single-line JSON object is printed to stderr so the N8N
 * Outlook alert node can surface { run_id, status, error } without parsing logs.
 */
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { getPool, closePool, validateEnv } from '../tests/helpers/db';
import {
  fetchActivePropertiesFromDb,
  fetchPodioOverrides,
  applyPodioOverrides,
  WS2Payload,
} from '../tests/helpers/propertySources';
import { ingestQuickBooksFolder } from '../tests/helpers/quickbooksIngest';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAYLOAD_DIR = process.env.WS1_PAYLOAD_DIR ?? path.resolve(__dirname, '..', 'cache');

function newRunId(): string {
  // ws1-2026-06-08T1200Z — sortable, unique per minute.
  return 'ws1-' + new Date().toISOString().replace(/:\d\d\.\d+Z$/, 'Z').replace(/:/g, '');
}

/** Emit the machine-readable failure line N8N's Outlook alert node reads, then exit. */
function fail(runId: string, status: 'FAILED' | 'EMPTY', message: string, code: 1 | 2): never {
  process.stderr.write(JSON.stringify({ run_id: runId, status, error: message }) + '\n');
  console.error(`[WS-1] ${status}: ${message}`);
  process.exit(code);
}

async function recordRunStart(runId: string): Promise<void> {
  if (DRY_RUN) return;
  await getPool().query(
    `INSERT INTO public.orchestration_run (run_id, status) VALUES ($1, 'PENDING')
     ON CONFLICT (run_id) DO NOTHING`,
    [runId]
  );
}

async function recordRunFinish(runId: string, payload: WS2Payload, payloadPath: string): Promise<void> {
  if (DRY_RUN) return;
  await getPool().query(
    `UPDATE public.orchestration_run
        SET status = $2, property_count = $3, appfolio_source = $4,
            podio_source = $5, qb_csv_ingested = $6, payload_path = $7, finished_at = NOW()
      WHERE run_id = $1`,
    [
      runId,
      payload.property_count > 0 ? 'SUCCESS' : 'EMPTY',
      payload.property_count,
      payload.source.appfolio,
      payload.source.podio,
      payload.source.quickbooks_csv_ingested,
      payloadPath,
    ]
  );
}

async function recordRunError(runId: string, message: string): Promise<void> {
  if (DRY_RUN) return;
  try {
    await getPool().query(
      `UPDATE public.orchestration_run SET status = 'FAILED', error = $2, finished_at = NOW()
        WHERE run_id = $1`,
      [runId, message.slice(0, 2000)]
    );
  } catch { /* best-effort: DB may be the thing that's down */ }
}

async function main(): Promise<void> {
  const runId = newRunId();
  console.log(`[WS-1] Starting weekly orchestration run ${runId}${DRY_RUN ? ' (dry-run)' : ''}`);

  // Fail fast on missing DB config — a clean error N8N can alert on.
  try {
    validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);
  } catch (e: any) {
    fail(runId, 'FAILED', e?.message ?? String(e), 1);
  }

  await recordRunStart(runId).catch(e => fail(runId, 'FAILED', `Could not open run ledger: ${e?.message ?? e}`, 1));

  // 1. Active property list (AppFolio source).
  let properties;
  try {
    properties = await fetchActivePropertiesFromDb();
    console.log(`[WS-1] AppFolio/DB: ${properties.length} active properties.`);
  } catch (e: any) {
    await recordRunError(runId, `AppFolio property fetch failed: ${e?.message ?? e}`);
    fail(runId, 'FAILED', `AppFolio property fetch failed: ${e?.message ?? e}`, 1);
  }

  if (properties.length === 0) {
    await recordRunError(runId, 'No active properties returned.');
    fail(runId, 'EMPTY', 'No active properties returned from AppFolio/DB — halting run.', 2);
  }

  // 2. Podio manual overrides (best-effort; never fatal).
  let podioSource: 'db' | 'api' | 'absent' = 'absent';
  try {
    const { source, byTitle } = await fetchPodioOverrides();
    applyPodioOverrides(properties, byTitle);
    podioSource = source;
    console.log(`[WS-1] Podio overrides: source=${source}, matched on ${byTitle.size} title(s).`);
  } catch (e: any) {
    console.warn(`[WS-1] Podio override step failed (non-fatal): ${e?.message ?? e}`);
  }

  // 3. QuickBooks shared-folder watcher (best-effort; never fatal).
  let qbIngested = 0;
  try {
    const qb = await ingestQuickBooksFolder(runId);
    qbIngested = qb.newlyIngested;
    console.log(`[WS-1] QuickBooks folder: scanned ${qb.scanned}, newly ingested ${qb.newlyIngested}` +
      (qb.files.length ? ` (${qb.files.join(', ')})` : ''));
  } catch (e: any) {
    console.warn(`[WS-1] QuickBooks ingestion failed (non-fatal): ${e?.message ?? e}`);
  }

  // 4. Build + persist the WS-2 handoff payload.
  const payload: WS2Payload = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    source: { appfolio: 'db', podio: podioSource, quickbooks_csv_ingested: qbIngested },
    property_count: properties.length,
    properties,
  };

  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  const payloadPath = path.join(PAYLOAD_DIR, `ws1-payload-${runId}.json`);
  const latestPath = path.join(PAYLOAD_DIR, 'ws1-latest.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), 'utf8');

  await recordRunFinish(runId, payload, payloadPath)
    .catch(e => console.warn(`[WS-1] Could not stamp run ledger (payload still written): ${e?.message ?? e}`));

  console.log(`[WS-1] SUCCESS — ${payload.property_count} properties handed to WS-2.`);
  console.log(`[WS-1] Payload: ${payloadPath}`);
  console.log(`[WS-1] Latest:  ${latestPath}`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    // Last-resort guard — main() handles its own typed failures above.
    process.stderr.write(JSON.stringify({ status: 'FAILED', error: err?.message ?? String(err) }) + '\n');
    console.error('[WS-1] Unhandled fatal:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
