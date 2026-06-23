/**
 * Manual payment approval CLI (stand-in for the WS-7 approve-link).
 *
 * June 19 2026: "no payment or bill-back happens without your approval." The
 * BGE (WS-3) and Water (WS-4) agents only pay accounts that have a row in
 * public.payment_approval. Until the WS-7 email approve-link + N8N poll exist,
 * this CLI is how an authorized human writes that row.
 *
 *   npx tsx scripts/approve-payments.ts \
 *     --run <run_id> --utility water --account 123456 [--amount 84.10] --by "Jack BeVier" [--reason "..."]
 *
 *   # bulk-approve every account flagged PAY for a run from a CSV of account numbers:
 *   npx tsx scripts/approve-payments.ts --run <run_id> --utility bge --accounts-file approvals.txt --by "Jack"
 *
 * Re-approving the same account for the same run is a no-op (UNIQUE constraint).
 */
import fs from 'fs';
import * as dotenv from 'dotenv';
import { getPool, closePool, validateEnv } from '../tests/helpers/db';

dotenv.config();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const run_id = argValue('--run');
  const utility = (argValue('--utility') ?? '').toLowerCase();
  const account = argValue('--account');
  const accountsFile = argValue('--accounts-file');
  const amountRaw = argValue('--amount');
  const by = argValue('--by');
  const reason = argValue('--reason') ?? null;
  const propertyIdRaw = argValue('--property-id');

  if (!run_id || (utility !== 'bge' && utility !== 'water') || !by || (!account && !accountsFile)) {
    console.error(
      'Usage: approve-payments.ts --run <run_id> --utility <bge|water> ' +
      '(--account <n> | --accounts-file <path>) [--amount <$>] --by "<name>" [--reason "<why>"] [--property-id <id>]'
    );
    process.exit(2);
  }

  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);

  const accounts: string[] = account
    ? [account]
    : fs.readFileSync(accountsFile!, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const approved_amount = amountRaw != null && amountRaw !== '' ? Number(amountRaw) : null;
  const property_id = propertyIdRaw != null && propertyIdRaw !== '' ? Number(propertyIdRaw) : null;

  const pool = getPool();
  let inserted = 0;
  for (const acct of accounts) {
    const res = await pool.query(
      `INSERT INTO public.payment_approval
         (run_id, property_id, utility, account_number, approved_amount, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, utility, account_number) DO NOTHING`,
      [run_id, property_id, utility, acct, approved_amount, by]
    );
    if ((res.rowCount ?? 0) > 0) inserted++;
    // reason is advisory metadata for the human trail; kept out of the approval
    // row schema deliberately — the override reason lives in proration_override.
    if (reason) console.log(`[approve] ${acct} reason: ${reason}`);
  }

  console.log(`[approve] run ${run_id} / ${utility}: ${inserted} new approval(s), ${accounts.length - inserted} already approved.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    console.error('[approve] FAILED:', err?.message ?? err);
    await closePool().catch(() => {});
    process.exit(1);
  });
