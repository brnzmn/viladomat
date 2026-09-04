import { describe, expect, it } from 'vitest';
import {
  defaultParameters,
  requireParameterValue,
  resolveParameter,
  resolveParameterValue,
  type Parameter,
} from './parameters.ts';

describe('resolveParameter', () => {
  const params: Parameter[] = [
    { key: 'x', valueNum: 1, version: 1, validFrom: '1900-01-01' },
    { key: 'x', valueNum: 2, version: 2, validFrom: '2021-07-11' },
    { key: 'x', valueNum: 3, version: 3, validFrom: '1900-01-01' }, // later correction of v1
    { key: 'y', valueNum: 9, version: 1, validFrom: '2030-01-01' },
  ];
  it('picks the version with the latest validFrom on or before the date', () => {
    expect(resolveParameter(params, 'x', '2022-01-01')?.valueNum).toBe(2);
    expect(resolveParameter(params, 'x', '2021-07-11')?.valueNum).toBe(2);
    expect(resolveParameter(params, 'x', '2021-07-10')?.valueNum).toBe(3);
  });
  it('breaks validFrom ties by the highest version', () => {
    expect(resolveParameter(params, 'x', '2000-01-01')?.version).toBe(3);
  });
  it('returns undefined when nothing applies', () => {
    expect(resolveParameter(params, 'y', '2022-01-01')).toBeUndefined();
    expect(resolveParameter(params, 'z', '2022-01-01')).toBeUndefined();
    expect(resolveParameterValue(params, 'y', '2022-01-01')).toBeUndefined();
    expect(() => requireParameterValue(params, 'y', '2022-01-01')).toThrow(RangeError);
    expect(requireParameterValue(params, 'y', '2031-01-01')).toBe(9);
  });
});

describe('defaultParameters', () => {
  const params = defaultParameters({ worksSpendUnderReview: 250000, ordinaryBudget: 60000 });
  const at = (key: string, date = '2023-06-01'): number => requireParameterValue(params, key, date);

  it('derives materiality from the review scope', () => {
    expect(at('pm_works')).toBe(2500);
    expect(at('pm_ordinary')).toBe(3000);
    expect(at('trivial_floor')).toBe(250); // 10% of pm_works > 200
    expect(at('funding_gap_min')).toBe(25000); // 10% of works > 5000
  });
  it('applies the floors for small scopes', () => {
    const small = defaultParameters({ worksSpendUnderReview: 10000, ordinaryBudget: 5000 });
    expect(requireParameterValue(small, 'trivial_floor', '2023-01-01')).toBe(200);
    expect(requireParameterValue(small, 'funding_gap_min', '2023-01-01')).toBe(5000);
    expect(requireParameterValue(small, 'pm_works', '2023-01-01')).toBe(100);
  });
  it('contains the fixed thresholds', () => {
    expect(at('outflow_min')).toBe(300);
    expect(at('authority_threshold')).toBe(1000);
    expect(at('upfront_max_pct_obra')).toBe(40);
    expect(at('upfront_max_pct_ascensor')).toBe(60);
    expect(at('convene_days')).toBe(30);
    expect(at('ocr_min')).toBe(1000);
  });
  it('makes the cash limit date-dependent', () => {
    expect(at('cash_limit', '2019-05-01')).toBe(2500);
    expect(at('cash_limit', '2021-07-10')).toBe(2500);
    expect(at('cash_limit', '2021-07-11')).toBe(1000);
    expect(at('cash_limit', '2024-01-01')).toBe(1000);
    expect(resolveParameter(params, 'cash_limit', '2024-01-01')?.version).toBe(2);
  });
  it('gives every parameter a basis text and a unit', () => {
    for (const p of params) {
      expect(p.basisText, p.key).toBeTruthy();
      expect(p.unit, p.key).toBeTruthy();
      expect(p.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(params.map((p) => p.key)).size).toBe(11);
  });
  it('never produces negative values from negative inputs', () => {
    const p = defaultParameters({ worksSpendUnderReview: -5, ordinaryBudget: -5 });
    expect(requireParameterValue(p, 'pm_works', '2023-01-01')).toBe(0);
    expect(requireParameterValue(p, 'trivial_floor', '2023-01-01')).toBe(200);
  });
});
