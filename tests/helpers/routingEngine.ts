/**
 * WS-2 — Routing Logic Engine (pure decision logic, no I/O).
 *
 * Consumes the WS-1 handoff payload (WS2Payload from propertySources.ts) and
 * routes every property, per utility, into the contract buckets:
 *
 *   BGE-pay / Water-pay   → Dominion pays; property goes to the WS-3 / WS-4 agents
 *   Tenant-skip           → tenant responsibility, occupied; no action
 *   Exception             → flag for human review (Abdul) with a reason code
 *
 * Decision tree finalized on the June 12 2026 client call (Jack BeVier). Applied
 * per property, per utility — BGE and water independently:
 *
 *   1. Manual override (Podio)?       "skip"/"pay" tokens honored; anything
 *                                     unrecognized → EXCEPTION (override review)
 *   2. lifecycle = disposed?          water → SKIP (settlement statement handles
 *                                     it, do not pay); bge → EXCEPTION (call BGE
 *                                     to take the sold property out of our name)
 *   3. lifecycle = acquisition / renovation / rent_ready?
 *                                     → PAY (Dominion owns/controls it; landlord
 *                                     responsible for both utilities this stage)
 *   4. Water:                         ALWAYS PAY (Baltimore water is a lien — we
 *                                     pay then bill the tenant back). The Podio
 *                                     water_billable flag gates the cost-recovery
 *                                     LETTER only, never the payment.
 *   5. BGE:                           gas & electric are ALWAYS the tenant's.
 *        PS / common-area account     → PAY (landlord pays foyer/hallway lights)
 *        landlord/dp flag on a unit   → EXCEPTION (LANDLORD_BGE_UNIT — shouldn't
 *                                       happen; on an occupied unit this also
 *                                       trips an occupancy check)
 *        included_in_rent             → PAY (recovered via rent)
 *        tenant + occupied            → SKIP (tenant pays)
 *        tenant + vacant (off-stage)  → PAY (billing reverts to landlord)
 *        tenant + occupancy unknown   → EXCEPTION
 *        unknown                      → EXCEPTION
 *   6. Account presence (only when PAY): no portal account on file → EXCEPTION.
 *
 * Consumption (independent of routing): expected quarterly usage =
 * adults×10 + children×5 (Podio). Reading vs expected → NORMAL (0–1.5×),
 * LETTER (1.5–3×), LETTER_PLUS_WORKORDER (>3×). A letter goes out even when the
 * tenant is responsible. Vacant "normal" is < vacantMaxUsage/quarter, raised
 * during renovation. Anomalies drive WS-7 letters/work orders and the WS-6
 * Outlook alert — they do NOT auto-pay (payment stays gated behind Jack, WS-7).
 *
 * Every decision carries an audit trail (DecisionStep[]) and the property a
 * shorthand decision_summary, so the WS-7 report can show — for every property,
 * not just exceptions — why the system reached its verdict.
 *
 * No payment happens here. Routing only.
 */
import { PropertyRoutingInput, ConsumptionBaseline, WS2Payload } from './propertySources';
import { buildDecisionSummary, buildLettersAndWorkOrders, computeBaseline } from './routingTrail';
import { prorate, ProrationResult } from './prorationEngine';

export type Utility = 'bge' | 'water';
export type Decision = 'PAY' | 'SKIP' | 'EXCEPTION';
export type Bucket = 'BGE-pay' | 'Water-pay' | 'Tenant-skip' | 'Exception';

/** Contract consumption tiers from the June 12 call. */
export type ContractTier = 'NORMAL' | 'LETTER' | 'LETTER_PLUS_WORKORDER';

