/**
 * Matching and write-planning tests for `vx vendors catastro`. Pure functions only: the unit
 * rows and the Cadastre units are literals shaped like the database rows and the check output.
 * Labels are invented; no natural person appears.
 */
import { describe, expect, it } from 'vitest';
import type { CatastroUnit } from './checks/catastro-units.ts';
import {
  catastroMatchKey,
  comparisonTable,
  matchCatastroUnits,
  normaliseDoor,
  normaliseFloor,
  planUnitWrites,
  renderComparison,
  splitUnitLabel,
  unitMatchKey,
  unitsFromNormalised,
  type UnitRow,
} from './catastro-apply.ts';

function cu(over: Partial<CatastroUnit>): CatastroUnit {
  return {
    rc: null,
    staircase: '1',
    floor: null,
    door: null,
    use: 'Residencial',
    surface_m2: null,
    coefficient_pct: null,
    year_built: 1928,
    address_line: null,
    ...over,
  };
}

function ur(over: Partial<UnitRow> & { id: string; label: string }): UnitRow {
  return {
    floor: null,
    door: null,
    use: null,
    quota_pct: null,
    catastro_rc20: null,
    surface_m2: null,
    ...over,
  };
}

describe('floor and door normalisation', () => {
  it('maps the usual spellings of the same floor to one token', () => {
    for (const s of ['Pral', 'PR', 'pral.', 'Principal', 'PRAL'])
      expect(normaliseFloor(s)).toBe('PR');
    for (const s of ['Baixos', 'BJ', 'Bajos', 'PB', '00', 'Local'])
      expect(normaliseFloor(s)).toBe('BJ');
    for (const s of ['Entl', 'EN', 'Entresol', 'Entresuelo']) expect(normaliseFloor(s)).toBe('EN');
    for (const s of ['Àtic', 'AT', 'Ático', 'atic']) expect(normaliseFloor(s)).toBe('AT');
    for (const s of ['1r', '01', '1º', '1', 'primer', '1a']) expect(normaliseFloor(s)).toBe('1');
    expect(normaliseFloor('4t')).toBe('4');
    expect(normaliseFloor('-1')).toBe('ST');
    expect(normaliseFloor(null)).toBeNull();
    expect(normaliseFloor('  ')).toBeNull();
  });

  it('maps door spellings symmetrically', () => {
    for (const s of ['1a', '01', '1ª', '1']) expect(normaliseDoor(s)).toBe('1');
    expect(normaliseDoor('2a')).toBe('2');
    expect(normaliseDoor('A')).toBe('A');
    for (const s of ['Dreta', 'DR', 'D', 'Dcha.']) expect(normaliseDoor(s)).toBe('DR');
    for (const s of ['Esquerra', 'IZ', 'E']) expect(normaliseDoor(s)).toBe('IZ');
    expect(normaliseDoor(null)).toBeNull();
  });

  it('splits labels into floor and door, dropping part words and the staircase', () => {
    expect(splitUnitLabel('Pral 1a')).toEqual({ floor: 'PRAL', door: '1A' });
    expect(splitUnitLabel('1r 2a')).toEqual({ floor: '1R', door: '2A' });
    expect(splitUnitLabel('Baixos')).toEqual({ floor: 'BAIXOS', door: null });
    expect(splitUnitLabel('4t 1a (esc. B)')).toEqual({ floor: '4T', door: '1A' });
    expect(splitUnitLabel('Esc A 1r 2a')).toEqual({ floor: '1R', door: '2A' });
    expect(splitUnitLabel('Àtic 1a')).toEqual({ floor: 'ATIC', door: '1A' });
    expect(splitUnitLabel('Pis 3r porta 1a')).toEqual({ floor: '3R', door: '1A' });
  });

  it('derives the same key from a table row and from the Cadastre unit', () => {
    expect(unitMatchKey({ label: 'Pral 1a', floor: null, door: null })).toEqual({
      key: 'PR|1',
      basis: 'label',
    });
    expect(unitMatchKey({ label: 'anything', floor: 'Pral', door: '1a' })).toEqual({
      key: 'PR|1',
      basis: 'floor_door',
    });
    expect(catastroMatchKey({ floor: 'PR', door: '01' })).toBe('PR|1');
    expect(catastroMatchKey({ floor: null, door: null })).toBeNull();
    expect(unitMatchKey({ label: '', floor: null, door: null })).toEqual({
      key: null,
      basis: null,
    });
  });
});

