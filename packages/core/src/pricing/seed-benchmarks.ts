/**
 * Official-tier constants for the M4 benchmark seed.
 *
 * Everything here comes from `docs/benchmark-sources.md` and carries the verification status
 * recorded there: the research network could not reach the primary Spanish and Catalan
 * government sites, so every figure is a search-engine summary until the archived PDF is in
 * Storage. `toVerify: true` means exactly that, and the report gate refuses to print a figure
 * whose source has not been archived and checked.
 *
 * No trade-tier price is baked into this module. Marketplace and firm-page ranges enter the
 * system only as `benchmark_records` rows with an archived evidence file, and a trade-tier
 * record alone can never raise a deviation above `REVIEW`. The one exception is marked `[L]`:
 * a literature range kept here for orientation, explicitly not usable as a benchmark.
 */

/** A constant read from a source that has not yet been checked against its archived copy. */
export interface VerifiableConstant<T> {
  value: T;
  /** Register id in `docs/benchmark-sources.md` / `public.benchmark_sources`. */
  sourceId: string;
  /** True until the archived PDF or JSON has been read and `verified_at` is set. */
  toVerify: boolean;
  /** Neutral note: disagreements between research packs, scope limits, edition caveats. */
  note?: string;
}

/** Marker for a literature range that is not a benchmark and may not price anything. */
export const LITERATURE_MARKER = '[L]';

/** A range quoted in trade literature; kept for orientation only. */
export interface LiteratureRange {
  marker: typeof LITERATURE_MARKER;
  low: number;
  high: number;
  unit: string;
  sourceId: string;
  /** Always false: a literature range never becomes a `benchmark_records` row. */
  usableAsBenchmark: false;
  /** Ceiling on the severity a rule may reach with this range alone. */
  severityCap: 1 | 2;
  note: string;
}

// ---------------------------------------------------------------------------
// ICIO (tax on constructions, installations and works) — municipal ordinance 2.1
// ---------------------------------------------------------------------------

/** Rate and bonus of one ICIO edition. */
export interface IcioYear {
  /** Rate applied to the PEM, in percent. */
  ratePct: number;
  /** Other rate reported by a research pack for the same year, when they disagreed. */
  alternativeReportedPct?: number;
  /** Accessibility bonus reported for works removing architectural barriers, in percent. */
  accessibilityBonusPct?: number;
}

/**
 * ICIO rate by year. Two research packs reported 4% and a third about 3.35%; the rate is
 * therefore stored per year and never as a constant, and both readings are carried until the
 * ordinance edition for the year has been archived.
 */
export const ICIO_BY_YEAR: VerifiableConstant<Readonly<Record<number, IcioYear>>> = Object.freeze({
  value: Object.freeze({
    2021: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
    2022: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
    2023: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
    2024: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
    2025: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
    2026: { ratePct: 4, alternativeReportedPct: 3.35, accessibilityBonusPct: 90 },
  }),
  sourceId: 'BS-01',
  toVerify: true,
  note: 'Rate and bonus per edition of the municipal fiscal ordinance 2.1. The bonus must be requested and granted; a definitive liquidation may follow the self-assessment.',
});

/** ICIO figures for a year, or undefined when no edition has been recorded. */
export function icioForYear(year: number): IcioYear | undefined {
  return ICIO_BY_YEAR.value[year];
}

/**
 * Expected ICIO quota for a declared PEM, at the rate recorded for the year. Returns null when
 * no edition is on file. The result is an expectation to compare against the self-assessment,
 * not an assessment of tax due.
 */
export function expectedIcio(pem: number, year: number): number | null {
  const edition = icioForYear(year);
  if (!edition || !Number.isFinite(pem)) return null;
  return Math.round(pem * edition.ratePct) / 100;
}

// ---------------------------------------------------------------------------
// Municipal fee for planning services — ordinance 3.3
// ---------------------------------------------------------------------------

/** Shape of the planning-services fee: a rate per square metre with a minimum. */
export interface PlanningFeeShape {
  /** Fee per square metre of works, EUR. */
  perSquareMetre: number | null;
  /** Minimum fee, EUR. */
  minimum: number | null;
}

/**
 * Ordinance 3.3 is stored as a shape with unset amounts: the figures circulating in the
 * research summaries may belong to an older edition, so they are read from the archived
 * ordinance before use. Comunicats carry lower fixed fees than major-works licences.
 */
export const PLANNING_FEE: VerifiableConstant<PlanningFeeShape> = Object.freeze({
  value: Object.freeze({ perSquareMetre: null, minimum: null }),
  sourceId: 'BS-02',
  toVerify: true,
  note: 'Amounts to be read from the edition in force at the filing date; the figures found during research may be from an earlier edition.',
});