export const REASON = {
  RESPONSIBILITY_DP: 'RESPONSIBILITY_DP',
  RESPONSIBILITY_LANDLORD: 'RESPONSIBILITY_LANDLORD',
  INCLUDED_IN_RENT: 'INCLUDED_IN_RENT',
  TENANT_OCCUPIED: 'TENANT_OCCUPIED',
  VACANT_REVERTS_TO_LANDLORD: 'VACANT_REVERTS_TO_LANDLORD',
  OCCUPANCY_UNKNOWN: 'OCCUPANCY_UNKNOWN',
  RESPONSIBILITY_UNKNOWN: 'RESPONSIBILITY_UNKNOWN',
  NO_BGE_ACCOUNT: 'NO_BGE_ACCOUNT',
  NO_WATER_ACCOUNT: 'NO_WATER_ACCOUNT',
  MANUAL_OVERRIDE_SKIP: 'MANUAL_OVERRIDE_SKIP',
  MANUAL_OVERRIDE_PAY: 'MANUAL_OVERRIDE_PAY',
  MANUAL_OVERRIDE_REVIEW: 'MANUAL_OVERRIDE_REVIEW',
  ANOMALY_SEVERE: 'ANOMALY_SEVERE',
  // June 12 additions:
  WATER_LIEN_PAY: 'WATER_LIEN_PAY',                 // water always paid (lien), bill back tenant
  LANDLORD_BGE_UNIT: 'LANDLORD_BGE_UNIT',           // gas/electric flagged landlord on a unit — flag
  PS_ACCOUNT_LANDLORD: 'PS_ACCOUNT_LANDLORD',       // PS/common-area BGE — landlord pays
  LIFECYCLE_LANDLORD_STAGE: 'LIFECYCLE_LANDLORD_STAGE', // acquisition/renovation/rent_ready → landlord
  DISPOSED_WATER_IGNORE: 'DISPOSED_WATER_IGNORE',   // sold property water bill — settlement handles it
  DISPOSED_BGE_EXCEPTION: 'DISPOSED_BGE_EXCEPTION', // sold property BGE bill — call BGE
} as const;
export type ReasonCode = (typeof REASON)[keyof typeof REASON];

/** Lifecycle stages where Dominion (landlord) owns the utility obligation. */
const LANDLORD_STAGES = ['acquisition', 'renovation', 'rent_ready'];
function isLandlordStage(lifecycle_stage: string): boolean {
  return LANDLORD_STAGES.includes((lifecycle_stage || '').toLowerCase());
}
function isRenovationStage(lifecycle_stage: string): boolean {
  const s = (lifecycle_stage || '').toLowerCase();
  return s === 'renovation' || s === 'acquisition' || s === 'rent_ready';
}

// ─── Audit trail ────────────────────────────────────────────────────────────────

/** One ordered step in the shorthand decision tree for a single utility verdict. */
export interface DecisionStep {
  step: number;
  label: string;      // what was evaluated, e.g. "BGE responsibility"
  evaluated: string;  // the value seen, e.g. "tenant + occupied"
  outcome: string;    // the branch taken, e.g. "tenant pays → SKIP"
}

/** How to round a computed tenant share (June 19: Jack is comfortable eating a few
 *  dollars; Aditya wants to avoid systematically over-charging). */
export type RoundingBias = 'tenant_favor' | 'dominion_favor' | 'nearest';
/** Proration method. June 19: Baltimore water / BGE bills are a single monthly
 *  meter read — no daily/weekly breakdown — so Method C (area-under-curve) is
 *  ruled out. Only 'average' (Method A) is supported. */
export type ProrationMethod = 'average';

export interface RoutingConfig {
  /** Max water units a vacant unit may consume per period before it's flagged. */
  vacantMaxUsage: number;
  /** Raised vacant ceiling while a property is under renovation (avoids false flags). */
  renovationVacantMaxUsage: number;
  /** reading ≥ multiplier × expected on an occupied unit → LETTER. */
  letterMultiplier: number;
  /** reading ≥ multiplier × expected on an occupied unit → LETTER + WORK ORDER. */
  workOrderMultiplier: number;
  /** Expected quarterly water units per adult occupant (Podio baseline). */
  adultQuarterlyUnits: number;
  /** Expected quarterly water units per child occupant (Podio baseline). */
  childQuarterlyUnits: number;
  // Backward-compat aliases (older callers/tests): moderate↔letter, severe↔workOrder.
  moderateSpikeMultiplier: number;
  severeSpikeMultiplier: number;
  // ── June 19 2026 proration knobs (Method A; see prorationEngine.ts) ──
  /** Move date within this many days of a bill boundary → attribute the whole
   *  stub, no proration. June 19: 2–3 days, 3 inclusive. */
  graceDays: number;
  /** Only 'average' (Method A) — Method C ruled out June 19. */
  prorationMethod: ProrationMethod;
  /** Strip renovation-window usage from the tenant's share before splitting. */
  renovationExcludesTenant: boolean;
  /** Tenant share above this $ amount surfaces for human review (June 19: $10). */
  reviewThresholdDollars: number;
  /** Which way to round the computed tenant share. */
  roundingBias: RoundingBias;
}

