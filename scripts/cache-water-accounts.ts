/**
 * Offline-cache the water account list.
 *
 * Run this WHEN you can reach the DB (work network / VPN to DB host).
 * It dumps the units that fetchWaterAccounts() would return into a JSON file.
 * The water.spec.ts test then reads from that JSON, so the portal automation
 * can run from a different network (e.g. portal-VPN with no DB access).
 *
 * Usage:
 *   npm run cache:water
 *
 * Re-run any time the DB changes (new units, status changes, etc.).
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const CACHE_DIR  = path.resolve(__dirname, '..', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'water-accounts.json');

async function run() {
  console.log('[Cache] Connecting to DB...');
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
  });

  try {
    // 1. Fetch the 558 owner-paid water units from the master data.
    const { rows } = await pool.query(`
      SELECT
        u.id                AS unit_id,
        u.appfolio_unit_id,
        u.unit_name,
        p.id                AS property_id,
        p.name              AS property_name,
        -- Prefer the unit-level address: on multi-unit properties it carries the
        -- "#A"/"#2002" marker; on single-unit properties unit and property
        -- addresses are identical, and the property row is the fallback.
        COALESCE(NULLIF(u.street1, ''), p.street1) AS street1,
        COALESCE(NULLIF(u.city,    ''), p.city)    AS city,
        COALESCE(NULLIF(u.state,   ''), p.state)   AS state,
        p.zip,
        p.lifecycle_stage,
        us.code             AS status_code,
        (SELECT COUNT(*) FROM hub.unit u2 WHERE u2.property_id = p.id) > 1
                            AS is_multi_unit,
        ucb.baseline_amount AS consumption_baseline,
        ucb.period_unit     AS baseline_period
      FROM hub.unit u
      JOIN hub.property p ON u.property_id = p.id
      LEFT JOIN hub.unit_status us ON us.id = u.unit_status_id
      JOIN hub.unit_utility_responsibility uur
        ON uur.unit_id = u.id
        AND uur.utility_type = 'water'
        AND uur.responsibility IN ('landlord', 'dp')
      LEFT JOIN hub.unit_consumption_baseline ucb
        ON ucb.unit_id = u.id
        AND ucb.utility_type = 'water'
        AND ucb.period_unit = 'quarterly'
      WHERE p.is_active = TRUE
      ORDER BY p.name, u.unit_name
    `);

    // 2. Fetch all water_account_map rows (water account number ↔ address).
    const wamRes = await pool.query<{ water_account_number: string; property_address: string }>(`
      SELECT water_account_number, property_address FROM public.water_account_map
    `);

    // 3. Build an in-memory lookup from the "proper street name" (house number
    //    + everything after the optional N/S/E/W directional, with street type
    //    stripped and spaces removed) → water_account_number.
    //    Catches "1005 N ASHBURTON ST" ↔ "1005 Ashburton St" and similar.
    const STREET_TYPE_RE =
      /\s+(ter|terrace|ave|avenue|av|st|street|str|rd|road|dr|drive|driveway|ln|lane|blvd|boulevard|ct|court|pl|place|pkwy|parkway|sq|square|cir|circle|way|ridge|run|cove|crossing)\.?$/i;

    const normalize = (addr: string): string => {
      const street = addr.split(/\s+(Baltimore|BALTIMORE|baltimore|Owings\s*Mills|Brooklyn|Towson)\b/i)[0].trim();
      return street
        .replace(/\s+#[\w\d\-/]+$/i, '')
        .replace(/\s+(apt|apartment|unit|suite|ste)\.?\s*[\w\d\-]+\s*$/i, '')
        .replace(/\s+\*\s*(apt|ps)\.?\s*[\w\d\-]*\s*$/i, '')
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const buildKey = (addr: string): string => {
      const noType = normalize(addr).replace(STREET_TYPE_RE, '').trim();
      const words = noType.split(/\s+/).filter(Boolean);
      let i = 0;
      // Keep house number but skip directional (so "1005 n ashburton" → "1005 ashburton")
      if (i < words.length && /^\d/.test(words[i])) i++;     // house number kept
      const houseNum = words[0] ?? '';
      if (i < words.length && /^[nsew]$/.test(words[i])) i++; // skip directional
      const rest = words.slice(i).join('');                   // squash spaces too
      return houseNum && rest ? `${houseNum} ${rest}` : noType.replace(/\s+/g, ' ');
    };

    const wamByKey = new Map<string, string>();
    for (const w of wamRes.rows) {
      if (!w.property_address || /^shared$/i.test(w.property_address.trim())) continue;
      wamByKey.set(buildKey(w.property_address), w.water_account_number);
    }

    // 4. Attach water_account_number to each unit by matching street1.
    let matched = 0;
    const enriched = rows.map((u: any) => {
      const key = buildKey(u.street1 || '');
      const water_account_number = wamByKey.get(key) ?? null;
      if (water_account_number) matched++;
      return { ...u, water_account_number };
    });

    console.log(`[Cache] Got ${enriched.length} water units from DB; ${matched} matched to a water_account_number (${enriched.length - matched} unmatched).`);
    const rowsOut = enriched;
    rows.length = 0; // for symmetry with original code path below
    (rows as any[]).push(...rowsOut);

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`[Cache] Saved → ${CACHE_FILE}`);

    if (rows.length === 0) {
      console.warn(
        '\n[Cache] ⚠  Query returned 0 rows. Likely causes:\n' +
        '   • lifecycle_stage filter does not match any rows (e.g. \'occupied\'/\'flip\' not in your data)\n' +
        '   • Schema search_path missing — unqualified `unit` / `property` may not resolve\n' +
        '   • unit_utility_responsibility has no \'water\' entries with responsibility \'landlord\'/\'dp\'\n' +
        'Cache file written anyway (as []). Fix the query or data, then re-run.'
      );
    } else {
      console.log(`[Cache] First 3 rows for sanity check:`);
      for (const row of rows.slice(0, 3)) {
        console.log(`   ${row.unit_name}  ${row.street1}, ${row.city}  (water_account_number=${row.water_account_number ?? 'NULL'})`);
      }
    }
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[Cache] Fatal:', err.message ?? err);
  process.exit(1);
});
