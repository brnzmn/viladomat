/**
 * Rule D5b: what one unit should contribute per period.
 *
 * The ordinary contribution follows the approved budget and the unit's quota; the
 * extraordinary contribution follows the rule the assembly set for the derrama (a flat amount
 * per unit, or a total distributed by quota). The result is compared against the receipts, the
 * administrator's per-unit rows and the bank credits; a difference is a discrepancy to verify,
 * and the office-holders' units get their own printed row like every other unit.
 */

/** How the extraordinary contribution is distributed. */
export type DerramaRule =
  | {
      kind: 'flat_per_unit';
      /** Amount per unit and period, EUR. */
      amountPerUnit: number;
      /** Number of periods the derrama runs for. */
      months: number;
    }
  | {
      kind: 'quota';
      /** Total to be raised, EUR, distributed by quota. */
      total: number;
      months: number;
    }
  | { kind: 'none' };

/** Input of {@link quotaExpectation}. */
export interface QuotaExpectationInput {
  /** Ordinary budget approved for the year, EUR. */
  budgetApproved: number;
  /** The unit's quota, in percent (6.56 = 6.56%). */
  quotaPct: number;
  /** Periods the ordinary budget is split into; 12 monthly instalments by default. */
  months?: number;
  /** Rule set by the assembly for the extraordinary contribution. */
  derramaRule?: DerramaRule;
}

/** Result of {@link quotaExpectation}. */
export interface QuotaExpectation {
  /** Periods the ordinary budget was split into. */
  periods: number;
  /** Ordinary contribution for the whole year, EUR. */
  ordinaryAnnual: number;
  /** Ordinary contribution per period, EUR. */
  ordinaryPerPeriod: number;
  /** Extraordinary contribution per period, EUR. */
  extraordinaryPerPeriod: number;
  /** Extraordinary contribution over the life of the derrama, EUR. */
  extraordinaryTotal: number;
  /** Periods the derrama runs for. */
  extraordinaryPeriods: number;
  /** Ordinary plus extraordinary per period, EUR. */
  totalPerPeriod: number;
  /** Neutral statement of how the figures were derived, for the finding. */
  basis: string;
}

/** Difference above which a per-unit deviation is worth listing. */
export const D5B_PER_PERIOD_TOLERANCE_EUR = 5;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Expected ordinary and extraordinary contribution of one unit, per period.
 *
 * Ordinary: `approved budget × quota ÷ periods`. Extraordinary: the flat amount per unit, or
 * the unit's quota share of the total, spread over the periods the derrama runs for. Figures
 * are rounded to cents; the tolerance for comparing them against receipts is
 * {@link D5B_PER_PERIOD_TOLERANCE_EUR}.
 */
export function quotaExpectation(input: QuotaExpectationInput): QuotaExpectation {
  const periods = Math.max(1, Math.trunc(input.months ?? 12));
  const quotaShare = (Number.isFinite(input.quotaPct) ? input.quotaPct : 0) / 100;
  const budget = Number.isFinite(input.budgetApproved) ? input.budgetApproved : 0;

  const ordinaryAnnual = round2(budget * quotaShare);
  const ordinaryPerPeriod = round2(ordinaryAnnual / periods);

  const rule = input.derramaRule ?? { kind: 'none' as const };
  let extraordinaryPeriods = 0;
  let extraordinaryPerPeriod = 0;
  let extraordinaryTotal = 0;
  let derramaBasis = 'no extraordinary contribution in force for the period';

  if (rule.kind === 'flat_per_unit') {
    extraordinaryPeriods = Math.max(0, Math.trunc(rule.months));
    extraordinaryPerPeriod = round2(rule.amountPerUnit);
    extraordinaryTotal = round2(extraordinaryPerPeriod * extraordinaryPeriods);
    derramaBasis = `flat contribution of ${extraordinaryPerPeriod} EUR per unit and period over ${extraordinaryPeriods} periods`;
  } else if (rule.kind === 'quota') {
    extraordinaryPeriods = Math.max(1, Math.trunc(rule.months));
    extraordinaryTotal = round2(rule.total * quotaShare);
    extraordinaryPerPeriod = round2(extraordinaryTotal / extraordinaryPeriods);
    derramaBasis = `quota share of ${round2(rule.total)} EUR spread over ${extraordinaryPeriods} periods`;
  }

  return {
    periods,
    ordinaryAnnual,
    ordinaryPerPeriod,
    extraordinaryPerPeriod,
    extraordinaryTotal,
    extraordinaryPeriods,
    totalPerPeriod: round2(ordinaryPerPeriod + extraordinaryPerPeriod),
    basis: `ordinary = approved budget ${round2(budget)} EUR × quota ${input.quotaPct}% ÷ ${periods} periods; extraordinary = ${derramaBasis}`,
  };
}

/** One period of the expectation, ready to be compared with what was charged and collected. */
export interface QuotaPeriodRow {
  /** First day of the period, ISO `yyyy-mm-dd`. */
  period: string;
  expectedOrdinary: number;
  expectedExtraordinary: number;
  expectedTotal: number;
}

/**
 * Expand the expectation into one row per period, starting at `startPeriod` (first day of a
 * month). The extraordinary part stops when the derrama's periods run out.
 */
export function quotaExpectationSchedule(
  input: QuotaExpectationInput,
  startPeriod: string,
): QuotaPeriodRow[] {
  const expectation = quotaExpectation(input);
  const rows: QuotaPeriodRow[] = [];
  const start = new Date(`${startPeriod.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return rows;
  for (let i = 0; i < expectation.periods; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const extraordinary =
      i < expectation.extraordinaryPeriods ? expectation.extraordinaryPerPeriod : 0;
    rows.push({
      period: d.toISOString().slice(0, 10),
      expectedOrdinary: expectation.ordinaryPerPeriod,
      expectedExtraordinary: extraordinary,
      expectedTotal: round2(expectation.ordinaryPerPeriod + extraordinary),
    });
  }
  return rows;
}

/** A deviation between the expectation and what a unit was charged or paid. */
export interface QuotaDeviation {
  period: string;
  expected: number;
  observed: number;
  /** `observed − expected`, EUR. */
  delta: number;
  /** True when the difference is above {@link D5B_PER_PERIOD_TOLERANCE_EUR}. */
  reportable: boolean;
}

/**
 * Compare the expectation with observed amounts per period. A period with no observation is
 * returned with `observed = 0`, which is the case rule D5b describes as a missing month.
 */
export function quotaDeviations(
  schedule: readonly QuotaPeriodRow[],
  observed: Readonly<Record<string, number>>,
): QuotaDeviation[] {
  return schedule.map((row) => {
    const value = observed[row.period] ?? 0;
    const delta = round2(value - row.expectedTotal);
    return {
      period: row.period,
      expected: row.expectedTotal,
      observed: round2(value),
      delta,
      reportable: Math.abs(delta) > D5B_PER_PERIOD_TOLERANCE_EUR,
    };
  });
}
