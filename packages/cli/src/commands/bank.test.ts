import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTransaction } from '@viladomat/core';
import { REPO_ROOT } from '../lib/env.ts';
import { detectDelimiter, detectSource, parseBankCsv, splitCsvLine, SOURCE_CONFIDENCE } from './bank.ts';

/**
 * CSV bank exports. Unlike Norma 43 and camt.053 nothing about a CSV is standardised, so what is
 * tested here is exactly the part that has to be inferred: which column is which, how the amounts
 * are written, and what happens to the rows that are not movements at all.
 */

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm2');
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

describe('CSV mechanics', () => {
  it('detects the delimiter from the header line', () => {
    expect(detectDelimiter('Data;Concepte;Import')).toBe(';');
    expect(detectDelimiter('Date,Concept,Amount')).toBe(',');
    expect(detectDelimiter('Date\tConcept\tAmount')).toBe('\t');
  });

  it('keeps a delimiter that sits inside quotes', () => {
    expect(splitCsvLine('a;"b;c";d', ';')).toEqual(['a', 'b;c', 'd']);
    expect(splitCsvLine('a;"say ""hello""";d', ';')).toEqual(['a', 'say "hello"', 'd']);
  });
});

describe('parsing a bank CSV', () => {
  const parsed = parseBankCsv(read('extracte-csv-caixa.csv'));

  it('finds the header even when the file starts with account metadata', () => {
    expect(parsed.columns).toMatchObject({ fecha: 0, valor: 1, concepto: 2, importe: 3, saldo: 4 });
    expect(parsed.warnings).toEqual([]);
  });

  it('reads Spanish amounts and keeps the sign of a debit', () => {
    expect(parsed.movements.map((m) => m.amount)).toEqual([60, -3253.8, -12, -180]);
  });

  it('reads the dates and the concept text', () => {
    expect(parsed.movements[0]?.opDate).toBe('2024-05-02');
    expect(parsed.movements[0]?.valueDate).toBe('2024-05-02');
    expect(parsed.movements[1]?.counterpartyText).toContain('INSTAL.LACIONS EXEMPLE SL');
  });

  it('derives the period from the movements', () => {
    expect(parsed.periodFrom).toBe('2024-05-02');
    expect(parsed.periodTo).toBe('2024-05-20');
  });

  it('derives the opening balance by undoing the first movement, so continuity can be checked', () => {
    expect(parsed.openingBalance).toBe(12500.4);
    expect(parsed.closingBalance).toBe(9114.6);
    const sum = parsed.movements.reduce((s, m) => s + m.amount, 0);
    expect(Math.abs((parsed.openingBalance ?? 0) + sum - (parsed.closingBalance ?? 0))).toBeLessThanOrEqual(0.01);
  });

  it('classifies the movements it read', () => {
    const kinds = parsed.movements.map((m) => classifyTransaction({ amount: m.amount, conceptText: m.counterpartyText }).txKind);
    expect(kinds[1]).toBe('transfer_out');
    expect(kinds[2]).toBe('fee');
  });
});

describe('a CSV with separate debit and credit columns', () => {
  const parsed = parseBankCsv(read('extracte-csv-debe-haber.csv'));

  it('signs the debit column negative and the credit column positive', () => {
    expect(parsed.movements.map((m) => m.amount)).toEqual([-78.5, 60]);
  });

  it('skips and counts the rows that carry no date or amount', () => {
    expect(parsed.warnings.join(' ')).toContain('1 row(s)');
  });
});

describe('format detection', () => {
  it('recognises camt.053 by its XML root', () => {
    expect(detectSource('<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022"></Document>', 'x.xml')).toBe('camt053');
  });

  it('recognises Norma 43 by its fixed-width records', () => {
    const line = `1121000418${'0'.repeat(10)}240501240531${'0'.repeat(14)}2978${' '.repeat(30)}`;
    expect(detectSource(line, 'export.txt')).toBe('norma43');
    expect(detectSource('anything', 'export.n43')).toBe('norma43');
  });

  it('falls back to CSV', () => {
    expect(detectSource(read('extracte-csv-caixa.csv'), 'extracte.csv')).toBe('csv');
  });
});

describe('confidence by format', () => {
  it('trusts the two banking standards fully and a CSV slightly less', () => {
    expect(SOURCE_CONFIDENCE.norma43).toBe(1);
    expect(SOURCE_CONFIDENCE.camt053).toBe(1);
    expect(SOURCE_CONFIDENCE.csv).toBe(0.95);
  });
});

describe('a file that is not a statement', () => {
  it('reports that no header was found instead of inventing movements', () => {
    const parsed = parseBankCsv('hola\nque tal\n');
    expect(parsed.movements).toEqual([]);
    expect(parsed.warnings.join(' ')).toContain('no header row');
  });
});
