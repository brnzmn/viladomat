import { describe, expect, it } from 'vitest';
import {
  expandTwoDigitYear,
  formatAmountEs,
  normaliseValue,
  parseAmountEs,
  parseDateEs,
  stripDiacritics,
  toIsoDate,
} from './amounts.ts';

describe('parseAmountEs', () => {
  it('parses Spanish and international notations', () => {
    expect(parseAmountEs('1.234,56')).toBe(1234.56);
    expect(parseAmountEs('1234,56')).toBe(1234.56);
    expect(parseAmountEs('1,234.56')).toBe(1234.56);
    expect(parseAmountEs('1234.56')).toBe(1234.56);
    expect(parseAmountEs('1.234.567,89')).toBe(1234567.89);
    expect(parseAmountEs('1,234,567.89')).toBe(1234567.89);
  });
  it('ignores currency symbols and words', () => {
    expect(parseAmountEs('€ 1.234,56')).toBe(1234.56);
    expect(parseAmountEs('1.234,56 €')).toBe(1234.56);
    expect(parseAmountEs('1.234,56 EUR')).toBe(1234.56);
    expect(parseAmountEs('12 euros')).toBe(12);
    expect(parseAmountEs('1 234,56')).toBe(1234.56);
  });
  it('handles signs, including trailing minus and parentheses', () => {
    expect(parseAmountEs('-1.234,56')).toBe(-1234.56);
    expect(parseAmountEs('1.234,56-')).toBe(-1234.56);
    expect(parseAmountEs('(1.234,56)')).toBe(-1234.56);
    expect(parseAmountEs('+50')).toBe(50);
  });
  it('treats a lone dot followed by three digits as a thousands separator', () => {
    expect(parseAmountEs('1.234')).toBe(1234);
    expect(parseAmountEs('12.345')).toBe(12345);
    expect(parseAmountEs('1.23')).toBe(1.23);
    expect(parseAmountEs('1.2')).toBe(1.2);
  });
  it('treats a lone comma as a decimal separator', () => {
    expect(parseAmountEs('1,234')).toBe(1.234);
    expect(parseAmountEs('0,5')).toBe(0.5);
    expect(parseAmountEs(',5')).toBe(0.5);
  });
  it('rejects inconsistent groupings and non-amounts', () => {
    expect(parseAmountEs('12,34.5')).toBeNull();
    expect(parseAmountEs('1.23.4')).toBeNull();
    expect(parseAmountEs('abc')).toBeNull();
    expect(parseAmountEs('')).toBeNull();
    expect(parseAmountEs(null)).toBeNull();
    expect(parseAmountEs('1.234,56,78')).toBeNull();
  });
  it('passes numbers through', () => {
    expect(parseAmountEs(12.5)).toBe(12.5);
    expect(parseAmountEs(Number.NaN)).toBeNull();
  });
});

describe('formatAmountEs', () => {
  it('formats with dots for thousands and a comma decimal', () => {
    expect(formatAmountEs(1234.56)).toBe('1.234,56');
    expect(formatAmountEs(1234567)).toBe('1.234.567,00');
    expect(formatAmountEs(-0.5)).toBe('-0,50');
    expect(formatAmountEs(12)).toBe('12,00');
  });
  it('supports currency suffix and other decimals', () => {
    expect(formatAmountEs(1234.5, { currency: true })).toBe('1.234,50 €');
    expect(formatAmountEs(1234, { decimals: 0 })).toBe('1.234');
  });
  it('round-trips with parseAmountEs', () => {
    for (const n of [0, 1, 999.99, 1000, 123456.78, -42.1]) {
      expect(parseAmountEs(formatAmountEs(n))).toBe(n);
    }
  });
});