// ---------------------------------------------------------------------------
// Subsidy calls — Consorci de l'Habitatge de Barcelona
// ---------------------------------------------------------------------------

/** Caps of a subsidy call. */
export interface SubsidyCap {
  /** Share of the eligible budget, in percent. */
  pct: number;
  /** Other percentage reported by a research pack, when they disagreed. */
  alternativeReportedPct?: number;
  /** Absolute caps in EUR; these are ceilings, never unit prices. */
  capPerBuilding?: number;
  capPerDwelling?: number;
  capExterior?: number;
  /** Conditions the call attaches to eligible expenses. */
  conditions?: readonly string[];
}

/** Accessibility call (lift installation and barrier removal). */
export const CONSORCI_ACCESSIBILITY_CAP: VerifiableConstant<SubsidyCap> = Object.freeze({
  value: Object.freeze({
    pct: 35,
    alternativeReportedPct: 25,
    capPerBuilding: 30000,
    capExterior: 50000,
    conditions: Object.freeze([
      'The composition of the eligible budget (technical fees, taxes, VAT) is unconfirmed.',
      'The district is not on the priority-neighbourhood list, which changes the percentage in some editions.',
    ]),
  }),
  sourceId: 'BS-03',
  toVerify: true,
  note: 'Research packs reported 35% capped at 30,000 EUR interior / 50,000 EUR exterior, and 25% / 30,000 EUR. Both readings are carried until the call resolution is archived.',
});

/** Common-elements call. */
export const CONSORCI_COMMON_ELEMENTS_CAP: VerifiableConstant<SubsidyCap> = Object.freeze({
  value: Object.freeze({
    pct: 35,
    capPerBuilding: 30000,
    capPerDwelling: 3000,
    conditions: Object.freeze([
      'The cap is the lower of the per-building and per-dwelling amounts.',
      'Eligible expenses above 1,000 EUR must be paid by bank transfer.',
      'A valid technical building inspection is required.',
    ]),
  }),
  sourceId: 'BS-04',
  toVerify: true,
  note: 'The documentary requirements are the operative part for rule G3; the percentage still needs the archived call.',
});

/**
 * Threshold above which the call bases require three quotes. Left unset on purpose: the figure
 * is read from the archived bases of the specific call and stored on the subsidy row.
 */
export const SUBSIDY_THREE_QUOTES_THRESHOLD: VerifiableConstant<number | null> = Object.freeze({
  value: null,
  sourceId: 'BS-04',
  toVerify: true,
  note: 'Rule G3 reads the threshold from `subsidies.programa_bases_source_id`; no default is assumed.',
});

// ---------------------------------------------------------------------------
// Lift maintenance and inspection periodicity — RD 355/2024 (ITC AEM 1)
// ---------------------------------------------------------------------------

/** Periodicity that drives the expected number of maintenance and inspection documents. */
export interface LiftPeriodicity {
  /** Maintenance visits per year expected for the installation class. */
  maintenanceVisitsPerYear: number | null;
  /** Interval in years between periodic inspections by a control body. */
  inspectionIntervalYears: number | null;
}

/**
 * Not a price: the periodicity decides how many maintenance invoices and inspection reports a
 * year should contain, which is what rule G5 tests. The values stay unset until the ITC has
 * been read, because the periodicity depends on the installation class.
 */
export const LIFT_PERIODICITY: VerifiableConstant<LiftPeriodicity> = Object.freeze({
  value: Object.freeze({ maintenanceVisitsPerYear: null, inspectionIntervalYears: null }),
  sourceId: 'BS-06',
  toVerify: true,
  note: 'Periodicity depends on the installation class (building use, occupancy); read it from the archived instruction before counting documents.',
});

// ---------------------------------------------------------------------------
// Administrator fees — literature range, not a benchmark
// ---------------------------------------------------------------------------

/**
 * `[L]` Administrator fee range quoted in firm publications, kept for orientation only. One
 * research pack quoted a far higher range; the lower one is carried and rule D9 is capped at
 * severity 2. This range never becomes a `benchmark_records` row and never prices a line.
 */
export const ADMIN_FEE_RANGE_LITERATURE: LiteratureRange = Object.freeze({
  marker: LITERATURE_MARKER,
  low: 3,
  high: 7,
  unit: 'EUR/unit/month',
  sourceId: 'BS-15',
  usableAsBenchmark: false,
  severityCap: 2,
  note: 'Firm publications, Barcelona; a higher range was reported by another research pack. Used only to decide whether a fee is worth asking about, never to compute a deviation.',
});

// ---------------------------------------------------------------------------
// Parameter rows derived from the constants above
// ---------------------------------------------------------------------------

