import { describe, expect, it } from 'vitest';
import {
  EXPECTED_PRICE_METHOD_VERSION,
  LAYER_WEIGHTS,
  expectedPrice,
  expectedPriceP1a,
  isNonBenchmarkableCategory,
  nonBenchmarkableNote,
  type ExpectedPriceInput,
  type LayerName,
  type LayerSource,
} from './expected.ts';

const PARAMS = { pmWorks: 1000, parametersVersion: 'par-v1' };

function input(overrides: Partial<ExpectedPriceInput> = {}): ExpectedPriceInput {
  return {
    target: { actual: 5625, qty: 450, unit: 'm2', categoryCode: 'PAINT_INT', date: '2023-07-01' },
    params: PARAMS,
    ...overrides,
  };
}

function layer(sources: readonly LayerSource[], name: LayerName): LayerSource {
  const found = sources.find((s) => s.layer === name);
  if (!found) throw new Error(`layer ${name} missing from the result`);
  return found;
}

const CONTRACT = { unitPrice: 12.5, qty: 450, fixedPrice: true, changeOrderSigned: false };

describe('expectedPrice — contract layer', () => {
  it('prices a closed contract line and widens the band for a single source', () => {
    const result = expectedPrice(input({ contract: CONTRACT }));
    expect(result.eValue).toBe(5625);
    expect(result.bandLow).toBe(5343.75);
    expect(result.bandHigh).toBe(5906.25);
    expect(result.confidence).toBe('medium');
    expect(result.severity).toBe('INFO');
    expect(result.delta).toBe(0);
    expect(result.methodVersion).toBe(EXPECTED_PRICE_METHOD_VERSION);
    expect(result.parametersVersion).toBe('par-v1');
    expect(layer(result.sources, 'CONTRACT').weight).toBe(LAYER_WEIGHTS.contract);
    expect(layer(result.sources, 'BUDGET').included).toBe(false);
  });

  it('allows the agreed extra above a closed price only with a signed change order', () => {
    const withOrder = expectedPrice(
      input({
        target: { ...input().target, actual: 6075 },
        contract: { ...CONTRACT, changeOrderSigned: true },
      }),
    );
    expect(withOrder.bandHigh).toBe(6187.5);
    expect(withOrder.severity).toBe('INFO');

    const withoutOrder = expectedPrice(
      input({ target: { ...input().target, actual: 6075 }, contract: CONTRACT }),
    );
    expect(withoutOrder.bandHigh).toBe(5906.25);
    expect(withoutOrder.severity).toBe('REVIEW');
  });

  it('widens the band of an open-price contract', () => {
    const result = expectedPrice(input({ contract: { ...CONTRACT, fixedPrice: false } }));
    expect(result.bandLow).toBe(5062.5);
    expect(result.bandHigh).toBe(6187.5);
  });
});

describe('expectedPrice — severities', () => {
  it('is INFO inside the band', () => {
    const result = expectedPrice(input({ contract: CONTRACT }));
    expect(result.severity).toBe('INFO');
    expect(result.outsideBy).toBe(0);
  });

  it('is REVIEW just outside the band', () => {
    const result = expectedPrice(
      input({ target: { ...input().target, actual: 6000 }, contract: CONTRACT }),
    );
    expect(result.severity).toBe('REVIEW');
    expect(result.outsideBy).toBeGreaterThan(0);
    expect(result.outsideBy).toBeLessThan(0.25);
  });

  it('is MATERIAL when the three conditions hold together', () => {
    const result = expectedPrice(
      input({ target: { ...input().target, actual: 8000 }, contract: CONTRACT }),
    );
    expect(result.outsideBy).toBeGreaterThanOrEqual(0.25);
    expect(result.delta).toBe(2375);
    expect(result.confidence).toBe('medium');
    expect(result.severity).toBe('MATERIAL');
  });

  it('stays REVIEW when the difference is below the works materiality', () => {
    const result = expectedPrice(
      input({
        target: { ...input().target, actual: 8000 },
        contract: CONTRACT,
        params: { pmWorks: 5000 },
      }),
    );
    expect(result.outsideBy).toBeGreaterThanOrEqual(0.25);
    expect(result.severity).toBe('REVIEW');
  });

  it('stays REVIEW just below the 25% boundary and turns MATERIAL just above it', () => {
    const bandHigh = 5906.25;
    const below = expectedPrice(
      input({ target: { ...input().target, actual: bandHigh * 1.24 }, contract: CONTRACT }),
    );
    expect(below.severity).toBe('REVIEW');
    const above = expectedPrice(
      input({ target: { ...input().target, actual: bandHigh * 1.26 }, contract: CONTRACT }),
    );
    expect(above.severity).toBe('MATERIAL');
  });

  it('flags a figure below the band as well', () => {
    const result = expectedPrice(
      input({ target: { ...input().target, actual: 3000 }, contract: CONTRACT }),
    );
    expect(result.severity).toBe('MATERIAL');
    expect(result.delta).toBe(-2625);
  });
});

