/**
 * Load BGE accounts from the unique-addresses CSV produced by
 * scripts/extract-unique-addresses.ts, and write per-account run results
 * back to a sibling results CSV.
 *
 * Input CSV columns (in order):
 *   property_address, bge_account_numbers, entity, qb_account_no, sources
 *
 * Output CSV columns:
 *   property_address, bge_account_number, entity, qb_account_no, sources,
 *   last_paperless_status, last_bill_amount, last_due_date, last_run_at, last_error
 *
 * Multi-account rows (bge_account_numbers contains "; ") expand into one
 * output row per BGE account. Addresses with no BGE account # are kept
 * in the output (empty result columns) so the file remains a complete
 * inventory.
 */

import fs from 'fs';
import type { BGEAccount } from './db';

export interface BGEAddressRow {
  property_address: string;
  bge_account_numbers: string;   // raw "; "-separated list as in source CSV
  entity: string;
  qb_account_no: string;
  sources: string;
}

export interface BGERunResult {
  last_paperless_status: string; // SUCCESS | FAILED | SKIPPED | ''
  last_bill_amount: string;
  last_due_date: string;
  last_run_at: string;
  last_error: string;
}

export interface LoadResult {
  accounts: BGEAccount[];
  allRows: BGEAddressRow[];
  rowsWithoutAccount: number;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadBGEAddressesFromCsv(csvPath: string): LoadResult {
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `BGE addresses CSV not found: ${csvPath}\n` +
      `Run \`npx tsx scripts/extract-unique-addresses.ts\` to generate it.`
    );
  }

  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) {
    throw new Error(`BGE addresses CSV is empty: ${csvPath}`);
  }

  const header = splitCsvLine(lines[0]);
  const idx = {
    address: header.indexOf('property_address'),
    accts:   header.indexOf('bge_account_numbers'),
    entity:  header.indexOf('entity'),
    qb:      header.indexOf('qb_account_no'),
    sources: header.indexOf('sources'),
  };
  if (idx.address === -1 || idx.accts === -1) {
    throw new Error(
      `BGE addresses CSV missing required columns. Got: ${header.join(', ')}\n` +
      `Need: property_address, bge_account_numbers (at minimum)`
    );
  }

  const accounts: BGEAccount[] = [];
  const allRows: BGEAddressRow[] = [];
  let rowsWithoutAccount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: BGEAddressRow = {
      property_address:    cells[idx.address] ?? '',
      bge_account_numbers: cells[idx.accts] ?? '',
      entity:              idx.entity  !== -1 ? (cells[idx.entity]  ?? '') : '',
      qb_account_no:       idx.qb      !== -1 ? (cells[idx.qb]      ?? '') : '',
      sources:             idx.sources !== -1 ? (cells[idx.sources] ?? '') : '',
    };
    allRows.push(row);

    const acctNums = row.bge_account_numbers
      .split(/;\s*/)
      .map(s => s.trim())
      .filter(Boolean);

    if (acctNums.length === 0) { rowsWithoutAccount++; continue; }

    for (const acctNum of acctNums) {
      accounts.push({
        bge_account_number: acctNum,
        property_address:   row.property_address,
        property_id:        null,
        property_name:      row.entity || row.property_address,
        lifecycle_stage:    '',
        street1:            row.property_address,
        city:               '',
        state:              '',
        zip:                '',
      });
    }
  }

  return { accounts, allRows, rowsWithoutAccount };
}

// ─── Writer ───────────────────────────────────────────────────────────────────

const OUTPUT_HEADER = [
  'property_address', 'bge_account_number', 'entity', 'qb_account_no', 'sources',
  'last_paperless_status', 'last_bill_amount', 'last_due_date', 'last_run_at', 'last_error',
];

export function writeBGEResults(
  csvPath: string,
  allRows: BGEAddressRow[],
  results: Map<string, BGERunResult>
): void {
  const lines: string[] = [OUTPUT_HEADER.join(',')];

  for (const row of allRows) {
    const acctNums = row.bge_account_numbers
      .split(/;\s*/)
      .map(s => s.trim())
      .filter(Boolean);
    const keys = acctNums.length > 0 ? acctNums : [''];

    for (const acctNum of keys) {
      const r = acctNum ? results.get(acctNum) : undefined;
      lines.push([
        csvEscape(row.property_address),
        csvEscape(acctNum),
        csvEscape(row.entity),
        csvEscape(row.qb_account_no),
        csvEscape(row.sources),
        csvEscape(r?.last_paperless_status ?? ''),
        csvEscape(r?.last_bill_amount     ?? ''),
        csvEscape(r?.last_due_date        ?? ''),
        csvEscape(r?.last_run_at          ?? ''),
        csvEscape(r?.last_error           ?? ''),
      ].join(','));
    }
  }

  fs.mkdirSync(require('path').dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, lines.join('\n') + '\n', 'utf8');
}
