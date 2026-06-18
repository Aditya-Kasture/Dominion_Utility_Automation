/**
 * QuickBooks Company File CSV mapper.
 *
 * Usage (single file):
 *   npx tsx scripts/import-quickbooks.ts --file export.csv [--output mapped.csv]
 *
 * Usage (batch — all 12 QB Desktop company files at once):
 *   npx tsx scripts/import-quickbooks.ts --dir ./qb-exports [--output ./mapped]
 *
 * What it does:
 *   1. Reads one or more QuickBooks CSV exports (any version — IIF / Company File / Transaction List)
 *   2. Auto-detects QB column names and maps them to Dominion's internal schema
 *   3. Prints a field-mapping report for Jack to confirm
 *   4. In --dir mode, prints a cross-file schema consistency report so gaps
 *      across the 12 company files can be found before the pipeline is designed
 *   5. Optionally writes normalized CSV(s) for downstream DB import
 *
 * Exit codes: 0 = success, 1 = fatal error
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── CLI args ────────────────────────────────────────────────────────────────

const fileIdx  = process.argv.indexOf('--file');
const dirIdx   = process.argv.indexOf('--dir');
const outIdx   = process.argv.indexOf('--output');

const fileArg = process.argv.find(a => a.startsWith('--file='))?.slice(7)
  ?? (fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined);
const dirArg = process.argv.find(a => a.startsWith('--dir='))?.slice(6)
  ?? (dirIdx !== -1 ? process.argv[dirIdx + 1] : undefined);
const outputArg = process.argv.find(a => a.startsWith('--output='))?.slice(9)
  ?? (outIdx !== -1 ? process.argv[outIdx + 1] : undefined);

if (!fileArg && !dirArg) {
  console.error('Usage:');
  console.error('  Single file: npx tsx scripts/import-quickbooks.ts --file <export.csv> [--output <mapped.csv>]');
  console.error('  Batch:       npx tsx scripts/import-quickbooks.ts --dir <folder>       [--output <out-folder>]');
  process.exit(1);
}

// ─── Field map: internal schema → QB column aliases (priority order) ─────────

const FIELD_MAP: Record<string, string[]> = {
  transaction_date: [
    'date', 'txn date', 'transaction date', 'posting date', 'invoice date', 'bill date',
  ],
  ref_number: [
    'num', 'ref no', 'ref #', 'reference no', 'reference #', 'check no', 'check #',
    'invoice no', 'invoice #', 'transaction #', 'trans no',
  ],
  description: [
    'description', 'memo', 'name', 'payee', 'vendor', 'customer', 'item description',
    'narration', 'particulars',
  ],
  account: [
    'account', 'account name', 'gl account', 'general ledger', 'chart of accounts',
    'expense account', 'income account', 'balance sheet account',
  ],
  amount: [
    'amount', 'debit', 'credit', 'total', 'net amount', 'balance', 'original amount',
    'foreign amount',
  ],
  transaction_type: [
    'type', 'transaction type', 'txn type', 'document type', 'entry type',
  ],
  property_address: [
    'class', 'location', 'job', 'customer:job', 'project', 'property', 'site',
    'department', 'division',
  ],
  utility_vendor: [
    'vendor', 'supplier', 'payee', 'paid to', 'billed by',
  ],
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface QBRow {
  transaction_date: string;
  ref_number: string;
  description: string;
  account: string;
  amount: string;
  transaction_type: string;
  property_address: string;
  utility_vendor: string;
  _raw: Record<string, string>;
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

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

function detectMapping(headers: string[]): Record<string, string | null> {
  const normHeaders = headers.map(norm);
  const detected: Record<string, string | null> = {};

  for (const [field, candidates] of Object.entries(FIELD_MAP)) {
    detected[field] = null;
    for (const candidate of candidates) {
      const idx = normHeaders.indexOf(norm(candidate));
      if (idx !== -1) { detected[field] = headers[idx]; break; }
    }
    if (!detected[field]) {
      for (const candidate of candidates) {
        const idx = normHeaders.findIndex(h => h.includes(norm(candidate)));
        if (idx !== -1) { detected[field] = headers[idx]; break; }
      }
    }
  }

  return detected;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

async function parseCsv(filePath: string): Promise<{
  headers: string[];
  rows: QBRow[];
  mapping: Record<string, string | null>;
  skippedLines: number;
}> {
  const rl = createInterface({ input: fs.createReadStream(filePath) });
  let headers: string[] = [];
  let mapping: Record<string, string | null> = {};
  const rawRows: Record<string, string>[] = [];
  let lineNum = 0;
  let skippedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) { skippedLines++; continue; }
    if (line.startsWith('!') || line === 'ENDTRNS') { skippedLines++; continue; }

    lineNum++;
    const values = splitLine(line);

    if (lineNum === 1) {
      headers = values;
      mapping = detectMapping(headers);
      continue;
    }

    if (!values[0] || values[0].toUpperCase().startsWith('TOTAL')) { skippedLines++; continue; }

    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    rawRows.push(row);
  }

  const rows: QBRow[] = rawRows.map(raw => ({
    transaction_date: raw[mapping.transaction_date ?? ''] ?? '',
    ref_number:       raw[mapping.ref_number ?? ''] ?? '',
    description:      raw[mapping.description ?? ''] ?? '',
    account:          raw[mapping.account ?? ''] ?? '',
    amount:           raw[mapping.amount ?? ''] ?? '',
    transaction_type: raw[mapping.transaction_type ?? ''] ?? '',
    property_address: raw[mapping.property_address ?? ''] ?? '',
    utility_vendor:   raw[mapping.utility_vendor ?? ''] ?? '',
    _raw: raw,
  }));

  return { headers, rows, mapping, skippedLines };
}

// ─── Per-file report ──────────────────────────────────────────────────────────

function printReport(
  filePath: string,
  headers: string[],
  mapping: Record<string, string | null>,
  rows: QBRow[],
  skippedLines: number
) {
  console.log('─── QuickBooks CSV Field Mapping Report ────────────────────────────────\n');
  console.log(`  Source file:   ${filePath}`);
  console.log(`  Total rows:    ${rows.length}`);
  console.log(`  Skipped lines: ${skippedLines}  (blanks, totals, IIF markers)\n`);

  const mapped   = Object.entries(mapping).filter(([, v]) => v !== null);
  const unmapped = Object.entries(mapping).filter(([, v]) => v === null);

  console.log('  Dominion field          QB source column');
  console.log('  ' + '─'.repeat(56));
  for (const [field, src] of mapped) {
    console.log(`  ✓  ${field.padEnd(22)} ← "${src}"`);
  }
  for (const [field] of unmapped) {
    console.log(`  ✗  ${field.padEnd(22)} ← (NOT FOUND — see note below)`);
  }

  const extraHeaders = headers.filter(h => !Object.values(mapping).includes(h));
  if (extraHeaders.length > 0) {
    console.log(`\n  Unused QB columns (${extraHeaders.length}):`);
    extraHeaders.forEach(h => console.log(`     · ${h}`));
  }

  if (rows.length > 0) {
    const sample = rows.slice(0, 5);
    console.log('\n  Sample rows (first 5):\n');
    console.log('  Date           Ref        Description                   Amount       Property');
    console.log('  ' + '─'.repeat(85));
    for (const r of sample) {
      const d = r.transaction_date.padEnd(14);
      const ref = r.ref_number.substring(0, 9).padEnd(10);
      const desc = r.description.substring(0, 28).padEnd(28);
      const amt = r.amount.padEnd(12);
      const prop = r.property_address.substring(0, 20);
      console.log(`  ${d} ${ref} ${desc} ${amt} ${prop}`);
    }
  }

  if (unmapped.length > 0) {
    console.log(`\n  ⚠  ${unmapped.length} field(s) could not be auto-mapped:`);
    for (const [field] of unmapped) {
      console.log(`     · ${field}`);
      console.log(`       Expected QB column names: ${FIELD_MAP[field].slice(0, 4).join(', ')}, ...`);
    }
  } else {
    console.log('\n  ✓  All fields mapped. Review sample rows, then run with --output to export.');
  }
}

// ─── Cross-file schema consistency report ────────────────────────────────────

function printSchemaReport(
  fileNames: string[],
  mappings: Record<string, string | null>[]
) {
  const fields = Object.keys(FIELD_MAP);
  const colWidth = 22;
  const fileColWidth = 12;

  console.log('\n═══ Cross-File Schema Consistency Report ═══════════════════════════════\n');
  console.log(`  Comparing ${fileNames.length} QB Desktop company files across ${fields.length} fields.\n`);

  // Header row
  const headerCols = fileNames.map(f => path.basename(f, '.csv').substring(0, fileColWidth - 1).padEnd(fileColWidth));
  console.log('  ' + 'Field'.padEnd(colWidth) + '| ' + headerCols.join('| ') + '| Consistency');
  console.log('  ' + '─'.repeat(colWidth) + '+' + fileNames.map(() => '─'.repeat(fileColWidth + 1)).join('+') + '+─────────────');

  const gapFields: string[] = [];

  for (const field of fields) {
    const cells = mappings.map(m => m[field] !== null ? '✓' : '✗');
    const mappedCount = cells.filter(c => c === '✓').length;
    const consistency = mappedCount === fileNames.length
      ? '✓ All files'
      : mappedCount === 0
        ? '✗ None'
        : `⚠ ${mappedCount}/${fileNames.length}`;

    if (mappedCount < fileNames.length) gapFields.push(field);

    const cellCols = cells.map(c => c.padEnd(fileColWidth));
    console.log('  ' + field.padEnd(colWidth) + '| ' + cellCols.join('| ') + '| ' + consistency);
  }

  console.log('  ' + '─'.repeat(colWidth) + '+' + fileNames.map(() => '─'.repeat(fileColWidth + 1)).join('+') + '+─────────────');

  const fullyCovered = fields.length - gapFields.length;
  console.log(`\n  Summary: ${fullyCovered}/${fields.length} fields consistent across all files.`);

  if (gapFields.length > 0) {
    console.log(`\n  ⚠  Fields with inconsistent coverage — must resolve before building the pipeline:`);
    for (const f of gapFields) {
      const covered = mappings.filter(m => m[f] !== null).length;
      console.log(`     · ${f}  (found in ${covered}/${fileNames.length} files)`);
    }
    console.log('\n  → Send this report to Jack. Ask which column name each file uses for the missing fields,');
    console.log('    then add those column aliases to FIELD_MAP in this script and re-run.');
  } else {
    console.log('\n  ✓  All fields mapped consistently across all files. Safe to build the pipeline schema.');
  }
}

// ─── CSV writer ───────────────────────────────────────────────────────────────

function writeMappedCsv(outputPath: string, rows: QBRow[]) {
  const fields: (keyof QBRow)[] = [
    'transaction_date', 'ref_number', 'description', 'account',
    'amount', 'transaction_type', 'property_address', 'utility_vendor',
  ];
  const escape = (v: string) => (v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push(fields.map(f => escape(row[f] as string ?? '')).join(','));
  }
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log(`\n  Normalized CSV → ${outputPath}`);
}

// ─── Batch mode ───────────────────────────────────────────────────────────────

async function runBatch(dirPath: string) {
  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exit(1);
  }

  const csvFiles = fs.readdirSync(absDir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => path.join(absDir, f))
    .sort();

  if (csvFiles.length === 0) {
    console.warn(`No .csv files found in: ${absDir}`);
    process.exit(0);
  }

  console.log(`Found ${csvFiles.length} CSV file(s) in: ${absDir}\n`);

  const allMappings: Record<string, string | null>[] = [];

  for (const csvPath of csvFiles) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  Processing: ${path.basename(csvPath)}`);
    console.log('═'.repeat(72));

    const { headers, rows, mapping, skippedLines } = await parseCsv(csvPath);
    allMappings.push(mapping);
    printReport(csvPath, headers, mapping, rows, skippedLines);

    if (outputArg) {
      fs.mkdirSync(path.resolve(outputArg), { recursive: true });
      const outName = path.basename(csvPath, '.csv') + '_mapped.csv';
      const outPath = path.join(path.resolve(outputArg), outName);
      writeMappedCsv(outPath, rows);
    }
  }

  printSchemaReport(csvFiles, allMappings);
}

// ─── Single-file mode ─────────────────────────────────────────────────────────

async function run() {
  const csvPath = path.resolve(fileArg!);
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  const { headers, rows, mapping, skippedLines } = await parseCsv(csvPath);
  printReport(csvPath, headers, mapping, rows, skippedLines);

  if (outputArg) {
    writeMappedCsv(path.resolve(outputArg), rows);
  } else if (rows.length > 0) {
    const missing = Object.entries(mapping).filter(([, v]) => v === null);
    if (missing.length === 0) {
      console.log('\n  Ready to export. Re-run with --output mapped.csv to write the normalized file.');
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(dirArg ? runBatch(dirArg) : run()).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
