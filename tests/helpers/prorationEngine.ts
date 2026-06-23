/**
 * WS-2 — Mid-cycle move-in / move-out proration (pure logic, no I/O).
 *
 * A utility bill covers a fixed window (e.g. May 1 → May 31), but tenants don't
 * move on the 1st. When a tenant takes the keys mid-period, one bill spans two
 * "owners": Dominion (vacant / renovation days) and the tenant (occupied days).
 * This module answers "how much of that one bill belongs to whom?".
 *
 * Decisions finalized on the June 19 2026 client call (Jack BeVier):
 *   · Baltimore water + BGE bills are a SINGLE monthly meter read — no daily/
 *     weekly breakdown — so Method C (area-under-the-curve) is RULED OUT. Only
 *     Method A (daily average) is implemented here.
 *   · Grace window 2–3 days, 3 inclusive: a move within graceDays of a bill
 *     boundary attributes the whole stub to the obvious party, no split.
 *   · BGE settles by name-change on the move date — no reconciliation unless the
 *     name-change is missing/far off; surfaced as an exception, never split here.
 *   · Tenant share above reviewThresholdDollars ($10) → needs human review.
 *   · The computed number is a SUGGESTION; a human override always wins and both
 *     the computed and final values are logged (handled by the caller / DB).
 *
 * Method A: per_day = total ÷ days_in_period; tenant = per_day × tenant_days.
 * Renovation days are excluded from the tenant's share when configured, so
 * construction water never lands on the tenant.
 *
 * Pure function over plain values — fully unit-testable, mirrors routingEngine.ts.
 */
import type { DecisionStep, RoutingConfig } from './routingEngine';

/** Proration-relevant config defaults, used when the caller passes no config.
 *  Kept local (not imported from routingEngine's DEFAULT_CONFIG) to avoid a
 *  runtime import cycle — routingEngine imports prorate() from here. Values must
 *  stay in sync with DEFAULT_CONFIG's June 19 settings. */
const PRORATION_DEFAULTS: Pick<
  RoutingConfig,
  'graceDays' | 'prorationMethod' | 'renovationExcludesTenant' | 'reviewThresholdDollars' | 'roundingBias'
> = {
  graceDays: 3,
  prorationMethod: 'average',
  renovationExcludesTenant: true,
  reviewThresholdDollars: 10,
  roundingBias: 'tenant_favor',
};

export type ProrationUtility = 'water' | 'bge';

/** A half-open-agnostic inclusive date window [start, end] (YYYY-MM-DD or ISO). */
export interface DateWindow {
  start: string;
  end: string;
}

export interface OccupancyTimeline {
  /** Tenant move-in date (start of tenant responsibility). Omit if not a move-in bill. */
  move_in?: string | null;
  /** Tenant move-out date (end of tenant responsibility). Omit if not a move-out bill. */
  move_out?: string | null;
  /** Renovation window overlapping the bill period (Dominion's days). */
  renovation?: DateWindow | null;
  /** BGE only: was the account name-changed on/near the move date? */
  bge_name_change_near_move?: boolean | null;
}

export interface ProrationInput {
  utility: ProrationUtility;
  bill_period: DateWindow;
  occupancy: OccupancyTimeline;
  /** Single period total consumption (the only granularity available — Method A). */
  total_consumption: number;
  /** Bill dollar amount, when known — enables the $ review-threshold check + split. */
  bill_amount?: number | null;
  config?: RoutingConfig;
}

export type ProrationMethodUsed =
  | 'average'          // Method A daily-average split
  | 'grace_whole'      // move within grace of a boundary → whole stub to one party
  | 'bge_name_change'  // BGE settled by name change — no reconciliation
  | 'bge_exception'    // BGE name-change missing/far off — surface for review
  | 'no_split';        // tenant occupied the entire period (or no move dates)

export interface ProrationResult {
  utility: ProrationUtility;
  method_used: ProrationMethodUsed;
  days_period: number;
  days_tenant: number;
  /** Tenant's consumption share (units), 2-dp; null when no split applies. */
  tenant_share: number | null;
  /** Dominion's consumption share (units), 2-dp; null when no split applies. */
  dominion_share: number | null;
  /** Tenant's dollar share (rounded per roundingBias) when bill_amount is known. */
  tenant_amount: number | null;
  dominion_amount: number | null;
  renovation_excluded: boolean;
  /** Tenant $ share exceeds the review threshold → a human eyeballs before bill-back. */
  needs_review: boolean;
  trail: DecisionStep[];
}

// ─── Date helpers (date-only, UTC, inclusive day counting) ──────────────────────

/** Parse a YYYY-MM-DD / ISO string to a UTC day-index (days since epoch). */
function toDayIndex(d: string): number {
  const t = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (!Number.isFinite(t)) throw new Error(`prorationEngine: unparseable date "${d}"`);
  return Math.floor(t / 86_400_000);
}

/** Inclusive day count of a window: Jan 1 → Jan 31 = 31 days. */
function inclusiveDays(start: number, end: number): number {
  return Math.max(0, end - start + 1);
}

