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
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map`);
    const matched = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map WHERE property_id IS NOT NULL`);
    const unmatched = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map WHERE property_id IS NULL`);
    const sharedAddr = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map WHERE property_address ILIKE 'shared%' OR property_address = ''`);

    console.log('═══ public.water_account_map state ═══');
    console.log(`  Total rows:                   ${total.rows[0].n}`);
    console.log(`  With property_id (matched):   ${matched.rows[0].n}`);
    console.log(`  Without property_id (unmatched): ${unmatched.rows[0].n}`);
    console.log(`  Address starts with 'Shared': ${sharedAddr.rows[0].n}`);
    console.log();

    const samples = await pool.query(`
      SELECT water_account_number, property_address, property_id
      FROM public.water_account_map ORDER BY water_account_number LIMIT 10
    `);
    console.log('First 10 rows:');
    for (const r of samples.rows) {
      console.log(`  ${r.water_account_number}  property_id=${r.property_id ?? 'NULL'}  "${(r.property_address || '').slice(0, 50)}"`);
    }

    if (unmatched.rows[0].n > 0) {
      const unsamples = await pool.query(`
        SELECT water_account_number, property_address FROM public.water_account_map
        WHERE property_id IS NULL ORDER BY water_account_number LIMIT 5
      `);
      console.log('\nFirst 5 unmatched rows:');
      for (const r of unsamples.rows) console.log(`  ${r.water_account_number}  "${r.property_address}"`);
    }
  } finally {
    await pool.end();
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