export const DEFAULT_CONFIG: RoutingConfig = {
  vacantMaxUsage: 10,             // June 12: vacant "normal" is < 10 units/quarter
  renovationVacantMaxUsage: 30,   // raised while under renovation
  letterMultiplier: 1.5,
  workOrderMultiplier: 3,
  adultQuarterlyUnits: 10,
  childQuarterlyUnits: 5,
  moderateSpikeMultiplier: 1.5,
  severeSpikeMultiplier: 3,
  graceDays: 3,                   // June 19: 2–3 days, 3 inclusive
  prorationMethod: 'average',     // June 19: Method C ruled out (monthly meter read only)
  renovationExcludesTenant: true,
  reviewThresholdDollars: 10,     // June 19: "make it 10 bucks"
  roundingBias: 'tenant_favor',
};

/** Threshold overrides via env (WS2_VACANT_MAX_USAGE etc.). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // reviewThresholdDollars may legitimately be 0 (pay everything to humans), so it
  // uses a 0-inclusive parse rather than the >0 guard above.
  const numNonNeg = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const bool = (v: string | undefined, fallback: boolean) =>
    v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v.trim());
  const letter = num(env.WS2_LETTER_MULTIPLIER ?? env.WS2_MODERATE_SPIKE_MULTIPLIER, DEFAULT_CONFIG.letterMultiplier);
  const workOrder = num(env.WS2_WORK_ORDER_MULTIPLIER ?? env.WS2_SEVERE_SPIKE_MULTIPLIER, DEFAULT_CONFIG.workOrderMultiplier);
  const bias = (env.WS2_ROUNDING_BIAS ?? '').trim().toLowerCase();
  const roundingBias: RoundingBias =
    bias === 'dominion_favor' || bias === 'nearest' || bias === 'tenant_favor'
      ? (bias as RoundingBias)
      : DEFAULT_CONFIG.roundingBias;
  return {
    vacantMaxUsage: num(env.WS2_VACANT_MAX_USAGE, DEFAULT_CONFIG.vacantMaxUsage),
    renovationVacantMaxUsage: num(env.WS2_RENOVATION_VACANT_MAX_USAGE, DEFAULT_CONFIG.renovationVacantMaxUsage),
    letterMultiplier: letter,
    workOrderMultiplier: workOrder,
    adultQuarterlyUnits: num(env.WS2_ADULT_QUARTERLY_UNITS, DEFAULT_CONFIG.adultQuarterlyUnits),
    childQuarterlyUnits: num(env.WS2_CHILD_QUARTERLY_UNITS, DEFAULT_CONFIG.childQuarterlyUnits),
    moderateSpikeMultiplier: letter,
    severeSpikeMultiplier: workOrder,
    graceDays: num(env.WS2_GRACE_DAYS, DEFAULT_CONFIG.graceDays),
    prorationMethod: 'average', // Method C removed; env cannot re-enable it
    renovationExcludesTenant: bool(env.WS2_RENOVATION_EXCLUDES_TENANT, DEFAULT_CONFIG.renovationExcludesTenant),
    reviewThresholdDollars: numNonNeg(env.WS2_REVIEW_THRESHOLD_DOLLARS, DEFAULT_CONFIG.reviewThresholdDollars),
    roundingBias,
  };
}

export type AnomalyTier = 'MODERATE' | 'SEVERE';
export type AnomalyKind = 'VACANT_USAGE' | 'POSSIBLE_LEAK' | 'MODERATE_SPIKE';

export interface ConsumptionAnomaly {
  property_id: number;
  property_name: string;
  unit_id: number;
  utility_type: string;
  tier: AnomalyTier;            // backward-compat: MODERATE↔LETTER, SEVERE↔WORKORDER/vacant
  contract_tier: ContractTier; // June 12 contract tier
  kind: AnomalyKind;
  reading: number;
  baseline: number | null;     // expected usage actually applied (occupant-derived or Podio)
  detail: string;
}

/** A tenant cost-recovery / "your bill is high" letter (WS-7 builds the real doc). */
export interface TenantLetter {
  property_id: number;
  property_name: string;
  unit_id: number;
  utility_type: string;
  tier: ContractTier;                   // LETTER or LETTER_PLUS_WORKORDER
  responsibility: 'landlord' | 'tenant'; // drives verbiage (June 12)
  reading: number;
  expected: number | null;
  summary: string;
}

