/**
 * Build a master CSV of every unique Dominion property address across:
 *   1. fixed_assets_consolidated.xlsx  → "Address Duplicate Check" sheet
 *   2. abdul - 1 .xlsx                 → Bill rows (QuickBooks Memo field)
 *   3. abdul -2.xlsx                   → Bill rows (QuickBooks Memo field)
 *
 * Dedup mode: AGGRESSIVE
 *   - case-insensitive
 *   - leading zeros stripped from house numbers ("00033" == "33")
 *   - street-type abbreviations normalised (Ave/Avenue, St/Street, Rd/Road, etc.)
 *   - apt/unit/# suffixes ignored for the dedup key (but kept on the displayed address)
 *
 * Output: cache/all-dominion-addresses.csv
 *   property_address, bge_account_numbers, entity, qb_account_no, sources
 *
 * Usage:
 *   npx tsx scripts/extract-unique-addresses.ts
 */

import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT  = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..', '..');   // f:/Xandec/dominiongroup/bge portal

const FIXED_ASSETS_FILE = path.join(WORKSPACE_ROOT, 'fixed_assets_consolidated.xlsx');
const ABDUL_FILES = [
  path.join(PROJECT_ROOT, 'abdul - 1 .xlsx'),
  path.join(PROJECT_ROOT, 'abdul -2.xlsx'),
];

const OUTPUT_CSV = path.join(PROJECT_ROOT, 'cache', 'all-dominion-addresses.csv');

// ─── Types ────────────────────────────────────────────────────────────────────

interface AddressEntry {
  display: string;
  bge_account_numbers: Set<string>;
  entities: Set<string>;
  qb_account_nos: Set<string>;
  sources: Set<string>;
}

// ─── Aggressive address normalisation (used for dedup key only) ───────────────

const STREET_TYPES: Record<string, string> = {
  ave: 'ave', avenue: 'ave',
  st: 'st', street: 'st',
  rd: 'rd', road: 'rd',
  dr: 'dr', drive: 'dr',
  ln: 'ln', lane: 'ln',
  pl: 'pl', place: 'pl',
  ct: 'ct', court: 'ct',
  cir: 'cir', circle: 'cir',
  blvd: 'blvd', boulevard: 'blvd',
  pkwy: 'pkwy', parkway: 'pkwy',
  hwy: 'hwy', highway: 'hwy',
  ter: 'ter', terrace: 'ter',
  way: 'way',
  trl: 'trl', trail: 'trl',
};

function normaliseForKey(addr: string): string {
  let s = addr.toLowerCase().trim();

  // Drop apt/unit/suite/# suffixes (anything after a # or " apt " / " unit " / " ste ")
  s = s.replace(/\s+#\s*[\w\d\-]+.*$/i, '');
  s = s.replace(/\s+(apt|apartment|unit|suite|ste|condo)\.?\s*[\w\d\-]+.*$/i, '');

  // Strip any 9-11 digit number embedded anywhere in the address — these are
  // residual BGE account numbers that survived the Memo parser.
  // (Real house numbers are 1-6 digits.)
  s = s.replace(/\s+\d{9,11}\b/g, '');

  // Collapse punctuation that varies between sources
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/[-_]/g, ' ');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Strip leading zeros from the very first numeric token (the house number).
  // "00033 mitchell ave" → "33 mitchell ave"
  s = s.replace(/^0+(\d)/, '$1');

  // Drop compass-direction tokens (n / s / e / w / nw / ne / sw / se) so
  // "136 culver st" and "136 n culver st" collapse to the same key.
  // This is aggressive — if there really are two streets in the same city
  // that differ only by compass direction, they'll collide.
  const parts = s.split(' ').filter(t => !/^(n|s|e|w|nw|ne|sw|se)$/.test(t));

  // Normalise the street type if it's the last word.
  const last = parts[parts.length - 1];
  if (last && STREET_TYPES[last]) {
    parts[parts.length - 1] = STREET_TYPES[last];
  }
  s = parts.join(' ');

  return s;
}

// ─── Display-address cleanup (kept human-readable) ────────────────────────────

