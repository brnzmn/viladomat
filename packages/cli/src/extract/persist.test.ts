import { describe, expect, it } from 'vitest';
import {
  approvedAmount,
  documentDate,
  familyOfKind,
  monthStart,
  resolutionKind,
  statementConfidence,
  statementSource,
  transactionDedupeKey,
  upfrontMaxPct,
  validatorFamily,
  validatorOkFor,
  valueKindOf,
} from './persist.ts';
import type { ValidatorResult } from './adapter.ts';

/**
 * The judgement calls the persistence layer makes on its own: which family of checks applies to a
 * field, what a resolution is about, how much of a contract may be paid in advance, and how a
 * movement is keyed so the same line is never counted twice.
 */

const v = (code: string, passed: boolean): ValidatorResult => ({ code, version: 1, passed, details: { checked: true } });

describe('validator families', () => {
  it('reads the family from the validator name', () => {
    expect(validatorFamily('factura.nif_emisor_valido')).toBe('nif');
    expect(validatorFamily('extracto.contraparte_iban_valido')).toBe('iban');
    expect(validatorFamily('acta.fechas_coherentes')).toBe('date');
    expect(validatorFamily('factura.lineas_suman_base')).toBe('amount');
  });

  it('judges a field only by the checks that concern it', () => {
    const results = [v('factura.total', false), v('factura.nif_emisor_valido', true), v('factura.fechas_coherentes', true)];
    expect(validatorOkFor('amount', results)).toBe(false);
    expect(validatorOkFor('nif', results)).toBe(true);
    expect(validatorOkFor('date', results)).toBe(true);
  });

  it('treats an integer as an amount and free text as belonging to no family', () => {
    expect(familyOfKind('int')).toBe('amount');
    expect(familyOfKind('text')).toBe('none');
    expect(validatorOkFor('text', [v('factura.total', false)])).toBe(true);
  });

  it('compares an integer as an amount and a boolean as text', () => {
    expect(valueKindOf('int')).toBe('amount');
    expect(valueKindOf('bool')).toBe('text');
    expect(valueKindOf('iban')).toBe('iban');
  });
});

describe('what a resolution is about', () => {
  it('records an approval of works with a price as a works approval, not an award', () => {
    expect(
      resolutionKind("S'aprova contractar la instal·lació de l'ascensor amb Ascensors Exemple S.A. per un import de 52.800,00 €", true),
    ).toBe('works_approval');
  });

  it('records an award decision as a contractor choice', () => {
    expect(resolutionKind("S'adjudica l'obra a l'empresa amb el pressupost més baix", false)).toBe('contractor_choice');
  });

  it.each([
    ["S'aprova una derrama de 60 € mensuals per entitat", 'derrama'],
    ["S'aproven els comptes de l'exercici 2022", 'accounts'],
    ['Se aprueba el presupuesto ordinario para el ejercicio', 'budget'],
    ["S'aprova sol·licitar una subvenció al Consorci", 'subsidy'],
    ["S'aprova la contractació d'un préstec amb l'entitat bancària", 'loan'],
    ["S'acorda encarregar una auditoria de comptes", 'audit'],
    ['Es nomena president el titular de la unitat', 'election'],
  ])('classifies %s', (text, expected) => {
    expect(resolutionKind(text, false)).toBe(expected);
  });

  it('falls back to a delegation when the text only delegates', () => {
    expect(resolutionKind('Es faculta el titular del càrrec per signar la documentació', true)).toBe('delegation');
  });

  it('says other rather than guessing', () => {
    expect(resolutionKind('Precs i preguntes', false)).toBe('other');
  });

  it('takes the amount a resolution approves, and the largest when several are named', () => {
    expect(approvedAmount([{ importe: 52800 }])).toBe(52800);
    expect(approvedAmount([{ importe: 1000 }, { importe: 52800 }, { importe: null }])).toBe(52800);
    expect(approvedAmount([])).toBeNull();
    expect(approvedAmount([{ importe: null }])).toBeNull();
  });
});

describe('bank statements', () => {
  it('separates a native PDF from a scan and from a photograph', () => {
    expect(statementSource('application/pdf', true)).toBe('pdf_native');
    expect(statementSource('application/pdf', false)).toBe('pdf_scan');
    expect(statementSource('image/jpeg', null)).toBe('photo');
  });

  it('trusts a native PDF more than pixels', () => {
    expect(statementConfidence('pdf_native')).toBe(0.85);
    expect(statementConfidence('pdf_scan')).toBe(0.7);
    expect(statementConfidence('photo')).toBe(0.7);
  });

  it('keys a movement by account, date, signed amount and concept', () => {
    const a = transactionDedupeKey('acct', '2024-05-03', -3253.8, 'TRANSFERENCIA A INSTAL·LACIONS');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionDedupeKey('acct', '2024-05-03', -3253.8, 'transferencia a instal·lacions')).toBe(a);
    expect(transactionDedupeKey('acct', '2024-05-03', 3253.8, 'TRANSFERENCIA A INSTAL·LACIONS')).not.toBe(a);
    expect(transactionDedupeKey('other', '2024-05-03', -3253.8, 'TRANSFERENCIA A INSTAL·LACIONS')).not.toBe(a);
  });
});

describe('contracts', () => {
  it('allows a larger advance on a lift installation than on ordinary works', () => {
    expect(upfrontMaxPct('ascensor_instalacion')).toBe(60);
    expect(upfrontMaxPct('obra')).toBe(40);
    expect(upfrontMaxPct('mantenimiento_ascensor')).toBe(40);
  });
});

describe('dates', () => {
  it('takes the first day of the month a date falls in', () => {
    expect(monthStart('2023-04-17')).toBe('2023-04-01');
    expect(monthStart('17/04/2023')).toBe('2023-04-01');
    expect(monthStart(null)).toBeNull();
  });

  it('picks the date that dates each document class', () => {
    expect(documentDate('factura', { fecha_expedicion: '2024-03-15' })).toBe('2024-03-15');
    expect(documentDate('acta', { fecha: '2023-03-14' })).toBe('2023-03-14');
    expect(documentDate('contrato_ascensor', { fecha_firma: '2024-09-10' })).toBe('2024-09-10');
    expect(documentDate('extracto_bancario', { periodo: { desde: '2024-05-01', hasta: '2024-05-31' } })).toBe('2024-05-31');
    expect(documentDate('liquidacion_anual', { periodo: { desde: null, hasta: null }, fecha_emision: null })).toBeNull();
  });
});
