/**
 * The layered expected-price engine ("what the line should cost").
 *
 * Up to four layers propose a point and a band for the same line; the point is the weighted
 * mean and the band is the union of the contributing bands. The distance between the actual
 * figure and that band, together with how much the expectation rests on, decides a severity
 * label. The label is an instruction to look, never a conclusion:
 *
 * | severity | meaning |
 * |---|---|
 * | `INFO` | the figure sits inside the band |
 * | `REVIEW` | outside the band, or outside it on thin evidence: verify |
 * | `MATERIAL` | outside by at least 25%, above the works materiality, on at least medium confidence and with at least one non-trade source |
 * | `NON_BENCHMARKABLE` | no layer could produce an expectation for this line |
 *
 * Rules P1a (contract and budget layers) and P1b (all four) read this module.
 */
import { NON_BENCHMARKABLE_CODES, categoryByCode } from '../taxonomy/categories.ts';

/** Version of the method; stored on every `expected_prices` row so a figure can be reproduced. */
export const EXPECTED_PRICE_METHOD_VERSION = 'p1-1.0.0';

/** Layer weights, as fixed in the plan. */
export const LAYER_WEIGHTS = Object.freeze({
  contract: 0.45,
  budget: 0.25,
  benchmarkOfficial: 0.3,
  benchmarkOther: 0.2,
  history: 0.1,
  /** Own history of a recurring service with no contract on file. */
  historyRecurring: 0.35,
});

/** Half-width applied when a single layer contributes, so a point estimate is not a knife edge. */
export const SINGLE_SOURCE_BAND_PCT = 0.05;

/** Relative distance outside the band from which a deviation can be MATERIAL. */
export const MATERIAL_OUTSIDE_PCT = 0.25;

/** Extra allowance over a fixed contract price when a signed change order exists. */
export const CHANGE_ORDER_ALLOWANCE_PCT = 0.1;

/** Band of an open-price (not fixed) contract. */
export const OPEN_PRICE_BAND_PCT = 0.1;

/** Extra points added to the IPC when banding an own-history expectation. */
export const HISTORY_BAND_EXTRA_PCT = 0.03;

/** Tier of a benchmark source; sets the weight and the ceiling on severity. */
export type BenchmarkTier = 'official' | 'semi_official' | 'trade' | 'own_history';

/** Confidence label of an expectation. */
export type ExpectedConfidence = 'high' | 'medium' | 'low';

/** Severity label of the deviation. */
export type ExpectedSeverity = 'INFO' | 'REVIEW' | 'MATERIAL' | 'NON_BENCHMARKABLE';

/** Name of a layer. */
export type LayerName = 'CONTRACT' | 'BUDGET' | 'BENCHMARK' | 'HISTORY';

/** The line being priced. */
export interface PriceTarget {
  /** The figure as invoiced, certified or contracted, in EUR. */
  actual: number;
  /** Quantity on the line, in `unit`. Required by the BENCHMARK layer. */
  qty?: number;
  /** Unit of `qty`, as normalised by the taxonomy. */
  unit?: string;
  /** Taxonomy category code. */
  categoryCode: string;
  /** Date of the line, ISO `yyyy-mm-dd`; used for indexation and parameter versions. */
  date: string;
}

/** Matched quote or contract partida. */
export interface ContractLayerInput {
  unitPrice: number;
  qty: number;
  /** A closed price (`precio cerrado`) admits no band of its own. */
  fixedPrice: boolean;
  /** A signed change order allows the agreed allowance above the closed price. */
  changeOrderSigned: boolean;
  /** Free-text reference printed with the finding, e.g. `quote P-2023-014 partida PI.01`. */
  ref?: string;
}

/** Amount approved by the assembly for this scope. */
export interface BudgetLayerInput {
  approved: number;
  /** Tolerance around the approved amount, as a fraction (0.1 = 10%). */
  tolerancePct: number;
  /**
   * A delegation without an explicit cap is a ceiling, not a price: it does not move the
   * expectation, it only caps the top of the band.
   */
  isCeiling: boolean;
  ref?: string;
}

