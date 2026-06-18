/**
 * WS-2 — Routing Logic Engine unit tests.
 * Pure-logic tests (no browser, no DB): npx playwright test tests/ws2-routing.spec.ts
 * Covers every branch of the decision tree documented in helpers/routingEngine.ts,
 * including all June 12 2026 changes (Jack BeVier call).
 */
import { test, expect } from '@playwright/test';
import { PropertyRoutingInput, WS2Payload } from './helpers/propertySources';
import {
  routeProperty, routeAll, detectAnomalies, configFromEnv,
  DEFAULT_CONFIG, REASON, Utility,
} from './helpers/routingEngine';

function prop(overrides: Partial<PropertyRoutingInput> = {}): PropertyRoutingInput {
  return {
    property_id: 1,
    property_name: '123 Test St',
    address: { street1: '123 Test St', city: 'Baltimore', state: 'MD', zip: '21201' },
    lifecycle_stage: 'active',
    occupancy: 'occupied',
    responsibility: { bge: 'tenant', water: 'tenant' },
    bge_accounts: ['1234567890'],
    water_accounts: [{ unit_id: 10, unit_name: '1', water_account_number: 'W-100' }],
    consumption_baselines: [],
    manual_overrides: [],
    ...overrides,
  };
}

function decision(p: PropertyRoutingInput, utility: Utility) {
  return routeProperty(p).decisions.find(d => d.utility === utility)!;
}

// ─── Responsibility branches ─────────────────────────────────────────────────
// June 12: landlord/dp BGE on a unit → EXCEPTION LANDLORD_BGE_UNIT (not PAY).
// PS / common-area accounts are the landlord-pay path for BGE.

