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
    // Connection info
    const meta = await pool.query<any>(`
      SELECT current_user, current_database() AS db, current_setting('search_path') AS sp
    `);
    console.log(`Connected: user=${meta.rows[0].current_user}  db=${meta.rows[0].db}  search_path=${meta.rows[0].sp}\n`);

    // Find ALL tables named water_account_map in ALL schemas
    const tables = await pool.query<any>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_name = 'water_account_map'
      ORDER BY table_schema
    `);

    if (tables.rows.length === 0) {
      console.log('No "water_account_map" table exists in this database at all.');
      return;
    }

    console.log(`Found ${tables.rows.length} water_account_map table(s):\n`);
    for (const t of tables.rows) {
      const cnt = await pool.query<any>(`SELECT COUNT(*)::int AS n FROM "${t.table_schema}"."${t.table_name}"`);
      const sample = await pool.query<any>(
        `SELECT water_account_number, property_address, property_id
         FROM "${t.table_schema}"."${t.table_name}"
         ORDER BY water_account_number LIMIT 3`
      ).catch(() => ({ rows: [] }));
      console.log(`  ${t.table_schema}.${t.table_name}   rows=${cnt.rows[0].n}`);
      for (const r of sample.rows) {
        console.log(`     ${r.water_account_number}  property_id=${r.property_id ?? 'NULL'}  "${(r.property_address || '').slice(0, 60)}"`);
      }
    }

    // What does an unqualified "water_account_map" resolve to (per current search_path)?
    console.log();
    const resolves = await pool.query<any>(`
      SELECT n.nspname AS schema FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'water_account_map'
        AND n.nspname = ANY(string_to_array(replace(current_setting('search_path'),' ',''),','))
      ORDER BY array_position(string_to_array(replace(current_setting('search_path'),' ',''),','), n.nspname)
      LIMIT 1
    `);
    console.log(`Unqualified "water_account_map" resolves to: ${resolves.rows[0]?.schema ?? '(NOT FOUND in search_path — unqualified reference would fail)'}`);

    // Check bge_account_property_map across schemas too for comparison
    console.log('\n─── For comparison: bge_account_property_map ───');
    const bgeTables = await pool.query<any>(`
      SELECT table_schema FROM information_schema.tables WHERE table_name = 'bge_account_property_map' ORDER BY table_schema
    `);
    for (const t of bgeTables.rows) {
      const cnt = await pool.query<any>(`SELECT COUNT(*)::int AS n FROM "${t.table_schema}".bge_account_property_map`);
      console.log(`  ${t.table_schema}.bge_account_property_map  rows=${cnt.rows[0].n}`);
    }
  } finally {
    await pool.end();
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