/** Inclusive overlap (in days) between two day-index windows. */
function overlapDays(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return inclusiveDays(start, end);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round a tenant dollar share per the configured bias (whole dollars). */
function roundAmount(amount: number, bias: RoutingConfig['roundingBias']): number {
  if (bias === 'tenant_favor') return Math.floor(amount);   // never over-charge the tenant
  if (bias === 'dominion_favor') return Math.ceil(amount);
  return Math.round(amount);
}

// ─── Engine ─────────────────────────────────────────────────────────────────────

export function prorate(input: ProrationInput): ProrationResult {
  const cfg = input.config ?? (PRORATION_DEFAULTS as RoutingConfig);
  const trail: DecisionStep[] = [];
  const note = (label: string, evaluated: string, outcome: string) =>
    trail.push({ step: trail.length + 1, label, evaluated, outcome });

  const pStart = toDayIndex(input.bill_period.start);
  const pEnd = toDayIndex(input.bill_period.end);
  if (pEnd < pStart) throw new Error('prorationEngine: bill_period.end before start');
  const daysPeriod = inclusiveDays(pStart, pEnd);

  const base = (
    method_used: ProrationMethodUsed,
    daysTenant: number,
    tenantShare: number | null,
    renovationExcluded: boolean
  ): ProrationResult => {
    const dominionShare = tenantShare == null ? null : round2(input.total_consumption - tenantShare);
    let tenant_amount: number | null = null;
    let dominion_amount: number | null = null;
    let needs_review = false;
    if (input.bill_amount != null && tenantShare != null && input.total_consumption > 0) {
      const ratio = tenantShare / input.total_consumption;
      const rawTenant = input.bill_amount * ratio;
      tenant_amount = roundAmount(rawTenant, cfg.roundingBias);
      dominion_amount = round2(input.bill_amount - tenant_amount);
      needs_review = tenant_amount > cfg.reviewThresholdDollars;
      note('Review threshold', `tenant $${tenant_amount} vs $${cfg.reviewThresholdDollars}`,
        needs_review ? 'above → flag for human review' : 'below → auto-resolve');
    }
    return {
      utility: input.utility,
      method_used,
      days_period: daysPeriod,
      days_tenant: daysTenant,
      tenant_share: tenantShare == null ? null : round2(tenantShare),
      dominion_share: dominionShare,
      tenant_amount,
      dominion_amount,
      renovation_excluded: renovationExcluded,
      needs_review,
      trail,
    };
  };

  // ── BGE path: settled by name-change, never split here (June 19) ──────────────
  if (input.utility === 'bge') {
    if (input.occupancy.bge_name_change_near_move) {
      note('BGE name change', 'on/near move date', 'no reconciliation → tenant owns by definition');
      return base('bge_name_change', 0, null, false);
    }
    note('BGE name change', 'missing or far off move date', 'surface for review (no auto-split)');
    return base('bge_exception', 0, null, false);
  }

  // ── Tenant-occupied interval within the bill period ───────────────────────────
  // Move-in bill: tenant from move_in → period end. Move-out bill: period start →
  // move_out. With both, the tenant occupies the middle slice. With neither, the
  // tenant occupied the whole period (no split).
  const tStart = input.occupancy.move_in ? toDayIndex(input.occupancy.move_in) : pStart;
  const tEnd = input.occupancy.move_out ? toDayIndex(input.occupancy.move_out) : pEnd;

  if (!input.occupancy.move_in && !input.occupancy.move_out) {
    note('Move dates', 'none in period', 'tenant occupied whole period → no split');
    return base('no_split', daysPeriod, input.total_consumption, false);
  }

  let tenantDays = overlapDays(tStart, tEnd, pStart, pEnd);

  // ── Grace: a move within graceDays of a boundary → attribute the whole stub ────
  // Captures both ends: tenant present almost the whole period → tenant whole;
  // tenant present only a sliver → Dominion whole.
  if (daysPeriod - tenantDays <= cfg.graceDays) {
    note('Grace check', `${daysPeriod - tenantDays}d gap ≤ ${cfg.graceDays}`, 'tenant owns whole stub');
    return base('grace_whole', daysPeriod, input.total_consumption, false);
  }
  if (tenantDays <= cfg.graceDays) {
    note('Grace check', `${tenantDays} tenant day(s) ≤ ${cfg.graceDays}`, 'Dominion owns whole stub');
    return base('grace_whole', tenantDays, 0, false);
  }
  note('Grace check', `tenant ${tenantDays}/${daysPeriod}d`, 'real split → Method A');

  // ── Renovation exclusion: construction water never lands on the tenant ────────
  let renovationExcluded = false;
  const reno = input.occupancy.renovation;
  if (reno && cfg.renovationExcludesTenant) {
    const rStart = toDayIndex(reno.start);
    const rEnd = toDayIndex(reno.end);
    const renoTenantOverlap = overlapDays(rStart, rEnd, tStart, tEnd);
    if (renoTenantOverlap > 0) {
      tenantDays = Math.max(0, tenantDays - renoTenantOverlap);
      renovationExcluded = true;
      note('Renovation exclusion', `${renoTenantOverlap}d of renovation in tenant window`,
        `stripped → tenant ${tenantDays}d`);
    }
  }

  // ── Method A — daily average ──────────────────────────────────────────────────
  const perDay = input.total_consumption / daysPeriod;
  const tenantShare = perDay * tenantDays;
  note('Method A (daily average)', `${round2(perDay)} units/day × ${tenantDays}d`,
    `tenant ${round2(tenantShare)} of ${input.total_consumption} units`);

  return base('average', tenantDays, tenantShare, renovationExcluded);
}
