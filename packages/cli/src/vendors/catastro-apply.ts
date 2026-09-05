/**
 * `vx vendors catastro` — compare the latest Cadastre unit list with the unit table and, on
 * `--apply`, fill `units.catastro_rc20` and `units.surface_m2` where exactly one Cadastre unit
 * matches exactly one unit of the table.
 *
 * The constitutive title is the authority on participation quotas (CCCat art. 553-3):
 * `quota_pct` is never written from the Cadastre. The coefficient the Cadastre publishes is
 * printed next to the quota so a difference can be verified, and both columns are summed so the
 * table closes on each side.
 *
 * Matching. Floor and door are normalised on both sides into the same tokens (`BJ`, `EN`, `PR`,
 * `AT`, digits without leading zeros, `IZ`/`DR`, …); the same normaliser is applied to the
 * Cadastre's `pt`/`pu` and to the table's `floor`/`door`, so a spelling that maps oddly still maps
 * identically on both sides. A unit label ("Pral 1a") is split into floor and door only when the
 * row carries no floor and door of its own. Anything that is not one-to-one is listed and left
 * alone; a lone unit on a floor may match a lone Cadastre unit on that floor.
 *
 * Every write is one `public.log_access` row (action `edit`, entity `unit`) naming the check the
 * figures came from, so the unit table can say where its cadastral data came from and when.
 */
import { stripDiacritics } from '@viladomat/core';
import type { CatastroUnit } from './checks/catastro-units.ts';
import type { Queryable } from './persist.ts';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Floor spellings (minutes, seed files, Cadastre `pt`) → one token. */
const FLOOR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  BJ: 'BJ',
  BJO: 'BJ',
  BAJO: 'BJ',
  BAJOS: 'BJ',
  BAIX: 'BJ',
  BAIXOS: 'BJ',
  PB: 'BJ',
  PLANTABAJA: 'BJ',
  PLANTABAIXA: 'BJ',
  // A ground-floor shop is labelled "Local" in minutes and sits on floor 00/BJ in the Cadastre.
  LOCAL: 'BJ',
  LOC: 'BJ',
  TIENDA: 'BJ',
  BOTIGA: 'BJ',
  EN: 'EN',
  ENT: 'EN',
  ENTL: 'EN',
  ENTLO: 'EN',
  ENTRESUELO: 'EN',
  ENTRESOL: 'EN',
  ENTRESSOL: 'EN',
  PR: 'PR',
  PRAL: 'PR',
  PRL: 'PR',
  PRINCIPAL: 'PR',
  AT: 'AT',
  ATC: 'AT',
  ATICO: 'AT',
  ATIC: 'AT',
  SA: 'SA',
  SAT: 'SA',
  SOBREATICO: 'SA',
  SOBREATIC: 'SA',
  ST: 'ST',
  SOT: 'ST',
  SOTANO: 'ST',
  SOTERRANI: 'ST',
  SS: 'ST',
  SM: 'SM',
  SEMISOTANO: 'SM',
  SEMISOTERRANI: 'SM',
});

/** Ordinal words for floors, Catalan and Spanish. */
const FLOOR_ORDINALS: Readonly<Record<string, string>> = Object.freeze({
  PRIMER: '1',
  PRIMERA: '1',
  PRIMERO: '1',
  SEGON: '2',
  SEGONA: '2',
  SEGUNDO: '2',
  SEGUNDA: '2',
  TERCER: '3',
  TERCERA: '3',
  TERCERO: '3',
  QUART: '4',
  QUARTA: '4',
  CUARTO: '4',
  CUARTA: '4',
  CINQUE: '5',
  CINQUENA: '5',
  QUINTO: '5',
  QUINTA: '5',
  SISE: '6',
  SISENA: '6',
  SEXTO: '6',
  SEXTA: '6',
  SETE: '7',
  SETENA: '7',
  SEPTIMO: '7',
  SEPTIMA: '7',
  VUITE: '8',
  VUITENA: '8',
  OCTAVO: '8',
  OCTAVA: '8',
});