/** A benchmark record brought to the date of the line. */
export interface BenchmarkLayerInput {
  /** Unit prices from the record. */
  low: number;
  median: number;
  high: number;
  tier: BenchmarkTier;
  /** Multiplier that brings the record to the date of the line (1 = no indexation). */
  indexFactor: number;
  /** `comparable` of the record, computed per works package. */
  comparable: boolean;
  /** Benchmark record id or reference. */
  ref?: string;
}

/** The community's own prior-period price for the same vendor and category. */
export interface HistoryLayerInput {
  /** Prior-period figure, EUR. */
  prior: number;
  /** Index variation between the two periods, as a fraction (0.031 = 3.1%). */
  ipc: number;
  /** A recurring service with no contract on file carries more weight. */
  recurring?: boolean;
  ref?: string;
}

/** Materiality and engine parameters. */
export interface PricingParameters {
  /** Works materiality in EUR (1% of the works spend under review). */
  pmWorks: number;
  /** Ordinary materiality in EUR; used when the line is not works spend. */
  pmOrdinary?: number;
  /** Version label of the parameter set, stored with the result. */
  parametersVersion?: string;
}

/** Everything the engine needs for one line. */
export interface ExpectedPriceInput {
  target: PriceTarget;
  contract?: ContractLayerInput;
  budget?: BudgetLayerInput;
  benchmark?: BenchmarkLayerInput;
  history?: HistoryLayerInput;
  params: PricingParameters;
}

/** One layer's contribution, kept in the result so a figure can be explained. */
export interface LayerSource {
  layer: LayerName;
  /** Whether the layer contributed to the expectation. */
  included: boolean;
  /** Point estimate in EUR, when the layer produced one. */
  point: number | null;
  low: number | null;
  high: number | null;
  /** Weight before renormalisation; 0 for a layer that only caps the band. */
  weight: number;
  tier?: BenchmarkTier;
  ref?: string;
  /** Neutral reason a layer was skipped or limited. */
  reason?: string;
}

/** Result of {@link expectedPrice}. */
export interface ExpectedPriceResult {
  /** Weighted expectation in EUR, or null when no layer applied. */
  eValue: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  confidence: ExpectedConfidence;
  severity: ExpectedSeverity;
  /** Signed difference `actual − eValue`, or null when there is no expectation. */
  delta: number | null;
  /** Relative distance outside the band (0 when inside), or null when there is no band. */
  outsideBy: number | null;
  sources: LayerSource[];
  methodVersion: string;
  parametersVersion?: string;
}

function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function isFinitePositive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

interface Contribution {
  layer: LayerName;
  point: number;
  low: number;
  high: number;
  weight: number;
  tier?: BenchmarkTier;
  ref?: string;
}

/** Whether the category has no comparable reference in v1 (lift and staircase scopes). */
export function isNonBenchmarkableCategory(code: string | null | undefined): boolean {
  return code ? NON_BENCHMARKABLE_CODES.has(code) : false;
}

function buildContract(input: ContractLayerInput): Contribution {
  const point = input.unitPrice * input.qty;
  let low = point;
  let high = point;
  if (!input.fixedPrice) {
    low = point * (1 - OPEN_PRICE_BAND_PCT);
    high = point * (1 + OPEN_PRICE_BAND_PCT);
  } else if (input.changeOrderSigned) {
    high = point * (1 + CHANGE_ORDER_ALLOWANCE_PCT);
  }
  const contribution: Contribution = {
    layer: 'CONTRACT',
    point,
    low,
    high,
    weight: LAYER_WEIGHTS.contract,
  };
  if (input.ref !== undefined) contribution.ref = input.ref;
  return contribution;
}

function buildBudget(input: BudgetLayerInput): Contribution {
  const tolerance = Number.isFinite(input.tolerancePct) ? Math.abs(input.tolerancePct) : 0;
  const contribution: Contribution = {
    layer: 'BUDGET',
    point: input.approved,
    low: input.approved * (1 - tolerance),
    high: input.approved * (1 + tolerance),
    weight: LAYER_WEIGHTS.budget,
  };
  if (input.ref !== undefined) contribution.ref = input.ref;
  return contribution;
}

