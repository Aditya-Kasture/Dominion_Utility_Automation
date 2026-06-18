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
    console.log('Breakdown of public.bge_account_property_map (86 total rows):\n');

    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM public.bge_account_property_map`);
    console.log(`  Total rows in mapping table:                ${total.rows[0].n}`);

    const nullProp = await pool.query(`SELECT COUNT(*)::int AS n FROM public.bge_account_property_map WHERE property_id IS NULL`);
    console.log(`  Rows with property_id IS NULL:              ${nullProp.rows[0].n}`);

    const withProp = await pool.query(`SELECT COUNT(*)::int AS n FROM public.bge_account_property_map WHERE property_id IS NOT NULL`);
    console.log(`  Rows with a property_id set:                ${withProp.rows[0].n}`);

    const inHub = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM public.bge_account_property_map bap
      JOIN hub.property p ON bap.property_id = p.id
    `);
    console.log(`  ↳ of those, found in hub.property:          ${inHub.rows[0].n}`);

    const inHubActive = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM public.bge_account_property_map bap
      JOIN hub.property p ON bap.property_id = p.id
      WHERE p.is_active = TRUE
    `);
    console.log(`  ↳ of those, active (is_active=TRUE):        ${inHubActive.rows[0].n}  ← what the old query returned`);

    const inHubInactive = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM public.bge_account_property_map bap
      JOIN hub.property p ON bap.property_id = p.id
      WHERE p.is_active = FALSE OR p.is_active IS NULL
    `);
    console.log(`  ↳ of those, INACTIVE (is_active=FALSE):     ${inHubInactive.rows[0].n}  ← these were excluded`);

    const notInHub = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM public.bge_account_property_map bap
      LEFT JOIN hub.property p ON bap.property_id = p.id
      WHERE bap.property_id IS NOT NULL AND p.id IS NULL
    `);
    console.log(`  Rows with property_id that doesn't exist in hub.property: ${notInHub.rows[0].n}`);

    // Sample inactive accounts
    const inactive = await pool.query<any>(`
      SELECT bap.bge_account_number, p.name, p.lifecycle_stage, p.is_active
      FROM public.bge_account_property_map bap
      JOIN hub.property p ON bap.property_id = p.id
      WHERE p.is_active = FALSE OR p.is_active IS NULL
      LIMIT 10
    `);
    if (inactive.rows.length > 0) {
      console.log(`\nSample inactive accounts that the old query excluded:`);
      for (const r of inactive.rows) {
        console.log(`  ${r.bge_account_number}  "${r.name}"  lifecycle=${r.lifecycle_stage}  is_active=${r.is_active}`);
      }
    }
  } finally {
    await pool.end();
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
