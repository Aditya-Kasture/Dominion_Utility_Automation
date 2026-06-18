/**
 * WS-1 — Property data sources & WS-2 handoff contract.
 *
 * Pulls the active property list (AppFolio: vacancy + utility-responsibility flags),
 * consumption baselines and Podio manual overrides, and assembles the single
 * structured payload that the Routing Logic Engine (WS-2) consumes.
 *
 * Source strategy (decided June 2026): NO direct AppFolio/Podio API integration.
 * All AppFolio and Podio data is synced into Abdul's PostgreSQL (schemas `hub`,
 * `appfolio`, `podio`) and read from there — the same joins proven in
 * db.ts::fetchWaterAccounts. The DB is the single source of truth for Phase 2.
 *
 * Field mappings are documented in docs/WS-1-orchestration.md.
 */
import { getPool } from './db';

// ─── WS-2 handoff contract ─────────────────────────────────────────────────────
// This is the stable interface WS-2 imports. Treat changes here as a contract change.

export type Responsibility = 'landlord' | 'dp' | 'included_in_rent' | 'tenant' | 'unknown';

/** Best-effort occupancy hint derived from AppFolio lifecycle_stage. The raw
 *  lifecycle_stage is always passed through too; WS-2 owns the final vacancy call. */
export type Occupancy = 'occupied' | 'vacant' | 'disposed' | 'unknown';

export interface PropertyAddress {
  street1: string;
  city: string;
  state: string;
  zip: string;
}

export interface WaterAccountRef {
  unit_id: number | null;     // null = property-level water account (no specific unit)
  unit_name: string;
  water_account_number: string | null;
}

export interface ConsumptionBaseline {
  unit_id: number;
  utility_type: string;     // 'water' | 'electric' | 'gas'
  period_unit: string;      // 'quarterly' | 'monthly' | ...
  baseline_amount: number | null;
  /** Occupancy-derived quarterly baseline (adults×adultQtr + children×childQtr); null until WS-1 wires Podio. */
  computed_quarterly_baseline?: number | null;
}

export interface ManualOverride {
  source: 'podio';
  field: string;
  value: string;
  note?: string;
}

export interface PropertyRoutingInput {
  property_id: number;
  property_name: string;
  address: PropertyAddress;
  lifecycle_stage: string;
  /** Derived hint only — confirm the lifecycle→occupancy mapping with Abdul. */
  occupancy: Occupancy;
  /** Property-level roll-up of unit responsibility, per utility. WS-2 makes the call. */
  responsibility: { bge: Responsibility; water: Responsibility };
  bge_accounts: string[];
  water_accounts: WaterAccountRef[];
  consumption_baselines: ConsumptionBaseline[];
  manual_overrides: ManualOverride[];
  // ── June 12 2026 additions (optional; nullable until upstream schemas confirmed) ──
  /** True when the property's BGE is a PS / common-area account (foyer/hallway
   *  lighting in a multi-unit building). PS accounts are landlord-paid; all other
   *  unit-level gas/electric is always the tenant's. Seeded from Jack's BGE list. */
  is_ps_account?: boolean | null;
  /** Podio "water billable" flag. Gates the cost-recovery LETTER verbiage only —
   *  water is always paid (lien) regardless. false = landlord-paid water. */
  water_billable?: boolean | null;
  /** Occupant counts (Podio) for expected-usage = adults×10 + children×5 per qtr. */
  occupant_adults?: number | null;
  occupant_children?: number | null;
}

export interface WS2Payload {
  run_id: string;
  generated_at: string;            // ISO 8601
  source: {
    appfolio: 'db' | 'api';
    podio: 'db' | 'api' | 'absent';
    quickbooks_csv_ingested: number;
  };
  property_count: number;
  properties: PropertyRoutingInput[];
}

// Utility types that mean "this property's electric/gas is billed through BGE".
// Live data uses 'bge'; 'electric'/'gas' are accepted defensively in case the
// taxonomy is split later.
const BGE_UTILITY_TYPES = ['bge', 'electric', 'gas'];

// ─── Raw query row shapes ───────────────────────────────────────────────────────

// NOTE on id types: hub.property.id / hub.unit.id are bigint — node-postgres
// returns them as strings. The public.*_map tables use int4 property_id/unit_id —
// returned as numbers. All join keys are therefore normalized via String() before
// comparison, and ids are coerced to Number only at the output boundary.
interface PropertyRow {
  id: string;
  name: string;
  lifecycle_stage: string | null;
  street1: string;
  city: string;
  state: string;
  zip: string;
}
interface UnitRow { unit_id: string; unit_name: string; property_id: string; }
interface RespRow { unit_id: string; property_id: string; utility_type: string; responsibility: string; }
interface BaselineRow { unit_id: string; property_id: string; utility_type: string; period_unit: string; baseline_amount: string | null; }
interface BgeMapRow { property_id: number; bge_account_number: string; is_ps_account: boolean; }
interface WaterMapRow { property_id: number; unit_id: number | null; water_account_number: string | null; }

