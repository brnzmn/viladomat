import { describe, expect, it } from 'vitest';
import { dedupeKey, normaliseInvoiceNumber } from './normalise-doc.ts';

describe('normaliseInvoiceNumber', () => {
  it('splits series and number', () => {
    expect(normaliseInvoiceNumber('F-2023/001')).toEqual({
      series: 'F2023',
      numberInt: 1,
      suffix: '',
      canonical: 'F2023-1',
    });
  });
  it('is insensitive to separators, case and leading zeros', () => {
    const a = normaliseInvoiceNumber('f 2023/0001');
    const b = normaliseInvoiceNumber('F-2023-001');
    const c = normaliseInvoiceNumber('F2023/1');
    expect(a.canonical).toBe('F2023-1');
    expect(b.canonical).toBe('F2023-1');
    expect(c.canonical).toBe('F2023-1');
  });
  it('handles plain numbers, suffixes and empty input', () => {
    expect(normaliseInvoiceNumber('0007')).toEqual({
      series: '',
      numberInt: 7,
      suffix: '',
      canonical: '7',
    });
    expect(normaliseInvoiceNumber('FAC 7 B')).toEqual({
      series: 'FAC',
      numberInt: 7,
      suffix: 'B',
      canonical: 'FAC-7-B',
    });
    expect(normaliseInvoiceNumber('A/23/0007')).toMatchObject({ series: 'A23', numberInt: 7 });
    expect(normaliseInvoiceNumber('')).toEqual({
      series: '',
      numberInt: null,
      suffix: '',
      canonical: '',
    });
    expect(normaliseInvoiceNumber('SIN-NUMERO')).toEqual({
      series: 'SINNUMERO',
      numberInt: null,
      suffix: '',
      canonical: 'SINNUMERO',
    });
  });
});

describe('dedupeKey', () => {
  it('produces a canonical pipe-separated key', () => {
    expect(
      dedupeKey({
        vendorNif: 'b-12.345.674',
        serie: 'F',
        numero: '2023/001',
        total: '1.234,56',
        fecha: '03/02/2023',
      }),
    ).toBe('B12345674|F2023|1|1234.56|2023-02-03');
  });
  it('is stable across reader formatting differences', () => {
    const a = dedupeKey({
      vendorNif: 'B12345674',
      serie: '',
      numero: 'F-2023/001',
      total: 1234.56,
      fecha: '2023-02-03',
    });
    const b = dedupeKey({
      vendorNif: ' b12345674 ',
      serie: 'F',
      numero: '2023-0001',
      total: '1234,56 €',
      fecha: '3 de febrero de 2023',
    });
    expect(a).toBe(b);
  });
  it('differs when any component differs', () => {
    const base = {
      vendorNif: 'B12345674',
      serie: 'F',
      numero: '2023/001',
      total: 100,
      fecha: '2023-02-03',
    };
    const key = dedupeKey(base);
    expect(dedupeKey({ ...base, total: 100.01 })).not.toBe(key);
    expect(dedupeKey({ ...base, numero: '2023/002' })).not.toBe(key);
    expect(dedupeKey({ ...base, fecha: '2023-02-04' })).not.toBe(key);
    expect(dedupeKey({ ...base, vendorNif: 'A98765434' })).not.toBe(key);
  });
  it('falls back to raw text for unparseable totals and dates', () => {
    expect(
      dedupeKey({ vendorNif: null, serie: null, numero: null, total: 'n/a', fecha: 'unknown' }),
    ).toBe('|||n/a|unknown');
  });
});