function buildBenchmark(input: BenchmarkLayerInput, qty: number): Contribution {
  const factor =
    Number.isFinite(input.indexFactor) && input.indexFactor > 0 ? input.indexFactor : 1;
  const weight =
    input.tier === 'official' ? LAYER_WEIGHTS.benchmarkOfficial : LAYER_WEIGHTS.benchmarkOther;
  const contribution: Contribution = {
    layer: 'BENCHMARK',
    point: input.median * qty * factor,
    low: input.low * qty * factor,
    high: input.high * qty * factor,
    weight,
    tier: input.tier,
  };
  if (input.ref !== undefined) contribution.ref = input.ref;
  return contribution;
}

function buildHistory(input: HistoryLayerInput, hasContract: boolean): Contribution {
  const ipc = Number.isFinite(input.ipc) ? input.ipc : 0;
  const point = input.prior * (1 + ipc);
  const halfWidth = Math.abs(ipc) + HISTORY_BAND_EXTRA_PCT;
  const contribution: Contribution = {
    layer: 'HISTORY',
    point,
    low: point * (1 - halfWidth),
    high: point * (1 + halfWidth),
    weight:
      input.recurring === true && !hasContract
        ? LAYER_WEIGHTS.historyRecurring
        : LAYER_WEIGHTS.history,
    tier: 'own_history',
  };
  if (input.ref !== undefined) contribution.ref = input.ref;
  return contribution;
}

function confidenceOf(contributions: readonly Contribution[]): ExpectedConfidence {
  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  const hasContract = contributions.some((c) => c.layer === 'CONTRACT');
  if ((hasContract && contributions.length >= 2) || totalWeight >= 0.65) return 'high';
  if (totalWeight >= 0.25) return 'medium';
  return 'low';
}

const CONFIDENCE_RANK: Record<ExpectedConfidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Compute the expected price of one line.
 *
 * Layers that cannot apply are still reported in `sources` with `included: false` and a neutral
 * reason, so the report can say why an expectation rests on what it rests on.
 */
