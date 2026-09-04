import { describe, expect, it } from 'vitest';
import { actaFixture, clone, extractoFixture, facturaFixture } from './__fixtures__/documents.ts';
import {
  CRITICAL_FIELD_PATTERNS,
  criticalFieldPaths,
  criticalSeeds,
  flattenParsed,
  indexEvidence,
  isCriticalPath,
  kindForPath,
  normaliseFieldPath,
  pathMatches,
} from './flatten.ts';
import { SCHEMA_KEYS } from './types.ts';

describe('flattenParsed', () => {
  const seeds = flattenParsed(facturaFixture, facturaFixture.evidence, 'factura');
  const byPath = new Map(seeds.map((s) => [s.field_path, s]));

  it('produces dot paths with indexes and joins evidence by path', () => {
    const total = byPath.get('total_factura');
    expect(total).toBeDefined();
    expect(total?.value).toBe(3253.8);
    expect(total?.value_kind).toBe('amount');
    expect(total?.quote).toBe('3.253,80 €');
    expect(total?.bbox).toEqual([820, 1300, 1010, 1332]);
    expect(total?.page_index).toBe(0);
    expect(total?.model_conf).toBe(0.99);
    expect(total?.provenance).toBe('evidence');
    expect(total?.is_critical).toBe(true);

    expect(byPath.get('lineas[2].base')?.quote).toBe('180,00');
    expect(byPath.get('lineas[2].descripcion')?.value).toBe('Ferramenta i accessoris');
    expect(byPath.get('resumen_iva[1].cuota')?.value).toBe(37.8);
    expect(byPath.get('menciones.materiales_40pct')?.value_kind).toBe('bool');
    expect(byPath.get('anotaciones_manuscritas[0].texto')?.value).toBe('pagat 20/4');
  });

  it('assigns value kinds by leaf key and runtime type', () => {
    expect(byPath.get('emisor.nif')?.value_kind).toBe('nif');
    expect(byPath.get('destinatario.nif')?.value_kind).toBe('nif');
    expect(byPath.get('fecha_expedicion')?.value_kind).toBe('date');
    expect(byPath.get('vencimiento')?.value_kind).toBe('date');
    expect(byPath.get('iban_mostrado')?.value_kind).toBe('iban');
    expect(byPath.get('lineas[0].orden')?.value_kind).toBe('int');
    expect(byPath.get('lineas[0].cantidad')?.value_kind).toBe('amount');
    expect(byPath.get('emisor.nombre')?.value_kind).toBe('text');
    expect(byPath.get('sello_o_firma_presente')?.value_kind).toBe('bool');
    expect(byPath.get('self_checks.lineas_suman_base')?.value_kind).toBe('bool');
    expect(kindForPath('retencion_irpf.importe', null)).toBe('amount');
    expect(kindForPath('referencia', null)).toBe('text');
    expect(kindForPath('garantia_meses', 24)).toBe('int');
    expect(kindForPath('plazo.fin_previsto', null)).toBe('date');
  });

  it('skips evidence and row provenance keys, keeps nulls only for critical paths by default', () => {
    expect([...byPath.keys()].some((p) => p.startsWith('evidence'))).toBe(false);
    expect(byPath.has('anotaciones_manuscritas[0].page_index')).toBe(false);
    expect(byPath.has('anotaciones_manuscritas[0].bbox')).toBe(false);
    // critical null kept, non-critical null dropped
    expect(byPath.has('serie')).toBe(true);
    expect(byPath.get('serie')?.value).toBeNull();
    expect(byPath.has('fecha_operacion')).toBe(true);
    expect(byPath.has('lineas[0].codigo')).toBe(false);

    const all = flattenParsed(facturaFixture, null, 'factura', { includeNulls: 'all' });
    expect(all.some((s) => s.field_path === 'lineas[0].codigo')).toBe(true);
    const none = flattenParsed(facturaFixture, null, 'factura', { includeNulls: 'none' });
    expect(none.some((s) => s.value === null)).toBe(false);
  });

  it('reads evidence from the parsed object when none is passed', () => {
    const fromDoc = flattenParsed(facturaFixture, null, 'factura');
    expect(fromDoc.find((s) => s.field_path === 'total_factura')?.quote).toBe('3.253,80 €');
  });

  it('inherits page/bbox from a row that carries page_index', () => {
    const rows = flattenParsed(extractoFixture, extractoFixture.evidence, 'extracto_bancario');
    const importe = rows.find((s) => s.field_path === 'movimientos[1].importe');
    expect(importe?.value).toBe(-3253.8);
    expect(importe?.provenance).toBe('row');
    expect(importe?.page_index).toBe(0);
    expect(importe?.bbox).toEqual([60, 440, 1500, 470]);
    expect(importe?.quote).toBeNull();
    expect(importe?.is_critical).toBe(true);
    const saldo = rows.find((s) => s.field_path === 'saldo_inicial');
    expect(saldo?.provenance).toBe('evidence');
    expect(saldo?.quote).toBe('12.500,40');
    // nested rows in an acta inherit from the acuerdo
    const acta = flattenParsed(actaFixture, actaFixture.evidence, 'acta');
    const amount = acta.find((s) => s.field_path === 'acuerdos[1].importes_mencionados[0].importe');
    expect(amount?.provenance).toBe('evidence');
    const lit = acta.find((s) => s.field_path === 'acuerdos[2].texto_literal');
    expect(lit?.provenance).toBe('row');
    expect(lit?.page_index).toBe(1);
    const noRow = acta.find((s) => s.field_path === 'lugar');
    expect(noRow?.provenance).toBe('none');
  });

  it('normalises evidence paths written with dotted indexes and prefers the most confident item', () => {
    const doc = clone(facturaFixture);
    doc.evidence.push({ field_path: 'lineas.0.base', page_index: 0, bbox: null, quote: '2400,00', confidence: 0.99 });
    const idx = indexEvidence(doc.evidence);
    expect(idx.get('lineas[0].base')?.quote).toBe('2400,00');
    expect(normaliseFieldPath('a.0.b.12.c')).toBe('a[0].b[12].c');
    expect(normaliseFieldPath('a[ 3 ].b')).toBe('a[3].b');
    expect(normaliseFieldPath('total')).toBe('total');
  });

  it('critical paths cover monetary and identity fields per document type', () => {
    expect(criticalFieldPaths('factura')).toContain('total_factura');
    expect(criticalFieldPaths('factura_rectificativa')).toContain('lineas[*].base');
    expect(criticalFieldPaths('albaran')).toEqual([]);
    expect(isCriticalPath('factura', 'lineas[7].base')).toBe(true);
    expect(isCriticalPath('factura', 'lineas.7.base')).toBe(true);
    expect(isCriticalPath('factura', 'lineas[7].descripcion')).toBe(false);
    expect(isCriticalPath('acta', 'acuerdos[2].importes_mencionados[0].importe')).toBe(true);
    expect(pathMatches('a[*].b', 'a[3].b')).toBe(true);
    expect(pathMatches('a[*].b', 'a[3].bc')).toBe(false);
    expect(pathMatches('a.b', 'a.b')).toBe(true);
    for (const key of SCHEMA_KEYS) {
      expect(CRITICAL_FIELD_PATTERNS[key].length).toBeGreaterThan(5);
    }
    const crit = criticalSeeds(seeds);
    expect(crit.every((s) => s.is_critical)).toBe(true);
    expect(crit.map((s) => s.field_path)).toContain('emisor.nif');
    expect(crit.map((s) => s.field_path)).not.toContain('emisor.email');
  });
});
