/**
 * WS-6 — digest builder unit tests.
 * Pure-logic tests (no browser, no DB): npx playwright test tests/ws6-summary.spec.ts
 * Covers buildRunDigest severity escalation + body content from a RunSummary.
 */
import { test, expect } from '@playwright/test';
import { buildRunDigest } from './helpers/outlookAlert';
import { RunSummary } from './helpers/runSummary';

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'ws1-2026-06-22T1200Z',
    bge_pay: 0, water_pay: 0, tenant_skip: 0, exception_count: 0, occupancy_checks: 0,
    severe_anomalies: 0, moderate_anomalies: 0, letters: 0, work_orders: 0,
    prorations_needing_review: 0,
    payments_confirmed: 0, payments_failed: 0, payments_skipped: 0, amount_paid_total: 0,
    bge_accounts_seen: 0, water_accounts_seen: 0,
    ...overrides,
  };
}

test('clean run → info severity', () => {
  const a = buildRunDigest(summary({ bge_pay: 5, water_pay: 3, payments_confirmed: 8 }));
  expect(a.severity).toBe('info');
  expect(a.source).toBe('WS-6 summary');
  expect(a.run_id).toBe('ws1-2026-06-22T1200Z');
});

test('exceptions / occupancy checks → warning severity', () => {
  expect(buildRunDigest(summary({ exception_count: 2 })).severity).toBe('warning');
  expect(buildRunDigest(summary({ occupancy_checks: 1 })).severity).toBe('warning');
});

test('severe anomalies or failed payments → critical severity', () => {
  expect(buildRunDigest(summary({ severe_anomalies: 1 })).severity).toBe('critical');
  expect(buildRunDigest(summary({ payments_failed: 1 })).severity).toBe('critical');
  // critical wins even when exceptions are also present
  expect(buildRunDigest(summary({ exception_count: 5, payments_failed: 1 })).severity).toBe('critical');
});

test('body + subject carry the key totals and formatted money', () => {
  const a = buildRunDigest(summary({
    bge_pay: 4, water_pay: 6, tenant_skip: 10, exception_count: 2,
    payments_confirmed: 9, amount_paid_total: 1234.5, payments_skipped: 1,
    severe_anomalies: 3, letters: 2, work_orders: 1, prorations_needing_review: 2,
  }));
  expect(a.body).toContain('BGE-pay: 4');
  expect(a.body).toContain('Water-pay: 6');
  expect(a.body).toContain('$1234.50');
  expect(a.body).toContain('3 severe');
  expect(a.body).toContain('2 split(s) need human review');
  expect(a.subject).toContain('9 paid ($1234.50)');
});

test('occupancy-check line only appears when there are checks', () => {
  expect(buildRunDigest(summary()).body).not.toContain('occupancy check(s) required');
  expect(buildRunDigest(summary({ occupancy_checks: 3 })).body).toContain('3 occupancy check(s) required');
});