/** Best-effort lifecycle_stage → occupancy. Mapping is an assumption to confirm
 *  with Abdul; the raw lifecycle_stage is always carried through alongside it. */
function deriveOccupancy(lifecycle_stage: string | null): Occupancy {
  const s = (lifecycle_stage || '').toLowerCase();
  if (s === 'active') return 'occupied';
  if (s === 'acquisition' || s === 'renovation' || s === 'rent_ready') return 'vacant';
  if (s === 'disposed') return 'disposed';
  return 'unknown';
}

/** Roll unit-level responsibilities up to a single per-utility verdict for the
 *  property, priority-ordered so any landlord-side obligation wins. */
function rollUp(values: string[]): Responsibility {
  if (values.length === 0) return 'unknown';
  if (values.includes('dp')) return 'dp';
  if (values.includes('landlord')) return 'landlord';
  if (values.includes('included_in_rent')) return 'included_in_rent';
  if (values.every(v => v === 'tenant')) return 'tenant';
  return 'unknown';
}

// ─── AppFolio: active properties + units + responsibility ───────────────────────

/**
 * Default DB-backed source for the active property list. Reads the same `hub` /
 * `public` tables Phase 1 uses. Returns everything WS-2 needs to route, minus
 * Podio overrides (fetched separately).
 */
export async function fetchActivePropertiesFromDb(): Promise<PropertyRoutingInput[]> {
  const pool = getPool();

  const [props, units, resp, baselines, bgeMap, waterMap] = await Promise.all([
    pool.query<PropertyRow>(`
      SELECT p.id, p.name, p.lifecycle_stage, p.street1, p.city, p.state, p.zip
      FROM hub.property p
      WHERE p.is_active = TRUE
      ORDER BY p.name`),
    pool.query<UnitRow>(`
      SELECT u.id AS unit_id, u.unit_name, u.property_id
      FROM hub.unit u
      JOIN hub.property p ON u.property_id = p.id
      WHERE p.is_active = TRUE`),
    pool.query<RespRow>(`
      SELECT uur.unit_id, u.property_id, uur.utility_type, uur.responsibility
      FROM hub.unit_utility_responsibility uur
      JOIN hub.unit u     ON uur.unit_id = u.id
      JOIN hub.property p ON u.property_id = p.id
      WHERE p.is_active = TRUE`),
    pool.query<BaselineRow>(`
      SELECT ucb.unit_id, u.property_id, ucb.utility_type, ucb.period_unit, ucb.baseline_amount
      FROM hub.unit_consumption_baseline ucb
      JOIN hub.unit u     ON ucb.unit_id = u.id
      JOIN hub.property p ON u.property_id = p.id
      WHERE p.is_active = TRUE`),
    pool.query<BgeMapRow>(`
      SELECT property_id, bge_account_number, COALESCE(is_ps_account, FALSE) AS is_ps_account
      FROM public.bge_account_property_map
      WHERE property_id IS NOT NULL`),
    pool.query<WaterMapRow>(`
      SELECT property_id, unit_id, water_account_number
      FROM public.water_account_map
      WHERE property_id IS NOT NULL`),
  ]);

  // Index the child rows by property_id (string-normalized) for in-memory assembly.
  const unitsByProp = groupBy(units.rows, r => r.property_id);
  const respByProp = groupBy(resp.rows, r => r.property_id);
  const baseByProp = groupBy(baselines.rows, r => r.property_id);
  const bgeByProp = groupBy(bgeMap.rows, r => r.property_id);
  const waterByProp = groupBy(waterMap.rows, r => r.property_id);

  return props.rows.map<PropertyRoutingInput>(p => {
    const key = String(p.id);
    const propResp = respByProp.get(key) ?? [];
    const propUnits = unitsByProp.get(key) ?? [];
    const waterVerdicts = propResp.filter(r => r.utility_type === 'water').map(r => r.responsibility);
    const bgeVerdicts = propResp.filter(r => BGE_UTILITY_TYPES.includes(r.utility_type)).map(r => r.responsibility);

    return {
      property_id: Number(p.id),
      property_name: p.name,
      address: { street1: p.street1 ?? '', city: p.city ?? '', state: p.state ?? '', zip: p.zip ?? '' },
      lifecycle_stage: p.lifecycle_stage ?? '',
      occupancy: deriveOccupancy(p.lifecycle_stage),
      responsibility: { bge: rollUp(bgeVerdicts), water: rollUp(waterVerdicts) },
      is_ps_account: (bgeByProp.get(key) ?? []).some(r => r.is_ps_account === true),
      // TODO: wire Podio once column names confirmed (data spike).
      // null = "engine uses stored baseline / no letter suppression".
      water_billable: null,
      occupant_adults: null,
      occupant_children: null,
      bge_accounts: dedupe((bgeByProp.get(key) ?? []).map(r => r.bge_account_number)),
      water_accounts: (waterByProp.get(key) ?? []).map(r => ({
        // unit_id is nullable: a water account may map to the property as a whole.
        unit_id: r.unit_id == null ? null : Number(r.unit_id),
        unit_name: r.unit_id == null
          ? ''
          : propUnits.find(u => String(u.unit_id) === String(r.unit_id))?.unit_name ?? '',
        water_account_number: r.water_account_number,
      })),
      consumption_baselines: (baseByProp.get(key) ?? []).map(b => ({
        unit_id: Number(b.unit_id),
        utility_type: b.utility_type,
        period_unit: b.period_unit,
        baseline_amount: b.baseline_amount == null ? null : Number(b.baseline_amount),
      })),
      manual_overrides: [], // filled in by applyPodioOverrides()
    };
  });
}

