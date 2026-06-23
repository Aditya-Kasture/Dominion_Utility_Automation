/**
 * WS-2 — Mid-cycle proration (Method A) unit tests.
 * Pure-logic (no browser, no DB): npx playwright test tests/ws2-proration.spec.ts
 *
 * Covers the June 19 2026 decisions: Method A only (Method C ruled out), grace
 * window 3 inclusive, renovation exclusion, $10 review threshold, and the edge
 * cases in docs/Phase2_Utility_Proration_Design.md §8.5.
 */
import { test, expect } from '@playwright/test';
import { prorate, ProrationInput } from './helpers/prorationEngine';
import { DEFAULT_CONFIG, configFromEnv } from './helpers/routingEngine';

function input(overrides: Partial<ProrationInput> = {}): ProrationInput {
  return {
    utility: 'water',
    bill_period: { start: '2026-05-01', end: '2026-05-31' }, // 31 days
    occupancy: { move_in: '2026-05-15' },                    // 17 tenant days (15–31)
    total_consumption: 31,                                   // 1 unit/day
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

test('Method A: 31-day bill, move-in May 15 → tenant 17/31 of usage', () => {
  const r = prorate(input());
  expect(r.method_used).toBe('average');
  expect(r.days_period).toBe(31);
  expect(r.days_tenant).toBe(17);
  expect(r.tenant_share).toBeCloseTo(17, 5);
  expect(r.dominion_share).toBeCloseTo(14, 5);
});

test('Method A with bill amount splits dollars and rounds in tenant favor', () => {
  const r = prorate(input({ bill_amount: 100 })); // 17/31 = $54.83 → floor $54
  expect(r.tenant_amount).toBe(54);
  expect(r.dominion_amount).toBeCloseTo(46, 5);
});

test('$10 review threshold: tenant share above $10 → needs_review', () => {
  const r = prorate(input({ bill_amount: 100 }));     // tenant ~$54
  expect(r.needs_review).toBe(true);
  const small = prorate(input({ bill_amount: 15 }));  // 17/31×15 = $8.2 → floor $8 < $10
  expect(small.tenant_amount).toBe(8);
  expect(small.needs_review).toBe(false);
});

test('grace (3 inclusive): move-in 3 days after period start → tenant owns whole stub', () => {
  // period 05/01–05/31, move-in 05/04 → 28 tenant days, gap = 3 ≤ graceDays(3).
  const r = prorate(input({ occupancy: { move_in: '2026-05-04' } }));
  expect(r.method_used).toBe('grace_whole');
  expect(r.tenant_share).toBe(31);
});

test('grace boundary: move-in 4 days after start → real Method A split (not grace)', () => {
  const r = prorate(input({ occupancy: { move_in: '2026-05-05' } })); // gap 4 > 3
  expect(r.method_used).toBe('average');
  expect(r.days_tenant).toBe(27);
});

test('grace at the other end: tenant present ≤ grace days → Dominion owns whole stub', () => {
  // move-in 05/29 → 3 tenant days ≤ graceDays(3).
  const r = prorate(input({ occupancy: { move_in: '2026-05-29' } }));
  expect(r.method_used).toBe('grace_whole');
  expect(r.tenant_share).toBe(0);
  expect(r.dominion_share).toBe(31);
});

test('move-in AND move-out in same period → tenant occupies the middle slice', () => {
  // tenant 05/10–05/20 = 11 days of 31.
  const r = prorate(input({ occupancy: { move_in: '2026-05-10', move_out: '2026-05-20' } }));
  expect(r.method_used).toBe('average');
  expect(r.days_tenant).toBe(11);
  expect(r.tenant_share).toBeCloseTo(11, 5);
});

test('renovation overlapping the tenant window is excluded from the tenant share', () => {
  // renovation 05/01–05/14, move-in 05/10. Tenant window 05/10–05/31 (22 days),
  // renovation overlap 05/10–05/14 = 5 days → tenant 17 days after exclusion.
  const r = prorate(input({
    occupancy: { move_in: '2026-05-10', renovation: { start: '2026-05-01', end: '2026-05-14' } },
  }));
  expect(r.renovation_excluded).toBe(true);
  expect(r.days_tenant).toBe(17);
  expect(r.tenant_share).toBeCloseTo(17, 5);
});

test('renovation exclusion can be turned off via config', () => {
  const cfg = { ...DEFAULT_CONFIG, renovationExcludesTenant: false };
  const r = prorate(input({
    config: cfg,
    occupancy: { move_in: '2026-05-10', renovation: { start: '2026-05-01', end: '2026-05-14' } },
  }));
  expect(r.renovation_excluded).toBe(false);
  expect(r.days_tenant).toBe(22); // full tenant window, renovation not stripped
});

test('no move dates → tenant occupied whole period, no split', () => {
  const r = prorate(input({ occupancy: {} }));
  expect(r.method_used).toBe('no_split');
  expect(r.tenant_share).toBe(31);
});

test('BGE with name-change near move → no reconciliation', () => {
  const r = prorate(input({ utility: 'bge', occupancy: { move_in: '2026-05-15', bge_name_change_near_move: true } }));
  expect(r.method_used).toBe('bge_name_change');
  expect(r.tenant_share).toBeNull();
});

test('BGE without name-change → surfaced as exception (no auto-split)', () => {
  const r = prorate(input({ utility: 'bge', occupancy: { move_in: '2026-05-15' } }));
  expect(r.method_used).toBe('bge_exception');
  expect(r.tenant_share).toBeNull();
});

test('dominion_favor rounding rounds the tenant share up', () => {
  const cfg = { ...DEFAULT_CONFIG, roundingBias: 'dominion_favor' as const };
  const r = prorate(input({ config: cfg, bill_amount: 100 })); // 54.83 → ceil 55
  expect(r.tenant_amount).toBe(55);
});

test('configFromEnv reads the June 19 knobs', () => {
  const cfg = configFromEnv({
    WS2_GRACE_DAYS: '2', WS2_REVIEW_THRESHOLD_DOLLARS: '20',
    WS2_RENOVATION_EXCLUDES_TENANT: 'false', WS2_ROUNDING_BIAS: 'nearest',
  } as NodeJS.ProcessEnv);
  expect(cfg.graceDays).toBe(2);
  expect(cfg.reviewThresholdDollars).toBe(20);
  expect(cfg.renovationExcludesTenant).toBe(false);
  expect(cfg.roundingBias).toBe('nearest');
  expect(cfg.prorationMethod).toBe('average');
});

test('default review threshold is $10 (June 19)', () => {
  expect(DEFAULT_CONFIG.reviewThresholdDollars).toBe(10);
  expect(DEFAULT_CONFIG.graceDays).toBe(3);
});
