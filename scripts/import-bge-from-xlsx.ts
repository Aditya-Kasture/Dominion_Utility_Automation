/**
 * Import BGE account-to-property mappings from QuickBooks Desktop Excel exports.
 *
 * Reads one or more .xlsx files (QuickBooks "Transaction List by Vendor" exports),
 * extracts unique BGE account numbers + property addresses from Bill rows,
 * and upserts them into bge_account_property_map so bge.spec.ts can use them.
 *
 * Usage:
 *   npx tsx scripts/import-bge-from-xlsx.ts [--dry-run]
 *   npx tsx scripts/import-bge-from-xlsx.ts --file "abdul - 1 .xlsx" --file "abdul -2.xlsx" [--dry-run]
 *   npx tsx scripts/import-bge-from-xlsx.ts --parse-only   (no DB connection — just print extracted accounts)
 *
 * Defaults to both Abdul QuickBooks files when no --file is specified.
 * Exit codes: 0 = success, 1 = fatal error
 */

import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── CLI args ────────────────────────────────────────────────────────────────

const DRY_RUN    = process.argv.includes('--dry-run');
const PARSE_ONLY = process.argv.includes('--parse-only');

const fileArgs: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--file' && process.argv[i + 1]) {
    fileArgs.push(process.argv[++i]);
  } else if (process.argv[i].startsWith('--file=')) {
    fileArgs.push(process.argv[i].slice(7));
  }
}

const DEFAULT_FILES = ['abdul - 1 .xlsx', 'abdul -2.xlsx'];
const inputFiles = fileArgs.length > 0 ? fileArgs : DEFAULT_FILES;

// ─── Types ───────────────────────────────────────────────────────────────────

interface BGEEntry {
  bge_account_number: string;
  property_address: string;
  source_file: string;
}

// ─── Excel parser ─────────────────────────────────────────────────────────────

function extractAccountNumber(num: string): string | null {
  // Num field format: "0285949611-04/23/20"  →  "0285949611"
  // Strip the trailing  -MM/DD/YY  date suffix added by QuickBooks
  const match = /^(.+?)-\d{2}\/\d{2}\/\d{2}$/.exec(num.trim());
  return match ? match[1].trim() : null;
}

function extractAddress(memo: string): string | null {
  let raw = memo.trim();

  // VOID entries: real address is after "VOID: <description> - <address> - ..."
  // e.g. "VOID: Void with JE 783 - 01011 Hunter St # F3 - Acc# 0040364116 - ..."
  if (/^void/i.test(raw)) {
    const parts = raw.split(' - ');
    // parts[0] = "VOID: ...", parts[1] = real address (if present)
    raw = parts[1]?.trim() ?? '';
    if (!raw) return null;
  }

  // Standard split: take everything before the first " - "
  const sepIdx = raw.indexOf(' - ');
  let addr = sepIdx === -1 ? raw : raw.slice(0, sepIdx);

  // Strip trailing " {digits}-{date}(-{date})" with no space before the dash
  // e.g. "3162 Woodring Ave 2297825508-06/21/21-07/15/21"
  addr = addr.replace(/\s+\d{7,}-\d{2}\/\d{2}\/\d{2}(-\d{2}\/\d{2}\/\d{2})?$/, '');

  // Strip trailing " -{digits}" (space-dash-no-space account number)
  // e.g. "4504 Rehbaum Ave -1313677651"
  addr = addr.replace(/\s+-\d{7,}$/, '');

  // Strip trailing " {9-10 digit account number}" appended with a space
  // e.g. "00813 Wellington 1312045022"
  addr = addr.replace(/\s+\d{9,10}$/, '');

  return addr.trim() || null;
}

