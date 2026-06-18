/**
 * Import water account-to-unit/property mapping into the DB.
 *
 * Usage:
 *   npx tsx scripts/import-water-mapping.ts --file water_mapping.csv [--dry-run]
 *
 * Expected CSV columns (header row required, column names are flexible):
 *   water_account_number  — Water utility account # (required)
 *   property_address      — Full street address (required)
 *   property_id           — Integer FK into property table (optional — looked up by address if omitted)
 *   unit_id               — Integer FK into unit table (optional — looked up by unit name if omitted)
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
  console.error('Usage: npx tsx scripts/import-water-mapping.ts --file <path.csv> [--dry-run]');
  process.exit(1);
}

const csvPath = path.resolve(fileArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface MappingRow {
  water_account_number: string;
  property_address: string;
  property_id?: number;
  unit_id?: number;
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

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

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCol(headers: string[], aliases: string[]): number {
  const normHeaders = headers.map(norm);
  for (const alias of aliases) {
    const idx = normHeaders.indexOf(norm(alias));
    if (idx !== -1) return idx;
  }
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
  let acctIdx = -1, addrIdx = -1, propIdx = -1, unitIdx = -1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNum++;
    const values = splitLine(line);

    if (lineNum === 1) {
      acctIdx = findCol(values, ['water_account_number', 'account_number', 'account number', 'account#', 'account #', 'water account', 'acct', 'account']);
      addrIdx = findCol(values, ['property_address', 'property address', 'address', 'street address', 'street', 'location', 'property']);
      propIdx = findCol(values, ['property_id', 'prop_id', 'property id', 'propid', 'id']);
      unitIdx = findCol(values, ['unit_id', 'unit id', 'unit', 'unitid']);

      if (acctIdx === -1) {
        console.error(`Cannot find water account number column. Headers found: ${values.join(', ')}`);
        console.error('Expected one of: water_account_number, account_number, Account #, Water Account, etc.');
        process.exit(1);
      }
      if (addrIdx === -1) {
        console.error(`Cannot find property address column. Headers found: ${values.join(', ')}`);
        console.error('Expected one of: property_address, address, street, location, etc.');
        process.exit(1);
      }

      console.log('Column mapping detected:');
      console.log(`  Water account number → "${values[acctIdx]}" (col ${acctIdx + 1})`);
      console.log(`  Property address     → "${values[addrIdx]}" (col ${addrIdx + 1})`);
      if (propIdx !== -1) console.log(`  Property ID          → "${values[propIdx]}" (col ${propIdx + 1})`);
      else console.log(`  Property ID          → (will look up by address)`);
      if (unitIdx !== -1) console.log(`  Unit ID              → "${values[unitIdx]}" (col ${unitIdx + 1})`);
      else console.log(`  Unit ID              → (will attempt lookup by unit name, NULL if not found)`);
      console.log();
      continue;
    }

    const acctNum = values[acctIdx]?.replace(/\s/g, '') ?? '';
    const addr    = values[addrIdx] ?? '';
    const rawProp = propIdx !== -1 ? values[propIdx] : '';
    const rawUnit = unitIdx !== -1 ? values[unitIdx] : '';

    if (!acctNum) {
      console.warn(`  Line ${lineNum + 1}: empty water account number — skipping.`);
      continue;
    }

    rows.push({
      water_account_number: acctNum,
      property_address:     addr,
      property_id:          rawProp ? Number(rawProp) : undefined,
      unit_id:              rawUnit ? Number(rawUnit) : undefined,
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

async function resolveUnitId(pool: Pool, unitName: string): Promise<number | null> {
  if (!unitName) return null;
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM unit
     WHERE unit_name ILIKE $1 OR appfolio_unit_id ILIKE $1
     LIMIT 1`,
    [unitName]
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
    ssl:      false,
  });

  let inserted = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    const { water_account_number: acctNum, property_address: addr } = row;
    let propId = row.property_id ?? null;
    let unitId = row.unit_id ?? null;

    if (!propId) {
      propId = await resolvePropertyId(pool, addr);
      if (propId === null) {
        console.warn(`  SKIP  ${acctNum}  — address not found in property table: "${addr}"`);
        skipped++;
        continue;
      }
    }

    if (unitId === null) {
      const unitHint = addr.split(',').slice(1).join(',').trim();
      if (unitHint) unitId = await resolveUnitId(pool, unitHint);
    }

    const unitLabel = unitId !== null ? `unit_id=${unitId}` : 'unit_id=NULL';
    console.log(`  ${DRY_RUN ? '[DRY]' : 'UPSERT'}  ${acctNum}  →  property_id=${propId}  ${unitLabel}  (${addr})`);

    if (!DRY_RUN) {
      try {
        const res = await pool.query(
          `INSERT INTO water_account_map
             (water_account_number, property_address, property_id, unit_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (water_account_number) DO UPDATE
             SET property_address = EXCLUDED.property_address,
                 property_id      = EXCLUDED.property_id,
                 unit_id          = EXCLUDED.unit_id`,
          [acctNum, addr, propId, unitId]
        );
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
    console.log('     Ask Abdul to add a property_id column to the spreadsheet,');
    console.log('     or confirm spelling matches what is in the DB.');
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
