import { describe, expect, it } from 'vitest';
import {
  D5B_PER_PERIOD_TOLERANCE_EUR,
  quotaDeviations,
  quotaExpectation,
  quotaExpectationSchedule,
} from './d5b.ts';

describe('quotaExpectation', () => {
  it('splits the approved budget by quota over twelve periods', () => {
    const result = quotaExpectation({ budgetApproved: 6700, quotaPct: 6.56 });
    expect(result.periods).toBe(12);
    expect(result.ordinaryAnnual).toBe(439.52);
    expect(result.ordinaryPerPeriod).toBe(36.63);
    expect(result.extraordinaryPerPeriod).toBe(0);
    expect(result.totalPerPeriod).toBe(36.63);
    expect(result.basis).toContain('approved budget 6700 EUR');
  });

  it('adds a flat extraordinary contribution per unit', () => {
    const result = quotaExpectation({
      budgetApproved: 6700,
      quotaPct: 6.56,
      derramaRule: { kind: 'flat_per_unit', amountPerUnit: 60, months: 12 },
    });
    expect(result.extraordinaryPerPeriod).toBe(60);
    expect(result.extraordinaryTotal).toBe(720);
    expect(result.extraordinaryPeriods).toBe(12);
    expect(result.totalPerPeriod).toBe(96.63);
    expect(result.basis).toContain('flat contribution of 60 EUR');
  });

  it('distributes an extraordinary total by quota', () => {
    const result = quotaExpectation({
      budgetApproved: 6700,
      quotaPct: 6.56,
      derramaRule: { kind: 'quota', total: 60000, months: 24 },
    });
    expect(result.extraordinaryTotal).toBe(3936);
    expect(result.extraordinaryPerPeriod).toBe(164);
    expect(result.extraordinaryPeriods).toBe(24);
  });

  it('honours a different number of ordinary periods', () => {
    const result = quotaExpectation({ budgetApproved: 6700, quotaPct: 6.56, months: 4 });
    expect(result.periods).toBe(4);
    expect(result.ordinaryPerPeriod).toBe(109.88);
  });

  it('is defined for a zero budget and an unreadable quota', () => {
    const result = quotaExpectation({ budgetApproved: 0, quotaPct: Number.NaN });
    expect(result.ordinaryAnnual).toBe(0);
    expect(result.totalPerPeriod).toBe(0);
  });
});

describe('quotaExpectationSchedule', () => {
  it('produces one row per period and stops the derrama when it ends', () => {
    const rows = quotaExpectationSchedule(
      {
        budgetApproved: 6700,
        quotaPct: 6.56,
        months: 12,
        derramaRule: { kind: 'flat_per_unit', amountPerUnit: 60, months: 9 },
      },
      '2023-04-01',
    );
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({
      period: '2023-04-01',
      expectedOrdinary: 36.63,
      expectedExtraordinary: 60,
      expectedTotal: 96.63,
    });
    expect(rows[8]?.expectedExtraordinary).toBe(60);
    expect(rows[9]?.expectedExtraordinary).toBe(0);
    expect(rows[11]?.period).toBe('2024-03-01');
  });

  it('returns nothing for an unreadable start period', () => {
    expect(quotaExpectationSchedule({ budgetApproved: 1000, quotaPct: 10 }, 'not-a-date')).toEqual(
      [],
    );
  });
});

describe('quotaDeviations', () => {
  const schedule = quotaExpectationSchedule(
    {
      budgetApproved: 6700,
      quotaPct: 6.56,
      months: 12,
      derramaRule: { kind: 'flat_per_unit', amountPerUnit: 60, months: 12 },
    },
    '2023-04-01',
  );

  it('reports a missing period as a full shortfall', () => {
    const deviations = quotaDeviations(schedule, {
      '2023-04-01': 96.63,
      '2023-05-01': 96.63,
    });
    expect(deviations[0]?.reportable).toBe(false);
    expect(deviations[2]?.observed).toBe(0);
    expect(deviations[2]?.delta).toBe(-96.63);
    expect(deviations[2]?.reportable).toBe(true);
  });

  it('lets a rounding difference through the tolerance', () => {
    const deviations = quotaDeviations(schedule, {
      '2023-04-01': 96.63 + D5B_PER_PERIOD_TOLERANCE_EUR,
    });
    expect(deviations[0]?.reportable).toBe(false);
    const beyond = quotaDeviations(schedule, {
      '2023-04-01': 96.63 + D5B_PER_PERIOD_TOLERANCE_EUR + 0.01,
    });
    expect(beyond[0]?.reportable).toBe(true);
  });
});
