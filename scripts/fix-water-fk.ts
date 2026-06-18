/**
 * One-off migration: re-point public.water_account_map.property_id from
 * whatever it currently references → hub.property(id).
 *
 * Usage:
 *   npm run db:fix-water-fk
 *
 * Idempotent — safe to re-run. Reports what was done.
 *
 * What it does, in order:
 *   1. Find and drop the existing FK on water_account_map.property_id (if any)
 *   2. Widen the column type to BIGINT (hub.property.id is bigint)
 *   3. Add a new FK pointing to hub.property(id)
 *   4. Same treatment for unit_id → hub.unit(id), if the column exists
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
    console.log('─── Fix water_account_map.property_id FK → hub.property(id) ───\n');

    // 1. Find existing FK constraint name (if any)
    const fkRes = await pool.query<{ constraint_name: string; referenced: string }>(`
      SELECT
        c.conname        AS constraint_name,
        c.confrelid::regclass::text AS referenced
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum   = ANY(c.conkey)
      WHERE c.contype  = 'f'
        AND c.conrelid = 'public.water_account_map'::regclass
        AND a.attname  = 'property_id'
    `);

    if (fkRes.rows.length > 0) {
      const { constraint_name, referenced } = fkRes.rows[0];
      console.log(`  Existing FK: ${constraint_name}  →  ${referenced}`);
      if (referenced === 'hub.property') {
        console.log('  Already points to hub.property — nothing to do for property_id.');
      } else {
        console.log(`  Dropping FK ${constraint_name}...`);
        await pool.query(`ALTER TABLE public.water_account_map DROP CONSTRAINT "${constraint_name}"`);
      }
    } else {
      console.log('  No existing FK on property_id (already dropped earlier).');
    }

    // 2. Widen column to BIGINT (hub.property.id is bigint)
    const colType = await pool.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='water_account_map' AND column_name='property_id'
    `);
    if (colType.rows[0]?.data_type === 'integer') {
      console.log('  Widening property_id INTEGER → BIGINT...');
      await pool.query(`ALTER TABLE public.water_account_map ALTER COLUMN property_id TYPE BIGINT`);
    } else {
      console.log(`  property_id type is ${colType.rows[0]?.data_type} — no widening needed.`);
    }

    // 3. Add the new FK if not already present
    const newFkRes = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype  = 'f'
        AND c.conrelid = 'public.water_account_map'::regclass
        AND c.confrelid = 'hub.property'::regclass
        AND a.attname  = 'property_id'
    `);
    if (Number(newFkRes.rows[0].count) === 0) {
      console.log('  Adding new FK property_id → hub.property(id)...');
      await pool.query(`
        ALTER TABLE public.water_account_map
          ADD CONSTRAINT water_account_map_property_id_hub_fkey
          FOREIGN KEY (property_id) REFERENCES hub.property(id)
      `);
      console.log('  ✓ FK added.');
    } else {
      console.log('  FK to hub.property already exists.');
    }

    // ── Same treatment for unit_id, if the column exists ──────────────────
    const unitCol = await pool.query<{ data_type: string | null }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='water_account_map' AND column_name='unit_id'
    `);
    if (unitCol.rows.length > 0) {
      console.log('\n─── Same treatment for unit_id → hub.unit(id) ───');

      const unitFk = await pool.query<{ constraint_name: string; referenced: string }>(`
        SELECT c.conname AS constraint_name, c.confrelid::regclass::text AS referenced
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype='f' AND c.conrelid='public.water_account_map'::regclass AND a.attname='unit_id'
      `);
      if (unitFk.rows.length > 0 && unitFk.rows[0].referenced !== 'hub.unit') {
        console.log(`  Dropping unit_id FK ${unitFk.rows[0].constraint_name}...`);
        await pool.query(`ALTER TABLE public.water_account_map DROP CONSTRAINT "${unitFk.rows[0].constraint_name}"`);
      }

      if (unitCol.rows[0].data_type === 'integer') {
        console.log('  Widening unit_id INTEGER → BIGINT...');
        await pool.query(`ALTER TABLE public.water_account_map ALTER COLUMN unit_id TYPE BIGINT`);
      }

      const newUnitFk = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype='f' AND c.conrelid='public.water_account_map'::regclass
          AND c.confrelid='hub.unit'::regclass AND a.attname='unit_id'
      `);
      if (Number(newUnitFk.rows[0].count) === 0) {
        console.log('  Adding new FK unit_id → hub.unit(id)...');
        await pool.query(`
          ALTER TABLE public.water_account_map
            ADD CONSTRAINT water_account_map_unit_id_hub_fkey
            FOREIGN KEY (unit_id) REFERENCES hub.unit(id)
        `);
        console.log('  ✓ FK added.');
      } else {
        console.log('  FK to hub.unit already exists.');
      }
    }

    console.log('\nDone. Now re-run "npm run import:water-xlsx" — property_id will populate correctly.');
  } finally {
    await pool.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err.message ?? err);
    process.exit(1);
  });
