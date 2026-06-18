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
    // Look at the water-bills tables specifically — list columns
    const waterTables = [
      'items__high_water_bills__credit_issued_research_matchup_to_affe',
      'items__high_water_bills__old_high_water_bill',
      'items__high_water_bills__protocol',
      'items__high_water_bills__research',
      'items__rentals_billing_compliance__lead_certs_water_bills',
    ];
    console.log('─── Columns in water-related podio tables ───');
    for (const tn of waterTables) {
      const cols = await pool.query<any>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='podio' AND table_name=$1 ORDER BY ordinal_position`,
        [tn]
      );
      if (cols.rows.length === 0) continue;
      console.log(`\n  podio.${tn}:`);
      for (const c of cols.rows) console.log(`     ${c.column_name}  (${c.data_type})`);
    }

    // Look for property-like columns across ALL podio tables
    console.log('\n─── property/location/name-like columns across all podio tables ───');
    const propLike = await pool.query<any>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='podio'
        AND (column_name ILIKE '%property%' OR column_name ILIKE '%location%' OR column_name ILIKE '%address%' OR column_name ILIKE '%title%' OR column_name = 'name' OR column_name ILIKE '%item_name%')
      ORDER BY table_name, column_name
    `);
    for (const r of propLike.rows) {
      console.log(`  podio.${r.table_name}.${r.column_name}`);
    }

    // Look for any podio column whose values contain Baltimore addresses
    console.log('\n─── Searching ALL text columns in podio for "1025 N CAREY" pattern ───');
    const textCols = await pool.query<any>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='podio' AND data_type IN ('text', 'character varying', 'varchar')
      ORDER BY table_name, column_name
    `);

    const targets = ['1025 N CAREY', '2791', '609 N ELLWOOD', '30-34 SOUTH', '32 SOUTH ST'];
    for (const tc of textCols.rows) {
      for (const target of targets) {
        const res = await pool.query<any>(
          `SELECT "${tc.column_name}" AS hit FROM podio."${tc.table_name}" WHERE "${tc.column_name}" ILIKE $1 LIMIT 2`,
          [`%${target}%`]
        ).catch(() => ({ rows: [] }));
        if (res.rows.length > 0) {
          console.log(`  "${target}" → podio.${tc.table_name}.${tc.column_name}:`);
          for (const r of res.rows) console.log(`     "${String(r.hit).slice(0, 100)}"`);
        }
      }
    }
    console.log();
  } finally {
    await pool.end();
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