describe('expectedPrice — benchmark layer', () => {
  const trade = {
    low: 8,
    median: 11,
    high: 15,
    tier: 'trade' as const,
    indexFactor: 1,
    comparable: true,
  };

  it('never reaches MATERIAL on a trade-tier benchmark alone', () => {
    const result = expectedPrice(
      input({ target: { ...input().target, actual: 12000 }, benchmark: trade }),
    );
    expect(result.eValue).toBe(4950);
    expect(result.bandHigh).toBe(6750);
    expect(result.confidence).toBe('low');
    expect(result.outsideBy).toBeGreaterThan(0.25);
    expect(result.severity).toBe('REVIEW');
    expect(layer(result.sources, 'BENCHMARK').weight).toBe(LAYER_WEIGHTS.benchmarkOther);
  });

  it('can reach MATERIAL on an official-tier benchmark alone', () => {
    const result = expectedPrice(
      input({
        target: { ...input().target, actual: 12000 },
        benchmark: { ...trade, tier: 'official' },
      }),
    );
    expect(result.confidence).toBe('medium');
    expect(result.severity).toBe('MATERIAL');
    expect(layer(result.sources, 'BENCHMARK').weight).toBe(LAYER_WEIGHTS.benchmarkOfficial);
  });

  it('brings the record to the date of the line with the index factor', () => {
    const result = expectedPrice(input({ benchmark: { ...trade, indexFactor: 1.1 } }));
    expect(result.eValue).toBe(5445);
  });

  it('skips the layer when the record is not comparable', () => {
    const result = expectedPrice(
      input({ contract: CONTRACT, benchmark: { ...trade, comparable: false } }),
    );
    const benchmark = layer(result.sources, 'BENCHMARK');
    expect(benchmark.included).toBe(false);
    expect(benchmark.reason).toMatch(/not comparable/);
    expect(result.eValue).toBe(5625);
  });

  it('skips the layer when the line has no quantity in a recognised unit', () => {
    const result = expectedPrice(
      input({
        target: { actual: 5625, categoryCode: 'PAINT_INT', date: '2023-07-01' },
        benchmark: trade,
      }),
    );
    expect(layer(result.sources, 'BENCHMARK').reason).toMatch(/no quantity/);
    expect(result.severity).toBe('NON_BENCHMARKABLE');
    expect(result.eValue).toBeNull();
  });
});

describe('expectedPrice — non-benchmarkable categories', () => {
  it('knows which categories have no comparable reference in v1', () => {
    expect(isNonBenchmarkableCategory('ELEV_INSTALL')).toBe(true);
    expect(isNonBenchmarkableCategory('STAIR_REHAB')).toBe(true);
    expect(isNonBenchmarkableCategory('PAINT_INT')).toBe(false);
    expect(nonBenchmarkableNote('ELEV_INSTALL')).toMatch(/no comparable benchmark in v1/);
  });

  it('keeps the contract and budget layers for a lift line', () => {
    const result = expectedPrice(
      input({
        target: {
          actual: 62000,
          qty: 1,
          unit: 'ud',
          categoryCode: 'ELEV_INSTALL',
          date: '2023-07-01',
        },
        contract: { unitPrice: 58000, qty: 1, fixedPrice: true, changeOrderSigned: false },
        benchmark: {
          low: 36000,
          median: 49000,
          high: 62000,
          tier: 'trade',
          indexFactor: 1,
          comparable: true,
        },
      }),
    );
    expect(layer(result.sources, 'BENCHMARK').included).toBe(false);
    expect(layer(result.sources, 'BENCHMARK').reason).toMatch(/no comparable benchmark in v1/);
    expect(result.eValue).toBe(58000);
    expect(result.severity).toBe('REVIEW');
  });

  it('returns NON_BENCHMARKABLE when no layer at all applies', () => {
    const result = expectedPrice(
      input({
        target: { actual: 62000, qty: 1, categoryCode: 'STAIR_REHAB', date: '2023-07-01' },
      }),
    );
    expect(result.severity).toBe('NON_BENCHMARKABLE');
    expect(result.eValue).toBeNull();
    expect(result.bandLow).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.sources.every((s) => !s.included)).toBe(true);
  });
});

