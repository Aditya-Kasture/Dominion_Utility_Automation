/**
 * Truncate public.water_account_map and reset its identity sequence.
 *
 *   npm run reset:water-map
 *
 * Use BEFORE re-running `npm run import:water-xlsx` if you want a clean slate
 * (e.g. removing test rows, fixing a botched run).
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
  });

  try {
    const before = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM public.water_account_map`);
    console.log(`Before: public.water_account_map has ${before.rows[0].n} rows.`);

    await pool.query(`TRUNCATE TABLE public.water_account_map RESTART IDENTITY CASCADE`);

    const after = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM public.water_account_map`);
    console.log(`After:  public.water_account_map has ${after.rows[0].n} rows.`);
    console.log('\nDone. Re-run "npm run import:water-xlsx" to repopulate from the Excel.');
  } finally {
    await pool.end();
  }
})()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal:', err.message ?? err); process.exit(1); });
