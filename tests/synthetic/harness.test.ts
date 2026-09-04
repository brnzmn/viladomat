import { describe, expect, it } from 'vitest';
import {
  compareFields,
  checkPlanted,
  wilsonLower95,
  type ExpectedField,
  type ExtractedField,
  type PlantedItem,
  type FindingLike,
} from './harness.ts';

describe('wilsonLower95', () => {
  it('is 0 for zero trials', () => {
    expect(wilsonLower95(0, 0)).toBe(0);
  });
  it('is well below the point estimate for a small perfect sample (does not overstate confidence)', () => {
    const lower = wilsonLower95(5, 5);
    expect(lower).toBeGreaterThan(0.4);
    expect(lower).toBeLessThan(1);
  });
  it('increases toward the point estimate as n grows, for a fixed accuracy', () => {
    const small = wilsonLower95(9, 10);
    const big = wilsonLower95(900, 1000);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(0.9);
  });
  it('never exceeds k/n', () => {
    expect(wilsonLower95(7, 10)).toBeLessThanOrEqual(0.7);
  });
});

describe('compareFields', () => {
  const expected: ExpectedField[] = [
    { doc: 'inv-1', path: 'total', type: 'amount', value: 1234.56 },
    { doc: 'inv-1', path: 'issuer_nif', type: 'nif', value: 'B12345674' },
    { doc: 'inv-1', path: 'date', type: 'date', value: '2026-05-05' },
    { doc: 'inv-1', path: 'issuer_iban', type: 'iban', value: 'ES9121000418450200051332' },
    { doc: 'inv-2', path: 'total', type: 'amount', value: 500 },
    { doc: 'inv-2', path: 'date', type: 'date', value: '2026-05-02' },
  ];

  it('is 100% when every field matches after normalisation, even with cosmetic formatting differences', () => {
    const extracted: ExtractedField[] = [
      { doc: 'inv-1', path: 'total', value: '1.234,56' }, // Spanish-formatted, same value
      { doc: 'inv-1', path: 'issuer_nif', value: 'b 12345674' }, // lower-case, spaced
      { doc: 'inv-1', path: 'date', value: '05/05/2026' }, // dd/mm/yyyy vs ISO
      { doc: 'inv-1', path: 'issuer_iban', value: 'ES91 2100 0418 4502 0005 1332' }, // spaced
      { doc: 'inv-2', path: 'total', value: 500 },
      { doc: 'inv-2', path: 'date', value: '2026-05-02' },
    ];
    const result = compareFields(expected, extracted);
    expect(result.overall.accuracy).toBe(1);
    expect(result.mismatches).toHaveLength(0);
    for (const t of result.byType) expect(t.accuracy).toBe(1);
  });

  it('counts a missing extracted field as incorrect, not skipped', () => {
    const extracted: ExtractedField[] = expected
      .filter((f) => !(f.doc === 'inv-2' && f.path === 'date'))
      .map((f) => ({ doc: f.doc, path: f.path, value: f.value }));
    const result = compareFields(expected, extracted);
    expect(result.overall.n).toBe(6);
    expect(result.overall.correct).toBe(5);
    expect(result.mismatches).toEqual([
      { doc: 'inv-2', path: 'date', type: 'date', expected: '2026-05-02', extracted: undefined },
    ]);
  });

  it('flags a genuine value mismatch and buckets accuracy per field type', () => {
    const extracted: ExtractedField[] = [
      { doc: 'inv-1', path: 'total', value: 1234.56 },
      { doc: 'inv-1', path: 'issuer_nif', value: 'B12345674' },
      { doc: 'inv-1', path: 'date', value: '2026-05-05' },
      { doc: 'inv-1', path: 'issuer_iban', value: 'ES9121000418450200051332' },
      { doc: 'inv-2', path: 'total', value: 450 }, // wrong
      { doc: 'inv-2', path: 'date', value: '2026-05-02' },
    ];
    const result = compareFields(expected, extracted);
    const amountReport = result.byType.find((t) => t.fieldType === 'amount');
    expect(amountReport?.n).toBe(2);
    expect(amountReport?.correct).toBe(1);
    expect(amountReport?.accuracy).toBe(0.5);
    // amount is the only type with an error; the other three types are perfect.
    for (const t of result.byType) {
      if (t.fieldType !== 'amount') expect(t.accuracy).toBe(1);
    }
    expect(result.mismatches).toEqual([
      { doc: 'inv-2', path: 'total', type: 'amount', expected: 500, extracted: 450 },
    ]);
  });

  it('returns NaN accuracy (not a throw) for an empty input', () => {
    const result = compareFields([], []);
    expect(result.overall.n).toBe(0);
    expect(Number.isNaN(result.overall.accuracy)).toBe(true);
    expect(result.overall.wilsonLower95).toBe(0);
    expect(result.byType).toHaveLength(0);
  });
});

