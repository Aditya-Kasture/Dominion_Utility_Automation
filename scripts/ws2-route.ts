/**
 * WS-2 — Routing Logic Engine entry point.
 *
 *   npm run ws2:route          # invoked by the N8N "Hand off to WS-2" node
 *   npx tsx scripts/ws2-route.ts [--payload cache/ws1-latest.json] [--dry-run]
 *
 * Consumes the WS-1 handoff payload and, per property:
 *   1. Routes each utility to BGE-pay / Water-pay / Tenant-skip / Exception
 *      (decision tree documented in tests/helpers/routingEngine.ts).
 *   2. Checks consumption against Podio baselines using the latest readings in
 *      water_portal_audit_log (filled weekly by WS-4).
 *   3. Writes every decision + reason code to PostgreSQL (routing_decision,
 *      consumption_anomaly) for WS-3/WS-4/WS-7 to read.
 *   4. Writes cache/ws2-decisions-<run_id>.json + cache/ws2-latest.json.
 *   5. Sends ONE batched Outlook webhook ping (WS-6 channel) when anything is
 *      wrong in consumption per unit / per property, or exceptions need review.
 *
 * Exit contract (read by the N8N IF node downstream):
 *   exit 0 → SUCCESS; downstream WS-3/WS-4 bill retrieval may proceed.
 *   exit 1 → FAILED (missing payload, DB error); N8N fires the Outlook alert.
 * On non-zero exit one JSON line goes to stderr: { run_id, status, error }.
 *
 * No payment happens here — routing only. Payment stays gated behind Jack's
 * approval (WS-7), per the Phase 2 contract.
 */
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { getPool, closePool, validateEnv } from '../tests/helpers/db';
import { WS2Payload } from '../tests/helpers/propertySources';
import {
  routeAll, configFromEnv, ConsumptionReadings, RoutingRunResult,
} from '../tests/helpers/routingEngine';
import { buildWs2Alert, sendOutlookAlert } from '../tests/helpers/outlookAlert';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAYLOAD_DIR = process.env.WS1_PAYLOAD_DIR ?? path.resolve(__dirname, '..', 'cache');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(runId: string, message: string): never {
  process.stderr.write(JSON.stringify({ run_id: runId, status: 'FAILED', error: message }) + '\n');
  console.error(`[WS-2] FAILED: ${message}`);
  process.exit(1);
}

function loadPayload(): WS2Payload {
  const p = argValue('--payload') ?? path.join(PAYLOAD_DIR, 'ws1-latest.json');
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) fail('unknown', `WS-1 payload not found: ${resolved}`);
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8')) as WS2Payload;
  if (!payload.run_id || !Array.isArray(payload.properties)) {
    fail(payload.run_id ?? 'unknown', `Malformed WS-1 payload: ${resolved}`);
  }
  return payload;
}

/** Latest water consumption reading per unit, from WS-4's audit trail.
 *  Best-effort: in week 1 (no WS-4 runs yet) this is simply empty. */
async function fetchLatestConsumption(): Promise<ConsumptionReadings> {
  const readings: ConsumptionReadings = new Map();
  try {
    const { rows } = await getPool().query<{ unit_id: number; consumption_units: string }>(`
      SELECT DISTINCT ON (unit_id) unit_id, consumption_units
      FROM public.water_portal_audit_log
      WHERE consumption_units IS NOT NULL
      ORDER BY unit_id, run_at DESC`);
    for (const r of rows) readings.set(Number(r.unit_id), Number(r.consumption_units));
  } catch (e: any) {
    console.warn(`[WS-2] Could not load consumption readings (non-fatal — anomaly checks limited): ${e?.message ?? e}`);
  }
  console.log(`[WS-2] Consumption readings loaded for ${readings.size} unit(s).`);
  return readings;
}