export function expectedPrice(input: ExpectedPriceInput): ExpectedPriceResult {
  const { target, params } = input;
  const sources: LayerSource[] = [];
  const contributions: Contribution[] = [];

  const push = (c: Contribution): void => {
    contributions.push(c);
    const source: LayerSource = {
      layer: c.layer,
      included: true,
      point: round(c.point, 2),
      low: round(c.low, 2),
      high: round(c.high, 2),
      weight: c.weight,
    };
    if (c.tier !== undefined) source.tier = c.tier;
    if (c.ref !== undefined) source.ref = c.ref;
    sources.push(source);
  };

  const skip = (layer: LayerName, reason: string, tier?: BenchmarkTier): void => {
    const source: LayerSource = {
      layer,
      included: false,
      point: null,
      low: null,
      high: null,
      weight: 0,
      reason,
    };
    if (tier !== undefined) source.tier = tier;
    sources.push(source);
  };

  // --- CONTRACT -------------------------------------------------------------
  if (input.contract) {
    if (Number.isFinite(input.contract.unitPrice) && Number.isFinite(input.contract.qty)) {
      push(buildContract(input.contract));
    } else {
      skip('CONTRACT', 'matched partida has no usable unit price or quantity');
    }
  } else {
    skip('CONTRACT', 'no matched quote or contract partida');
  }

  // --- BUDGET ---------------------------------------------------------------
  let ceiling: number | null = null;
  if (input.budget) {
    if (!Number.isFinite(input.budget.approved)) {
      skip('BUDGET', 'approved amount not readable');
    } else if (input.budget.isCeiling) {
      ceiling = input.budget.approved;
      const source: LayerSource = {
        layer: 'BUDGET',
        included: false,
        point: null,
        low: null,
        high: round(input.budget.approved, 2),
        weight: 0,
        reason: 'delegation without an explicit cap: a ceiling, not a price',
      };
      if (input.budget.ref !== undefined) source.ref = input.budget.ref;
      sources.push(source);
    } else {
      push(buildBudget(input.budget));
    }
  } else {
    skip('BUDGET', 'no approved amount located for this scope');
  }

  // --- BENCHMARK ------------------------------------------------------------
  const categoryNonBenchmarkable = isNonBenchmarkableCategory(target.categoryCode);
  if (categoryNonBenchmarkable) {
    skip(
      'BENCHMARK',
      `no comparable benchmark in v1 for category ${target.categoryCode}`,
      input.benchmark?.tier,
    );
  } else if (!input.benchmark) {
    skip('BENCHMARK', 'no benchmark record for this category, region and period');
  } else if (!input.benchmark.comparable) {
    skip(
      'BENCHMARK',
      'benchmark record marked not comparable for this works package',
      input.benchmark.tier,
    );
  } else if (!isFinitePositive(target.qty)) {
    skip('BENCHMARK', 'line has no quantity in a recognised unit', input.benchmark.tier);
  } else {
    push(buildBenchmark(input.benchmark, target.qty));
  }

  // --- HISTORY --------------------------------------------------------------
  const hasContract = contributions.some((c) => c.layer === 'CONTRACT');
  if (input.history) {
    if (Number.isFinite(input.history.prior)) {
      push(buildHistory(input.history, hasContract));
    } else {
      skip('HISTORY', 'prior-period figure not readable', 'own_history');
    }
  } else {
    skip('HISTORY', 'no prior period for this vendor and category', 'own_history');
  }

  const base: Pick<ExpectedPriceResult, 'methodVersion'> & { parametersVersion?: string } = {
    methodVersion: EXPECTED_PRICE_METHOD_VERSION,
  };
  if (params.parametersVersion !== undefined) base.parametersVersion = params.parametersVersion;

  if (contributions.length === 0) {
    // Only a ceiling may still be known; it is reported but cannot make an expectation.
    return {
      eValue: null,
      bandLow: null,
      bandHigh: null,
      confidence: 'low',
      severity: 'NON_BENCHMARKABLE',
      delta: null,
      outsideBy: null,
      sources,
      ...base,
    };
  }

  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  const eValue = contributions.reduce((sum, c) => sum + c.point * c.weight, 0) / totalWeight;

  let bandLow = Math.min(...contributions.map((c) => c.low));
  let bandHigh = Math.max(...contributions.map((c) => c.high));
  if (contributions.length === 1) {
    const only = contributions[0] as Contribution;
    bandLow = Math.min(bandLow, only.point * (1 - SINGLE_SOURCE_BAND_PCT));
    bandHigh = Math.max(bandHigh, only.point * (1 + SINGLE_SOURCE_BAND_PCT));
  }
  if (ceiling !== null) bandHigh = Math.max(bandLow, Math.min(bandHigh, ceiling));

  const confidence = confidenceOf(contributions);
  const delta = target.actual - eValue;

  let outsideBy = 0;
  if (target.actual > bandHigh && bandHigh > 0) outsideBy = (target.actual - bandHigh) / bandHigh;
  else if (target.actual < bandLow && bandLow > 0) outsideBy = (bandLow - target.actual) / bandLow;

  const nonTradeSources = contributions.some((c) => c.tier !== 'trade');
  const materiality = params.pmWorks;

  let severity: ExpectedSeverity;
  if (outsideBy === 0) {
    severity = 'INFO';
  } else if (
    outsideBy >= MATERIAL_OUTSIDE_PCT &&
    Math.abs(delta) >= materiality &&
    CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.medium &&
    nonTradeSources
  ) {
    severity = 'MATERIAL';
  } else {
    severity = 'REVIEW';
  }

  return {
    eValue: round(eValue, 2),
    bandLow: round(bandLow, 2),
    bandHigh: round(bandHigh, 2),
    confidence,
    severity,
    delta: round(delta, 2),
    outsideBy: round(outsideBy, 4),
    sources,
    ...base,
  };
}

/**
 * The subset of layers rule P1a is allowed to use (contract and budget only). P1b adds the
 * benchmark and history layers once archived records exist.
 */
export function expectedPriceP1a(input: ExpectedPriceInput): ExpectedPriceResult {
  const stripped: ExpectedPriceInput = { target: input.target, params: input.params };
  if (input.contract) stripped.contract = input.contract;
  if (input.budget) stripped.budget = input.budget;
  return expectedPrice(stripped);
}

/** Label printed next to a category with no comparable reference in v1. */
export function nonBenchmarkableNote(code: string): string {
  const category = categoryByCode(code);
  const label = category ? category.labelEn : code;
  return `${label}: no comparable benchmark in v1; the expectation rests on the contract and budget layers only.`;
}
