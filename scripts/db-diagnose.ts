/**
 * Diagnose where the BGE/Water script is actually writing (or failing to write).
 *
 *   npm run db:diagnose
 *
 * Reports:
 *   1. Connected user + current search_path
 *   2. Every schema that contains a bge_portal_audit_log / water_portal_audit_log
 *      / bge_account_property_map / water_account_map — with row counts
 *   3. Tries an INSERT + ROLLBACK to see if writes are allowed
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
  });

  try {
    // 1. Connection info
    const meta = await pool.query<{ current_user: string; search_path: string; current_database: string }>(`
      SELECT current_user, current_setting('search_path') AS search_path, current_database()
    `);
    const m = meta.rows[0];
    console.log(`\n─── Connection ───────────────────────────────────────────────`);
    console.log(`  user:        ${m.current_user}`);
    console.log(`  database:    ${m.current_database}`);
    console.log(`  search_path: ${m.search_path}`);

    // 2. Locate all script-related tables across schemas
    const tableNames = [
      'bge_account_property_map',
      'bge_portal_audit_log',
      'water_account_map',
      'water_portal_audit_log',
    ];
    console.log(`\n─── Script tables — where they live + row count ──────────────`);
    for (const tn of tableNames) {
      const locations = await pool.query<{ table_schema: string }>(
        `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`,
        [tn]
      );
      if (locations.rows.length === 0) {
        console.log(`  ✗ ${tn.padEnd(30)} not found in any schema`);
        continue;
      }
      for (const { table_schema } of locations.rows) {
        try {
          const cnt = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "${table_schema}"."${tn}"`);
          const last = await pool.query<{ max: Date | null }>(
            `SELECT MAX(run_at)::text AS max FROM "${table_schema}"."${tn}"`
          ).catch(() => ({ rows: [{ max: null }] }));
          const lastStr = last.rows[0].max ? `   last row: ${last.rows[0].max}` : '';
          console.log(`  ✓ ${(table_schema + '.' + tn).padEnd(50)} rows=${cnt.rows[0].n}${lastStr}`);
        } catch (err: any) {
          console.log(`  ⚠ ${(table_schema + '.' + tn).padEnd(50)} access denied or query failed (${err.message})`);
        }
      }
    }

    // 3. Where does an UNQUALIFIED reference resolve?
    console.log(`\n─── Where unqualified names resolve (per current search_path) ─`);
    for (const tn of tableNames) {
      const r = await pool.query<{ schema: string | null }>(
        `SELECT n.nspname AS schema
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = $1 AND has_table_privilege(c.oid, 'SELECT')
           AND n.nspname = ANY(string_to_array(replace(current_setting('search_path'),' ',''),','))
         ORDER BY array_position(string_to_array(replace(current_setting('search_path'),' ',''),','), n.nspname)
         LIMIT 1`,
        [tn]
      ).catch(() => ({ rows: [{ schema: null }] }));
      const resolves = r.rows[0]?.schema ?? '(NOT FOUND — unqualified queries on this table will fail)';
      console.log(`  ${tn.padEnd(30)} → ${resolves}`);
    }

    // 4. Probe an INSERT (rolled back) to confirm the script can actually write
    console.log(`\n─── Probe INSERT into bge_portal_audit_log (rolled back) ─────`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // First need a valid property_id for the FK
      const prop = await client.query<{ id: number }>(`SELECT id FROM hub.property WHERE is_active = TRUE LIMIT 1`);
      if (prop.rows.length === 0) {
        console.log('  ⚠ No active hub.property rows — cannot probe FK insert.');
      } else {
        const propId = prop.rows[0].id;
        try {
          await client.query(
            `INSERT INTO bge_portal_audit_log
               (bge_account_number, property_id, action, status, notes, run_at)
             VALUES ('DIAGNOSTIC_TEST', $1, 'diagnose', 'TEST', 'probe insert from db:diagnose — rolled back', NOW())`,
            [propId]
          );
          console.log(`  ✓ Unqualified INSERT succeeded — script writes WOULD work.`);
          console.log(`     (Rolled back — no row was actually inserted.)`);
        } catch (err: any) {
          console.log(`  ✗ Unqualified INSERT failed: ${err.message}`);
          console.log(`     This is why the script's log rows aren't appearing.`);
          console.log(`     Fix: qualify the INSERT in tests/helpers/db.ts with "appfolio.bge_portal_audit_log",`);
          console.log(`     OR set DB search_path to include appfolio for the script's connection.`);
        }
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    console.log();
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