describe('checkPlanted', () => {
  const planted: PlantedItem[] = [
    { id: 'C3-duplicate-invoice', rules: ['C3'], event_key: 'dup:vendor-a:4598.00' },
    { id: 'D4E2-advance-before-acta', rules: ['D4', 'E2'], event_key: 'tx:advance:2026-05-04' },
    { id: 'D2-cash-withdrawal', rules: ['D2'], event_key: 'tx:cash:2026-05-20' },
  ];

  it('reports a clean run (one finding per planted event, nothing else) as fully detected with no extras', () => {
    const findings: FindingLike[] = [
      { ruleCode: 'C3', eventKey: 'dup:vendor-a:4598.00' },
      { ruleCode: 'D4', eventKey: 'tx:advance:2026-05-04' }, // D4/E2 already collapsed to one hit
      { ruleCode: 'D2', eventKey: 'tx:cash:2026-05-20' },
    ];
    const result = checkPlanted(planted, findings);
    expect(result.missed).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
    expect(result.detected).toHaveLength(3);
    for (const d of result.detected) expect(d.collapsedToOne).toBe(true);
  });

  it('flags a planted item with no matching finding as missed', () => {
    const findings: FindingLike[] = [{ ruleCode: 'C3', eventKey: 'dup:vendor-a:4598.00' }];
    const result = checkPlanted(planted, findings);
    expect(result.detected.map((d) => d.plantedId)).toEqual(['C3-duplicate-invoice']);
    expect(result.missed.map((m) => m.plantedId).sort()).toEqual(['D2-cash-withdrawal', 'D4E2-advance-before-acta']);
  });

  it('flags a finding on an event key outside the planted list as extra (a false positive)', () => {
    const findings: FindingLike[] = [
      { ruleCode: 'C3', eventKey: 'dup:vendor-a:4598.00' },
      { ruleCode: 'D4', eventKey: 'tx:advance:2026-05-04' },
      { ruleCode: 'D2', eventKey: 'tx:cash:2026-05-20' },
      { ruleCode: 'D1', eventKey: 'tx:some-clean-transfer' }, // not planted -> should be clean
    ];
    const result = checkPlanted(planted, findings);
    expect(result.extra).toEqual([{ ruleCode: 'D1', eventKey: 'tx:some-clean-transfer' }]);
    expect(result.missed).toHaveLength(0);
  });

  it('detects but flags collapsedToOne=false when a planted event still carries more than one finding', () => {
    const findings: FindingLike[] = [
      { ruleCode: 'D4', eventKey: 'tx:advance:2026-05-04' },
      { ruleCode: 'E2', eventKey: 'tx:advance:2026-05-04' }, // not collapsed — two hits, same event
      { ruleCode: 'C3', eventKey: 'dup:vendor-a:4598.00' },
      { ruleCode: 'D2', eventKey: 'tx:cash:2026-05-20' },
    ];
    const result = checkPlanted(planted, findings);
    const advance = result.detected.find((d) => d.plantedId === 'D4E2-advance-before-acta');
    expect(advance?.collapsedToOne).toBe(false);
    expect(advance?.findingCount).toBe(2);
    expect(advance?.matchedRules.sort()).toEqual(['D4', 'E2']);
  });
});