/** A maintenance work order to physically inspect a >3× consumption property. */
export interface WorkOrderRequest {
  property_id: number;
  property_name: string;
  unit_id: number;
  utility_type: string;
  reading: number;
  expected: number | null;
  reason: string;
}

export interface UtilityDecision {
  utility: Utility;
  decision: Decision;
  reason_code: ReasonCode;
  detail: string;
  trail: DecisionStep[];     // shorthand decision tree for this verdict
}

export interface PropertyRoutingResult {
  property_id: number;
  property_name: string;
  decisions: UtilityDecision[];     // one entry per utility (bge, water)
  anomalies: ConsumptionAnomaly[];
  letters: TenantLetter[];
  work_orders: WorkOrderRequest[];
  /** BGE reverted to landlord on a supposedly-occupied unit → manual occupancy check. */
  occupancy_check_required: boolean;
  /** 4–5 line plain-English shorthand of why the verdicts were reached (WS-7 trust). */
  decision_summary: string;
  buckets: Bucket[];
  /** Mid-cycle move-in/out water split (Method A), when the bill period + occupancy
   *  timeline are present on the input. Undefined for retrieval-only / week-1 runs.
   *  The computed number is a suggestion — a human override (proration_override)
   *  always wins. See prorationEngine.ts. */
  proration?: ProrationResult;
}

export interface RoutingRunResult {
  run_id: string;
  results: PropertyRoutingResult[];
  totals: {
    bge_pay: number; water_pay: number; tenant_skip: number; exception: number;
    anomalies: number; letters: number; work_orders: number; occupancy_checks: number;
  };
}

// ─── Manual overrides (Podio) ───────────────────────────────────────────────────
// Conservative: only explicit "skip"/"pay" verbs (optionally scoped "skip water" /
// "pay bge") are honored. Anything else flags the property for review.

interface ParsedOverride { scope: Utility | 'all'; action: 'pay' | 'skip' | null; raw: string; }

function parseOverride(value: string): ParsedOverride {
  const v = (value || '').trim().toLowerCase();
  const action = /\bskip\b|\bdo not pay\b|\bdont pay\b/.test(v) ? 'skip'
    : /\bpay\b/.test(v) ? 'pay'
    : null;
  const scope: Utility | 'all' = /\bwater\b/.test(v) && !/\bbge\b|\belectric\b|\bgas\b/.test(v) ? 'water'
    : (/\bbge\b|\belectric\b|\bgas\b/.test(v) && !/\bwater\b/.test(v)) ? 'bge'
    : 'all';
  return { scope, action, raw: value };
}

// ─── Per-utility decision ───────────────────────────────────────────────────────