const CATASTRO: CatastroUnit[] = [
  cu({
    rc: '9999999ZZ9999Z0001AB',
    floor: 'BJ',
    door: '01',
    use: 'Comercial',
    surface_m2: 120,
    coefficient_pct: 12.4,
  }),
  cu({
    rc: '9999999ZZ9999Z0002CD',
    floor: 'EN',
    door: '01',
    surface_m2: 70,
    coefficient_pct: 7.32,
  }),
  cu({ rc: '9999999ZZ9999Z0003EF', floor: 'PR', door: '01', surface_m2: 88, coefficient_pct: 9.1 }),
  cu({
    rc: '9999999ZZ9999Z0004GH',
    floor: '01',
    door: '01',
    surface_m2: 76,
    coefficient_pct: 7.85,
  }),
  cu({
    rc: '9999999ZZ9999Z0005IJ',
    floor: '01',
    door: '02',
    surface_m2: 76,
    coefficient_pct: 7.85,
  }),
];

const UNITS: UnitRow[] = [
  ur({ id: 'u-local', label: 'Local', quota_pct: 12.5 }),
  ur({
    id: 'u-entl',
    label: 'Entl 1a',
    quota_pct: 7.32,
    catastro_rc20: '9999999ZZ9999Z0002CD',
    surface_m2: 70,
  }),
  ur({ id: 'u-pral', label: 'Pral 1a', floor: 'Pral', door: '1a', quota_pct: 9.0, surface_m2: 85 }),
  ur({ id: 'u-1r1a', label: '1r 1a', quota_pct: 7.85 }),
  ur({ id: 'u-1r2a', label: '1r 2a', quota_pct: 7.85 }),
  ur({ id: 'u-2n1a', label: '2n 1a', quota_pct: 8.0 }),
];

describe('matchCatastroUnits', () => {
  const report = matchCatastroUnits(UNITS, CATASTRO);

  it('matches one-to-one on the normalised floor and door, via label or via the row columns', () => {
    const byLabel = new Map(report.matches.map((m) => [m.unit.label, m]));
    expect(byLabel.get('Entl 1a')?.catastro.rc).toBe('9999999ZZ9999Z0002CD');
    expect(byLabel.get('Entl 1a')?.matched_by).toBe('label');
    expect(byLabel.get('Pral 1a')?.matched_by).toBe('floor_door');
    expect(byLabel.get('1r 1a')?.catastro.rc).toBe('9999999ZZ9999Z0004GH');
    expect(byLabel.get('1r 2a')?.catastro.rc).toBe('9999999ZZ9999Z0005IJ');
  });

  it('pairs a doorless table unit with the only Cadastre unit left on its floor', () => {
    const local = report.matches.find((m) => m.unit.label === 'Local');
    expect(local?.matched_by).toBe('floor_only');
    expect(local?.catastro.rc).toBe('9999999ZZ9999Z0001AB');
  });

  it('lists what has no counterpart', () => {
    expect(report.unmatchedUnits.map((u) => u.unit.label)).toEqual(['2n 1a']);
    expect(report.unmatchedCatastro).toEqual([]);
    expect(report.ambiguous).toEqual([]);
  });

  it('leaves anything that is not one-to-one alone', () => {
    const twoLocals = [
      ur({ id: 'a', label: 'Baixos 1', quota_pct: 6 }),
      ur({ id: 'b', label: 'Local 1', quota_pct: 6 }),
    ];
    const r = matchCatastroUnits(twoLocals, [CATASTRO[0] as CatastroUnit]);
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]?.key).toBe('BJ|1');
    expect(r.ambiguous[0]?.units.map((u) => u.id).sort()).toEqual(['a', 'b']);
    expect(r.unmatchedUnits).toEqual([]);
    expect(r.unmatchedCatastro).toEqual([]);
  });

  it('does not pair a doorless unit when several Cadastre units remain on the floor', () => {
    const r = matchCatastroUnits(
      [ur({ id: 'x', label: 'Primer', quota_pct: 10 })],
      [CATASTRO[3] as CatastroUnit, CATASTRO[4] as CatastroUnit],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedUnits).toHaveLength(1);
    expect(r.unmatchedCatastro).toHaveLength(2);
  });
});