function cleanDisplay(addr: string): string {
  let s = addr.replace(/\s+/g, ' ').trim();
  // Strip residual BGE-account-number tokens (9-11 digits) and a trailing
  // bare "-" left over after the Memo parser. e.g.
  //   "00813 Wellington 1312045022"  → "00813 Wellington"
  //   "00010 E Lee St #2003-"        → "00010 E Lee St #2003"
  s = s.replace(/\s+\d{9,11}\b/g, '');
  s = s.replace(/-\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Within a single address row, collapse BGE account numbers that differ only
 * by a leading or trailing zero (likely typos in QB). Keeps the 10-digit form
 * when there's a 9-digit variant. Numbers with no zero-variant pair are kept
 * as-is, including the 11-digit ones.
 */
function dedupBgeAccountsByZeroPad(nums: Set<string>): string[] {
  const list = Array.from(nums);
  const drop = new Set<string>();
  for (const a of list) {
    if (drop.has(a)) continue;
    for (const b of list) {
      if (a === b || drop.has(b)) continue;
      // a is the longer; b is the shorter
      const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
      if (longer.length !== shorter.length + 1) continue;
      const sameWithLeadingZero  = longer === '0' + shorter;
      const sameWithTrailingZero = longer === shorter + '0';
      if (sameWithLeadingZero || sameWithTrailingZero) {
        drop.add(shorter);
      }
    }
  }
  return list.filter(n => !drop.has(n)).sort();
}

/** Picks the "better" display address between two variants of the same property.
 *  Prefer the one with an apt/unit suffix (more specific). Otherwise the shorter,
 *  cleaner one. */
function pickDisplay(a: string, b: string): string {
  const aHasUnit = /#|apt|unit|suite|ste|condo/i.test(a);
  const bHasUnit = /#|apt|unit|suite|ste|condo/i.test(b);
  if (aHasUnit && !bHasUnit) return a;
  if (bHasUnit && !aHasUnit) return b;
  return a.length <= b.length ? a : b;
}

// ─── Source 1: fixed_assets_consolidated.xlsx ─────────────────────────────────

interface FixedAssetEntry {
  address: string;
  entity: string;
  qb_account_no: string;
}

function parseFixedAssets(filePath: string): FixedAssetEntry[] {
  if (!fs.existsSync(filePath)) {
    console.error(`Fixed assets file not found: ${filePath}`);
    process.exit(1);
  }
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Address Duplicate Check'];
  if (!ws) {
    console.error(`Sheet "Address Duplicate Check" not found in ${path.basename(filePath)}.`);
    process.exit(1);
  }
  const rows: (string | number | null)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1, defval: null,
  });

  // Header row: Description / Address | Entity | Account # | Parent Category | Sub-Group | # Entities with same address
  // Data starts at row 1.
  const entries: FixedAssetEntry[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const address = row[0] != null ? String(row[0]).trim() : '';
    const entity  = row[1] != null ? String(row[1]).trim() : '';
    const acctNo  = row[2] != null ? String(row[2]).trim() : '';
    if (!address) continue;
    entries.push({ address, entity, qb_account_no: acctNo });
  }
  return entries;
}

// ─── Source 2 & 3: abdul .xlsx files (QuickBooks Bill rows) ───────────────────

interface AbdulEntry {
  address: string;
  bge_account_number: string;
}

function extractAccountNumber(num: string): string | null {
  const match = /^(.+?)-\d{2}\/\d{2}\/\d{2}$/.exec(num.trim());
  return match ? match[1].trim() : null;
}

function extractAddress(memo: string): string | null {
  let raw = memo.trim();
  if (/^void/i.test(raw)) {
    const parts = raw.split(' - ');
    raw = parts[1]?.trim() ?? '';
    if (!raw) return null;
  }
  const sepIdx = raw.indexOf(' - ');
  let addr = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
  addr = addr.replace(/\s+\d{7,}-\d{2}\/\d{2}\/\d{2}(-\d{2}\/\d{2}\/\d{2})?$/, '');
  addr = addr.replace(/\s+-\d{7,}$/, '');
  addr = addr.replace(/\s+\d{9,10}$/, '');
  return addr.trim() || null;
}