function parseXlsx(filePath: string): BGEEntry[] {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(absPath);
  const ws = wb.Sheets['Sheet1'];
  if (!ws) {
    console.warn(`  No "Sheet1" in ${path.basename(filePath)} — skipping.`);
    return [];
  }

  const rows: (string | number | null)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
  });

  // Locate the header row that contains Type, Num, Memo
  let typeIdx = -1, numIdx = -1, memoIdx = -1;
  let dataStartRow = -1;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map(c => (c != null ? String(c).trim() : ''));
    const tIdx = cells.indexOf('Type');
    const nIdx = cells.indexOf('Num');
    const mIdx = cells.indexOf('Memo');
    if (tIdx !== -1 && nIdx !== -1 && mIdx !== -1) {
      typeIdx = tIdx;
      numIdx  = nIdx;
      memoIdx = mIdx;
      dataStartRow = r + 1;
      break;
    }
  }

  if (dataStartRow === -1) {
    console.warn(`  Could not find header row in ${path.basename(filePath)} — skipping.`);
    return [];
  }

  const entries: BGEEntry[] = [];
  const seen = new Set<string>();

  for (let r = dataStartRow; r < rows.length; r++) {
    const row = rows[r];
    const type = row[typeIdx] != null ? String(row[typeIdx]).trim() : '';
    if (type !== 'Bill') continue;

    const numRaw  = row[numIdx]  != null ? String(row[numIdx]).trim()  : '';
    const memoRaw = row[memoIdx] != null ? String(row[memoIdx]).trim() : '';
    if (!numRaw || !memoRaw) continue;

    const acctNum = extractAccountNumber(numRaw);
    const address = extractAddress(memoRaw);
    if (!acctNum || !address) continue;

    // Deduplicate by account number within this file (keep first occurrence = earliest bill)
    if (seen.has(acctNum)) continue;
    seen.add(acctNum);

    entries.push({ bge_account_number: acctNum, property_address: address, source_file: path.basename(filePath) });
  }

  return entries;
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
  // Parse all xlsx files and merge. Later files override earlier ones for the
  // same account number (last-file-wins), so more recent QB exports take precedence.
  const entryMap = new Map<string, BGEEntry>();

  for (const file of inputFiles) {
    console.log(`\nParsing: ${file}`);
    const entries = parseXlsx(file);
    console.log(`  Found ${entries.length} unique BGE accounts.`);
    for (const e of entries) {
      const existing = entryMap.get(e.bge_account_number);
      if (existing) {
        console.warn(`  OVERRIDE  ${e.bge_account_number}: "${existing.property_address}" [${existing.source_file}] → "${e.property_address}" [${e.source_file}]`);
      }
      entryMap.set(e.bge_account_number, e);
    }
  }

  const allEntries = Array.from(entryMap.values());

  console.log(`\nTotal unique BGE accounts across all files: ${allEntries.length}`);

  if (PARSE_ONLY) {
    console.log('\n─── Extracted Accounts (--parse-only) ──────────────────────');
    for (const e of allEntries) {
      console.log(`  ${e.bge_account_number.padEnd(14)}  ${e.property_address.padEnd(40)}  [${e.source_file}]`);
    }
    console.log(`\n  ${allEntries.length} accounts extracted. Re-run without --parse-only to import into DB.`);
    return;
  }

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

  for (const entry of allEntries) {
    const { bge_account_number: acctNum, property_address: addr } = entry;

    const propId = await resolvePropertyId(pool, addr);
    if (propId === null) {
      console.warn(`  SKIP  ${acctNum}  — address not found in property table: "${addr}"`);
      skipped++;
      continue;
    }

    console.log(`  ${DRY_RUN ? '[DRY]' : 'UPSERT'}  ${acctNum}  →  property_id=${propId}  (${addr})`);

    if (!DRY_RUN) {
      try {
        await pool.query(
          `INSERT INTO bge_account_property_map
             (bge_account_number, property_address, property_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (bge_account_number) DO UPDATE
             SET property_address = EXCLUDED.property_address,
                 property_id      = EXCLUDED.property_id`,
          [acctNum, addr, propId]
        );
        inserted++;
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
    console.log('     Confirm spelling matches what is in the DB, or add a property_id column');
    console.log('     to the spreadsheet and use import:bge-mapping instead.');
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
