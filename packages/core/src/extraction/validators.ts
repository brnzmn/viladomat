/**
 * Versioned, pure validators over parsed documents. Each returns
 * `{ code, version, passed, details }[]` rows for `public.validator_results`.
 *
 * A validator passes when no inconsistency is detected. When the figures needed for a check are
 * not printed, the validator passes with `details.checked = false` — absence of data is not a
 * discrepancy; the mandatory-content rules deal with that separately.
 */
import { validateIban } from '../ids/iban.ts';
import { validateNif } from '../ids/nif.ts';
import type { Acta } from './schemas/acta.ts';
import type { Certificacion } from './schemas/certificacion.ts';
import { isIsoDate } from './schemas/common.ts';
import type { Contrato } from './schemas/contrato.ts';
import type { Derrama } from './schemas/derrama.ts';
import type { Extracto } from './schemas/extracto.ts';
import type { Factura } from './schemas/factura.ts';
import type { Liquidacion } from './schemas/liquidacion.ts';
import type { Presupuesto } from './schemas/presupuesto.ts';
import { schemaKeyFor, type DocType, type SchemaKey } from './types.ts';

export interface ValidatorResult {
  code: string;
  version: number;
  passed: boolean;
  details: Record<string, unknown>;
}

export interface ValidatorOptions {
  /** Reference "today" for date sanity (default: current date). */
  now?: Date;
  /** Earliest plausible document year (default 2019). */
  minYear?: number;
  /** Contract total for the cumulative-certification check (default: `importe_contrato` on the document). */
  contractTotal?: number | null;
}

/** Tolerances in EUR (or percentage points where noted). */
export const TOLERANCES = Object.freeze({
  /** Per line when summing lines. */
  perLine: 0.02,
  /** base × rate = cuota. */
  cuota: 0.02,
  /** Invoice / summary totals. */
  total: 0.05,
  /** Bank statement continuity. */
  statement: 0.01,
  /** Certification arithmetic. */
  certification: 0.02,
  /** Quota sums may not exceed this (percentage points). */
  quotaCap: 100.05,
  /** Quota comparisons (percentage points). */
  quota: 0.05,
});

export const ALLOWED_VAT_RATES: readonly number[] = Object.freeze([0, 4, 10, 21]);
export const SIMPLIFIED_INVOICE_MAX_EUR = 400;
export const DEFAULT_MIN_YEAR = 2019;

/** Version of every validator (bump individually when its logic changes). */
export const VALIDATOR_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  'factura.lineas_suman_base': 1,
  'factura.resumen_suma_totales': 1,
  'factura.base_por_tipo_cuota': 1,
  'factura.total': 1,
  'factura.tipo_iva_permitido': 1,
  'factura.simplificada_max_400': 1,
  'factura.linea_aritmetica': 1,
  'factura.fechas_coherentes': 1,
  'factura.nif_emisor_valido': 1,
  'factura.nif_destinatario_valido': 1,
  'factura.iban_valido': 1,
  'extracto.continuidad_saldo': 1,
  'extracto.saldos_intermedios': 1,
  'extracto.fechas_coherentes': 1,
  'extracto.movimientos_en_periodo': 1,
  'extracto.iban_valido': 1,
  'extracto.contraparte_iban_valido': 1,
  'certificacion.actual_es_origen_menos_anterior': 1,
  'certificacion.partidas_suman_totales': 1,
  'certificacion.acumulado_le_contrato': 1,
  'certificacion.base_iva_total': 1,
  'certificacion.fechas_coherentes': 1,
  'certificacion.nif_contratista_valido': 1,
  'acta.coeficientes_asistentes_le_100': 1,
  'acta.quorum_coincide_con_asistentes': 1,
  'acta.coeficientes_favor_le_quorum': 1,
  'acta.votos_no_exceden_asistentes': 1,
  'acta.fechas_coherentes': 1,
  'presupuesto.partidas_suman_capitulo': 1,
  'presupuesto.capitulos_suman_pem': 1,
  'presupuesto.contrata': 1,
  'presupuesto.total_con_iva': 1,
  'presupuesto.tipo_iva_permitido': 1,
  'presupuesto.fechas_coherentes': 1,
  'presupuesto.nif_emisor_valido': 1,
  'liquidacion.ingresos_suman_total': 1,
  'liquidacion.gastos_suman_total': 1,
  'liquidacion.resultado': 1,
  'liquidacion.saldo_final': 1,
  'liquidacion.fondo_reserva': 1,
  'liquidacion.coeficientes_le_100': 1,
  'liquidacion.fechas_coherentes': 1,
  'liquidacion.nif_comunidad_valido': 1,
  'contrato.precio_con_iva': 1,
  'contrato.calendario_suma': 1,
  'contrato.fechas_coherentes': 1,
  'contrato.nif_partes_validos': 1,
  'contrato.iban_prestamo_valido': 1,
  'derrama.cuotas_suman_total': 1,
  'derrama.plazos_suman_cuota': 1,
  'derrama.coeficientes_le_100': 1,
  'derrama.iban_valido': 1,
  'derrama.fechas_coherentes': 1,
});

