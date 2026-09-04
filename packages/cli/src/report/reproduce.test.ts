import { describe, expect, it } from 'vitest';
import { diffFindingSets, formatReproduceResult, parameterDrift, stableJson, type FindingSignature, type ReproduceResult } from './reproduce.ts';

const sig = (over: Partial<FindingSignature> = {}): FindingSignature => ({
  fingerprint: 'aaaa1111',
  severity: 3,
  tier: 'T2',
  amountAtStake: 900,
  computed: { gap: 900, basis: 'bank' },
  ...over,
});

describe('finding diff', () => {
  it('is empty when the same set comes back', () => {
    const stored = [sig(), sig({ fingerprint: 'bbbb2222', severity: 2 })];
    expect(diffFindingSets(stored, [...stored].reverse())).toEqual([]);
  });

  it('reports a finding that the re-run no longer produces', () => {
    expect(diffFindingSets([sig()], [])).toEqual([{ kind: 'missing', fingerprint: 'aaaa1111', stored: 3 }]);
  });

  it('reports a finding the re-run produces and the run never stored', () => {
    expect(diffFindingSets([], [sig()])).toEqual([{ kind: 'unexpected', fingerprint: 'aaaa1111', recomputed: 3 }]);
  });

  it('reports severity, tier and amount changes field by field', () => {
    const diffs = diffFindingSets([sig()], [sig({ severity: 4, tier: 'T1', amountAtStake: 950 })]);
    expect(diffs.map((d) => d.field)).toEqual(['severity', 'tier', 'amount_at_stake']);
    expect(diffs[0]).toMatchObject({ kind: 'changed', stored: 3, recomputed: 4 });
  });

  it('ignores cent-level float noise in the amount but not a real change', () => {
    expect(diffFindingSets([sig({ amountAtStake: 900.004 })], [sig({ amountAtStake: 900 })])).toEqual([]);
    expect(diffFindingSets([sig({ amountAtStake: 900.01 })], [sig({ amountAtStake: 900 })])).toHaveLength(1);
  });

  it('compares the computed object by value, not by key order', () => {
    expect(diffFindingSets([sig({ computed: { a: 1, b: 2 } })], [sig({ computed: { b: 2, a: 1 } })])).toEqual([]);
    const changed = diffFindingSets([sig({ computed: { a: 1 } })], [sig({ computed: { a: 2 } })]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.field).toBe('computed');
  });

  it('reports several fingerprints in a stable order', () => {
    const diffs = diffFindingSets([sig({ fingerprint: 'zzzz' }), sig({ fingerprint: 'aaaa' })], []);
    expect(diffs.map((d) => d.fingerprint)).toEqual(['aaaa', 'zzzz']);
  });
});

describe('stable json', () => {
  it('sorts keys at every depth so equal structures serialise equally', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
  });
});

describe('parameter drift', () => {
  const snapshot = [
    { key: 'cash_limit', value_num: '1000', version: 2 },
    { key: 'pm_ordinary', value_num: '335', version: 1 },
  ];

  it('is empty when nothing was added since the run', () => {
    expect(parameterDrift(snapshot, snapshot)).toEqual([]);
  });

  it('reports a newer version of a parameter the run used', () => {
    const drift = parameterDrift(snapshot, [
      { key: 'cash_limit', value_num: '1000', version: 3 },
      { key: 'pm_ordinary', value_num: '335', version: 1 },
    ]);
    expect(drift).toEqual([{ key: 'cash_limit', snapshotVersion: 2, currentVersion: 3, snapshotValue: '1000', currentValue: '1000' }]);
  });

  it('reports a value change and a parameter the run never saw', () => {
    const drift = parameterDrift(snapshot, [
      { key: 'cash_limit', value_num: '1000', version: 2 },
      { key: 'outflow_min', value_num: '300', version: 1 },
      { key: 'pm_ordinary', value_num: '400', version: 1 },
    ]);
    expect(drift.map((d) => d.key)).toEqual(['outflow_min', 'pm_ordinary']);
    expect(drift[0]?.snapshotVersion).toBeNull();
  });

  it('treats numerically equal values written differently as unchanged', () => {
    expect(parameterDrift([{ key: 'pm_works', value_num: '1000.00', version: 1 }], [{ key: 'pm_works', value_num: '1000', version: 1 }])).toEqual([]);
  });
});

describe('report formatting', () => {
  const base: ReproduceResult = {
    reportId: 'r1',
    kind: 'auditor_es',
    pack: 'auditor',
    lang: 'es',
    communityId: 'c1',
    findingRunId: 'run1',
    generatedOn: '2026-09-04',
    canonicalExpected: 'aaa',
    canonicalActual: 'aaa',
    canonicalMatches: true,
    parameterDrift: [],
    findingDiffs: [],
    ok: true,
  };

  it('says the diff is empty when all three comparisons agree', () => {
    const lines = formatReproduceResult(base);
    expect(lines).toContain('document: identical');
    expect(lines).toContain('findings: identical');
    expect(lines).toContain('reproduce: empty diff');
  });

  it('blocks distribution and prints each difference when anything differs', () => {
    const lines = formatReproduceResult({
      ...base,
      canonicalActual: 'bbb',
      canonicalMatches: false,
      findingDiffs: [{ kind: 'missing', fingerprint: 'aaaa1111bbbb' }],
      parameterDrift: [{ key: 'cash_limit', snapshotVersion: 2, currentVersion: 3, snapshotValue: '1000', currentValue: '900' }],
      ok: false,
    });
    expect(lines.join('\n')).toContain('document: DIFFERS');
    expect(lines.join('\n')).toContain('findings: aaaa1111bbbb missing');
    expect(lines.join('\n')).toContain('parameters: cash_limit snapshot v2 = 1000 · current v3 = 900');
    expect(lines.at(-1)).toBe('reproduce: NON-EMPTY DIFF — do not distribute');
  });
});