/** Door spellings → one token. Symmetric on both sides, so a letter door still matches itself. */
const DOOR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  IZ: 'IZ',
  IZQ: 'IZ',
  IZQUIERDA: 'IZ',
  ESQ: 'IZ',
  ESQUERRA: 'IZ',
  E: 'IZ',
  DR: 'DR',
  DER: 'DR',
  DCHA: 'DR',
  DERECHA: 'DR',
  DRETA: 'DR',
  D: 'DR',
  C: 'C',
  CTR: 'C',
  CENTRO: 'C',
  CENTRE: 'C',
  UNICA: '1',
  UNICO: '1',
  UNIC: '1',
});

/** Words in a label that name a part rather than a value ("Pis", "Porta", "Esc."). */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  'PIS',
  'PISO',
  'PLANTA',
  'PL',
  'PT',
  'PTA',
  'PORTA',
  'PUERTA',
  'BLOQUE',
  'BLOC',
  'BQ',
  'ENTITAT',
  'ENTIDAD',
  'FINCA',
]);

/** Words introducing a staircase; the token that follows them is the staircase, not a door. */
const STAIRCASE_WORDS: ReadonlySet<string> = new Set(['ESC', 'ESCALA', 'ESCALERA', 'ES']);

function cleanToken(raw: unknown): string {
  return stripDiacritics(String(raw))
    .toUpperCase()
    .replace(/[ºª°.]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** `Pral`, `PR`, `01`, `1r`, `primero` → `PR` / `1`; `Baixos`, `BJ`, `00`, `Local` → `BJ`. */
export function normaliseFloor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = cleanToken(raw);
  if (!s) return null;
  const word = FLOOR_WORDS[s] ?? FLOOR_ORDINALS[s];
  if (word) return word;
  const m = /^(-?\d+)[A-Z]{0,3}$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n === 0) return 'BJ';
    if (n < 0) return 'ST';
    return String(n);
  }
  return s;
}

/** `1a`, `01`, `1ª` → `1`; `A` → `A`; `Dreta`, `DR`, `D` → `DR`. */
export function normaliseDoor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = cleanToken(raw);
  if (!s) return null;
  const word = DOOR_WORDS[s];
  if (word) return word;
  const m = /^(\d+)[A-Z]{0,3}$/.exec(s);
  if (m) return String(Number(m[1]));
  return s;
}

/**
 * Split a unit label into a floor and a door: "Pral 1a" → {Pral, 1a}; "Baixos" → {Baixos, null};
 * "4t 1a (esc. B)" → {4t, 1a}. Parenthesised parts, part words and the staircase are dropped.
 */
export function splitUnitLabel(label: string): { floor: string | null; door: string | null } {
  const text = stripDiacritics(label)
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[ºª°.]/g, '');
  const tokens = text.split(/[\s,\-/]+/).filter(Boolean);
  const kept: string[] = [];
  let skipNext = false;
  for (const t of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (STAIRCASE_WORDS.has(t)) {
      skipNext = true;
      continue;
    }
    if (NOISE_WORDS.has(t)) continue;
    kept.push(t);
  }
  return { floor: kept[0] ?? null, door: kept[1] ?? null };
}

