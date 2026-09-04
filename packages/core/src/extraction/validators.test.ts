import { describe, expect, it } from 'vitest';
import {
  CIF_VENDOR,
  IBAN_VENDOR,
  actaFixture,
  certificacionFixture,
  clone,
  contratoFixture,
  derramaFixture,
  extractoFixture,
  facturaFixture,
  liquidacionFixture,
  presupuestoFixture,
} from './__fixtures__/documents.ts';
import {
  VALIDATOR_CODES,
  VALIDATOR_VERSIONS,
  allPassed,
  validateActa,
  validateCertificacion,
  validateContrato,
  validateDerrama,
  validateExtracto,
  validateFactura,
  validateLiquidacion,
  validateParsed,
  validatePresupuesto,
  type ValidatorResult,
} from './validators.ts';

const NOW = new Date('2026-09-04T00:00:00Z');
const opts = { now: NOW };

function failing(results: ValidatorResult[]): string[] {
  return results.filter((r) => !r.passed).map((r) => r.code);
}

function byCode(results: ValidatorResult[], code: string): ValidatorResult {
  const r = results.find((x) => x.code === code);
  if (!r) throw new Error(`missing ${code}`);
  return r;
}

describe('validators: shape', () => {
  it('every result has a registered code and version', () => {
    const all = [
      ...validateFactura(facturaFixture, opts),
      ...validateExtracto(extractoFixture, opts),
      ...validateCertificacion(certificacionFixture, opts),
      ...validateActa(actaFixture, opts),
      ...validatePresupuesto(presupuestoFixture, opts),
      ...validateLiquidacion(liquidacionFixture, opts),
      ...validateContrato(contratoFixture, opts),
      ...validateDerrama(derramaFixture, opts),
    ];
    for (const r of all) {
      expect(VALIDATOR_CODES).toContain(r.code);
      expect(r.version).toBe(VALIDATOR_VERSIONS[r.code]);
      expect(r.version).toBeGreaterThanOrEqual(1);
      expect(typeof r.passed).toBe('boolean');
      expect(r.details).toBeTypeOf('object');
    }
    expect(new Set(all.map((r) => r.code)).size).toBe(all.length);
  });

  it('validateParsed dispatches by document type and ignores unsupported types', () => {
    expect(validateParsed('factura_simplificada', facturaFixture, opts).length).toBeGreaterThan(5);
    expect(validateParsed('extracto_bancario', extractoFixture, opts).map((r) => r.code)).toContain('extracto.continuidad_saldo');
    expect(validateParsed('albaran', {}, opts)).toEqual([]);
    expect(validateParsed('factura', null, opts)).toEqual([]);
  });
});

