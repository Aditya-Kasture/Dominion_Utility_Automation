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

  console.log('Step 1: Show current row count');
  let cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map`);
  console.log(`  Before: ${cnt.rows[0].n} rows\n`);

  console.log('Step 2: Try to insert a single test row');
  try {
    const r = await pool.query(
      `INSERT INTO public.water_account_map (water_account_number, property_address, property_id)
       VALUES ('TEST_INSERT_001', 'TEST ADDRESS Baltimore MD 21218 USA', NULL)
       ON CONFLICT (water_account_number) DO UPDATE
         SET property_address = EXCLUDED.property_address
       RETURNING id, water_account_number, property_id`
    );
    console.log(`  ✓ INSERT returned:`, r.rows[0]);
  } catch (err: any) {
    console.log(`  ✗ INSERT failed: ${err.message} (code: ${err.code})`);
  }

  console.log('\nStep 3: Read it back in the SAME connection');
  const readBack = await pool.query(
    `SELECT id, water_account_number, property_address, property_id FROM public.water_account_map WHERE water_account_number = 'TEST_INSERT_001'`
  );
  console.log(`  Found ${readBack.rows.length} row(s):`, readBack.rows);

  console.log('\nStep 4: Total row count after insert');
  cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM public.water_account_map`);
  console.log(`  After: ${cnt.rows[0].n} rows`);

  console.log('\nStep 5: Clean up the test row');
  const del = await pool.query(`DELETE FROM public.water_account_map WHERE water_account_number = 'TEST_INSERT_001' RETURNING id`);
  console.log(`  Deleted ${del.rows.length} row(s)`);

  await pool.end();
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
