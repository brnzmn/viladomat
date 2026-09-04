import { describe, expect, it } from 'vitest';
import {
  ADMIN_FEE_RANGE_LITERATURE,
  CONSORCI_ACCESSIBILITY_CAP,
  CONSORCI_COMMON_ELEMENTS_CAP,
  ICIO_BY_YEAR,
  LIFT_PERIODICITY,
  LITERATURE_MARKER,
  PLANNING_FEE,
  SUBSIDY_THREE_QUOTES_THRESHOLD,
  expectedIcio,
  icioForYear,
  officialParameterSeeds,
  unverifiedConstants,
} from './seed-benchmarks.ts';

describe('ICIO by year', () => {
  it('is parameterised by year and carries both readings', () => {
    expect(icioForYear(2023)?.ratePct).toBe(4);
    expect(icioForYear(2023)?.alternativeReportedPct).toBe(3.35);
    expect(icioForYear(2019)).toBeUndefined();
    expect(ICIO_BY_YEAR.toVerify).toBe(true);
    expect(ICIO_BY_YEAR.sourceId).toBe('BS-01');
  });

  it('computes an expectation for a declared works budget', () => {
    expect(expectedIcio(10000, 2023)).toBe(400);
    expect(expectedIcio(10000, 2019)).toBeNull();
    expect(expectedIcio(Number.NaN, 2023)).toBeNull();
  });
});

describe('official constants', () => {
  it('leaves the planning fee unset until the ordinance is archived', () => {
    expect(PLANNING_FEE.value.perSquareMetre).toBeNull();
    expect(PLANNING_FEE.value.minimum).toBeNull();
    expect(PLANNING_FEE.toVerify).toBe(true);
  });

  it('keeps the subsidy caps with their disagreements recorded', () => {
    expect(CONSORCI_ACCESSIBILITY_CAP.value.pct).toBe(35);
    expect(CONSORCI_ACCESSIBILITY_CAP.value.alternativeReportedPct).toBe(25);
    expect(CONSORCI_COMMON_ELEMENTS_CAP.value.capPerDwelling).toBe(3000);
    expect(CONSORCI_COMMON_ELEMENTS_CAP.value.conditions?.length).toBeGreaterThan(0);
  });

  it('assumes no three-quotes threshold', () => {
    expect(SUBSIDY_THREE_QUOTES_THRESHOLD.value).toBeNull();
  });

  it('keeps the lift periodicity unset because it depends on the installation class', () => {
    expect(LIFT_PERIODICITY.value.maintenanceVisitsPerYear).toBeNull();
    expect(LIFT_PERIODICITY.value.inspectionIntervalYears).toBeNull();
  });
});

describe('administrator fee literature range', () => {
  it('is marked as literature and may not price anything', () => {
    expect(ADMIN_FEE_RANGE_LITERATURE.marker).toBe(LITERATURE_MARKER);
    expect(ADMIN_FEE_RANGE_LITERATURE.usableAsBenchmark).toBe(false);
    expect(ADMIN_FEE_RANGE_LITERATURE.severityCap).toBe(2);
    expect(ADMIN_FEE_RANGE_LITERATURE.sourceId).toBe('BS-15');
  });
});

describe('parameter seeds', () => {
  it('emits one ICIO rate row per recorded year', () => {
    const seeds = officialParameterSeeds();
    const icio = seeds.filter((s) => s.key === 'icio_rate_pct');
    expect(icio).toHaveLength(Object.keys(ICIO_BY_YEAR.value).length);
    expect(icio.every((s) => s.toVerify)).toBe(true);
    expect(icio.map((s) => s.validFrom)).toContain('2023-01-01');
  });

  it('inserts placeholders rather than defaults for the unread figures', () => {
    const seeds = officialParameterSeeds();
    const planning = seeds.find((s) => s.key === 'planning_fee_per_m2');
    expect(planning?.valueNum).toBeNull();
    const visits = seeds.find((s) => s.key === 'lift_maintenance_visits_per_year');
    expect(visits?.valueNum).toBeNull();
  });

  it('names every source id it seeds from', () => {
    for (const seed of officialParameterSeeds()) {
      expect(seed.sourceId).toMatch(/^BS-\d\d$/);
      expect(seed.basisText.length).toBeGreaterThan(0);
    }
  });
});

describe('unverifiedConstants', () => {
  it('lists everything the report gate still has to check', () => {
    const keys = unverifiedConstants().map((c) => c.key);
    expect(keys).toContain('icio_by_year');
    expect(keys).toContain('consorci_accessibility_cap');
    expect(keys).toContain('lift_periodicity');
    expect(unverifiedConstants().every((c) => c.sourceId.startsWith('BS-'))).toBe(true);
  });
});