describe('validators: factura', () => {
  it('passes on a clean invoice', () => {
    const r = validateFactura(facturaFixture, opts);
    expect(failing(r)).toEqual([]);
    expect(allPassed(r)).toBe(true);
    expect(byCode(r, 'factura.lineas_suman_base').details['mode']).toBe('per_rate');
    expect(byCode(r, 'factura.nif_emisor_valido').details['kind']).toBe('CIF');
    expect(byCode(r, 'factura.iban_valido').details['checkDigitsOk']).toBe(true);
    expect(byCode(r, 'factura.simplificada_max_400').details['checked']).toBe(false);
  });

  it('catches lines that do not sum to the base', () => {
    const doc = clone(facturaFixture);
    (doc.lineas[1] as { base: number }).base = 361;
    expect(failing(validateFactura(doc, opts))).toContain('factura.lineas_suman_base');
  });

  it('catches base × rate ≠ cuota', () => {
    const doc = clone(facturaFixture);
    (doc.resumen_iva[0] as { cuota: number }).cuota = 270;
    const r = validateFactura(doc, opts);
    expect(failing(r)).toContain('factura.base_por_tipo_cuota');
    expect(failing(r)).toContain('factura.resumen_suma_totales');
  });

  it('catches base + IVA − IRPF + suplidos ≠ total and honours IRPF/suplidos', () => {
    const doc = clone(facturaFixture);
    doc.total_factura = 3260;
    expect(failing(validateFactura(doc, opts))).toContain('factura.total');
    const withIrpf = clone(facturaFixture);
    withIrpf.retencion_irpf = { pct: 15, importe: 441 };
    withIrpf.suplidos = 20;
    withIrpf.total_factura = 2940 + 313.8 - 441 + 20;
    expect(failing(validateFactura(withIrpf, opts))).not.toContain('factura.total');
  });

  it('catches VAT rates outside {0,4,10,21}', () => {
    const doc = clone(facturaFixture);
    (doc.resumen_iva[1] as { tipo_pct: number }).tipo_pct = 16;
    const r = validateFactura(doc, opts);
    expect(failing(r)).toContain('factura.tipo_iva_permitido');
    expect(byCode(r, 'factura.tipo_iva_permitido').details['notAllowed']).toEqual([16]);
  });

  it('catches a simplified invoice above 400 EUR', () => {
    const doc = clone(facturaFixture);
    doc.doc_type_confirmed = 'factura_simplificada';
    expect(failing(validateFactura(doc, opts))).toContain('factura.simplificada_max_400');
    doc.total_factura = 399.99;
    doc.base_imponible_total = null;
    expect(failing(validateFactura(doc, opts))).not.toContain('factura.simplificada_max_400');
  });

  it('catches implausible or inconsistent dates', () => {
    const old = clone(facturaFixture);
    old.fecha_expedicion = '2015-03-15';
    expect(failing(validateFactura(old, opts))).toContain('factura.fechas_coherentes');
    const future = clone(facturaFixture);
    future.vencimiento = '2028-01-01';
    expect(failing(validateFactura(future, opts))).toContain('factura.fechas_coherentes');
    const order = clone(facturaFixture);
    order.vencimiento = '2024-03-01';
    const r = byCode(validateFactura(order, opts), 'factura.fechas_coherentes');
    expect(r.passed).toBe(false);
    expect(r.details['problems']).toHaveProperty('fecha_expedicion<=vencimiento');
    const notIso = clone(facturaFixture);
    notIso.fecha_expedicion = '15/03/2024';
    expect(failing(validateFactura(notIso, opts))).toContain('factura.fechas_coherentes');
  });

  it('catches an invalid NIF and an invalid IBAN', () => {
    const doc = clone(facturaFixture);
    doc.emisor.nif = 'B65432100';
    doc.iban_mostrado = `ES00${IBAN_VENDOR.slice(4)}`;
    const r = validateFactura(doc, opts);
    expect(failing(r)).toContain('factura.nif_emisor_valido');
    expect(failing(r)).toContain('factura.iban_valido');
    const none = clone(facturaFixture);
    none.emisor.nif = null;
    expect(byCode(validateFactura(none, opts), 'factura.nif_emisor_valido').details['checked']).toBe(false);
  });

  it('catches line arithmetic (qty × price ≠ base; base + cuota ≠ total)', () => {
    const doc = clone(facturaFixture);
    (doc.lineas[1] as { precio_unitario: number }).precio_unitario = 50;
    (doc.lineas[2] as { total_linea: number }).total_linea = 220;
    const r = byCode(validateFactura(doc, opts), 'factura.linea_aritmetica');
    expect(r.passed).toBe(false);
    expect((r.details['mismatches'] as unknown[]).length).toBe(2);
  });
});

