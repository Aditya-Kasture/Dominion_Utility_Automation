/**
 * Import water accounts from "water portal infromation.xlsx".
 *
 * The Excel file has 3 rows per account:
 *     Account 11000158444
 *     2900 POPLAR TER Baltimore MD 21216-2832 USA
 *     Premises
 *
 * For each account this script:
 *   1. Parses out water_account_number + address
 *   2. Looks up matching property in hub.property (by street1, with apt-stripping)
 *   3. UPSERTs into public.water_account_map
 *
 * Usage:
 *   npm run import:water-xlsx [-- --dry-run]
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const XLSX_FILE = path.resolve(__dirname, '..', 'water portal infromation.xlsx');
const DRY_RUN = process.argv.includes('--dry-run');

interface WaterAccountRow {
  water_account_number: string;
  full_address: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}

function parseAddress(s: string): { street: string; city: string; state: string; zip: string } {
  // "2900 POPLAR TER Baltimore MD 21216-2832 USA"
  // street: anything up to the mixed-case city, then 2-letter state, then 5-digit zip
  const m = s.match(/^(.+?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  if (!m) return { street: s.trim(), city: '', state: '', zip: '' };
  return { street: m[1].trim(), city: m[2], state: m[3], zip: m[4] };
}

function stripUnitSuffix(street: string): string {
  return street
    .replace(/\s+\*?\s*(apt|apartment|unit|suite|ste|#)\.?\s*[\w\d\-]+\s*$/i, '')
    .replace(/\s+\*\s*ps\s*$/i, '')
    .trim();
}

function parseXlsx(filePath: string): WaterAccountRow[] {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], { header: 1, defval: '' });

  const rows: WaterAccountRow[] = [];
  let i = 0;
  while (i < data.length) {
    const cell = String(data[i]?.[0] ?? '').trim();
    if (/^Account\s+\d/i.test(cell)) {
      const water_account_number = cell.replace(/^Account\s+/i, '').trim();

      // The next row is either the address OR a type label like "Shared" / "Sole".
      // Real addresses always start with a digit (the house number). If the next
      // row doesn't start with a digit, treat it as a type label and look one
      // row further for the actual address.
      let addrIdx = i + 1;
      const nextCell = String(data[addrIdx]?.[0] ?? '').trim();
      if (!/^\d/.test(nextCell)) {
        addrIdx = i + 2;
      }
      const addressCell = String(data[addrIdx]?.[0] ?? '').trim();
      const parsed = parseAddress(addressCell);
      rows.push({ water_account_number, full_address: addressCell, ...parsed });

      // Advance past the address + the "Premises" footer (one row after the address)
      i = addrIdx + 2;
    } else {
      i++;
    }
  }
  return rows;
}

async function run() {
  if (!fs.existsSync(XLSX_FILE)) {
    console.error(`File not found: ${XLSX_FILE}`);
    process.exit(1);
  }

  console.log(`Reading ${path.basename(XLSX_FILE)}...`);
  const rows = parseXlsx(XLSX_FILE);
  console.log(`Parsed ${rows.length} water accounts.\n`);

  if (rows.length === 0) {
    console.error('No accounts found. Check that the Excel format is unchanged (3 rows per account).');
    process.exit(1);
  }

  // Show first 3 for sanity
  console.log('First 3 rows for sanity check:');
  for (const r of rows.slice(0, 3)) {
    console.log(`  ${r.water_account_number}  ${r.street}, ${r.city} ${r.state} ${r.zip}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('[DRY RUN] No DB writes. Re-run without --dry-run to insert.');
    return;
  }

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
  });

  try {
    // Make property_id nullable so unmatched accounts can still be stored.
    // Idempotent — does nothing if already nullable.
    await pool.query(`ALTER TABLE public.water_account_map ALTER COLUMN property_id DROP NOT NULL`).catch(() => null);

    let inserted = 0, matched = 0, fkBlocked = 0;
    const unmatched: string[] = [];
    const startedAt = Date.now();

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      if (idx > 0 && idx % 20 === 0) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const rate = idx / elapsed;
        const remaining = Math.round((rows.length - idx) / rate);
        console.log(`  ... ${idx}/${rows.length} processed (${elapsed}s elapsed, ~${remaining}s remaining)`);
      }
      // Try matching against hub.property (master data).
      const street = row.street;
      const stripped = stripUnitSuffix(street);
      const candidates = [stripped, street, stripped.replace(/-/g, ' ')].filter(Boolean);

      let propId: number | null = null;
      for (const c of candidates) {
        const lookup = await pool.query<{ id: number }>(
          `SELECT id FROM hub.property WHERE street1 ILIKE $1 LIMIT 1`,
          [c]
        ).catch(() => ({ rows: [] as { id: number }[] }));
        if (lookup.rows.length > 0) { propId = lookup.rows[0].id; break; }
      }

      if (propId !== null) matched++;
      else                 unmatched.push(`${row.water_account_number}  ${street}`);

      // Preserve already-matched rows: only update if the existing row has
      // property_id IS NULL. If we've already matched this account_number to
      // a property (manually or via Gemini), don't touch it on re-runs.
      try {
        await pool.query(
          `INSERT INTO public.water_account_map (water_account_number, property_address, property_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (water_account_number) DO UPDATE
             SET property_address = EXCLUDED.property_address,
                 property_id      = EXCLUDED.property_id
             WHERE water_account_map.property_id IS NULL`,
          [row.water_account_number, row.full_address, propId]
        );
        inserted++;
      } catch (err: any) {
        if (err.code === '23503' && propId !== null) {
          // FK violation — keep account_number, NULL the property_id.
          try {
            await pool.query(
              `INSERT INTO public.water_account_map (water_account_number, property_address, property_id)
               VALUES ($1, $2, NULL)
               ON CONFLICT (water_account_number) DO UPDATE
                 SET property_address = EXCLUDED.property_address,
                     property_id      = NULL
                 WHERE water_account_map.property_id IS NULL`,
              [row.water_account_number, row.full_address]
            );
            inserted++;
            fkBlocked++;
            matched--;
          } catch (err2: any) {
            console.error(`Insert failed (NULL fallback) for ${row.water_account_number}: ${err2.message}`);
          }
        } else {
          console.error(`Insert failed for ${row.water_account_number}: ${err.message}`);
        }
      }
    }

    console.log(`\n─── Summary ───────────────────────────────────────────`);
    console.log(`  Total parsed:               ${rows.length}`);
    console.log(`  Inserted into DB:           ${inserted}`);
    console.log(`  Matched to hub.property:    ${matched}`);
    console.log(`  Unmatched (property_id NULL): ${rows.length - matched}`);
    if (fkBlocked > 0) {
      console.log(`  FK target mismatch (NULL): ${fkBlocked}  ← public.water_account_map.property_id FK doesn't accept hub.property IDs`);
    }
    if (unmatched.length > 0 && unmatched.length <= 30) {
      console.log(`\n  Unmatched addresses:`);
      for (const u of unmatched) console.log(`    ${u}`);
    } else if (unmatched.length > 30) {
      console.log(`\n  ${unmatched.length} unmatched addresses (first 30 shown):`);
      for (const u of unmatched.slice(0, 30)) console.log(`    ${u}`);
      console.log(`    ... and ${unmatched.length - 30} more`);
    }
  } finally {
    await pool.end();
  }
}

run()
  .then(() => process.exit(0))  // force-exit in case pool.end() leaves dangling sockets
  .catch(err => {
    console.error('Fatal:', err.message ?? err);
    process.exit(1);
  });
