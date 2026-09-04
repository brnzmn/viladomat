import { describe, expect, it } from 'vitest';
import {
  chainIndex,
  indexFactor,
  indexSegments,
  indexVariation,
  observationAt,
  type IndexObservation,
} from './indexation.ts';

const SINGLE_BASE: IndexObservation[] = [
  { period: '2021-01-01', value: 100, base: '2021=100' },
  { period: '2022-01-01', value: 106.2, base: '2021=100' },
  { period: '2023-01-01', value: 112.5, base: '2021=100' },
];

/** Old base to 2025, new base from 2025, overlapping in January 2025. */
const REBASED: IndexObservation[] = [
  { period: '2023-01-01', value: 112.5, base: '2021=100' },
  { period: '2024-01-01', value: 116.0, base: '2021=100' },
  { period: '2025-01-01', value: 120.0, base: '2021=100' },
  { period: '2025-01-01', value: 100, base: '2025=100' },
  { period: '2026-01-01', value: 103.5, base: '2025=100' },
];

describe('indexSegments', () => {
  it('keeps one segment when the base never changes', () => {
    expect(indexSegments(SINGLE_BASE)).toHaveLength(1);
  });

  it('splits on a change of base', () => {
    const segments = indexSegments(REBASED);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(3);
    expect(segments[1]).toHaveLength(2);
  });
});

describe('chainIndex', () => {
  it('leaves a single-base series alone', () => {
    const chained = chainIndex(SINGLE_BASE);
    expect(chained?.map((o) => o.value)).toEqual([100, 106.2, 112.5]);
  });

  it('re-expresses the old base on the new one through the overlapping period', () => {
    const chained = chainIndex(REBASED);
    expect(chained).not.toBeNull();
    const byPeriod = new Map(chained?.map((o) => [o.period, o.value]));
    // 120 on the old base is 100 on the new one, so the factor is 100/120
    expect(byPeriod.get('2023-01-01')).toBeCloseTo(93.75, 6);
    expect(byPeriod.get('2024-01-01')).toBeCloseTo(96.667, 3);
    expect(byPeriod.get('2026-01-01')).toBe(103.5);
    expect(chained?.every((o) => o.base === '2025=100')).toBe(true);
  });

  it('uses an explicit link factor when the segments do not overlap', () => {
    const disjoint: IndexObservation[] = [
      { period: '2023-01-01', value: 112.5, base: '2021=100' },
      { period: '2026-01-01', value: 103.5, base: '2025=100' },
    ];
    expect(chainIndex(disjoint)).toBeNull();
    const chained = chainIndex(disjoint, { links: { '2021=100': 100 / 120 } });
    expect(chained?.[0]?.value).toBeCloseTo(93.75, 6);
  });

  it('returns an empty series unchanged', () => {
    expect(chainIndex([])).toEqual([]);
  });
});

describe('observationAt', () => {
  it('takes the latest observation on or before the date', () => {
    expect(observationAt(SINGLE_BASE, '2022-06-30')?.period).toBe('2022-01-01');
    expect(observationAt(SINGLE_BASE, '2022-01-01')?.period).toBe('2022-01-01');
    expect(observationAt(SINGLE_BASE, '2020-12-31')).toBeUndefined();
  });
});

describe('indexFactor', () => {
  it('divides two values of the same base', () => {
    expect(indexFactor(SINGLE_BASE, '2021-03-01', '2023-05-01')).toBeCloseTo(1.125, 6);
  });

  it('handles a rebase between the two dates', () => {
    // 112.5 -> 103.5 on the old base scale is 112.5 -> 124.2, i.e. +10.4%
    const factor = indexFactor(REBASED, '2023-06-01', '2026-06-01');
    expect(factor).toBeCloseTo(103.5 / 93.75, 6);
  });

  it('returns null when an endpoint has no observation', () => {
    expect(indexFactor(SINGLE_BASE, '2019-01-01', '2023-01-01')).toBeNull();
    expect(indexFactor([], '2021-01-01', '2023-01-01')).toBeNull();
  });

  it('returns null rather than 1 when the segments cannot be chained', () => {
    const disjoint: IndexObservation[] = [
      { period: '2023-01-01', value: 112.5, base: '2021=100' },
      { period: '2026-01-01', value: 103.5, base: '2025=100' },
    ];
    expect(indexFactor(disjoint, '2023-06-01', '2026-06-01')).toBeNull();
  });
});

describe('indexVariation', () => {
  it('reports the variation as a fraction', () => {
    expect(indexVariation(SINGLE_BASE, '2021-01-01', '2022-01-01')).toBeCloseTo(0.062, 6);
    expect(indexVariation(SINGLE_BASE, '2019-01-01', '2022-01-01')).toBeNull();
  });
});