export const VALIDATOR_CODES: readonly string[] = Object.freeze(Object.keys(VALIDATOR_VERSIONS));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function result(code: string, passed: boolean, details: Record<string, unknown>): ValidatorResult {
  const version = VALIDATOR_VERSIONS[code];
  if (version === undefined) throw new RangeError(`unknown validator code ${code}`);
  return { code, version, passed, details };
}

function skipped(code: string, reason: string): ValidatorResult {
  return result(code, true, { checked: false, reason });
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sum(values: readonly (number | null | undefined)[]): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const v of values) {
    if (isNum(v)) {
      total += v;
      count += 1;
    }
  }
  return { total: r2(total), count };
}

function within(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol + 1e-9;
}

function dateSane(iso: string | null | undefined, opts: ValidatorOptions): { ok: boolean; reason?: string } {
  if (iso === null || iso === undefined) return { ok: true };
  if (!isIsoDate(iso)) return { ok: false, reason: 'not an ISO date' };
  const minYear = opts.minYear ?? DEFAULT_MIN_YEAR;
  const year = Number(iso.slice(0, 4));
  if (year < minYear) return { ok: false, reason: `before ${minYear}` };
  const now = opts.now ?? new Date();
  const limit = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  if (new Date(`${iso}T00:00:00Z`).getTime() > limit.getTime()) {
    return { ok: false, reason: 'more than one year in the future' };
  }
  return { ok: true };
}

function datesCheck(
  code: string,
  fields: Record<string, string | null | undefined>,
  opts: ValidatorOptions,
  order: ReadonlyArray<readonly [string, string]> = [],
): ValidatorResult {
  const problems: Record<string, string> = {};
  let checked = 0;
  for (const [name, iso] of Object.entries(fields)) {
    if (iso === null || iso === undefined) continue;
    checked += 1;
    const s = dateSane(iso, opts);
    if (!s.ok) problems[name] = s.reason ?? 'invalid';
  }
  for (const [earlier, later] of order) {
    const a = fields[earlier];
    const b = fields[later];
    if (isIsoDate(a) && isIsoDate(b) && a > b) problems[`${earlier}<=${later}`] = `${a} > ${b}`;
  }
  if (checked === 0) return skipped(code, 'no dates');
  return result(code, Object.keys(problems).length === 0, { checked: true, problems });
}

function nifCheck(code: string, raw: string | null | undefined, expectEntity?: 'H'): ValidatorResult {
  if (!raw) return skipped(code, 'not present');
  const v = validateNif(raw);
  const details: Record<string, unknown> = {
    checked: true,
    normalised: v.normalised,
    kind: v.kind,
    reason: v.reason ?? null,
  };
  if (v.entityLetter) details['entityLetter'] = v.entityLetter;
  let passed = v.valid;
  if (passed && expectEntity && v.entityLetter !== expectEntity) {
    details['expectedEntityLetter'] = expectEntity;
    passed = false;
  }
  return result(code, passed, details);
}