function parseAbdul(filePath: string): AbdulEntry[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`  File not found, skipping: ${filePath}`);
    return [];
  }
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Sheet1'];
  if (!ws) return [];
  const rows: (string | number | null)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1, defval: null,
  });

  let typeIdx = -1, numIdx = -1, memoIdx = -1, dataStartRow = -1;
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map(c => (c != null ? String(c).trim() : ''));
    const tIdx = cells.indexOf('Type');
    const nIdx = cells.indexOf('Num');
    const mIdx = cells.indexOf('Memo');
    if (tIdx !== -1 && nIdx !== -1 && mIdx !== -1) {
      typeIdx = tIdx; numIdx = nIdx; memoIdx = mIdx; dataStartRow = r + 1; break;
    }
  }
  if (dataStartRow === -1) return [];

  const entries: AbdulEntry[] = [];
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
    entries.push({ address, bge_account_number: acctNum });
  }
  return entries;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function run(): void {
  const merged = new Map<string, AddressEntry>();

  // Source 1: fixed assets
  console.log(`Reading fixed assets: ${path.basename(FIXED_ASSETS_FILE)}`);
  const fixed = parseFixedAssets(FIXED_ASSETS_FILE);
  console.log(`  ${fixed.length} address rows from "Address Duplicate Check" sheet.`);
  for (const fe of fixed) {
    const key = normaliseForKey(fe.address);
    if (!key) continue;
    const display = cleanDisplay(fe.address);
    const existing = merged.get(key);
    if (existing) {
      existing.display = pickDisplay(existing.display, display);
      if (fe.entity)        existing.entities.add(fe.entity);
      if (fe.qb_account_no) existing.qb_account_nos.add(fe.qb_account_no);
      existing.sources.add('fixed_assets');
    } else {
      merged.set(key, {
        display,
        bge_account_numbers: new Set<string>(),
        entities:            new Set<string>(fe.entity ? [fe.entity] : []),
        qb_account_nos:      new Set<string>(fe.qb_account_no ? [fe.qb_account_no] : []),
        sources:             new Set<string>(['fixed_assets']),
      });
    }
  }

  // Source 2 & 3: abdul files
  for (const file of ABDUL_FILES) {
    console.log(`Reading abdul file: ${path.basename(file)}`);
    const rows = parseAbdul(file);
    console.log(`  ${rows.length} Bill rows extracted.`);
    const tag = path.basename(file).toLowerCase().includes('-2') ? 'abdul-2' : 'abdul-1';
    for (const ae of rows) {
      const key = normaliseForKey(ae.address);
      if (!key) continue;
      const display = cleanDisplay(ae.address);
      const existing = merged.get(key);
      if (existing) {
        existing.display = pickDisplay(existing.display, display);
        existing.bge_account_numbers.add(ae.bge_account_number);
        existing.sources.add(tag);
      } else {
        merged.set(key, {
          display,
          bge_account_numbers: new Set<string>([ae.bge_account_number]),
          entities:            new Set<string>(),
          qb_account_nos:      new Set<string>(),
          sources:             new Set<string>([tag]),
        });
      }
    }
  }

  // ─── Write CSV ──────────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });

  const allEntries = Array.from(merged.values())
    .sort((a, b) => a.display.localeCompare(b.display));

  const header = ['property_address', 'bge_account_numbers', 'entity', 'qb_account_no', 'sources'].join(',');
  const lines: string[] = [header];
  for (const e of allEntries) {
    const bgeAccts = dedupBgeAccountsByZeroPad(e.bge_account_numbers);
    lines.push([
      csvEscape(e.display),
      csvEscape(bgeAccts.join('; ')),
      csvEscape(Array.from(e.entities).sort().join('; ')),
      csvEscape(Array.from(e.qb_account_nos).sort().join('; ')),
      csvEscape(Array.from(e.sources).sort().join('; ')),
    ].join(','));
  }
  fs.writeFileSync(OUTPUT_CSV, lines.join('\n') + '\n', 'utf8');

  // ─── Summary ────────────────────────────────────────────────────────────────
  const fromFixedOnly  = allEntries.filter(e => e.sources.has('fixed_assets') && !e.sources.has('abdul-1') && !e.sources.has('abdul-2')).length;
  const fromAbdulOnly  = allEntries.filter(e => !e.sources.has('fixed_assets') && (e.sources.has('abdul-1') || e.sources.has('abdul-2'))).length;
  const fromBoth       = allEntries.filter(e => e.sources.has('fixed_assets') && (e.sources.has('abdul-1') || e.sources.has('abdul-2'))).length;
  const withBgeNumber  = allEntries.filter(e => e.bge_account_numbers.size > 0).length;

  console.log('\n─── Summary ──────────────────────────────────────────────────');
  console.log(`  Total unique addresses:        ${allEntries.length}`);
  console.log(`    · In fixed_assets only:      ${fromFixedOnly}`);
  console.log(`    · In abdul files only:       ${fromAbdulOnly}`);
  console.log(`    · In both:                   ${fromBoth}`);
  console.log(`  Addresses with BGE account #:  ${withBgeNumber}  (the rest need BGE accounts looked up)`);
  console.log(`\n  Output written to: ${OUTPUT_CSV}`);
}

run();