describe('expectedPrice — budget layer', () => {
  it('uses the approved amount with its tolerance', () => {
    const result = expectedPrice(
      input({
        target: { ...input().target, actual: 6300 },
        budget: { approved: 6000, tolerancePct: 0.1, isCeiling: false },
      }),
    );
    expect(result.eValue).toBe(6000);
    expect(result.bandLow).toBe(5400);
    expect(result.bandHigh).toBe(6600);
    expect(result.severity).toBe('INFO');
  });

  it('treats a delegation without an explicit cap as a ceiling on the band', () => {
    const result = expectedPrice(
      input({
        contract: CONTRACT,
        budget: { approved: 5000, tolerancePct: 0.1, isCeiling: true },
      }),
    );
    const budget = layer(result.sources, 'BUDGET');
    expect(budget.included).toBe(false);
    expect(budget.weight).toBe(0);
    expect(budget.reason).toMatch(/ceiling, not a price/);
    expect(result.eValue).toBe(5625);
    expect(result.bandHigh).toBe(5343.75);
    expect(result.severity).toBe('REVIEW');
  });

  it('produces no expectation from a ceiling alone', () => {
    const result = expectedPrice(
      input({ budget: { approved: 5000, tolerancePct: 0.1, isCeiling: true } }),
    );
    expect(result.severity).toBe('NON_BENCHMARKABLE');
    expect(layer(result.sources, 'BUDGET').high).toBe(5000);
  });
});

describe('expectedPrice — history layer and weighting', () => {
  it('bands the prior period by the index plus three points', () => {
    const result = expectedPrice(input({ history: { prior: 5000, ipc: 0.03 } }));
    expect(result.eValue).toBe(5150);
    expect(result.bandLow).toBe(4841);
    expect(result.bandHigh).toBe(5459);
    expect(layer(result.sources, 'HISTORY').weight).toBe(LAYER_WEIGHTS.history);
  });

  it('weights own history more for a recurring service with no contract', () => {
    const recurring = expectedPrice(
      input({ history: { prior: 5000, ipc: 0.03, recurring: true } }),
    );
    expect(layer(recurring.sources, 'HISTORY').weight).toBe(LAYER_WEIGHTS.historyRecurring);
    expect(recurring.confidence).toBe('medium');

    const withContract = expectedPrice(
      input({ contract: CONTRACT, history: { prior: 5000, ipc: 0.03, recurring: true } }),
    );
    expect(layer(withContract.sources, 'HISTORY').weight).toBe(LAYER_WEIGHTS.history);
  });

  it('takes the weighted mean and the union of the bands over four layers', () => {
    const result = expectedPrice(
      input({
        contract: CONTRACT,
        budget: { approved: 6000, tolerancePct: 0.1, isCeiling: false },
        benchmark: {
          low: 8,
          median: 11,
          high: 15,
          tier: 'official',
          indexFactor: 1,
          comparable: true,
        },
        history: { prior: 5000, ipc: 0.03 },
      }),
    );
    expect(result.eValue).toBe(5482.95);
    expect(result.bandLow).toBe(3600);
    expect(result.bandHigh).toBe(6750);
    expect(result.confidence).toBe('high');
    expect(result.sources.filter((s) => s.included)).toHaveLength(4);
  });
});

describe('expectedPriceP1a', () => {
  it('uses the contract and budget layers only', () => {
    const full = input({
      contract: CONTRACT,
      budget: { approved: 6000, tolerancePct: 0.1, isCeiling: false },
      benchmark: {
        low: 8,
        median: 11,
        high: 15,
        tier: 'official',
        indexFactor: 1,
        comparable: true,
      },
      history: { prior: 5000, ipc: 0.03 },
    });
    const result = expectedPriceP1a(full);
    expect(layer(result.sources, 'BENCHMARK').included).toBe(false);
    expect(layer(result.sources, 'HISTORY').included).toBe(false);
    expect(result.eValue).toBe(5758.93);
    expect(result.confidence).toBe('high');
  });
});