function decideUtility(p: PropertyRoutingInput, utility: Utility): UtilityDecision {
  const trail: DecisionStep[] = [];
  const note = (label: string, evaluated: string, outcome: string) =>
    trail.push({ step: trail.length + 1, label, evaluated, outcome });
  const mk = (decision: Decision, reason_code: ReasonCode, detail: string): UtilityDecision =>
    ({ utility, decision, reason_code, detail, trail });

  // 1. Manual overrides trump everything (Podio is the human channel).
  for (const o of p.manual_overrides) {
    const parsed = parseOverride(o.value);
    if (parsed.scope !== 'all' && parsed.scope !== utility) continue;
    if (parsed.action === 'skip') { note('Manual override', `"${o.value}"`, 'honored → SKIP'); return mk('SKIP', REASON.MANUAL_OVERRIDE_SKIP, `Podio override: "${o.value}"`); }
    if (parsed.action === 'pay') { note('Manual override', `"${o.value}"`, 'honored → PAY'); return mk('PAY', REASON.MANUAL_OVERRIDE_PAY, `Podio override: "${o.value}"`); }
    note('Manual override', `"${o.value}"`, 'unrecognized → EXCEPTION');
    return mk('EXCEPTION', REASON.MANUAL_OVERRIDE_REVIEW, `Unrecognized Podio override: "${o.value}"`);
  }
  note('Manual override', 'none', 'continue');

  // 2. Sold/disposed: water is settled on the HUD; BGE needs a call to BGE.
  if (p.occupancy === 'disposed' || p.lifecycle_stage.toLowerCase() === 'disposed') {
    if (utility === 'water') {
      note('Lifecycle', 'disposed', 'water → ignore (settlement statement)');
      return mk('SKIP', REASON.DISPOSED_WATER_IGNORE, 'Property disposed — trailing water bill handled via settlement; do not pay.');
    }
    note('Lifecycle', 'disposed', 'bge → EXCEPTION (call BGE)');
    return mk('EXCEPTION', REASON.DISPOSED_BGE_EXCEPTION, 'Property disposed — trailing BGE bill: call BGE to remove from our name.');
  }

  // 3. Landlord-responsible lifecycle stage (acquisition/renovation/rent_ready).
  if (isLandlordStage(p.lifecycle_stage)) {
    note('Lifecycle', p.lifecycle_stage, 'landlord-responsible stage → PAY');
    return mk('PAY', REASON.LIFECYCLE_LANDLORD_STAGE,
      `${p.lifecycle_stage} stage — Dominion owns the utility obligation.`);
  }

  // 4. Water: always pay (Baltimore lien), bill the tenant back afterward.
  if (utility === 'water') {
    note('Water lien rule', 'Baltimore water = lien on property', 'PAY then bill back tenant');
    return mk('PAY', REASON.WATER_LIEN_PAY,
      'Water is a lien — Dominion pays, then bills the tenant back where billable.');
  }

  // 5. BGE: gas & electric are always the tenant's, except PS common-area accounts.
  if (p.is_ps_account) {
    note('BGE account type', 'PS / common-area', 'landlord pays common area → PAY');
    return mk('PAY', REASON.PS_ACCOUNT_LANDLORD, 'PS / common-area BGE account — landlord responsibility.');
  }
  const resp = p.responsibility.bge;
  switch (resp) {
    case 'landlord':
    case 'dp':
      note('BGE responsibility', resp, 'gas/electric is always tenant → EXCEPTION (flag)');
      return mk('EXCEPTION', REASON.LANDLORD_BGE_UNIT,
        `Gas/electric flagged ${resp} on a unit — should be tenant; review (possible skip/occupancy change).`);
    case 'included_in_rent':
      note('BGE responsibility', 'included_in_rent', 'Dominion pays, recovered via rent → PAY');
      return mk('PAY', REASON.INCLUDED_IN_RENT, 'Utility included in rent — Dominion pays, recovered via rent.');
    case 'tenant':
      if (p.occupancy === 'occupied') {
        note('BGE responsibility', 'tenant + occupied', 'tenant pays → SKIP');
        return mk('SKIP', REASON.TENANT_OCCUPIED, 'Tenant-responsible and occupied — tenant pays.');
      }
      if (p.occupancy === 'vacant') {
        note('BGE responsibility', 'tenant + vacant (off-stage)', 'billing reverts to landlord → PAY');
        return mk('PAY', REASON.VACANT_REVERTS_TO_LANDLORD,
          `Vacant (${p.lifecycle_stage || 'no stage'}) — BGE reverts to Dominion; confirm vacancy vs billing period.`);
      }
      note('BGE responsibility', 'tenant + occupancy unknown', '→ EXCEPTION');
      return mk('EXCEPTION', REASON.OCCUPANCY_UNKNOWN,
        `Tenant-responsible but occupancy unknown (lifecycle_stage="${p.lifecycle_stage}").`);
    default:
      note('BGE responsibility', 'unknown', '→ EXCEPTION');
      return mk('EXCEPTION', REASON.RESPONSIBILITY_UNKNOWN,
        `No usable bge responsibility flag (lifecycle_stage="${p.lifecycle_stage}").`);
  }
}