// ─── Podio: manual overrides ────────────────────────────────────────────────────

/**
 * Podio manual overrides. The exact Podio table is not pinned down in Phase 1
 * (see scripts/check-podio*.ts), so this is deliberately defensive: it only runs
 * when PODIO_OVERRIDE_TABLE is configured AND the table exists, otherwise it
 * returns 'absent' and the run proceeds with no overrides (logged, not fatal).
 *
 * Expected table shape (configurable): a `title` column carrying the property
 * address/name, plus a free-text override column named by PODIO_OVERRIDE_FIELD.
 */
export async function fetchPodioOverrides(): Promise<{
  source: 'db' | 'absent';
  byTitle: Map<string, ManualOverride[]>;
}> {
  const table = process.env.PODIO_OVERRIDE_TABLE;
  const field = process.env.PODIO_OVERRIDE_FIELD ?? 'override';
  const empty = { source: 'absent' as const, byTitle: new Map<string, ManualOverride[]>() };
  if (!table) return empty;

  const pool = getPool();
  const exists = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'podio' AND table_name = $1 AND column_name = 'title'
     ) AS ok`,
    [table]
  );
  if (!exists.rows[0]?.ok) {
    console.warn(`[WS-1] PODIO_OVERRIDE_TABLE "podio.${table}" not found (or lacks a 'title' column) — proceeding with no overrides.`);
    return empty;
  }

  const rows = await pool
    .query<{ title: string; value: string | null }>(
      `SELECT title, "${field}" AS value FROM podio."${table}"
       WHERE "${field}" IS NOT NULL AND "${field}" <> ''`
    )
    .catch((e: any) => {
      console.warn(`[WS-1] Podio override query failed (${e?.message ?? e}) — proceeding with no overrides.`);
      return { rows: [] as { title: string; value: string | null }[] };
    });

  const byTitle = new Map<string, ManualOverride[]>();
  for (const r of rows.rows) {
    if (!r.title || !r.value) continue;
    const key = normalizeAddress(r.title);
    const list = byTitle.get(key) ?? [];
    list.push({ source: 'podio', field, value: r.value });
    byTitle.set(key, list);
  }
  return { source: 'db', byTitle };
}

/**
 * Podio occupancy + water-billability source — STUB.
 *
 * Mirrors fetchPodioOverrides()'s existence-check discipline, but the exact Podio
 * columns (occupant counts, water-billable flag) are NOT confirmed yet (data spike
 * pending). Until then this returns empties so the pure engine ships now with
 * is_ps_account from the BGE map and null occupancy/billing fields.
 *
 * TODO(data-spike): once PODIO column names are confirmed, query them here and
 * return per-property { water_billable, occupant_adults, occupant_children } so a
 * sibling of applyPodioOverrides() can populate computed_quarterly_baseline.
 */
export async function fetchPodioOccupancyAndBilling(): Promise<{
  source: 'db' | 'absent';
  byTitle: Map<string, { water_billable: boolean | null; occupant_adults: number | null; occupant_children: number | null }>;
}> {
  // DO NOT query Podio tables yet — column names unconfirmed (data spike).
  return { source: 'absent', byTitle: new Map() };
}

/** Attach Podio overrides to properties, matched on normalized address/name. */
export function applyPodioOverrides(
  properties: PropertyRoutingInput[],
  byTitle: Map<string, ManualOverride[]>
): void {
  if (byTitle.size === 0) return;
  for (const p of properties) {
    const candidates = [normalizeAddress(p.property_name), normalizeAddress(p.address.street1)];
    for (const key of candidates) {
      const hit = byTitle.get(key);
      if (hit) { p.manual_overrides.push(...hit); break; }
    }
  }
}

// ─── small local helpers ────────────────────────────────────────────────────────

function groupBy<T>(rows: T[], key: (r: T) => string | number): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(key(r));
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAddress(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
