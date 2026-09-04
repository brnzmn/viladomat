/**
 * Versioned, date-dependent parameters (materiality thresholds and statutory limits).
 * Every rule reads its thresholds through {@link resolveParameter} so the parameter version
 * used can be printed with the finding.
 */

/** One version of a parameter. */
export interface Parameter {
  /** Stable key, e.g. `cash_limit`. */
  key: string;
  /** Numeric value in `unit`. */
  valueNum: number;
  /** Optional textual value (e.g. a formula or label). */
  valueText?: string;
  /** Unit of `valueNum`: `EUR`, `pct`, `days`, … */
  unit?: string;
  /** Neutral statement of where the value comes from (statute, professional standard, derivation). */
  basisText?: string;
  /** Monotonically increasing version per key. */
  version: number;
  /** First date (ISO `yyyy-mm-dd`) on which this version applies. */
  validFrom: string;
}

/**
 * Resolve the parameter version applicable on a date: among versions with
 * `validFrom <= onDate`, the one with the latest `validFrom`, ties broken by the highest
 * `version`. Returns undefined when no version applies.
 */
export function resolveParameter(
  params: readonly Parameter[],
  key: string,
  onDate: string,
): Parameter | undefined {
  let best: Parameter | undefined;
  for (const p of params) {
    if (p.key !== key || p.validFrom > onDate) continue;
    if (
      !best ||
      p.validFrom > best.validFrom ||
      (p.validFrom === best.validFrom && p.version > best.version)
    ) {
      best = p;
    }
  }
  return best;
}

/** Numeric value of the applicable parameter version, or undefined. */
export function resolveParameterValue(
  params: readonly Parameter[],
  key: string,
  onDate: string,
): number | undefined {
  return resolveParameter(params, key, onDate)?.valueNum;
}

/** Like {@link resolveParameterValue} but throws when no version applies. */
export function requireParameterValue(params: readonly Parameter[], key: string, onDate: string): number {
  const p = resolveParameter(params, key, onDate);
  if (!p) throw new RangeError(`parameter "${key}" has no version valid on ${onDate}`);
  return p.valueNum;
}

/** Inputs from which the v1 materiality defaults are derived. */
export interface DefaultParameterInput {
  /** Total works spend under review, EUR. */
  worksSpendUnderReview: number;
  /** Ordinary annual budget of the community, EUR. */
  ordinaryBudget: number;
}

const EPOCH = '1900-01-01';

/**
 * Version-1 parameter set derived from the review scope.
 *
 * - `pm_works` = 1% of works spend; `pm_ordinary` = 5% of ordinary budget;
 * - `trivial_floor` = max(10% of `pm_works`, 200);
 * - `outflow_min` 300; `authority_threshold` 1,000;
 * - `funding_gap_min` = max(5,000, 10% of works spend);
 * - `upfront_max_pct_obra` 40; `upfront_max_pct_ascensor` 60;
 * - `cash_limit` 2,500 from 1900-01-01 and 1,000 from 2021-07-11 (Ley 7/2012 art. 7 as
 *   amended by Ley 11/2021);
 * - `convene_days` 30 (informational); `ocr_min` 1,000.
 */
export function defaultParameters(input: DefaultParameterInput): Parameter[] {
  const works = Math.max(0, input.worksSpendUnderReview);
  const ordinary = Math.max(0, input.ordinaryBudget);
  const pmWorks = round2(works * 0.01);
  const pmOrdinary = round2(ordinary * 0.05);
  return [
    {
      key: 'pm_works',
      valueNum: pmWorks,
      unit: 'EUR',
      valueText: '1% of works spend under review',
      basisText: 'Planning materiality for works: 1% of the works spend under review (professional standard, derived).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'pm_ordinary',
      valueNum: pmOrdinary,
      unit: 'EUR',
      valueText: '5% of ordinary budget',
      basisText: 'Planning materiality for ordinary accounts: 5% of the ordinary budget (professional standard, derived).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'trivial_floor',
      valueNum: Math.max(round2(pmWorks * 0.1), 200),
      unit: 'EUR',
      valueText: 'max(10% of pm_works, 200)',
      basisText: 'Clearly trivial floor: 10% of pm_works, minimum EUR 200 (internal control).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'outflow_min',
      valueNum: 300,
      unit: 'EUR',
      basisText: 'Minimum outflow considered by payment rules (internal control).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'authority_threshold',
      valueNum: 1000,
      unit: 'EUR',
      basisText: 'Spend above which a resolution is expected; the community has no written rule, so this value is stated (internal control).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'funding_gap_min',
      valueNum: Math.max(5000, round2(works * 0.1)),
      unit: 'EUR',
      valueText: 'max(5000, 10% of works spend)',
      basisText: 'Minimum funding gap reported: the larger of EUR 5,000 and 10% of works spend (internal control).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'upfront_max_pct_obra',
      valueNum: 40,
      unit: 'pct',
      basisText: 'Upfront payment share for building works beyond which a contract clause is verified (professional standard).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'upfront_max_pct_ascensor',
      valueNum: 60,
      unit: 'pct',
      basisText: 'Upfront payment share for lift contracts beyond which a contract clause is verified (professional standard).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'cash_limit',
      valueNum: 2500,
      unit: 'EUR',
      basisText: 'Ley 7/2012 art. 7: limit on cash payments where one party acts as a business (statutory).',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'cash_limit',
      valueNum: 1000,
      unit: 'EUR',
      basisText: 'Ley 11/2021 amending Ley 7/2012 art. 7: cash payment limit reduced from 2021-07-11 (statutory).',
      version: 2,
      validFrom: '2021-07-11',
    },
    {
      key: 'convene_days',
      valueNum: 30,
      unit: 'days',
      basisText: 'Informational: days within which a meeting is expected to be convened after a qualified request.',
      version: 1,
      validFrom: EPOCH,
    },
    {
      key: 'ocr_min',
      valueNum: 1000,
      unit: 'EUR',
      basisText: 'Documents at or above this amount receive a second OCR reading on every page (process).',
      version: 1,
      validFrom: EPOCH,
    },
  ];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