function keyOf(floor: string | null, door: string | null): string | null {
  if (floor === null && door === null) return null;
  return `${floor ?? ''}|${door ?? ''}`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A row of `public.units` as the matcher needs it (numerics already converted). */
export interface UnitRow {
  id: string;
  label: string;
  floor: string | null;
  door: string | null;
  use: string | null;
  quota_pct: number | null;
  catastro_rc20: string | null;
  surface_m2: number | null;
}

export type MatchBasis = 'floor_door' | 'label' | 'floor_only';

/** The key of a table row: from its floor and door, else from its label. */
export function unitMatchKey(unit: Pick<UnitRow, 'label' | 'floor' | 'door'>): {
  key: string | null;
  basis: 'floor_door' | 'label' | null;
} {
  let floor = normaliseFloor(unit.floor);
  let door = normaliseDoor(unit.door);
  let basis: 'floor_door' | 'label' = 'floor_door';
  if (floor === null && door === null) {
    const split = splitUnitLabel(unit.label);
    floor = normaliseFloor(split.floor);
    door = normaliseDoor(split.door);
    basis = 'label';
  }
  const key = keyOf(floor, door);
  return { key, basis: key === null ? null : basis };
}

/** The key of a Cadastre unit, from `pt` and `pu`. */
export function catastroMatchKey(unit: Pick<CatastroUnit, 'floor' | 'door'>): string | null {
  return keyOf(normaliseFloor(unit.floor), normaliseDoor(unit.door));
}

export interface UnitMatch {
  unit: UnitRow;
  catastro: CatastroUnit;
  key: string;
  matched_by: MatchBasis;
}

export interface MatchReport {
  matches: UnitMatch[];
  unmatchedUnits: Array<{ unit: UnitRow; key: string | null }>;
  unmatchedCatastro: Array<{ catastro: CatastroUnit; key: string | null }>;
  /** Keys present on both sides but not one-to-one: listed, never written. */
  ambiguous: Array<{ key: string; units: UnitRow[]; catastro: CatastroUnit[] }>;
}

function groupBy<T>(items: readonly T[], keyFn: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    if (k === null) continue;
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

/**
 * One-to-one matching on the normalised floor+door key, then a second pass that pairs a table
 * unit with no door to the only Cadastre unit left on its floor. Everything else is reported.
 */
export function matchCatastroUnits(
  units: readonly UnitRow[],
  catastro: readonly CatastroUnit[],
): MatchReport {
  const unitKeys = new Map(units.map((u) => [u.id, unitMatchKey(u)] as const));
  const byUnitKey = groupBy(units, (u) => unitKeys.get(u.id)?.key ?? null);
  const byCatastroKey = groupBy(catastro, catastroMatchKey);

  const matches: UnitMatch[] = [];
  const ambiguous: MatchReport['ambiguous'] = [];
  const matchedUnitIds = new Set<string>();
  const matchedCatastro = new Set<CatastroUnit>();

  for (const [key, us] of byUnitKey) {
    const cs = byCatastroKey.get(key);
    if (!cs) continue;
    const u = us[0];
    const c = cs[0];
    if (us.length === 1 && cs.length === 1 && u && c) {
      matches.push({ unit: u, catastro: c, key, matched_by: unitKeys.get(u.id)?.basis ?? 'label' });
      matchedUnitIds.add(u.id);
      matchedCatastro.add(c);
    } else {
      ambiguous.push({ key, units: [...us], catastro: [...cs] });
      for (const x of us) matchedUnitIds.add(x.id);
      for (const x of cs) matchedCatastro.add(x);
    }
  }

  // Second pass: a table unit with a floor but no door, alone on that floor, against the only
  // remaining Cadastre unit on the same floor.
  const leftUnits = units.filter((u) => !matchedUnitIds.has(u.id));
  const leftCatastro = catastro.filter((c) => !matchedCatastro.has(c));
  const leftByFloor = groupBy(leftCatastro, (c) => normaliseFloor(c.floor));
  const doorlessByFloor = groupBy(
    leftUnits.filter((u) => {
      const k = unitKeys.get(u.id)?.key;
      return typeof k === 'string' && k.endsWith('|') && k !== '|';
    }),
    (u) => (unitKeys.get(u.id)?.key ?? '').slice(0, -1),
  );
  for (const [floor, us] of doorlessByFloor) {
    const cs = leftByFloor.get(floor);
    const u = us[0];
    const c = cs?.[0];
    if (us.length === 1 && cs && cs.length === 1 && u && c) {
      matches.push({ unit: u, catastro: c, key: `${floor}|`, matched_by: 'floor_only' });
      matchedUnitIds.add(u.id);
      matchedCatastro.add(c);
    }
  }

  const ambiguousUnitIds = new Set(ambiguous.flatMap((a) => a.units.map((u) => u.id)));
  const ambiguousCatastro = new Set(ambiguous.flatMap((a) => a.catastro));
  return {
    matches,
    ambiguous,
    unmatchedUnits: units
      .filter((u) => !matchedUnitIds.has(u.id) && !ambiguousUnitIds.has(u.id))
      .map((u) => ({ unit: u, key: unitKeys.get(u.id)?.key ?? null })),
    unmatchedCatastro: catastro
      .filter((c) => !matchedCatastro.has(c) && !ambiguousCatastro.has(c))
      .map((c) => ({ catastro: c, key: catastroMatchKey(c) })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface UnitWrite {
  unitId: string;
  label: string;
  /** Columns to write; empty when the row already carries the same values. */
  set: { catastro_rc20?: string; surface_m2?: number };
  /** Values left as they are, with the reason. */
  kept: string[];
}

/**
 * What `--apply` would write for each match: the 20-character reference and the built surface,
 * only into empty columns unless `force` is set. `quota_pct` is never part of a plan.
 */
export function planUnitWrites(
  matches: readonly UnitMatch[],
  opts: { force: boolean },
): UnitWrite[] {
  return matches.map(({ unit, catastro }): UnitWrite => {
    const set: UnitWrite['set'] = {};
    const kept: string[] = [];
    const rc = catastro.rc && catastro.rc.length === 20 ? catastro.rc : null;
    if (rc) {
      if (unit.catastro_rc20 === null || (opts.force && unit.catastro_rc20 !== rc)) {
        set.catastro_rc20 = rc;
      } else if (unit.catastro_rc20 !== rc) {
        kept.push(
          `catastro_rc20 kept as ${unit.catastro_rc20} (Cadastre ${rc}); pass --force to overwrite`,
        );
      }
    } else if (catastro.rc) {
      kept.push(`Cadastre reference ${catastro.rc} is not 20 characters; not written`);
    }
    if (catastro.surface_m2 !== null) {
      if (unit.surface_m2 === null || (opts.force && unit.surface_m2 !== catastro.surface_m2)) {
        set.surface_m2 = catastro.surface_m2;
      } else if (unit.surface_m2 !== catastro.surface_m2) {
        kept.push(
          `surface_m2 kept as ${unit.surface_m2} (Cadastre ${catastro.surface_m2}); pass --force to overwrite`,
        );
      }
    }
    return { unitId: unit.id, label: unit.label, set, kept };
  });
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  side: 'matched' | 'ambiguous' | 'unit_only' | 'catastro_only';
  label: string | null;
  key: string | null;
  matched_by: MatchBasis | null;
  rc: string | null;
  surface_table: number | null;
  surface_catastro: number | null;
  quota_pct: number | null;
  coefficient_pct: number | null;
  /** Cadastre coefficient minus table quota, when both are known. */
  difference_pct: number | null;
}

export interface ComparisonTable {
  rows: ComparisonRow[];
  sums: {
    units: number;
    catastro_units: number;
    matched: number;
    quota_pct: number;
    coefficient_pct: number;
    matched_quota_pct: number;
    matched_coefficient_pct: number;
  };
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;

export function comparisonTable(
  report: MatchReport,
  units: readonly UnitRow[],
  catastro: readonly CatastroUnit[],
): ComparisonTable {
  const rows: ComparisonRow[] = [];
  let matchedQuota = 0;
  let matchedCoefficient = 0;
  for (const m of report.matches) {
    const q = m.unit.quota_pct;
    const c = m.catastro.coefficient_pct;
    if (q !== null) matchedQuota += q;
    if (c !== null) matchedCoefficient += c;
    rows.push({
      side: 'matched',
      label: m.unit.label,
      key: m.key,
      matched_by: m.matched_by,
      rc: m.catastro.rc,
      surface_table: m.unit.surface_m2,
      surface_catastro: m.catastro.surface_m2,
      quota_pct: q,
      coefficient_pct: c,
      difference_pct: q !== null && c !== null ? r4(c - q) : null,
    });
  }
  for (const a of report.ambiguous) {
    for (const u of a.units) {
      rows.push({
        side: 'ambiguous',
        label: u.label,
        key: a.key,
        matched_by: null,
        rc: null,
        surface_table: u.surface_m2,
        surface_catastro: null,
        quota_pct: u.quota_pct,
        coefficient_pct: null,
        difference_pct: null,
      });
    }
    for (const c of a.catastro) {
      rows.push({
        side: 'ambiguous',
        label: null,
        key: a.key,
        matched_by: null,
        rc: c.rc,
        surface_table: null,
        surface_catastro: c.surface_m2,
        quota_pct: null,
        coefficient_pct: c.coefficient_pct,
        difference_pct: null,
      });
    }
  }
  for (const { unit, key } of report.unmatchedUnits) {
    rows.push({
      side: 'unit_only',
      label: unit.label,
      key,
      matched_by: null,
      rc: unit.catastro_rc20,
      surface_table: unit.surface_m2,
      surface_catastro: null,
      quota_pct: unit.quota_pct,
      coefficient_pct: null,
      difference_pct: null,
    });
  }
  for (const { catastro: c, key } of report.unmatchedCatastro) {
    rows.push({
      side: 'catastro_only',
      label: null,
      key,
      matched_by: null,
      rc: c.rc,
      surface_table: null,
      surface_catastro: c.surface_m2,
      quota_pct: null,
      coefficient_pct: c.coefficient_pct,
      difference_pct: null,
    });
  }
  return {
    rows,
    sums: {
      units: units.length,
      catastro_units: catastro.length,
      matched: report.matches.length,
      quota_pct: r4(units.reduce((acc, u) => acc + (u.quota_pct ?? 0), 0)),
      coefficient_pct: r4(catastro.reduce((acc, c) => acc + (c.coefficient_pct ?? 0), 0)),
      matched_quota_pct: r4(matchedQuota),
      matched_coefficient_pct: r4(matchedCoefficient),
    },
  };
}

const fmt = (n: number | null, digits = 2): string => (n === null ? '-' : n.toFixed(digits));
const cell = (s: string | null | undefined, width: number): string =>
  (s ?? '-').slice(0, width).padEnd(width);

/** Plain-text rendering of the comparison, for the terminal. */
export function renderComparison(table: ComparisonTable): string[] {
  const lines: string[] = [];
  lines.push(
    `${cell('unit', 14)} ${cell('key', 8)} ${cell('via', 10)} ${cell('Cadastre ref', 20)} ` +
      `${'m2 table'.padStart(9)} ${'m2 Cad.'.padStart(8)} ${'quota %'.padStart(9)} ${'coef. %'.padStart(9)} ${'diff'.padStart(8)}  side`,
  );
  for (const r of table.rows) {
    lines.push(
      `${cell(r.label, 14)} ${cell(r.key, 8)} ${cell(r.matched_by, 10)} ${cell(r.rc, 20)} ` +
        `${fmt(r.surface_table).padStart(9)} ${fmt(r.surface_catastro).padStart(8)} ` +
        `${fmt(r.quota_pct, 4).padStart(9)} ${fmt(r.coefficient_pct, 4).padStart(9)} ${fmt(r.difference_pct, 4).padStart(8)}  ${r.side}`,
    );
  }
  const s = table.sums;
  lines.push(
    `sums: table ${s.units} unit(s), quota ${fmt(s.quota_pct, 4)} % · Cadastre ${s.catastro_units} unit(s), coefficient ${fmt(s.coefficient_pct, 4)} % · ` +
      `matched ${s.matched}: quota ${fmt(s.matched_quota_pct, 4)} % vs coefficient ${fmt(s.matched_coefficient_pct, 4)} %`,
  );
  lines.push(
    'Quotas come from the constitutive title and are not changed here; a difference from the Cadastre coefficient is a discrepancy to verify against the title.',
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface LatestCatastroCheck {
  id: string;
  fetchedAt: string;
  units: CatastroUnit[];
  sourceVerified: boolean | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** The unit list as stored in a check row, coerced back into {@link CatastroUnit}. */
export function unitsFromNormalised(normalised: unknown): CatastroUnit[] {
  const list = (normalised as { units?: unknown } | null)?.units;
  if (!Array.isArray(list)) return [];
  return list
    .filter((u): u is Record<string, unknown> => u !== null && typeof u === 'object')
    .map((u) => ({
      rc: str(u.rc),
      staircase: str(u.staircase),
      floor: str(u.floor),
      door: str(u.door),
      use: str(u.use),
      surface_m2: num(u.surface_m2),
      coefficient_pct: num(u.coefficient_pct),
      year_built: num(u.year_built),
      address_line: str(u.address_line),
    }));
}

/** Latest successful `catastro_units` check recorded for the community itself. */
export async function latestCatastroCheck(
  client: Queryable,
  cid: string,
): Promise<LatestCatastroCheck | null> {
  const res = await client.query(
    `select id, fetched_at::text as fetched_at, normalised
       from public.external_checks
      where community_id = $1 and check_type = 'catastro_units' and status = 'ok'
        and subject_type = 'community'
      order by fetched_at desc limit 1`,
    [cid],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const normalised = (row.normalised as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    fetchedAt: String(row.fetched_at ?? ''),
    units: unitsFromNormalised(normalised),
    sourceVerified:
      typeof normalised.source_verified === 'boolean' ? normalised.source_verified : null,
  };
}

export async function loadUnitRows(client: Queryable, cid: string): Promise<UnitRow[]> {
  const res = await client.query(
    `select id, label, floor, door, use, quota_pct::text as quota_pct, catastro_rc20,
            surface_m2::text as surface_m2
       from public.units where community_id = $1 order by label`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    label: String(r.label ?? ''),
    floor: str(r.floor),
    door: str(r.door),
    use: str(r.use),
    quota_pct: num(r.quota_pct),
    catastro_rc20: str(r.catastro_rc20),
    surface_m2: num(r.surface_m2),
  }));
}

export interface ApplyCatastroOptions {
  /** Write the planned columns; false prints the plan only. */
  apply: boolean;
  /** Overwrite a non-empty `catastro_rc20` or `surface_m2`. */
  force: boolean;
}

export interface CatastroApplyResult {
  check: LatestCatastroCheck;
  report: MatchReport;
  plans: UnitWrite[];
  table: ComparisonTable;
  applied: boolean;
  written: number;
}

/**
 * Compare and, when asked, write. Runs inside the caller's transaction; each written unit gets
 * its `log_access` row naming the check id, before any of it is committed.
 */
export async function applyCatastroToUnits(
  client: Queryable,
  cid: string,
  opts: ApplyCatastroOptions,
): Promise<CatastroApplyResult> {
  const check = await latestCatastroCheck(client, cid);
  if (!check) {
    throw new Error(
      'no successful catastro_units check for this community yet: run `vx vendors check --all --only catastro_units` first',
    );
  }
  const units = await loadUnitRows(client, cid);
  const report = matchCatastroUnits(units, check.units);
  const plans = planUnitWrites(report.matches, { force: opts.force });
  const table = comparisonTable(report, units, check.units);

  let written = 0;
  if (opts.apply) {
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const plan of plans) {
      if (plan.set.catastro_rc20 === undefined && plan.set.surface_m2 === undefined) continue;
      const before = byId.get(plan.unitId);
      await client.query(
        `update public.units
            set catastro_rc20 = coalesce($2, catastro_rc20), surface_m2 = coalesce($3, surface_m2)
          where id = $1 and community_id = $4`,
        [plan.unitId, plan.set.catastro_rc20 ?? null, plan.set.surface_m2 ?? null, cid],
      );
      await client.query(
        `select public.log_access($1, 'edit', 'unit', $2, $3::jsonb, $4::jsonb, $5)`,
        [
          cid,
          plan.unitId,
          JSON.stringify({
            catastro_rc20: before?.catastro_rc20 ?? null,
            surface_m2: before?.surface_m2 ?? null,
          }),
          JSON.stringify({
            catastro_rc20: plan.set.catastro_rc20 ?? before?.catastro_rc20 ?? null,
            surface_m2: plan.set.surface_m2 ?? before?.surface_m2 ?? null,
          }),
          `vx vendors catastro --apply: catastro_rc20 and surface_m2 from Cadastre check ${check.id}; quota_pct untouched`,
        ],
      );
      written++;
    }
  }
  return { check, report, plans, table, applied: opts.apply, written };
}
