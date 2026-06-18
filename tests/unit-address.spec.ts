/**
 * Unit-aware addressing — parseUnitAddress() unit tests.
 * Pure-logic tests (no browser, no DB): npx playwright test tests/unit-address.spec.ts
 * Covers the splitting rules documented in helpers/utils.ts: single-unit
 * properties have no "#" marker; everything after the FIRST "#" is the unit
 * suffix; both halves are trimmed.
 */
import { test, expect } from '@playwright/test';
import { parseUnitAddress } from './helpers/utils';

// ─── Single-unit (no "#" marker) ─────────────────────────────────────────────

test('single-unit address has no suffix and is not multi-unit', () => {
  expect(parseUnitAddress('1 Glyer Ct')).toEqual({
    base: '1 Glyer Ct',
    unitSuffix: null,
    isMultiUnit: false,
  });
});

// ─── Multi-unit markers ──────────────────────────────────────────────────────

test('numeric unit suffix: "10 E Lee St #2002"', () => {
  expect(parseUnitAddress('10 E Lee St #2002')).toEqual({
    base: '10 E Lee St',
    unitSuffix: '2002',
    isMultiUnit: true,
  });
});

test('letter suffix with a space after "#": "01011 Hunter St # F3"', () => {
  expect(parseUnitAddress('01011 Hunter St # F3')).toEqual({
    base: '01011 Hunter St',
    unitSuffix: 'F3',
    isMultiUnit: true,
  });
});

test('multiple "#" characters: everything after the FIRST "#" is the suffix', () => {
  expect(parseUnitAddress('10 E Lee St #A#B')).toEqual({
    base: '10 E Lee St',
    unitSuffix: 'A#B',
    isMultiUnit: true,
  });
});

// ─── Degenerate inputs ───────────────────────────────────────────────────────

test('empty string yields empty base, no suffix', () => {
  expect(parseUnitAddress('')).toEqual({
    base: '',
    unitSuffix: null,
    isMultiUnit: false,
  });
});

test('bare trailing "#" is not a usable unit marker', () => {
  expect(parseUnitAddress('10 E Lee St #')).toEqual({
    base: '10 E Lee St',
    unitSuffix: null,
    isMultiUnit: false,
  });
});

test('trailing "#" followed only by whitespace is also not a marker', () => {
  expect(parseUnitAddress('10 E Lee St #   ')).toEqual({
    base: '10 E Lee St',
    unitSuffix: null,
    isMultiUnit: false,
  });
});

test('null / undefined input is tolerated at runtime', () => {
  // Stale cache rows may surface undefined despite the string type.
  expect(parseUnitAddress(null as any)).toEqual({
    base: '',
    unitSuffix: null,
    isMultiUnit: false,
  });
  expect(parseUnitAddress(undefined as any)).toEqual({
    base: '',
    unitSuffix: null,
    isMultiUnit: false,
  });
});

// ─── Whitespace handling ─────────────────────────────────────────────────────

test('leading/trailing whitespace is trimmed on both halves', () => {
  expect(parseUnitAddress('  10 E Lee St  #  2002  ')).toEqual({
    base: '10 E Lee St',
    unitSuffix: '2002',
    isMultiUnit: true,
  });
  expect(parseUnitAddress('   1 Glyer Ct   ')).toEqual({
    base: '1 Glyer Ct',
    unitSuffix: null,
    isMultiUnit: false,
  });
});