describe('planUnitWrites', () => {
  const report = matchCatastroUnits(UNITS, CATASTRO);

  it('fills empty columns only, never quota_pct, and keeps differing values unless forced', () => {
    const plans = planUnitWrites(report.matches, { force: false });
    const byLabel = new Map(plans.map((p) => [p.label, p]));
    expect(byLabel.get('Local')?.set).toEqual({
      catastro_rc20: '9999999ZZ9999Z0001AB',
      surface_m2: 120,
    });
    // Already carries the same reference and surface: nothing to write, nothing kept.
    expect(byLabel.get('Entl 1a')?.set).toEqual({});
    expect(byLabel.get('Entl 1a')?.kept).toEqual([]);
    // Reference empty (written), surface differs (kept).
    expect(byLabel.get('Pral 1a')?.set).toEqual({ catastro_rc20: '9999999ZZ9999Z0003EF' });
    expect(byLabel.get('Pral 1a')?.kept[0]).toMatch(/surface_m2 kept as 85 \(Cadastre 88\)/);
    for (const p of plans) expect(Object.keys(p.set)).not.toContain('quota_pct');
  });

  it('overwrites differing values with --force', () => {
    const plans = planUnitWrites(report.matches, { force: true });
    const pral = plans.find((p) => p.label === 'Pral 1a');
    expect(pral?.set).toEqual({ catastro_rc20: '9999999ZZ9999Z0003EF', surface_m2: 88 });
    expect(pral?.kept).toEqual([]);
  });

  it('refuses a reference that is not 20 characters', () => {
    const short = matchCatastroUnits(
      [ur({ id: 'p', label: 'Pral 1a' })],
      [cu({ rc: '9999999ZZ9999Z', floor: 'PR', door: '01', surface_m2: 88 })],
    );
    const [plan] = planUnitWrites(short.matches, { force: true });
    expect(plan?.set).toEqual({ surface_m2: 88 });
    expect(plan?.kept[0]).toMatch(/not 20 characters/);
  });
});

describe('comparisonTable', () => {
  const report = matchCatastroUnits(UNITS, CATASTRO);
  const table = comparisonTable(report, UNITS, CATASTRO);

  it('prints quota next to coefficient with the difference, and sums both sides', () => {
    const pral = table.rows.find((r) => r.label === 'Pral 1a');
    expect(pral?.quota_pct).toBe(9);
    expect(pral?.coefficient_pct).toBe(9.1);
    expect(pral?.difference_pct).toBeCloseTo(0.1, 9);
    expect(pral?.surface_table).toBe(85);
    expect(pral?.surface_catastro).toBe(88);
    expect(table.sums.units).toBe(6);
    expect(table.sums.catastro_units).toBe(5);
    expect(table.sums.matched).toBe(5);
    expect(table.sums.quota_pct).toBeCloseTo(52.52, 9);
    expect(table.sums.coefficient_pct).toBeCloseTo(44.52, 9);
    expect(table.sums.matched_quota_pct).toBeCloseTo(44.52, 9);
    expect(table.sums.matched_coefficient_pct).toBeCloseTo(44.52, 9);
  });

  it('lists the unmatched unit as unit_only', () => {
    const only = table.rows.filter((r) => r.side === 'unit_only');
    expect(only.map((r) => r.label)).toEqual(['2n 1a']);
  });

  it('renders one line per row plus the sums and the wording about the title', () => {
    const lines = renderComparison(table);
    expect(lines).toHaveLength(1 + table.rows.length + 2);
    expect(lines[0]).toMatch(/quota %/);
    expect(lines.at(-2)).toMatch(/^sums: table 6 unit\(s\)/);
    expect(lines.at(-1)).toMatch(/discrepancy to verify/);
    expect(lines.join('\n')).toContain('9999999ZZ9999Z0003EF');
  });
});

describe('unitsFromNormalised', () => {
  it('coerces the stored unit list back, tolerating strings for numbers', () => {
    const units = unitsFromNormalised({
      units: [
        {
          rc: '9999999ZZ9999Z0001AB',
          floor: 'BJ',
          door: '01',
          surface_m2: '120',
          coefficient_pct: '12.4',
        },
        null,
        'garbage',
      ],
    });
    expect(units).toHaveLength(1);
    expect(units[0]?.surface_m2).toBe(120);
    expect(units[0]?.coefficient_pct).toBe(12.4);
    expect(units[0]?.staircase).toBeNull();
    expect(unitsFromNormalised({})).toEqual([]);
    expect(unitsFromNormalised(null)).toEqual([]);
  });
});