/** 6. A PAY with no portal account on file can't execute — flag it. */
function checkAccounts(p: PropertyRoutingInput, d: UtilityDecision): UtilityDecision {
  if (d.decision !== 'PAY') return d;
  if (d.utility === 'bge' && p.bge_accounts.length === 0) {
    d.trail.push({ step: d.trail.length + 1, label: 'Account presence', evaluated: 'no BGE account', outcome: '→ EXCEPTION' });
    return { ...d, decision: 'EXCEPTION', reason_code: REASON.NO_BGE_ACCOUNT,
      detail: `Routed PAY (${d.reason_code}) but no BGE account mapped — reconcile via WS-5.` };
  }
  if (d.utility === 'water' && !p.water_accounts.some(w => w.water_account_number)) {
    d.trail.push({ step: d.trail.length + 1, label: 'Account presence', evaluated: 'no water account', outcome: '→ EXCEPTION' });
    return { ...d, decision: 'EXCEPTION', reason_code: REASON.NO_WATER_ACCOUNT,
      detail: `Routed PAY (${d.reason_code}) but no water account number mapped — reconcile via WS-5.` };
  }
  return d;
}

// ─── Consumption anomaly checks (independent of routing) ───────────────────────

/** Latest consumption per unit_id (from water_portal_audit_log or any source). */
export type ConsumptionReadings = Map<number, number>;

/** Expected quarterly usage for the property: adults×10 + children×5 when occupant
 *  counts are known, else the unit's computed/stored Podio baseline. */
function expectedUsage(p: PropertyRoutingInput, b: ConsumptionBaseline, cfg: RoutingConfig): number | null {
  const adults = p.occupant_adults ?? 0;
  const children = p.occupant_children ?? 0;
  const computed = adults * cfg.adultQuarterlyUnits + children * cfg.childQuarterlyUnits;
  if (computed > 0) return computed;
  return computeBaseline(b);
}

export function detectAnomalies(
  p: PropertyRoutingInput,
  readings: ConsumptionReadings,
  cfg: RoutingConfig
): ConsumptionAnomaly[] {
  const out: ConsumptionAnomaly[] = [];
  for (const b of p.consumption_baselines) {
    const reading = readings.get(b.unit_id);
    if (reading == null) continue; // no reading yet — WS-4 fills these in weekly
    const expected = expectedUsage(p, b, cfg);
    const base = { property_id: p.property_id, property_name: p.property_name,
      unit_id: b.unit_id, utility_type: b.utility_type, reading };

    if (p.occupancy === 'vacant') {
      const ceiling = isRenovationStage(p.lifecycle_stage) ? cfg.renovationVacantMaxUsage : cfg.vacantMaxUsage;
      if (reading > ceiling) {
        out.push({ ...base, baseline: ceiling, tier: 'SEVERE', contract_tier: 'LETTER_PLUS_WORKORDER', kind: 'VACANT_USAGE',
          detail: `Vacant unit consumed ${reading} ${b.utility_type} units (max ${ceiling}/${b.period_unit}) — possible leak or unauthorized use.` });
      }
      continue;
    }
    if (expected == null) continue;
    if (reading >= cfg.workOrderMultiplier * expected) {
      out.push({ ...base, baseline: expected, tier: 'SEVERE', contract_tier: 'LETTER_PLUS_WORKORDER', kind: 'POSSIBLE_LEAK',
        detail: `${reading} vs expected ${expected}/${b.period_unit} (≥${cfg.workOrderMultiplier}×) — letter + work order (physical inspection).` });
    } else if (reading >= cfg.letterMultiplier * expected) {
      out.push({ ...base, baseline: expected, tier: 'MODERATE', contract_tier: 'LETTER', kind: 'MODERATE_SPIKE',
        detail: `${reading} vs expected ${expected}/${b.period_unit} (≥${cfg.letterMultiplier}×) — tenant letter.` });
    }
  }
  return out;
}

/** Mid-cycle water proration (Method A). Runs only when WS-4 has supplied the
 *  bill period + a period total AND an occupancy timeline with a move date is
 *  present. Water-only: water is always Dominion-paid then billed back (the lien),
 *  so the split is the thing that needs computing. BGE settles by name change. */