/** A row for `public.parameters`, so a rule can cite the version it used. */
export interface ParameterSeed {
  key: string;
  valueNum: number | null;
  unit: string;
  basisText: string;
  validFrom: string;
  version: number;
  sourceId: string;
  toVerify: boolean;
}

/**
 * Parameter rows for the official-tier constants. Rows whose `valueNum` is null are inserted
 * as placeholders so that a rule referring to them fails loudly instead of assuming a default.
 */
export function officialParameterSeeds(): ParameterSeed[] {
  const seeds: ParameterSeed[] = [];
  for (const [year, edition] of Object.entries(ICIO_BY_YEAR.value)) {
    seeds.push({
      key: 'icio_rate_pct',
      valueNum: edition.ratePct,
      unit: 'pct',
      basisText: `Municipal fiscal ordinance 2.1, edition ${year} (${ICIO_BY_YEAR.sourceId}); a second reading of ${edition.alternativeReportedPct ?? edition.ratePct}% is recorded and to verify.`,
      validFrom: `${year}-01-01`,
      version: 1,
      sourceId: ICIO_BY_YEAR.sourceId,
      toVerify: ICIO_BY_YEAR.toVerify,
    });
  }
  seeds.push({
    key: 'icio_accessibility_bonus_pct',
    valueNum: ICIO_BY_YEAR.value[2023]?.accessibilityBonusPct ?? null,
    unit: 'pct',
    basisText: `Accessibility bonus reported in ordinance 2.1 (${ICIO_BY_YEAR.sourceId}); must be requested and granted.`,
    validFrom: '2021-01-01',
    version: 1,
    sourceId: ICIO_BY_YEAR.sourceId,
    toVerify: true,
  });
  seeds.push({
    key: 'planning_fee_per_m2',
    valueNum: PLANNING_FEE.value.perSquareMetre,
    unit: 'EUR/m2',
    basisText: `Municipal fiscal ordinance 3.3 (${PLANNING_FEE.sourceId}); amount to be read from the edition in force.`,
    validFrom: '2021-01-01',
    version: 1,
    sourceId: PLANNING_FEE.sourceId,
    toVerify: true,
  });
  seeds.push({
    key: 'subsidy_accessibility_pct',
    valueNum: CONSORCI_ACCESSIBILITY_CAP.value.pct,
    unit: 'pct',
    basisText: `Accessibility call (${CONSORCI_ACCESSIBILITY_CAP.sourceId}); a second reading of ${CONSORCI_ACCESSIBILITY_CAP.value.alternativeReportedPct ?? ''}% is recorded and to verify.`,
    validFrom: '2021-05-07',
    version: 1,
    sourceId: CONSORCI_ACCESSIBILITY_CAP.sourceId,
    toVerify: true,
  });
  seeds.push({
    key: 'subsidy_common_elements_pct',
    valueNum: CONSORCI_COMMON_ELEMENTS_CAP.value.pct,
    unit: 'pct',
    basisText: `Common-elements call (${CONSORCI_COMMON_ELEMENTS_CAP.sourceId}).`,
    validFrom: '2025-01-01',
    version: 1,
    sourceId: CONSORCI_COMMON_ELEMENTS_CAP.sourceId,
    toVerify: true,
  });
  seeds.push({
    key: 'lift_maintenance_visits_per_year',
    valueNum: LIFT_PERIODICITY.value.maintenanceVisitsPerYear,
    unit: 'count',
    basisText: `Periodicity instruction (${LIFT_PERIODICITY.sourceId}); depends on the installation class.`,
    validFrom: '2024-01-01',
    version: 1,
    sourceId: LIFT_PERIODICITY.sourceId,
    toVerify: true,
  });
  return seeds;
}

/** Every constant in this module that still needs its archived source, for the report gate. */
export function unverifiedConstants(): { key: string; sourceId: string; note: string }[] {
  const rows: { key: string; sourceId: string; note: string }[] = [];
  const add = (key: string, c: { sourceId: string; toVerify: boolean; note?: string }): void => {
    if (c.toVerify) rows.push({ key, sourceId: c.sourceId, note: c.note ?? '' });
  };
  add('icio_by_year', ICIO_BY_YEAR);
  add('planning_fee', PLANNING_FEE);
  add('consorci_accessibility_cap', CONSORCI_ACCESSIBILITY_CAP);
  add('consorci_common_elements_cap', CONSORCI_COMMON_ELEMENTS_CAP);
  add('subsidy_three_quotes_threshold', SUBSIDY_THREE_QUOTES_THRESHOLD);
  add('lift_periodicity', LIFT_PERIODICITY);
  return rows;
}