test('dp BGE responsibility → EXCEPTION LANDLORD_BGE_UNIT (unit-level gas/electric is always tenant)', () => {
  const d = decision(prop({ responsibility: { bge: 'dp', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.LANDLORD_BGE_UNIT);
});

test('dp water responsibility → PAY WATER_LIEN_PAY (water lien rule supersedes dp flag)', () => {
  const d = decision(prop({ responsibility: { bge: 'tenant', water: 'dp' } }), 'water');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.WATER_LIEN_PAY);
});

test('included_in_rent BGE → PAY with its own reason code', () => {
  const d = decision(prop({ responsibility: { bge: 'included_in_rent', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.INCLUDED_IN_RENT);
});

test('tenant + occupied BGE → SKIP (tenant pays)', () => {
  const d = decision(prop(), 'bge');
  expect(d.decision).toBe('SKIP');
  expect(d.reason_code).toBe(REASON.TENANT_OCCUPIED);
});

test('tenant + occupied water → PAY WATER_LIEN_PAY (lien — always pay)', () => {
  const d = decision(prop(), 'water');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.WATER_LIEN_PAY);
});

test('tenant + unknown occupancy BGE → EXCEPTION OCCUPANCY_UNKNOWN', () => {
  const d = decision(prop({ lifecycle_stage: '', occupancy: 'unknown' }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.OCCUPANCY_UNKNOWN);
});

test('unknown BGE responsibility → EXCEPTION RESPONSIBILITY_UNKNOWN', () => {
  const d = decision(prop({ responsibility: { bge: 'unknown', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.RESPONSIBILITY_UNKNOWN);
});

// ─── Disposed property ───────────────────────────────────────────────────────
// June 12 split: disposed water → SKIP (settlement statement handles it);
// disposed BGE → EXCEPTION (call BGE to take it out of our name).

test('disposed property water → SKIP DISPOSED_WATER_IGNORE (settlement handles it)', () => {
  const d = decision(prop({ lifecycle_stage: 'disposed', occupancy: 'disposed',
    responsibility: { bge: 'landlord', water: 'landlord' } }), 'water');
  expect(d.decision).toBe('SKIP');
  expect(d.reason_code).toBe(REASON.DISPOSED_WATER_IGNORE);
});

test('disposed property BGE → EXCEPTION DISPOSED_BGE_EXCEPTION (call BGE)', () => {
  const d = decision(prop({ lifecycle_stage: 'disposed', occupancy: 'disposed',
    responsibility: { bge: 'landlord', water: 'landlord' } }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.DISPOSED_BGE_EXCEPTION);
});

test('disposed property with trailing BGE bill — detail mentions disposed', () => {
  const p = prop({ lifecycle_stage: 'disposed', occupancy: 'disposed',
    responsibility: { bge: 'landlord', water: 'landlord' }, bge_accounts: ['9999999999'] });
  const d = decision(p, 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.DISPOSED_BGE_EXCEPTION);
  expect(d.detail).toMatch(/disposed/i);
});

// ─── Account presence guards ─────────────────────────────────────────────────
// PAY paths that reach checkAccounts: is_ps_account / included_in_rent for BGE.

test('PS account BGE with no account number → EXCEPTION NO_BGE_ACCOUNT', () => {
  const d = decision(prop({ is_ps_account: true, bge_accounts: [] }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.NO_BGE_ACCOUNT);
});

test('included_in_rent BGE with no account → EXCEPTION NO_BGE_ACCOUNT', () => {
  const d = decision(prop({ responsibility: { bge: 'included_in_rent', water: 'tenant' }, bge_accounts: [] }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.NO_BGE_ACCOUNT);
});

test('PAY without a water account number → EXCEPTION NO_WATER_ACCOUNT', () => {
  const d = decision(prop({
    water_accounts: [{ unit_id: 10, unit_name: '1', water_account_number: null }],
  }), 'water');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.NO_WATER_ACCOUNT);
});

test('SKIP BGE without accounts stays SKIP (nothing to pay)', () => {
  const d = decision(prop({ bge_accounts: [] }), 'bge');
  expect(d.decision).toBe('SKIP');
});

// ─── Manual overrides ────────────────────────────────────────────────────────

test('Podio override "skip" → SKIP, trumps every other flag', () => {
  const d = decision(prop({
    responsibility: { bge: 'landlord', water: 'landlord' },
    manual_overrides: [{ source: 'podio', field: 'override', value: 'skip' }],
  }), 'bge');
  expect(d.decision).toBe('SKIP');
  expect(d.reason_code).toBe(REASON.MANUAL_OVERRIDE_SKIP);
});

test('Podio override scoped "pay water" only affects water', () => {
  const p = prop({ manual_overrides: [{ source: 'podio', field: 'override', value: 'pay water' }] });
  expect(decision(p, 'water').reason_code).toBe(REASON.MANUAL_OVERRIDE_PAY);
  expect(decision(p, 'bge').reason_code).toBe(REASON.TENANT_OCCUPIED); // untouched
});

test('unrecognized Podio override → EXCEPTION for review', () => {
  const d = decision(prop({
    manual_overrides: [{ source: 'podio', field: 'override', value: 'tenant moving out 6/15??' }],
  }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.MANUAL_OVERRIDE_REVIEW);
});

// ─── June 12: PS account and landlord-unit BGE ───────────────────────────────

test('PS / common-area BGE account → PAY PS_ACCOUNT_LANDLORD', () => {
  const d = decision(prop({ is_ps_account: true }), 'bge');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.PS_ACCOUNT_LANDLORD);
});

test('landlord BGE responsibility on unit (no PS flag) → EXCEPTION LANDLORD_BGE_UNIT', () => {
  const d = decision(prop({ responsibility: { bge: 'landlord', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('EXCEPTION');
  expect(d.reason_code).toBe(REASON.LANDLORD_BGE_UNIT);
});

// ─── June 12: Lifecycle-landlord-stage routing ───────────────────────────────
// acquisition / renovation / rent_ready → PAY LIFECYCLE_LANDLORD_STAGE for both
// utilities, regardless of the responsibility flag.

test('renovation lifecycle → PAY LIFECYCLE_LANDLORD_STAGE for water', () => {
  const d = decision(prop({ lifecycle_stage: 'renovation', occupancy: 'vacant',
    responsibility: { bge: 'tenant', water: 'tenant' } }), 'water');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.LIFECYCLE_LANDLORD_STAGE);
});

test('renovation lifecycle → PAY LIFECYCLE_LANDLORD_STAGE for BGE', () => {
  const d = decision(prop({ lifecycle_stage: 'renovation', occupancy: 'vacant',
    responsibility: { bge: 'tenant', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.LIFECYCLE_LANDLORD_STAGE);
});

test('acquisition lifecycle → PAY LIFECYCLE_LANDLORD_STAGE for both utilities', () => {
  const p = prop({ lifecycle_stage: 'acquisition', occupancy: 'vacant',
    responsibility: { bge: 'tenant', water: 'tenant' } });
  const r = routeProperty(p);
  for (const d of r.decisions) {
    expect(d.decision).toBe('PAY');
    expect(d.reason_code).toBe(REASON.LIFECYCLE_LANDLORD_STAGE);
  }
});

test('rent_ready lifecycle → PAY LIFECYCLE_LANDLORD_STAGE for both utilities', () => {
  const p = prop({ lifecycle_stage: 'rent_ready', occupancy: 'vacant',
    responsibility: { bge: 'tenant', water: 'tenant' } });
  const r = routeProperty(p);
  for (const d of r.decisions) {
    expect(d.decision).toBe('PAY');
    expect(d.reason_code).toBe(REASON.LIFECYCLE_LANDLORD_STAGE);
  }
});

// ─── June 12: Water is unconditional PAY (lien rule) ────────────────────────
// Water lien fires after disposed+lifecycle-stage checks, before BGE logic.

test('tenant + occupied water → PAY WATER_LIEN_PAY', () => {
  const d = decision(prop(), 'water');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.WATER_LIEN_PAY);
});

test('unknown water responsibility → PAY WATER_LIEN_PAY (lien supersedes)', () => {
  const d = decision(prop({ responsibility: { bge: 'tenant', water: 'unknown' } }), 'water');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.WATER_LIEN_PAY);
});

// ─── BGE tenant + vacant (off-stage) → VACANT_REVERTS_TO_LANDLORD ───────────
// This only fires for BGE when lifecycle_stage is NOT a landlord stage
// (acquisition/renovation/rent_ready) — those hit LIFECYCLE_LANDLORD_STAGE first.

test('tenant + vacant BGE (non-landlord-stage) → PAY VACANT_REVERTS_TO_LANDLORD', () => {
  const d = decision(prop({ lifecycle_stage: 'active', occupancy: 'vacant',
    responsibility: { bge: 'tenant', water: 'tenant' } }), 'bge');
  expect(d.decision).toBe('PAY');
  expect(d.reason_code).toBe(REASON.VACANT_REVERTS_TO_LANDLORD);
});

// ─── BGE on occupied → occupancy-check trigger ───────────────────────────────
// When BGE responsibility resolves to LANDLORD_BGE_UNIT on an occupied property,
// routeProperty sets occupancy_check_required = true.

test('BGE landlord on occupied → occupancy_check_required true', () => {
  const p = prop({ responsibility: { bge: 'landlord', water: 'tenant' },
    occupancy: 'occupied', lifecycle_stage: 'active' });
  const r = routeProperty(p);
  expect(r.occupancy_check_required).toBe(true);
});

test('BGE tenant on occupied → occupancy_check_required false', () => {
  const r = routeProperty(prop());
  expect(r.occupancy_check_required).toBe(false);
});

test('BGE landlord on vacant → occupancy_check_required false (only fires on occupied)', () => {
  const p = prop({ responsibility: { bge: 'landlord', water: 'tenant' },
    occupancy: 'vacant', lifecycle_stage: 'active' });
  // vacant non-landlord-stage: BGE → LANDLORD_BGE_UNIT... but occupancy is vacant
  // Actually with 'active' lifecycle + 'vacant' occupancy + landlord resp:
  // lifecycle not a landlord stage, not disposed; water-lien for water; BGE hits
  // the responsibility switch → landlord → LANDLORD_BGE_UNIT; but occupancy=vacant ≠ occupied
  const r = routeProperty(p);
  expect(r.occupancy_check_required).toBe(false);
});

// ─── Consumption anomalies ───────────────────────────────────────────────────
// Baseline used: 20 (2 adults × 10). Thresholds: LETTER ≥ 1.5× = 30, LETTER_PLUS_WORKORDER ≥ 3× = 60.

const baselineProp = (occupancy: 'occupied' | 'vacant', lifecycle = occupancy === 'vacant' ? 'renovation' : 'active') =>
  prop({
    occupancy,
    lifecycle_stage: lifecycle,
    responsibility: { bge: 'tenant', water: 'landlord' },
    consumption_baselines: [{ unit_id: 10, utility_type: 'water', period_unit: 'quarterly', baseline_amount: 20 }],
  });

// Helper with explicit adults/children for occupant-derived baseline.
function tieredProp(adults: number, children: number): PropertyRoutingInput {
  return prop({
    occupancy: 'occupied',
    lifecycle_stage: 'active',
    responsibility: { bge: 'tenant', water: 'landlord' },
    occupant_adults: adults,
    occupant_children: children,
    consumption_baselines: [{ unit_id: 10, utility_type: 'water', period_unit: 'quarterly', baseline_amount: null }],
  });
}

test('occupied ≥3× expected → SEVERE POSSIBLE_LEAK, contract_tier LETTER_PLUS_WORKORDER', () => {
  // 2 adults = expected 20; 3× = 60; reading 70 → SEVERE
  const a = detectAnomalies(baselineProp('occupied'), new Map([[10, 70]]), DEFAULT_CONFIG);
  expect(a[0]?.kind).toBe('POSSIBLE_LEAK');
  expect(a[0]?.tier).toBe('SEVERE');
  expect(a[0]?.contract_tier).toBe('LETTER_PLUS_WORKORDER');
});

test('occupied between 1.5× and 3× expected → MODERATE_SPIKE, contract_tier LETTER', () => {
  // expected 20; 35 = 1.75× → LETTER
  const a = detectAnomalies(baselineProp('occupied'), new Map([[10, 35]]), DEFAULT_CONFIG);
  expect(a[0]?.kind).toBe('MODERATE_SPIKE');
  expect(a[0]?.tier).toBe('MODERATE');
  expect(a[0]?.contract_tier).toBe('LETTER');
});

test('occupied near expected → no anomaly; no reading → no anomaly', () => {
  expect(detectAnomalies(baselineProp('occupied'), new Map([[10, 22]]), DEFAULT_CONFIG)).toHaveLength(0);
  expect(detectAnomalies(baselineProp('occupied'), new Map(), DEFAULT_CONFIG)).toHaveLength(0);
});

test('SEVERE anomaly escalates a water PAY to EXCEPTION ANOMALY_SEVERE', () => {
  const r = routeProperty(baselineProp('occupied'), DEFAULT_CONFIG, new Map([[10, 70]]));
  const water = r.decisions.find(d => d.utility === 'water')!;
  expect(water.decision).toBe('EXCEPTION');
  expect(water.reason_code).toBe(REASON.ANOMALY_SEVERE);
});

test('MODERATE anomaly keeps the PAY routing but is reported', () => {
  const r = routeProperty(baselineProp('occupied'), DEFAULT_CONFIG, new Map([[10, 35]]));
  expect(r.decisions.find(d => d.utility === 'water')!.decision).toBe('PAY');
  expect(r.anomalies).toHaveLength(1);
});

// ─── June 12: Consumption tiers — exact boundaries (1.5× and 3×) ────────────
// Uses adult/child occupant counts: adults×10 + children×5.
// 2 adults → expected = 20. 1.5× = 30, 3× = 60.

test('consumption exactly at 1.5× expected boundary → LETTER (MODERATE_SPIKE)', () => {
  const a = detectAnomalies(baselineProp('occupied'), new Map([[10, 30]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('MODERATE');
  expect(a[0].kind).toBe('MODERATE_SPIKE');
  expect(a[0].contract_tier).toBe('LETTER');
});

test('consumption just below 1.5× boundary → NORMAL (no anomaly)', () => {
  const a = detectAnomalies(baselineProp('occupied'), new Map([[10, 29]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(0);
});

test('consumption exactly at 3× expected boundary → LETTER_PLUS_WORKORDER (SEVERE)', () => {
  const a = detectAnomalies(baselineProp('occupied'), new Map([[10, 60]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('SEVERE');
  expect(a[0].kind).toBe('POSSIBLE_LEAK');
  expect(a[0].contract_tier).toBe('LETTER_PLUS_WORKORDER');
});

test('adult/child baseline: 2 adults + 1 child → expected 25; 1.5× = 37.5 so reading 38 → LETTER', () => {
  // 2×10 + 1×5 = 25; 1.5×25 = 37.5; 38 ≥ 37.5 → LETTER
  const p = tieredProp(2, 1);
  const a = detectAnomalies(p, new Map([[10, 38]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('MODERATE');
  expect(a[0].contract_tier).toBe('LETTER');
  expect(a[0].baseline).toBe(25);
});

test('adult/child baseline: 1 adult + 2 children → expected 20; 3× = 60; reading 60 → LETTER_PLUS_WORKORDER', () => {
  // 1×10 + 2×5 = 20; 3×20 = 60
  const p = tieredProp(1, 2);
  const a = detectAnomalies(p, new Map([[10, 60]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('SEVERE');
  expect(a[0].contract_tier).toBe('LETTER_PLUS_WORKORDER');
  expect(a[0].baseline).toBe(20);
});

// ─── Vacant consumption thresholds ───────────────────────────────────────────
// Default: vacantMaxUsage = 10; renovation: renovationVacantMaxUsage = 30.

test('vacant (non-renovation) unit usage ≤ 10 → no anomaly', () => {
  const p = baselineProp('vacant', 'active');   // lifecycle 'active', occupancy 'vacant'
  expect(detectAnomalies(p, new Map([[10, 9]]), DEFAULT_CONFIG)).toHaveLength(0);
});

test('vacant (non-renovation) unit usage > 10 → SEVERE VACANT_USAGE LETTER_PLUS_WORKORDER', () => {
  const p = baselineProp('vacant', 'active');
  const a = detectAnomalies(p, new Map([[10, 11]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('SEVERE');
  expect(a[0].kind).toBe('VACANT_USAGE');
  expect(a[0].contract_tier).toBe('LETTER_PLUS_WORKORDER');
});

test('renovation vacant unit: raised ceiling = 30; usage 25 → no anomaly', () => {
  // 'renovation' lifecycle → renovationVacantMaxUsage = 30
  const p = baselineProp('vacant', 'renovation');
  expect(detectAnomalies(p, new Map([[10, 25]]), DEFAULT_CONFIG)).toHaveLength(0);
});

test('renovation vacant unit: usage > 30 → SEVERE VACANT_USAGE', () => {
  const p = baselineProp('vacant', 'renovation');
  const a = detectAnomalies(p, new Map([[10, 31]]), DEFAULT_CONFIG);
  expect(a).toHaveLength(1);
  expect(a[0].tier).toBe('SEVERE');
  expect(a[0].kind).toBe('VACANT_USAGE');
});

test('renovation raises vacant threshold via config (custom renovationVacantMaxUsage = 50)', () => {
  const p = baselineProp('vacant', 'renovation');
  const customCfg = { ...DEFAULT_CONFIG, renovationVacantMaxUsage: 50 };
  // 31 is below 50 → no anomaly with custom config
  expect(detectAnomalies(p, new Map([[10, 31]]), customCfg)).toHaveLength(0);
  // 31 is above default 30 → anomaly with default config
  expect(detectAnomalies(p, new Map([[10, 31]]), DEFAULT_CONFIG)).toHaveLength(1);
});

// ─── Letters and work orders ──────────────────────────────────────────────────

test('LETTER tier anomaly → one letter, zero work orders', () => {
  // reading 35, expected 20 → LETTER (1.75×)
  const r = routeProperty(baselineProp('occupied'), DEFAULT_CONFIG, new Map([[10, 35]]));
  expect(r.letters).toHaveLength(1);
  expect(r.work_orders).toHaveLength(0);
  expect(r.letters[0].tier).toBe('LETTER');
});

test('LETTER_PLUS_WORKORDER tier anomaly → one letter + one work order', () => {
  // reading 70, expected 20 → LETTER_PLUS_WORKORDER (3.5×)
  const r = routeProperty(baselineProp('occupied'), DEFAULT_CONFIG, new Map([[10, 70]]));
  // Note: water PAY is escalated to EXCEPTION by SEVERE anomaly, but letters/work_orders still built
  expect(r.letters).toHaveLength(1);
  expect(r.work_orders).toHaveLength(1);
  expect(r.letters[0].tier).toBe('LETTER_PLUS_WORKORDER');
});

test('water_billable false → letter responsibility is landlord', () => {
  const p = prop({
    water_billable: false,
    consumption_baselines: [{ unit_id: 10, utility_type: 'water', period_unit: 'quarterly', baseline_amount: 20 }],
  });
  const r = routeProperty(p, DEFAULT_CONFIG, new Map([[10, 35]]));
  expect(r.letters[0].responsibility).toBe('landlord');
});

test('water_billable true (or absent) → letter responsibility is tenant', () => {
  const p = prop({
    water_billable: true,
    consumption_baselines: [{ unit_id: 10, utility_type: 'water', period_unit: 'quarterly', baseline_amount: 20 }],
  });
  const r = routeProperty(p, DEFAULT_CONFIG, new Map([[10, 35]]));
  expect(r.letters[0].responsibility).toBe('tenant');
});

test('no anomaly → zero letters and zero work orders', () => {
  const r = routeProperty(baselineProp('occupied'), DEFAULT_CONFIG, new Map([[10, 22]]));
  expect(r.letters).toHaveLength(0);
  expect(r.work_orders).toHaveLength(0);
});

// ─── Decision-tree audit trail ───────────────────────────────────────────────
// Every UtilityDecision must carry a non-empty trail[] and every
// PropertyRoutingResult a non-empty decision_summary string.

test('every PAY decision carries a non-empty trail and detail', () => {
  const r = routeProperty(prop({ is_ps_account: true }));
  for (const d of r.decisions) {
    expect(d.trail.length).toBeGreaterThan(0);
    expect(d.detail).toBeTruthy();
  }
});

test('every SKIP decision carries a non-empty trail and detail', () => {
  const r = routeProperty(prop());
  const bge = r.decisions.find(d => d.utility === 'bge')!;
  expect(bge.decision).toBe('SKIP');
  expect(bge.trail.length).toBeGreaterThan(0);
  expect(bge.detail).toBeTruthy();
});

test('every EXCEPTION decision carries a non-empty trail and detail', () => {
  const r = routeProperty(prop({ responsibility: { bge: 'unknown', water: 'tenant' } }));
  const bge = r.decisions.find(d => d.utility === 'bge')!;
  expect(bge.decision).toBe('EXCEPTION');
  expect(bge.trail.length).toBeGreaterThan(0);
  expect(bge.detail).toBeTruthy();
});

test('every result carries a non-empty decision_summary string', () => {
  const cases = [
    prop({ is_ps_account: true }),
    prop(),
    prop({ responsibility: { bge: 'unknown', water: 'tenant' } }),
  ];
  for (const p of cases) {
    const r = routeProperty(p);
    expect(r.decision_summary).toBeTruthy();
    expect(r.decision_summary.length).toBeGreaterThan(0);
  }
});

test('routeAll: every property result has decisions with trail and detail', () => {
  const payload: WS2Payload = {
    run_id: 'trail-test', generated_at: new Date().toISOString(),
    source: { appfolio: 'db', podio: 'absent', quickbooks_csv_ingested: 0 },
    property_count: 3,
    properties: [
      prop({ property_id: 1, is_ps_account: true }),
      prop({ property_id: 2 }),
      prop({ property_id: 3, responsibility: { bge: 'unknown', water: 'unknown' } }),
    ],
  };
  const run = routeAll(payload);
  for (const result of run.results) {
    for (const d of result.decisions) {
      expect(d.trail.length).toBeGreaterThan(0);
      expect(d.detail).toBeTruthy();
    }
    expect(result.decision_summary).toBeTruthy();
  }
});

// ─── Buckets, totals, config ─────────────────────────────────────────────────

test('buckets: PS BGE + tenant water occupied → BGE-pay and Water-pay', () => {
  const r = routeProperty(prop({ is_ps_account: true }));
  expect(r.buckets).toContain('BGE-pay');
  expect(r.buckets).toContain('Water-pay');
});

test('buckets: tenant BGE occupied + tenant water → Tenant-skip and Water-pay', () => {
  const r = routeProperty(prop());
  expect(r.buckets).toContain('Tenant-skip'); // BGE SKIP
  expect(r.buckets).toContain('Water-pay');   // water lien PAY
});

test('buckets: landlord BGE (no PS) → Exception bucket', () => {
  const r = routeProperty(prop({ responsibility: { bge: 'landlord', water: 'tenant' } }));
  expect(r.buckets).toContain('Exception'); // LANDLORD_BGE_UNIT
});

test('routeAll totals add up across properties', () => {
  // prop1: is_ps_account → BGE PAY (bge_pay+1) + water PAY (water_pay+1)
  // prop2: tenant occupied → BGE SKIP (tenant_skip+1) + water PAY (water_pay+1)
  // prop3: unknown BGE + tenant water → BGE EXCEPTION (exception+1) + water PAY (water_pay+1)
  const payload: WS2Payload = {
    run_id: 'ws1-test', generated_at: new Date().toISOString(),
    source: { appfolio: 'db', podio: 'absent', quickbooks_csv_ingested: 0 },
    property_count: 3,
    properties: [
      prop({ property_id: 1, is_ps_account: true }),
      prop({ property_id: 2 }),
      prop({ property_id: 3, responsibility: { bge: 'unknown', water: 'tenant' } }),
    ],
  };
  const run = routeAll(payload);
  expect(run.totals.bge_pay).toBe(1);
  expect(run.totals.water_pay).toBe(3);
  expect(run.totals.tenant_skip).toBe(1);
  expect(run.totals.exception).toBe(1);
  expect(run.totals.anomalies).toBe(0);
  expect(run.totals.letters).toBe(0);
  expect(run.totals.work_orders).toBe(0);
  expect(run.totals.occupancy_checks).toBe(0);
});

test('routeAll totals: occupancy_checks counted when BGE landlord on occupied', () => {
  const payload: WS2Payload = {
    run_id: 'occ-test', generated_at: new Date().toISOString(),
    source: { appfolio: 'db', podio: 'absent', quickbooks_csv_ingested: 0 },
    property_count: 1,
    properties: [
      prop({ responsibility: { bge: 'landlord', water: 'tenant' },
        occupancy: 'occupied', lifecycle_stage: 'active' }),
    ],
  };
  const run = routeAll(payload);
  expect(run.totals.occupancy_checks).toBe(1);
});

test('configFromEnv honors overrides and rejects junk', () => {
  const cfg = configFromEnv({
    WS2_VACANT_MAX_USAGE: '10',
    WS2_SEVERE_SPIKE_MULTIPLIER: 'banana',
    WS2_LETTER_MULTIPLIER: '2',
  } as any);
  expect(cfg.vacantMaxUsage).toBe(10);
  expect(cfg.severeSpikeMultiplier).toBe(DEFAULT_CONFIG.severeSpikeMultiplier); // junk rejected
  expect(cfg.letterMultiplier).toBe(2);
  expect(cfg.moderateSpikeMultiplier).toBe(2); // alias kept in sync
});

// ─── Hardening: water-skip escape hatch, landlord verbiage at work-order tier ──

test('Podio "skip water" override is the only escape from water-lien PAY', () => {
  // Override is step 1; water-lien PAY is step 4. A scoped skip is the sole way
  // a water utility ever leaves the auto-PAY path — lock that precedence.
  const d = decision(prop({
    manual_overrides: [{ source: 'podio', field: 'override', value: 'skip water' }],
  }), 'water');
  expect(d.decision).toBe('SKIP');
  expect(d.reason_code).toBe(REASON.MANUAL_OVERRIDE_SKIP);
});

test('water_billable false at >3× tier → landlord-verbiage letter AND work order both emit', () => {
  const p = prop({
    water_billable: false,
    consumption_baselines: [{ unit_id: 10, utility_type: 'water', period_unit: 'quarterly', baseline_amount: 20 }],
  });
  const r = routeProperty(p, DEFAULT_CONFIG, new Map([[10, 70]])); // 3.5× expected
  expect(r.letters).toHaveLength(1);
  expect(r.letters[0].responsibility).toBe('landlord');
  expect(r.letters[0].tier).toBe('LETTER_PLUS_WORKORDER');
  expect(r.work_orders).toHaveLength(1);
});

test('decision-trail last step reflects the final decision (not just non-empty)', () => {
  const r = routeProperty(prop()); // BGE tenant+occupied → SKIP; water → PAY
  const bge = r.decisions.find(d => d.utility === 'bge')!;
  const water = r.decisions.find(d => d.utility === 'water')!;
  expect(bge.trail[bge.trail.length - 1].outcome).toMatch(/SKIP/);
  expect(water.trail[water.trail.length - 1].outcome).toMatch(/PAY/);
});