function looksLikeFullIban(raw: string): boolean {
  const s = raw.replace(/[\s.\-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s) && !/[*X#•]/.test(s.slice(4));
}

function ibanCheck(code: string, raw: string | null | undefined): ValidatorResult {
  if (!raw) return skipped(code, 'not present');
  if (!looksLikeFullIban(raw)) return skipped(code, 'masked or not an IBAN');
  const v = validateIban(raw);
  return result(code, v.valid, {
    checked: true,
    country: v.country,
    checkDigitsOk: v.checkDigitsOk,
    cccDcOk: v.cccDcOk ?? null,
    bankCode: v.bankCode ?? null,
    reason: v.reason ?? null,
  });
}

// ---------------------------------------------------------------------------
// factura
// ---------------------------------------------------------------------------

export function validateFactura(doc: Factura, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const lines = doc.lineas ?? [];
  const summary = doc.resumen_iva ?? [];

  // Σ lines = base (per rate when a summary exists) ± 0.02·n
  {
    const code = 'factura.lineas_suman_base';
    const withBase = lines.filter((l) => isNum(l.base));
    if (withBase.length === 0) out.push(skipped(code, 'no line bases'));
    else if (summary.some((s) => isNum(s.base) && isNum(s.tipo_pct))) {
      const groups: Record<string, unknown>[] = [];
      let passed = true;
      for (const row of summary) {
        if (!isNum(row.base) || !isNum(row.tipo_pct)) continue;
        const rate = row.tipo_pct;
        const group = withBase.filter((l) => isNum(l.tipo_iva_pct) && l.tipo_iva_pct === rate);
        const s = sum(group.map((l) => l.base));
        const ok = group.length === 0 ? null : within(s.total, row.base, TOLERANCES.perLine * s.count);
        if (ok === false) passed = false;
        groups.push({ rate, lines: s.count, sumLines: s.total, summaryBase: r2(row.base), ok });
      }
      out.push(result(code, passed, { checked: true, mode: 'per_rate', groups }));
    } else if (isNum(doc.base_imponible_total)) {
      const s = sum(withBase.map((l) => l.base));
      const passed = within(s.total, doc.base_imponible_total, TOLERANCES.perLine * s.count);
      out.push(result(code, passed, { checked: true, mode: 'total', sumLines: s.total, base: r2(doc.base_imponible_total), lines: s.count }));
    } else out.push(skipped(code, 'no base to compare'));
  }

  // Σ summary bases = base total, Σ summary cuotas = IVA total
  {
    const code = 'factura.resumen_suma_totales';
    const bases = sum(summary.map((s) => s.base));
    const cuotas = sum(summary.map((s) => s.cuota));
    if (bases.count === 0 && cuotas.count === 0) out.push(skipped(code, 'no summary rows'));
    else {
      const problems: Record<string, unknown> = {};
      if (bases.count > 0 && isNum(doc.base_imponible_total) && !within(bases.total, doc.base_imponible_total, TOLERANCES.perLine * bases.count)) {
        problems['base'] = { sumRows: bases.total, base_imponible_total: r2(doc.base_imponible_total) };
      }
      if (cuotas.count > 0 && isNum(doc.iva_total) && !within(cuotas.total, doc.iva_total, TOLERANCES.perLine * cuotas.count)) {
        problems['iva'] = { sumRows: cuotas.total, iva_total: r2(doc.iva_total) };
      }
      out.push(result(code, Object.keys(problems).length === 0, { checked: true, problems }));
    }
  }

  // base × rate = cuota ± 0.02 (summary rows and lines that print a cuota)
  {
    const code = 'factura.base_por_tipo_cuota';
    const mismatches: Record<string, unknown>[] = [];
    let checked = 0;
    summary.forEach((row, i) => {
      if (!isNum(row.base) || !isNum(row.tipo_pct) || !isNum(row.cuota)) return;
      checked += 1;
      const expected = r2((row.base * row.tipo_pct) / 100);
      if (!within(expected, row.cuota, TOLERANCES.cuota)) mismatches.push({ where: `resumen_iva[${i}]`, expected, printed: r2(row.cuota) });
    });
    lines.forEach((l, i) => {
      if (!isNum(l.base) || !isNum(l.tipo_iva_pct) || !isNum(l.cuota_iva)) return;
      checked += 1;
      const expected = r2((l.base * l.tipo_iva_pct) / 100);
      if (!within(expected, l.cuota_iva, TOLERANCES.cuota)) mismatches.push({ where: `lineas[${i}]`, expected, printed: r2(l.cuota_iva) });
    });
    if (checked === 0) out.push(skipped(code, 'no base/rate/cuota triplets'));
    else out.push(result(code, mismatches.length === 0, { checked: true, mismatches }));
  }

  // base + IVA − IRPF (+ suplidos) = total ± 0.05
  {
    const code = 'factura.total';
    if (!isNum(doc.total_factura) || !isNum(doc.base_imponible_total)) out.push(skipped(code, 'base or total missing'));
    else {
      const iva = isNum(doc.iva_total) ? doc.iva_total : 0;
      const irpf = doc.retencion_irpf && isNum(doc.retencion_irpf.importe) ? doc.retencion_irpf.importe : 0;
      const suplidos = isNum(doc.suplidos) ? doc.suplidos : 0;
      const expected = r2(doc.base_imponible_total + iva - irpf + suplidos);
      out.push(result(code, within(expected, doc.total_factura, TOLERANCES.total), {
        checked: true,
        expected,
        printed: r2(doc.total_factura),
        components: { base: r2(doc.base_imponible_total), iva: r2(iva), irpf: r2(irpf), suplidos: r2(suplidos) },
        ivaPrinted: isNum(doc.iva_total),
      }));
    }
  }

  // rate ∈ {0, 4, 10, 21}
  {
    const code = 'factura.tipo_iva_permitido';
    const rates = new Set<number>();
    for (const l of lines) if (isNum(l.tipo_iva_pct)) rates.add(l.tipo_iva_pct);
    for (const s of summary) if (isNum(s.tipo_pct)) rates.add(s.tipo_pct);
    if (rates.size === 0) out.push(skipped(code, 'no rates'));
    else {
      const bad = [...rates].filter((r) => !ALLOWED_VAT_RATES.includes(r));
      out.push(result(code, bad.length === 0, { checked: true, rates: [...rates], notAllowed: bad }));
    }
  }

  // simplified invoice ≤ 400
  {
    const code = 'factura.simplificada_max_400';
    if (doc.doc_type_confirmed !== 'factura_simplificada') out.push(skipped(code, 'not a simplified invoice'));
    else if (!isNum(doc.total_factura)) out.push(skipped(code, 'no total'));
    else out.push(result(code, doc.total_factura <= SIMPLIFIED_INVOICE_MAX_EUR, { checked: true, total: r2(doc.total_factura), max: SIMPLIFIED_INVOICE_MAX_EUR }));
  }

  // line arithmetic: qty × price × (1 − dto) = base; base + cuota = total_linea
  {
    const code = 'factura.linea_aritmetica';
    const mismatches: Record<string, unknown>[] = [];
    let checked = 0;
    lines.forEach((l, i) => {
      if (isNum(l.cantidad) && isNum(l.precio_unitario) && isNum(l.base) && !l.es_partida_alzada) {
        checked += 1;
        const dto = isNum(l.descuento_pct) ? l.descuento_pct : 0;
        const expected = r2(l.cantidad * l.precio_unitario * (1 - dto / 100));
        if (!within(expected, l.base, TOLERANCES.perLine)) mismatches.push({ where: `lineas[${i}].base`, expected, printed: r2(l.base) });
      }
      if (isNum(l.base) && isNum(l.cuota_iva) && isNum(l.total_linea)) {
        checked += 1;
        const expected = r2(l.base + l.cuota_iva);
        if (!within(expected, l.total_linea, TOLERANCES.perLine)) mismatches.push({ where: `lineas[${i}].total_linea`, expected, printed: r2(l.total_linea) });
      }
    });
    if (checked === 0) out.push(skipped(code, 'no complete lines'));
    else out.push(result(code, mismatches.length === 0, { checked: true, mismatches }));
  }

  out.push(
    datesCheck(
      'factura.fechas_coherentes',
      { fecha_expedicion: doc.fecha_expedicion, fecha_operacion: doc.fecha_operacion, vencimiento: doc.vencimiento },
      opts,
      [['fecha_expedicion', 'vencimiento']],
    ),
  );
  out.push(nifCheck('factura.nif_emisor_valido', doc.emisor?.nif));
  out.push(nifCheck('factura.nif_destinatario_valido', doc.destinatario?.nif));
  out.push(ibanCheck('factura.iban_valido', doc.iban_mostrado));
  return out;
}

// ---------------------------------------------------------------------------
// extracto
// ---------------------------------------------------------------------------

export function validateExtracto(doc: Extracto, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const movs = doc.movimientos ?? [];

  {
    const code = 'extracto.continuidad_saldo';
    if (!isNum(doc.saldo_inicial) || !isNum(doc.saldo_final)) out.push(skipped(code, 'opening or closing balance missing'));
    else {
      const s = sum(movs.map((m) => m.importe));
      const expected = r2(doc.saldo_inicial + s.total);
      out.push(result(code, within(expected, doc.saldo_final, TOLERANCES.statement), {
        checked: true,
        saldo_inicial: r2(doc.saldo_inicial),
        sumMovimientos: s.total,
        expected,
        saldo_final: r2(doc.saldo_final),
        difference: r2(doc.saldo_final - expected),
        movimientos: s.count,
      }));
    }
  }

  {
    const code = 'extracto.saldos_intermedios';
    const withRunning = movs.filter((m) => isNum(m.saldo_tras));
    if (withRunning.length === 0) out.push(skipped(code, 'no running balances'));
    else {
      const mismatches: Record<string, unknown>[] = [];
      let running: number | null = isNum(doc.saldo_inicial) ? doc.saldo_inicial : null;
      movs.forEach((m, i) => {
        if (!isNum(m.importe)) return;
        if (running === null) {
          running = isNum(m.saldo_tras) ? m.saldo_tras : null;
          return;
        }
        running = r2(running + m.importe);
        if (isNum(m.saldo_tras) && !within(running, m.saldo_tras, TOLERANCES.statement)) {
          mismatches.push({ index: i, expected: running, printed: r2(m.saldo_tras) });
          running = m.saldo_tras; // re-anchor so one break does not cascade
        }
      });
      out.push(result(code, mismatches.length === 0, { checked: true, mismatches, anchoredOnOpening: isNum(doc.saldo_inicial) }));
    }
  }

  {
    const fields: Record<string, string | null> = {
      'periodo.desde': doc.periodo?.desde ?? null,
      'periodo.hasta': doc.periodo?.hasta ?? null,
      fecha_emision: doc.fecha_emision ?? null,
    };
    movs.forEach((m, i) => {
      fields[`movimientos[${i}].fecha_operacion`] = m.fecha_operacion;
      if (m.fecha_valor) fields[`movimientos[${i}].fecha_valor`] = m.fecha_valor;
    });
    out.push(datesCheck('extracto.fechas_coherentes', fields, opts, [['periodo.desde', 'periodo.hasta']]));
  }

  {
    const code = 'extracto.movimientos_en_periodo';
    const desde = doc.periodo?.desde;
    const hasta = doc.periodo?.hasta;
    if (!isIsoDate(desde) || !isIsoDate(hasta)) out.push(skipped(code, 'no period'));
    else {
      const outside = movs
        .map((m, i) => ({ i, d: m.fecha_operacion }))
        .filter(({ d }) => isIsoDate(d) && (d < desde || d > hasta))
        .map(({ i, d }) => ({ index: i, fecha: d }));
      out.push(result(code, outside.length === 0, { checked: true, desde, hasta, outside }));
    }
  }

  out.push(ibanCheck('extracto.iban_valido', doc.iban_o_cuenta_mostrada));
  {
    const code = 'extracto.contraparte_iban_valido';
    const full = movs.map((m, i) => ({ i, iban: m.contraparte_iban })).filter((x): x is { i: number; iban: string } => !!x.iban && looksLikeFullIban(x.iban));
    if (full.length === 0) out.push(skipped(code, 'no full counterparty IBANs'));
    else {
      const invalid = full.filter((x) => !validateIban(x.iban).valid).map((x) => ({ index: x.i, last4: x.iban.slice(-4) }));
      out.push(result(code, invalid.length === 0, { checked: true, checkedCount: full.length, invalid }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// certificacion
// ---------------------------------------------------------------------------

export function validateCertificacion(doc: Certificacion, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const partidas = doc.partidas ?? [];

  {
    const code = 'certificacion.actual_es_origen_menos_anterior';
    const mismatches: Record<string, unknown>[] = [];
    let checked = 0;
    const check = (where: string, a: number | null, b: number | null, c: number | null): void => {
      if (!isNum(a) || !isNum(b) || !isNum(c)) return;
      checked += 1;
      const expected = r2(a - b);
      if (!within(expected, c, TOLERANCES.certification)) mismatches.push({ where, a_origen: r2(a), anterior: r2(b), expectedActual: expected, printedActual: r2(c) });
    };
    partidas.forEach((p, i) => check(`partidas[${i}]`, p.a_origen, p.anterior, p.actual));
    check('totales', doc.totales?.a_origen ?? null, doc.totales?.anterior ?? null, doc.totales?.actual ?? null);
    if (checked === 0) out.push(skipped(code, 'no complete a_origen/anterior/actual rows'));
    else out.push(result(code, mismatches.length === 0, { checked: true, mismatches }));
  }

  {
    const code = 'certificacion.partidas_suman_totales';
    const cols = ['a_origen', 'anterior', 'actual'] as const;
    const problems: Record<string, unknown> = {};
    let checked = 0;
    for (const col of cols) {
      const total = doc.totales?.[col];
      if (!isNum(total)) continue;
      const s = sum(partidas.map((p) => p[col]));
      if (s.count === 0) continue;
      checked += 1;
      if (!within(s.total, total, TOLERANCES.certification * s.count)) problems[col] = { sumPartidas: s.total, total: r2(total), partidas: s.count };
    }
    if (checked === 0) out.push(skipped(code, 'no totals or partidas'));
    else out.push(result(code, Object.keys(problems).length === 0, { checked: true, problems }));
  }

  {
    const code = 'certificacion.acumulado_le_contrato';
    const contract = opts.contractTotal ?? doc.importe_contrato;
    const origen = doc.totales?.a_origen;
    if (!isNum(contract) || !isNum(origen)) out.push(skipped(code, 'contract total or a_origen missing'));
    else out.push(result(code, origen <= contract + TOLERANCES.certification, { checked: true, a_origen: r2(origen), contract: r2(contract), source: opts.contractTotal != null ? 'option' : 'document' }));
  }

  {
    const code = 'certificacion.base_iva_total';
    const base = doc.base_certificacion;
    const iva = doc.iva?.importe;
    const total = doc.total_certificacion;
    if (!isNum(base) || !isNum(total)) out.push(skipped(code, 'base or total missing'));
    else {
      const ivaN = isNum(iva) ? iva : 0;
      const ret = doc.retencion_garantia && isNum(doc.retencion_garantia.importe) ? doc.retencion_garantia.importe : 0;
      const withRet = r2(base - ret + ivaN);
      const withoutRet = r2(base + ivaN);
      const passed = within(withRet, total, TOLERANCES.total) || within(withoutRet, total, TOLERANCES.total);
      out.push(result(code, passed, { checked: true, base: r2(base), iva: r2(ivaN), retencion: r2(ret), expectedWithRetention: withRet, expectedWithoutRetention: withoutRet, printed: r2(total) }));
    }
  }

  out.push(datesCheck('certificacion.fechas_coherentes', { fecha: doc.fecha, 'periodo.desde': doc.periodo?.desde ?? null, 'periodo.hasta': doc.periodo?.hasta ?? null }, opts, [['periodo.desde', 'periodo.hasta']]));
  out.push(nifCheck('certificacion.nif_contratista_valido', doc.contratista?.nif));
  return out;
}

// ---------------------------------------------------------------------------
// acta
// ---------------------------------------------------------------------------

export function validateActa(doc: Acta, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const asistentes = doc.asistentes ?? [];
  const quotas = sum(asistentes.map((a) => a.coeficiente_pct));

  {
    const code = 'acta.coeficientes_asistentes_le_100';
    if (quotas.count === 0) out.push(skipped(code, 'no attendee quotas'));
    else out.push(result(code, quotas.total <= TOLERANCES.quotaCap, { checked: true, sum: quotas.total, attendeesWithQuota: quotas.count, cap: TOLERANCES.quotaCap }));
  }

  {
    const code = 'acta.quorum_coincide_con_asistentes';
    if (quotas.count === 0 || !isNum(doc.quorum_pct)) out.push(skipped(code, 'quorum or attendee quotas missing'));
    else out.push(result(code, within(quotas.total, doc.quorum_pct, TOLERANCES.quota), { checked: true, sumAttendees: quotas.total, quorum_pct: r2(doc.quorum_pct) }));
  }

  {
    const code = 'acta.coeficientes_favor_le_quorum';
    const cap = isNum(doc.quorum_pct) ? doc.quorum_pct : quotas.count > 0 ? quotas.total : 100;
    const rows = (doc.acuerdos ?? []).map((a, i) => ({ i, pct: a.coeficientes_favor_pct })).filter((x): x is { i: number; pct: number } => isNum(x.pct));
    if (rows.length === 0) out.push(skipped(code, 'no quota percentages on resolutions'));
    else {
      const over = rows.filter((x) => x.pct > cap + TOLERANCES.quota).map((x) => ({ index: x.i, pct: x.pct }));
      out.push(result(code, over.length === 0, { checked: true, cap: r2(cap), over }));
    }
  }

  {
    const code = 'acta.votos_no_exceden_asistentes';
    const n = asistentes.length;
    const rows = (doc.acuerdos ?? []).map((a, i) => ({ i, v: a.votos })).filter((x) => x.v !== null);
    if (n === 0 || rows.length === 0) out.push(skipped(code, 'no attendees or no vote counts'));
    else {
      const over: Record<string, unknown>[] = [];
      for (const { i, v } of rows) {
        if (!v) continue;
        const total = (v.favor ?? 0) + (v.contra ?? 0) + (v.abstencion ?? 0);
        if (total > n) over.push({ index: i, votes: total, attendees: n });
      }
      out.push(result(code, over.length === 0, { checked: true, attendees: n, over }));
    }
  }

  out.push(datesCheck('acta.fechas_coherentes', { fecha_convocatoria: doc.fecha_convocatoria, fecha: doc.fecha, fecha_cierre_acta: doc.fecha_cierre_acta }, opts, [['fecha_convocatoria', 'fecha'], ['fecha', 'fecha_cierre_acta']]));
  return out;
}

// ---------------------------------------------------------------------------
// presupuesto
// ---------------------------------------------------------------------------

export function validatePresupuesto(doc: Presupuesto, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const caps = doc.capitulos ?? [];

  {
    const code = 'presupuesto.partidas_suman_capitulo';
    const problems: Record<string, unknown>[] = [];
    let checked = 0;
    caps.forEach((c, i) => {
      if (!isNum(c.importe_capitulo)) return;
      const s = sum(c.partidas.map((p) => p.importe));
      if (s.count === 0) return;
      checked += 1;
      if (!within(s.total, c.importe_capitulo, TOLERANCES.perLine * s.count)) problems.push({ capitulo: i, sumPartidas: s.total, importe_capitulo: r2(c.importe_capitulo) });
    });
    if (checked === 0) out.push(skipped(code, 'no chapter subtotals'));
    else out.push(result(code, problems.length === 0, { checked: true, problems }));
  }

  {
    const code = 'presupuesto.capitulos_suman_pem';
    if (!isNum(doc.pem)) out.push(skipped(code, 'no PEM'));
    else {
      const subtotals = caps.map((c) => (isNum(c.importe_capitulo) ? c.importe_capitulo : sum(c.partidas.map((p) => p.importe)).total));
      const s = sum(subtotals);
      if (s.count === 0) out.push(skipped(code, 'no chapters'));
      else out.push(result(code, within(s.total, doc.pem, TOLERANCES.perLine * Math.max(s.count, caps.reduce((n, c) => n + c.partidas.length, 0))), { checked: true, sumCapitulos: s.total, pem: r2(doc.pem) }));
    }
  }

  {
    const code = 'presupuesto.contrata';
    if (!isNum(doc.pem) || !isNum(doc.presupuesto_contrata_sin_iva)) out.push(skipped(code, 'PEM or contract price missing'));
    else {
      const gg = doc.gastos_generales;
      const bi = doc.beneficio_industrial;
      const ggImp = gg && isNum(gg.importe) ? gg.importe : gg && isNum(gg.pct) ? r2((doc.pem * gg.pct) / 100) : 0;
      const biImp = bi && isNum(bi.importe) ? bi.importe : bi && isNum(bi.pct) ? r2((doc.pem * bi.pct) / 100) : 0;
      const expected = r2(doc.pem + ggImp + biImp);
      out.push(result(code, within(expected, doc.presupuesto_contrata_sin_iva, TOLERANCES.total), { checked: true, pem: r2(doc.pem), gg: r2(ggImp), bi: r2(biImp), expected, printed: r2(doc.presupuesto_contrata_sin_iva) }));
    }
  }

  {
    const code = 'presupuesto.total_con_iva';
    const net = isNum(doc.presupuesto_contrata_sin_iva) ? doc.presupuesto_contrata_sin_iva : doc.pem;
    if (!isNum(net) || !isNum(doc.total_con_iva)) out.push(skipped(code, 'net or gross total missing'));
    else {
      const iva = doc.iva;
      const ivaImp = iva && isNum(iva.importe) ? iva.importe : iva && isNum(iva.pct) ? r2((net * iva.pct) / 100) : null;
      if (ivaImp === null) out.push(skipped(code, 'no VAT line'));
      else {
        const expected = r2(net + ivaImp);
        const problems: Record<string, unknown> = {};
        if (!within(expected, doc.total_con_iva, TOLERANCES.total)) problems['total'] = { expected, printed: r2(doc.total_con_iva) };
        if (iva && isNum(iva.importe) && isNum(iva.pct) && !within(r2((net * iva.pct) / 100), iva.importe, TOLERANCES.cuota)) problems['cuota'] = { expected: r2((net * iva.pct) / 100), printed: r2(iva.importe) };
        out.push(result(code, Object.keys(problems).length === 0, { checked: true, net: r2(net), iva: r2(ivaImp), problems }));
      }
    }
  }

  {
    const code = 'presupuesto.tipo_iva_permitido';
    const pct = doc.iva?.pct;
    if (!isNum(pct)) out.push(skipped(code, 'no rate'));
    else out.push(result(code, ALLOWED_VAT_RATES.includes(pct), { checked: true, rate: pct }));
  }

  out.push(datesCheck('presupuesto.fechas_coherentes', { fecha: doc.fecha }, opts));
  out.push(nifCheck('presupuesto.nif_emisor_valido', doc.emisor?.nif));
  return out;
}

// ---------------------------------------------------------------------------
// liquidacion
// ---------------------------------------------------------------------------

export function validateLiquidacion(doc: Liquidacion, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const t = doc.totales;

  const sumCheck = (code: string, rows: readonly (number | null)[], total: number | null | undefined, label: string): void => {
    const s = sum(rows);
    if (!isNum(total) || s.count === 0) {
      out.push(skipped(code, `${label}: rows or total missing`));
      return;
    }
    out.push(result(code, within(s.total, total, TOLERANCES.perLine * s.count), { checked: true, sumRows: s.total, total: r2(total), rows: s.count }));
  };
  sumCheck('liquidacion.ingresos_suman_total', (doc.ingresos ?? []).map((r) => r.importe), t?.total_ingresos, 'ingresos');
  sumCheck('liquidacion.gastos_suman_total', (doc.gastos ?? []).map((r) => r.importe), t?.total_gastos, 'gastos');

  {
    const code = 'liquidacion.resultado';
    if (!isNum(t?.total_ingresos) || !isNum(t?.total_gastos) || !isNum(t?.resultado)) out.push(skipped(code, 'totals missing'));
    else {
      const expected = r2(t.total_ingresos - t.total_gastos);
      out.push(result(code, within(expected, t.resultado, TOLERANCES.total), { checked: true, expected, printed: r2(t.resultado) }));
    }
  }

  {
    const code = 'liquidacion.saldo_final';
    const s = doc.saldos;
    if (!isNum(s?.inicial) || !isNum(s?.final) || !isNum(t?.resultado)) out.push(skipped(code, 'balances or result missing'));
    else {
      const expected = r2(s.inicial + t.resultado);
      out.push(result(code, within(expected, s.final, TOLERANCES.total), { checked: true, inicial: r2(s.inicial), resultado: r2(t.resultado), expected, printed: r2(s.final) }));
    }
  }

  {
    const code = 'liquidacion.fondo_reserva';
    const f = doc.fondo_reserva;
    if (!isNum(f?.inicial) || !isNum(f?.final)) out.push(skipped(code, 'reserve fund balances missing'));
    else {
      const dot = isNum(f.dotacion) ? f.dotacion : 0;
      const disp = isNum(f.disposiciones) ? f.disposiciones : 0;
      const expected = r2(f.inicial + dot - disp);
      out.push(result(code, within(expected, f.final, TOLERANCES.total), { checked: true, inicial: r2(f.inicial), dotacion: r2(dot), disposiciones: r2(disp), expected, printed: r2(f.final) }));
    }
  }

  {
    const code = 'liquidacion.coeficientes_le_100';
    const s = sum((doc.cuotas_por_unidad ?? []).map((u) => u.coeficiente_pct));
    if (s.count === 0) out.push(skipped(code, 'no unit coefficients'));
    else out.push(result(code, s.total <= TOLERANCES.quotaCap, { checked: true, sum: s.total, units: s.count }));
  }

  out.push(datesCheck('liquidacion.fechas_coherentes', { 'periodo.desde': doc.periodo?.desde ?? null, 'periodo.hasta': doc.periodo?.hasta ?? null, aprobada_en_junta: doc.aprobada_en_junta }, opts, [['periodo.desde', 'periodo.hasta']]));
  out.push(nifCheck('liquidacion.nif_comunidad_valido', doc.comunidad?.nif, 'H'));
  return out;
}

// ---------------------------------------------------------------------------
// contrato
// ---------------------------------------------------------------------------

export function validateContrato(doc: Contrato, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const p = doc.precio;

  {
    const code = 'contrato.precio_con_iva';
    if (!isNum(p?.sin_iva) || !isNum(p?.con_iva) || !isNum(p?.iva_pct)) out.push(skipped(code, 'price components missing'));
    else {
      const expected = r2(p.sin_iva * (1 + p.iva_pct / 100));
      out.push(result(code, within(expected, p.con_iva, TOLERANCES.total), { checked: true, expected, printed: r2(p.con_iva), rateAllowed: ALLOWED_VAT_RATES.includes(p.iva_pct) }));
    }
  }

  {
    const code = 'contrato.calendario_suma';
    const cal = doc.calendario_pagos ?? [];
    if (cal.length === 0) out.push(skipped(code, 'no payment schedule'));
    else {
      const problems: Record<string, unknown> = {};
      const pct = sum(cal.map((c) => c.pct));
      if (pct.count === cal.length && !within(pct.total, 100, TOLERANCES.quota)) problems['pct'] = { sum: pct.total };
      const imp = sum(cal.map((c) => c.importe));
      if (imp.count === cal.length) {
        const targets = [p?.con_iva, p?.sin_iva].filter(isNum);
        if (targets.length > 0 && !targets.some((t) => within(imp.total, t, TOLERANCES.total))) problems['importe'] = { sum: imp.total, targets: targets.map(r2) };
      }
      if (pct.count !== cal.length && imp.count !== cal.length) out.push(skipped(code, 'schedule rows lack both pct and amount'));
      else out.push(result(code, Object.keys(problems).length === 0, { checked: true, rows: cal.length, problems }));
    }
  }

  {
    const fields: Record<string, string | null> = { fecha_firma: doc.fecha_firma, 'plazo.fin_previsto': doc.plazo?.fin_previsto ?? null };
    (doc.firmas ?? []).forEach((f, i) => {
      if (f.fecha) fields[`firmas[${i}].fecha`] = f.fecha;
    });
    out.push(datesCheck('contrato.fechas_coherentes', fields, opts, [['fecha_firma', 'plazo.fin_previsto']]));
  }

  {
    const code = 'contrato.nif_partes_validos';
    const withNif = (doc.partes ?? []).map((pt, i) => ({ i, nif: pt.nif, rol: pt.rol })).filter((x): x is { i: number; nif: string; rol: string } => !!x.nif);
    if (withNif.length === 0) out.push(skipped(code, 'no NIFs'));
    else {
      const invalid = withNif.filter((x) => !validateNif(x.nif).valid).map((x) => ({ index: x.i, rol: x.rol, reason: validateNif(x.nif).reason ?? null }));
      out.push(result(code, invalid.length === 0, { checked: true, checkedCount: withNif.length, invalid }));
    }
  }

  out.push(ibanCheck('contrato.iban_prestamo_valido', doc.prestamo_spec?.cuenta_abono_iban));
  return out;
}

// ---------------------------------------------------------------------------
// derrama
// ---------------------------------------------------------------------------

export function validateDerrama(doc: Derrama, opts: ValidatorOptions = {}): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const cuotas = doc.cuotas ?? [];

  {
    const code = 'derrama.cuotas_suman_total';
    const s = sum(cuotas.map((c) => c.importe));
    if (!isNum(doc.importe_total) || s.count === 0) out.push(skipped(code, 'total or unit amounts missing'));
    else out.push(result(code, within(s.total, doc.importe_total, TOLERANCES.perLine * s.count), { checked: true, sumCuotas: s.total, importe_total: r2(doc.importe_total), units: s.count }));
  }

  {
    const code = 'derrama.plazos_suman_cuota';
    const problems: Record<string, unknown>[] = [];
    let checked = 0;
    cuotas.forEach((c, i) => {
      if (!isNum(c.importe) || c.plazos.length === 0) return;
      const s = sum(c.plazos.map((pl) => pl.importe));
      if (s.count === 0) return;
      checked += 1;
      if (!within(s.total, c.importe, TOLERANCES.perLine * s.count)) problems.push({ index: i, entidad_label: c.entidad_label, sumPlazos: s.total, importe: r2(c.importe) });
    });
    if (checked === 0) out.push(skipped(code, 'no instalments'));
    else out.push(result(code, problems.length === 0, { checked: true, problems }));
  }

  {
    const code = 'derrama.coeficientes_le_100';
    const s = sum(cuotas.map((c) => c.coeficiente_pct));
    if (s.count === 0) out.push(skipped(code, 'no coefficients'));
    else out.push(result(code, s.total <= TOLERANCES.quotaCap, { checked: true, sum: s.total, units: s.count }));
  }

  out.push(ibanCheck('derrama.iban_valido', doc.cuenta_destino_iban));
  {
    const fields: Record<string, string | null> = { fecha: doc.fecha };
    cuotas.forEach((c, i) => c.plazos.forEach((pl, j) => {
      if (pl.fecha) fields[`cuotas[${i}].plazos[${j}].fecha`] = pl.fecha;
    }));
    out.push(datesCheck('derrama.fechas_coherentes', fields, opts));
  }
  return out;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/** Run the validators of a document type over a parsed document. */
export function validateParsed(
  docType: DocType | SchemaKey,
  parsed: unknown,
  opts: ValidatorOptions = {},
): ValidatorResult[] {
  const key = schemaKeyFor(docType);
  if (!key || parsed === null || typeof parsed !== 'object') return [];
  switch (key) {
    case 'factura':
      return validateFactura(parsed as Factura, opts);
    case 'extracto':
      return validateExtracto(parsed as Extracto, opts);
    case 'certificacion':
      return validateCertificacion(parsed as Certificacion, opts);
    case 'acta':
      return validateActa(parsed as Acta, opts);
    case 'presupuesto':
      return validatePresupuesto(parsed as Presupuesto, opts);
    case 'liquidacion':
      return validateLiquidacion(parsed as Liquidacion, opts);
    case 'contrato':
      return validateContrato(parsed as Contrato, opts);
    case 'derrama':
      return validateDerrama(parsed as Derrama, opts);
    default:
      return [];
  }
}

/** True when every result passed (skipped checks count as passed). */
export function allPassed(results: readonly ValidatorResult[]): boolean {
  return results.every((r) => r.passed);
}
