/**
 * Match unmatched water_account_map rows to hub.property — deterministic, no LLM.
 *
 * Normalises both sides (strip city/state/zip, lowercase, strip unit suffix,
 * strip apostrophes, strip street type, squash whitespace) and compares the
 * proper street name (after skipping house number + directional N/S/E/W).
 *
 * Handles multi-unit buildings: when a water account address matches multiple
 * candidates that differ only by unit suffix (#A, #B, ...), picks the first.
 *
 *   npm run match:water-gemini
 *
 * Already-matched rows are not touched. To redo a wrong match, NULL its
 * property_id manually first.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

interface WaterRow {
  water_account_number: string;
  property_address: string;
}

interface HubProperty {
  id: number;
  street1: string;
}

// ─── Address normalisation ───────────────────────────────────────────────────

const STREET_TYPE_RE =
  /\s+(ter|terrace|ave|avenue|av|st|street|str|rd|road|dr|drive|driveway|ln|lane|blvd|boulevard|ct|court|pl|place|pkwy|parkway|sq|square|cir|circle|way|ridge|run|cove|crossing|crse|hwy|highway|trl|trail|expressway|expy)\.?$/i;

function stripCityStateZip(s: string): string {
  // "2900 POPLAR TER Baltimore MD 21216-2832 USA" → "2900 POPLAR TER"
  return s.split(/\s+(Baltimore|BALTIMORE|baltimore|Owings\s*Mills|Brooklyn|Towson|Glen\s*Burnie)\b/i)[0].trim();
}

function stripUnitSuffix(s: string): string {
  return s
    .replace(/\s+#[\w\d\-/]+$/i, '')                                    // " #A", " #1B"
    .replace(/\s+(apt|apartment|unit|suite|ste)\.?\s+[\w\d\-]+\s*$/i, '') // " Apt 1A"
    .replace(/\s+\*\s*(apt|ps)\.?\s*[\w\d\-]+\s*$/i, '')                 // " *Apt T4", " *Ps"
    .trim();
}

function normaliseAddress(addr: string): string {
  return stripUnitSuffix(stripCityStateZip(addr))
    .toLowerCase()
    .replace(/['']/g, '')          // strip apostrophes
    .replace(/[.,]/g, '')          // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function stripStreetType(s: string): string {
  return s.replace(STREET_TYPE_RE, '').trim();
}

/**
 * Returns the "proper name" of the street (the part after house number and
 * directional prefix). Used to compare two addresses that may have different
 * street type abbreviations.
 *
 *   "1025 n carey st"     → "carey"
 *   "5532 midwood ave"    → "midwood"
 *   "600 e 29th st"       → "29th"
 *   "4032 w cold spring"  → "cold spring"
 */
function properName(normalisedAddrNoType: string): string {
  const words = normalisedAddrNoType.split(/\s+/).filter(Boolean);
  let i = 0;
  if (i < words.length && /^\d/.test(words[i])) i++; // skip house number
  if (i < words.length && /^[nsew]$/.test(words[i])) i++; // skip directional N/S/E/W
  return words.slice(i).join(' ').replace(/\s+/g, '');  // squashed — "cold spring" → "coldspring"
}

function matchCandidate(waterAddr: string, candidates: HubProperty[]): { id: number; matched: string } | null {
  const waterNorm = normaliseAddress(waterAddr);
  const waterNoType = stripStreetType(waterNorm);
  const waterProper = properName(waterNoType);

  if (!waterProper) return null;

  // Pass 1: exact equality on the full normalised (with street type)
  for (const c of candidates) {
    if (normaliseAddress(c.street1) === waterNorm) return { id: c.id, matched: c.street1 };
  }

  // Pass 2: equality on the no-street-type normalised form
  for (const c of candidates) {
    if (stripStreetType(normaliseAddress(c.street1)) === waterNoType) return { id: c.id, matched: c.street1 };
  }

  // Pass 3: proper-name comparison (handles unit suffixes, "Cold Spring" vs "Coldspring", etc.)
  for (const c of candidates) {
    const candProper = properName(stripStreetType(normaliseAddress(c.street1)));
    if (candProper && candProper === waterProper) return { id: c.id, matched: c.street1 };
  }

  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function extractHouseNumber(addr: string): string | null {
  const m = addr.trim().match(/^(\d+(?:-\d+)?(?:\s*\d+\/\d+)?)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

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
    const unmatched = await pool.query<WaterRow>(`
      SELECT water_account_number, property_address
      FROM public.water_account_map
      WHERE property_id IS NULL
        AND property_address IS NOT NULL
        AND property_address != ''
        AND property_address !~* '^shared$'
      ORDER BY water_account_number
    `);

    console.log(`Found ${unmatched.rows.length} unmatched water_account_map rows to process.\n`);
    if (unmatched.rows.length === 0) return;

    let matched = 0, skipped = 0;
    const skippedList: { water_account_number: string; street: string; reason: string }[] = [];

    for (const row of unmatched.rows) {
      const street = stripCityStateZip(row.property_address);
      const houseNum = extractHouseNumber(street);
      if (!houseNum) {
        console.log(`  ${row.water_account_number}  ${street.padEnd(35)}  ✗ no house number`);
        skipped++;
        skippedList.push({ water_account_number: row.water_account_number, street, reason: 'no house number' });
        continue;
      }

      // Pull candidates — any hub.property with the same house number prefix
      const candRes = await pool.query<HubProperty>(
        `SELECT id, street1 FROM hub.property WHERE street1 ILIKE $1 ORDER BY street1 LIMIT 20`,
        [`${houseNum} %`]
      );
      if (candRes.rows.length === 0) {
        console.log(`  ${row.water_account_number}  ${street.padEnd(35)}  ✗ no hub.property with house# "${houseNum}"`);
        skipped++;
        skippedList.push({ water_account_number: row.water_account_number, street, reason: `no candidates for house# ${houseNum}` });
        continue;
      }

      const match = matchCandidate(row.property_address, candRes.rows);

      if (match === null) {
        const cands = candRes.rows.map(c => `id=${c.id} "${c.street1}"`).join(', ');
        console.log(`  ${row.water_account_number}  ${street.padEnd(35)}  ✗ street name mismatch`);
        console.log(`       candidates: ${cands}`);
        skipped++;
        skippedList.push({ water_account_number: row.water_account_number, street, reason: `street name mismatch — candidates: ${cands}` });
        continue;
      }

      try {
        await pool.query(
          `UPDATE public.water_account_map SET property_id = $1 WHERE water_account_number = $2 AND property_id IS NULL`,
          [match.id, row.water_account_number]
        );
        console.log(`  ${row.water_account_number}  ${street.padEnd(35)}  → id=${match.id} "${match.matched}"`);
        matched++;
      } catch (err: any) {
        console.error(`  ${row.water_account_number}  UPDATE failed: ${err.message}`);
      }
    }

    console.log(`\n─── Summary ───────────────────────────────────`);
    console.log(`  Processed:               ${unmatched.rows.length}`);
    console.log(`  Matched deterministically: ${matched}`);
    console.log(`  Skipped (real gaps):     ${skipped}`);

    if (skippedList.length > 0) {
      console.log(`\n${skippedList.length} addresses still need manual review:`);
      for (const s of skippedList) {
        console.log(`  ${s.water_account_number}  ${s.street}`);
        console.log(`     reason: ${s.reason}`);
      }
    }
  } finally {
    await pool.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal:', err.message ?? err); process.exit(1); });