describe('validators: extracto', () => {
  it('passes on a continuous statement', () => {
    expect(failing(validateExtracto(extractoFixture, opts))).toEqual([]);
  });

  it('catches opening + movements ≠ closing', () => {
    const doc = clone(extractoFixture);
    doc.saldo_final = 9124.6;
    const r = byCode(validateExtracto(doc, opts), 'extracto.continuidad_saldo');
    expect(r.passed).toBe(false);
    expect(r.details['difference']).toBe(10);
  });

  it('catches a broken running balance and re-anchors afterwards', () => {
    const doc = clone(extractoFixture);
    (doc.movimientos[1] as { saldo_tras: number }).saldo_tras = 9300;
    const r = byCode(validateExtracto(doc, opts), 'extracto.saldos_intermedios');
    expect(r.passed).toBe(false);
    expect(r.details['mismatches']).toEqual([{ index: 1, expected: 9306.6, printed: 9300 }, { index: 2, expected: 9288, printed: 9294.6 }]);
  });

  it('catches movements outside the period and bad dates', () => {
    const doc = clone(extractoFixture);
    (doc.movimientos[0] as { fecha_operacion: string }).fecha_operacion = '2024-04-30';
    const r = validateExtracto(doc, opts);
    expect(failing(r)).toContain('extracto.movimientos_en_periodo');
    (doc.movimientos[0] as { fecha_operacion: string }).fecha_operacion = '2018-05-02';
    expect(failing(validateExtracto(doc, opts))).toContain('extracto.fechas_coherentes');
  });

  it('skips masked IBANs and validates full ones', () => {
    const doc = clone(extractoFixture);
    doc.iban_o_cuenta_mostrada = 'ES21 **** **** **** **** 1332';
    expect(byCode(validateExtracto(doc, opts), 'extracto.iban_valido').details['checked']).toBe(false);
    (doc.movimientos[1] as { contraparte_iban: string }).contraparte_iban = `ES00${IBAN_VENDOR.slice(4)}`;
    expect(failing(validateExtracto(doc, opts))).toContain('extracto.contraparte_iban_valido');
    (doc.movimientos[1] as { contraparte_iban: string }).contraparte_iban = 'ES12 XXXX XXXX XX12 3456';
    expect(byCode(validateExtracto(doc, opts), 'extracto.contraparte_iban_valido').details['checked']).toBe(false);
  });
});

describe('validators: certificacion', () => {
  it('passes on a consistent certification', () => {
    expect(failing(validateCertificacion(certificacionFixture, opts))).toEqual([]);
  });

  it('catches actual ≠ a_origen − anterior', () => {
    const doc = clone(certificacionFixture);
    (doc.partidas[0] as { actual: number }).actual = 6100;
    const r = validateCertificacion(doc, opts);
    expect(failing(r)).toContain('certificacion.actual_es_origen_menos_anterior');
    expect(failing(r)).toContain('certificacion.partidas_suman_totales');
  });

  it('catches cumulative above the contract (document or option)', () => {
    const doc = clone(certificacionFixture);
    doc.totales.a_origen = 43000;
    doc.totales.anterior = 34500;
    expect(failing(validateCertificacion(doc, opts))).toContain('certificacion.acumulado_le_contrato');
    const r = byCode(validateCertificacion(certificacionFixture, { ...opts, contractTotal: 18000 }), 'certificacion.acumulado_le_contrato');
    expect(r.passed).toBe(false);
    expect(r.details['source']).toBe('option');
  });

  it('catches base/IVA/total mismatch', () => {
    const doc = clone(certificacionFixture);
    doc.total_certificacion = 9000;
    expect(failing(validateCertificacion(doc, opts))).toContain('certificacion.base_iva_total');
  });
});

describe('validators: acta', () => {
  it('passes on consistent minutes', () => {
    expect(failing(validateActa(actaFixture, opts))).toEqual([]);
  });

  it('catches attendee quotas above 100', () => {
    const doc = clone(actaFixture);
    (doc.asistentes[0] as { coeficiente_pct: number }).coeficiente_pct = 73;
    doc.quorum_pct = null;
    const r = validateActa(doc, opts);
    expect(failing(r)).toContain('acta.coeficientes_asistentes_le_100');
  });

  it('catches quorum ≠ attendees, votes > attendees, quotas in favour > quorum, closing before meeting', () => {
    const doc = clone(actaFixture);
    doc.quorum_pct = 40;
    (doc.acuerdos[1] as { votos: { favor: number; contra: number; abstencion: number } }).votos = { favor: 5, contra: 1, abstencion: 0 };
    (doc.acuerdos[2] as { coeficientes_favor_pct: number }).coeficientes_favor_pct = 45;
    doc.fecha_cierre_acta = '2023-03-10';
    const codes = failing(validateActa(doc, opts));
    expect(codes).toContain('acta.quorum_coincide_con_asistentes');
    expect(codes).toContain('acta.votos_no_exceden_asistentes');
    expect(codes).toContain('acta.coeficientes_favor_le_quorum');
    expect(codes).toContain('acta.fechas_coherentes');
  });
});