async function persistDecisions(run: RoutingRunResult): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-running the same payload replaces that run's rows (idempotent re-route).
    await client.query('DELETE FROM public.routing_decision WHERE run_id = $1', [run.run_id]);
    await client.query('DELETE FROM public.consumption_anomaly WHERE run_id = $1', [run.run_id]);
    await client.query('DELETE FROM public.tenant_letter WHERE run_id = $1', [run.run_id]);
    await client.query('DELETE FROM public.work_order_request WHERE run_id = $1', [run.run_id]);
    await client.query('DELETE FROM public.proration_result WHERE run_id = $1', [run.run_id]);

    for (const r of run.results) {
      for (const d of r.decisions) {
        await client.query(
          `INSERT INTO public.routing_decision
             (run_id, property_id, property_name, utility, decision, reason_code, detail,
              decision_trail, decision_summary, occupancy_check_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [run.run_id, r.property_id, r.property_name, d.utility, d.decision, d.reason_code, d.detail,
           JSON.stringify(d.trail), r.decision_summary, r.occupancy_check_required]
        );
      }
      for (const a of r.anomalies) {
        await client.query(
          `INSERT INTO public.consumption_anomaly
             (run_id, property_id, unit_id, utility_type, tier, contract_tier, kind, reading, baseline, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [run.run_id, a.property_id, a.unit_id, a.utility_type, a.tier, a.contract_tier, a.kind, a.reading, a.baseline, a.detail]
        );
      }
      for (const l of r.letters) {
        await client.query(
          `INSERT INTO public.tenant_letter
             (run_id, property_id, unit_id, utility_type, tier, responsibility, reading, expected, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [run.run_id, l.property_id, l.unit_id, l.utility_type, l.tier, l.responsibility, l.reading, l.expected, l.summary]
        );
      }
      for (const w of r.work_orders) {
        await client.query(
          `INSERT INTO public.work_order_request
             (run_id, property_id, unit_id, utility_type, reading, expected, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [run.run_id, w.property_id, w.unit_id, w.utility_type, w.reading, w.expected, w.reason]
        );
      }
      if (r.proration) {
        const pr = r.proration;
        await client.query(
          `INSERT INTO public.proration_result
             (run_id, property_id, unit_id, utility, method_used, days_period, days_tenant,
              tenant_share, dominion_share, computed_amount, dominion_amount,
              renovation_excluded, needs_review)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [run.run_id, r.property_id, null, pr.utility, pr.method_used, pr.days_period, pr.days_tenant,
           pr.tenant_share, pr.dominion_share, pr.tenant_amount, pr.dominion_amount,
           pr.renovation_excluded, pr.needs_review]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const payload = loadPayload();
  console.log(`[WS-2] Routing run ${payload.run_id}${DRY_RUN ? ' (dry-run)' : ''} — ${payload.property_count} properties.`);

  const cfg = configFromEnv();
  let readings: ConsumptionReadings = new Map();

  if (!DRY_RUN) {
    try {
      validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);
    } catch (e: any) {
      fail(payload.run_id, e?.message ?? String(e));
    }
    readings = await fetchLatestConsumption();
  }

  const run = routeAll(payload, cfg, readings);
  const t = run.totals;
  console.log(`[WS-2] Routed: BGE-pay ${t.bge_pay}, Water-pay ${t.water_pay}, ` +
    `Tenant-skip ${t.tenant_skip}, Exceptions ${t.exception}, Anomalies ${t.anomalies}.`);
  console.log(`[WS-2] WS-7 staged: ${t.letters} letter(s), ${t.work_orders} work order(s); ` +
    `${t.occupancy_checks} occupancy check(s) flagged.`);

  // Persist for WS-3 / WS-4 / WS-7.
  if (!DRY_RUN) {
    try {
      await persistDecisions(run);
      console.log('[WS-2] Decisions written to routing_decision / consumption_anomaly.');
    } catch (e: any) {
      fail(payload.run_id, `Could not persist routing decisions: ${e?.message ?? e}`);
    }
  }

  // Disk artifacts (consumed by WS-3/WS-4 runners and humans alike).
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  const outPath = path.join(PAYLOAD_DIR, `ws2-decisions-${run.run_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2), 'utf8');
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'ws2-latest.json'), JSON.stringify(run, null, 2), 'utf8');
  console.log(`[WS-2] Decisions: ${outPath}`);

  // One batched WS-6 Outlook ping when consumption/routing needs human eyes.
  const alert = buildWs2Alert(run);
  if (alert && !DRY_RUN) await sendOutlookAlert(alert);
  else if (alert) console.log(`[WS-2] (dry-run) Outlook alert suppressed: ${alert.subject}`);
  else console.log('[WS-2] No anomalies or exceptions — no Outlook ping needed.');

  console.log(`[WS-2] SUCCESS — run ${run.run_id} routed.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    process.stderr.write(JSON.stringify({ status: 'FAILED', error: err?.message ?? String(err) }) + '\n');
    console.error('[WS-2] Unhandled fatal:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