describe('parseDateEs', () => {
  it('parses numeric formats with 4- and 2-digit years', () => {
    expect(parseDateEs('03/02/2023')).toBe('2023-02-03');
    expect(parseDateEs('3/2/2023')).toBe('2023-02-03');
    expect(parseDateEs('03-02-2023')).toBe('2023-02-03');
    expect(parseDateEs('03.02.23')).toBe('2023-02-03');
    expect(parseDateEs('03.02.85')).toBe('1985-02-03');
  });
  it('parses ISO dates and timestamps', () => {
    expect(parseDateEs('2023-02-03')).toBe('2023-02-03');
    expect(parseDateEs('2023-02-03T10:20:30Z')).toBe('2023-02-03');
  });
  it('parses Spanish month names', () => {
    expect(parseDateEs('3 de febrero de 2023')).toBe('2023-02-03');
    expect(parseDateEs('15 de septiembre de 2022')).toBe('2022-09-15');
    expect(parseDateEs('1 de enero del 2024')).toBe('2024-01-01');
    expect(parseDateEs('31 dic 2023')).toBe('2023-12-31');
  });
  it('parses Catalan month names including apostrophes and "del"', () => {
    expect(parseDateEs('3 de març de 2023')).toBe('2023-03-03');
    expect(parseDateEs("1 d'abril de 2023")).toBe('2023-04-01');
    expect(parseDateEs('12 de gener del 2024')).toBe('2024-01-12');
    expect(parseDateEs("5 d'octubre de 2022")).toBe('2022-10-05');
    expect(parseDateEs('28 de desembre de 2023')).toBe('2023-12-28');
  });
  it('finds a date embedded in a short text', () => {
    expect(parseDateEs('Barcelona, 3 de març de 2023')).toBe('2023-03-03');
    expect(parseDateEs('Data: 03/02/2023 Factura')).toBe('2023-02-03');
  });
  it('rejects impossible dates and non-dates', () => {
    expect(parseDateEs('31/02/2023')).toBeNull();
    expect(parseDateEs('00/01/2023')).toBeNull();
    expect(parseDateEs('13/13/2023')).toBeNull();
    expect(parseDateEs('sin fecha')).toBeNull();
    expect(parseDateEs('')).toBeNull();
    expect(parseDateEs(null)).toBeNull();
    expect(parseDateEs('3 de foo de 2023')).toBeNull();
  });
  it('helpers: two-digit years and calendar validation', () => {
    expect(expandTwoDigitYear(69)).toBe(2069);
    expect(expandTwoDigitYear(70)).toBe(1970);
    expect(toIsoDate(2024, 2, 29)).toBe('2024-02-29');
    expect(toIsoDate(2023, 2, 29)).toBeNull();
  });
});

describe('normaliseValue', () => {
  it('amounts → fixed two decimals', () => {
    expect(normaliseValue('amount', '1.234,5')).toBe('1234.50');
    expect(normaliseValue('amount', '1,234.56 €')).toBe('1234.56');
    expect(normaliseValue('amount', 1234.567)).toBe('1234.57');
    expect(normaliseValue('amount', 'n/a')).toBeNull();
  });
  it('dates → ISO', () => {
    expect(normaliseValue('date', '3 de febrero de 2023')).toBe('2023-02-03');
    expect(normaliseValue('date', '03/02/2023')).toBe('2023-02-03');
    expect(normaliseValue('date', '??')).toBeNull();
  });
  it('identifiers → normalised', () => {
    expect(normaliseValue('nif', 'b-12.345.674')).toBe('B12345674');
    expect(normaliseValue('iban', 'es91 2100 0418 4502 0005 1332')).toBe(
      'ES9121000418450200051332',
    );
    expect(normaliseValue('nif', '')).toBeNull();
  });
  it('text → accent-free lower case with collapsed spaces', () => {
    expect(normaliseValue('text', '  Instal·lacions   Elèctriques  ')).toBe(
      'instal·lacions electriques',
    );
    expect(normaliseValue('text', 'Ç à É')).toBe('c a e');
    expect(normaliseValue('text', null)).toBeNull();
  });
  it('same value written by two readers gives the same string', () => {
    expect(normaliseValue('amount', '1.234,56')).toBe(normaliseValue('amount', '1234.56'));
    expect(normaliseValue('date', '3-2-2023')).toBe(normaliseValue('date', '2023-02-03'));
  });
  it('stripDiacritics keeps base letters', () => {
    expect(stripDiacritics('àéîõüç')).toBe('aeiouc');
  });
});