describe('validators: presupuesto, liquidacion, contrato, derrama', () => {
  it('pass on the clean fixtures', () => {
    expect(failing(validatePresupuesto(presupuestoFixture, opts))).toEqual([]);
    expect(failing(validateLiquidacion(liquidacionFixture, opts))).toEqual([]);
    expect(failing(validateContrato(contratoFixture, opts))).toEqual([]);
    expect(failing(validateDerrama(derramaFixture, opts))).toEqual([]);
  });

  it('presupuesto: catches PEM, contract price and VAT arithmetic', () => {
    const doc = clone(presupuestoFixture);
    doc.pem = 5100;
    const codes = failing(validatePresupuesto(doc, opts));
    expect(codes).toContain('presupuesto.capitulos_suman_pem');
    expect(codes).toContain('presupuesto.contrata');
    const vat = clone(presupuestoFixture);
    vat.total_con_iva = 6600;
    expect(failing(validatePresupuesto(vat, opts))).toContain('presupuesto.total_con_iva');
  });

  it('liquidacion: catches totals, result, balances, reserve fund and quotas', () => {
    const doc = clone(liquidacionFixture);
    doc.totales.total_gastos = 16000;
    doc.fondo_reserva.final = 1200;
    (doc.cuotas_por_unidad[0] as { coeficiente_pct: number }).coeficiente_pct = 90;
    const codes = failing(validateLiquidacion(doc, opts));
    expect(codes).toContain('liquidacion.gastos_suman_total');
    expect(codes).toContain('liquidacion.resultado');
    expect(codes).toContain('liquidacion.fondo_reserva');
    expect(codes).toContain('liquidacion.coeficientes_le_100');
    expect(codes).not.toContain('liquidacion.saldo_final');
    // a valid CIF with the wrong entity letter for a community (H expected)
    const nif = clone(liquidacionFixture);
    nif.comunidad.nif = CIF_VENDOR;
    const r = byCode(validateLiquidacion(nif, opts), 'liquidacion.nif_comunidad_valido');
    expect(r.passed).toBe(false);
    expect(r.details['reason']).toBeNull();
    expect(r.details['entityLetter']).toBe('B');
    expect(r.details['expectedEntityLetter']).toBe('H');
  });

  it('contrato: catches price with VAT and payment schedule sums', () => {
    const doc = clone(contratoFixture);
    doc.precio.con_iva = 52000;
    (doc.calendario_pagos[0] as { pct: number }).pct = 35;
    const codes = failing(validateContrato(doc, opts));
    expect(codes).toContain('contrato.precio_con_iva');
    expect(codes).toContain('contrato.calendario_suma');
    const bad = clone(contratoFixture);
    (bad.partes[0] as { nif: string }).nif = 'A11223340';
    expect(failing(validateContrato(bad, opts))).toContain('contrato.nif_partes_validos');
  });

  it('derrama: catches unit sums, instalments and coefficients', () => {
    // clean fixture: Pral 1a prints only 2 of 12 instalments → the instalment check is skipped
    expect(byCode(validateDerrama(derramaFixture, opts), 'derrama.plazos_suman_cuota').details['checked']).toBe(false);
    const doc = clone(derramaFixture);
    doc.importe_total = 2200;
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(2023, 3 + i, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    });
    (doc.cuotas[0] as { plazos: { fecha: string; importe: number }[] }).plazos = months.map((fecha, i) => ({ fecha, importe: i < 2 ? 60 : 61 }));
    const codes = failing(validateDerrama(doc, opts));
    expect(codes).toContain('derrama.cuotas_suman_total');
    expect(codes).toContain('derrama.plazos_suman_cuota');
    const co = clone(derramaFixture);
    (co.cuotas[1] as { coeficiente_pct: number }).coeficiente_pct = 95;
    expect(failing(validateDerrama(co, opts))).toContain('derrama.coeficientes_le_100');
  });
});
