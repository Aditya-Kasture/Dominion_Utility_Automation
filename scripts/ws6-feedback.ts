/**
 * WS-6 — routing feedback hook (CLI).
 *
 * Records a user's disagreement with a routing verdict into routing_feedback —
 * the backend for the "Leave feedback" link the WS-2 alert advertises. Matches
 * the CLI-gate pattern of scripts/approve-payments.ts (the codebase has no HTTP
 * server yet; the WS-7 report UI will later call the same recordRoutingFeedback).
 *
 *   npm run ws6:feedback -- --run <run_id> --property <id> \
 *     [--utility bge|water] --text "<feedback>" [--by "<name>"]
 */
import * as dotenv from 'dotenv';
import { closePool, validateEnv, recordRoutingFeedback } from '../tests/helpers/db';

dotenv.config();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const run_id = argValue('--run');
  const propertyRaw = argValue('--property');
  const utilityRaw = (argValue('--utility') ?? '').toLowerCase();
  const text = argValue('--text');
  const by = argValue('--by') ?? null;

  const utility = utilityRaw === 'bge' || utilityRaw === 'water' ? utilityRaw : null;
  if (utilityRaw && !utility) {
    console.error('--utility must be "bge" or "water" (omit for whole-property feedback).');
    process.exit(2);
  }
  if (!run_id || !propertyRaw || !text) {
    console.error(
      'Usage: ws6-feedback.ts --run <run_id> --property <id> ' +
      '[--utility bge|water] --text "<feedback>" [--by "<name>"]'
    );
    process.exit(2);
  }

  const property_id = Number(propertyRaw);
  if (!Number.isInteger(property_id)) {
    console.error(`--property must be an integer property_id (got "${propertyRaw}").`);
    process.exit(2);
  }

  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);

  await recordRoutingFeedback({ run_id, property_id, utility, feedback_text: text, submitted_by: by });
  console.log(`[WS-6] Feedback recorded for run ${run_id}, property ${property_id}` +
    `${utility ? ` [${utility}]` : ''}.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    console.error('[WS-6] Feedback FAILED:', err?.message ?? err);
    await closePool().catch(() => {});
    process.exit(1);
  });