function computeProration(p: PropertyRoutingInput, cfg: RoutingConfig): ProrationResult | undefined {
  const period = p.bill_period;
  const timeline = p.occupancy_timeline;
  const total = p.period_total_consumption;
  if (!period || !timeline || total == null) return undefined;
  if (!timeline.move_in && !timeline.move_out) return undefined; // no mid-cycle event
  try {
    return prorate({
      utility: 'water',
      bill_period: { start: period.start, end: period.end },
      occupancy: timeline,
      total_consumption: total,
      bill_amount: p.period_bill_amount ?? null,
      config: cfg,
    });
  } catch {
    return undefined; // bad dates — never block routing on a proration failure
  }
}

// ─── Property + run entry points ────────────────────────────────────────────────

export function routeProperty(
  p: PropertyRoutingInput,
  cfg: RoutingConfig = DEFAULT_CONFIG,
  readings: ConsumptionReadings = new Map()
): PropertyRoutingResult {
  let decisions = (['bge', 'water'] as Utility[]).map(u => checkAccounts(p, decideUtility(p, u)));
  const anomalies = detectAnomalies(p, readings, cfg);

  // A SEVERE / >3× reading is a possible leak: never auto-queue that water payment
  // into the weekly batch — surface it for human review first (the work order still
  // drives the physical inspection; payment stays gated behind Jack regardless).
  const severe = anomalies.find(a => a.tier === 'SEVERE');
  if (severe) {
    decisions = decisions.map(d =>
      d.utility === 'water' && d.decision === 'PAY'
        ? { ...d, decision: 'EXCEPTION' as Decision, reason_code: REASON.ANOMALY_SEVERE,
            detail: `Was PAY (${d.reason_code}); escalated for review: ${severe.detail}`,
            trail: [...d.trail, { step: d.trail.length + 1, label: 'Consumption',
              evaluated: 'SEVERE anomaly', outcome: 'escalate PAY → EXCEPTION (review before pay)' }] }
        : d);
  }

  // BGE reverted to landlord on a supposedly-occupied unit → manual occupancy check.
  const bge = decisions.find(d => d.utility === 'bge');
  const occupancy_check_required = !!bge && bge.reason_code === REASON.LANDLORD_BGE_UNIT && p.occupancy === 'occupied';

  const { letters, work_orders } = buildLettersAndWorkOrders(p, anomalies);

  const buckets = dedupe(decisions.map((d): Bucket =>
    d.decision === 'EXCEPTION' ? 'Exception'
      : d.decision === 'SKIP' ? 'Tenant-skip'
      : d.utility === 'bge' ? 'BGE-pay' : 'Water-pay'));

  const result: PropertyRoutingResult = {
    property_id: p.property_id, property_name: p.property_name,
    decisions, anomalies, letters, work_orders, occupancy_check_required,
    decision_summary: '', buckets,
    proration: computeProration(p, cfg),
  };
  result.decision_summary = buildDecisionSummary(result, p);
  return result;
}

export function routeAll(
  payload: WS2Payload,
  cfg: RoutingConfig = DEFAULT_CONFIG,
  readings: ConsumptionReadings = new Map()
): RoutingRunResult {
  const results = payload.properties.map(p => routeProperty(p, cfg, readings));
  const totals = { bge_pay: 0, water_pay: 0, tenant_skip: 0, exception: 0,
    anomalies: 0, letters: 0, work_orders: 0, occupancy_checks: 0 };
  for (const r of results) {
    for (const d of r.decisions) {
      if (d.decision === 'EXCEPTION') totals.exception++;
      else if (d.decision === 'SKIP') totals.tenant_skip++;
      else if (d.utility === 'bge') totals.bge_pay++;
      else totals.water_pay++;
    }
    totals.anomalies += r.anomalies.length;
    totals.letters += r.letters.length;
    totals.work_orders += r.work_orders.length;
    if (r.occupancy_check_required) totals.occupancy_checks++;
  }
  return { run_id: payload.run_id, results, totals };
}

function dedupe<T>(xs: T[]): T[] { return [...new Set(xs)]; }
