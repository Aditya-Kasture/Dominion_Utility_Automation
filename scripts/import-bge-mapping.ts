/**
 * Import Jack's BGE account-to-property mapping spreadsheet into the DB.
 *
 * Usage:
 *   npx tsx scripts/import-bge-mapping.ts --file bge_mapping.csv [--dry-run]
 *
 * Expected CSV columns (header row required, column names are flexible):
 *   bge_account_number   — BGE account # (required)
 *   property_address     — Full street address  (required)
 *   property_id          — Integer FK into property table (optional — looked up by address if omitted)
 *
 * If your spreadsheet uses different column names (e.g. "Account #", "Street")
 * the script tries common aliases automatically. Run with --dry-run first to
 * verify matching before writing to the DB.
 *
 * Exit codes: 0 = success, 1 = fatal error
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── CLI args ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

const fileIdx = process.argv.indexOf('--file');
const fileArg = process.argv.find(a => a.startsWith('--file='))?.slice(7)
  ?? (fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined);

if (!fileArg) {
  console.error('Usage: npx tsx scripts/import-bge-mapping.ts --file <path.csv> [--dry-run]');
  process.exit(1);
}

const csvPath = path.resolve(fileArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface MappingRow {
  bge_account_number: string;
  property_address: string;
  property_id?: number;
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

/** Splits a CSV line respecting double-quoted fields. */
function splitLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

/** Normalise a header name for alias matching. */
function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find the first matching column index from a list of aliases. */
function findCol(headers: string[], aliases: string[]): number {
  const normHeaders = headers.map(norm);
  for (const alias of aliases) {
    const idx = normHeaders.indexOf(norm(alias));
    if (idx !== -1) return idx;
  }
  // Partial match fallback
  for (const alias of aliases) {
    const idx = normHeaders.findIndex(h => h.includes(norm(alias)));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function parseCsv(filePath: string): Promise<MappingRow[]> {
  const rl = createInterface({ input: fs.createReadStream(filePath) });
  const rows: MappingRow[] = [];
  let lineNum = 0;
  let acctIdx = -1, addrIdx = -1, propIdx = -1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNum++;
    const values = splitLine(line);

    if (lineNum === 1) {
      // Detect columns
      acctIdx = findCol(values, ['bge_account_number', 'account_number', 'account number', 'account#', 'account #', 'bge account', 'bge#', 'acct', 'account']);
      addrIdx = findCol(values, ['property_address', 'property address', 'address', 'street address', 'street', 'street1', 'location', 'property']);
      propIdx = findCol(values, ['property_id', 'prop_id', 'property id', 'propid', 'id']);

      if (acctIdx === -1) {
        console.error(`Cannot find BGE account number column. Headers found: ${values.join(', ')}`);
        console.error('Expected one of: bge_account_number, account_number, Account #, BGE Account, etc.');
        process.exit(1);
      }
      if (addrIdx === -1) {
        console.error(`Cannot find property address column. Headers found: ${values.join(', ')}`);
        console.error('Expected one of: property_address, address, street, location, etc.');
        process.exit(1);
      }

      console.log(`Column mapping detected:`);
      console.log(`  BGE account number → "${values[acctIdx]}" (col ${acctIdx + 1})`);
      console.log(`  Property address   → "${values[addrIdx]}" (col ${addrIdx + 1})`);
      if (propIdx !== -1) console.log(`  Property ID        → "${values[propIdx]}" (col ${propIdx + 1})`);
      else console.log(`  Property ID        → (will look up by address)`);
      console.log();
      continue;
    }

    const acctNum = values[acctIdx]?.replace(/\s/g, '') ?? '';
    const addr    = values[addrIdx] ?? '';
    const rawId   = propIdx !== -1 ? values[propIdx] : '';

    if (!acctNum) {
      console.warn(`  Line ${lineNum + 1}: empty BGE account number — skipping.`);
      continue;
    }

    rows.push({
      bge_account_number: acctNum,
      property_address:   addr,
      property_id:        rawId ? Number(rawId) : undefined,
    });
  }

  return rows;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function resolvePropertyId(pool: Pool, address: string): Promise<number | null> {
  const street = address.split(',')[0].trim();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM property
     WHERE street1 ILIKE $1 OR street1 ILIKE $2
     LIMIT 1`,
    [address, street]
  );
  return rows[0]?.id ?? null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const rows = await parseCsv(csvPath);
  console.log(`Parsed ${rows.length} account rows from: ${path.basename(csvPath)}`);
  if (DRY_RUN) console.log('[DRY RUN] No writes will occur.\n');
  else console.log();

  const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      { rejectUnauthorized: false },
  });

  let inserted = 0, updated = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    const { bge_account_number: acctNum, property_address: addr } = row;
    let propId = row.property_id ?? null;

    if (!propId) {
      propId = await resolvePropertyId(pool, addr);
      if (propId === null) {
        console.warn(`  SKIP  ${acctNum}  — address not found in property table: "${addr}"`);
        skipped++;
        continue;
      }
    }

    console.log(`  ${DRY_RUN ? '[DRY]' : 'UPSERT'}  ${acctNum}  →  property_id=${propId}  (${addr})`);

    if (!DRY_RUN) {
      try {
        const res = await pool.query(
          `INSERT INTO bge_account_property_map
             (bge_account_number, property_address, property_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (bge_account_number) DO UPDATE
             SET property_address = EXCLUDED.property_address,
                 property_id      = EXCLUDED.property_id`,
          [acctNum, addr, propId]
        );
        // rowCount=1 for INSERT, 1 for UPDATE (ON CONFLICT path)
        // Distinguish by checking if data changed — for simplicity count all as inserted
        if (res.rowCount && res.rowCount > 0) inserted++;
      } catch (err) {
        console.error(`  ERROR  ${acctNum}:`, err);
        errors++;
      }
    } else {
      inserted++;
    }
  }

  await pool.end();

  console.log('\n─── Summary ────────────────────────────────────────────────');
  if (DRY_RUN) {
    console.log(`  Would insert/update: ${inserted}`);
    console.log(`  Would skip (address not in DB): ${skipped}`);
    console.log(`  [DRY RUN — re-run without --dry-run to write to DB]`);
  } else {
    console.log(`  Inserted/updated: ${inserted}`);
    console.log(`  Skipped (address not found): ${skipped}`);
    console.log(`  Errors: ${errors}`);
  }

  if (skipped > 0) {
    console.log('\n  ⚠  Some addresses could not be matched to the property table.');
    console.log('     Ask Abdul to add a property_id column to Jack\'s spreadsheet,');
    console.log('     or confirm spelling matches what is in the DB.');
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
