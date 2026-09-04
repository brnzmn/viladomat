import { describe, expect, it } from 'vitest';
import { DATA_ROOM_TABLES, METHODOLOGY_NOTE, toCsv } from './dataroom.ts';
import { sha256 } from './sections.ts';
import { SCORE_FIELDS } from './gates.ts';

describe('CSV writing', () => {
  it('writes a header and the columns in the order it was given', () => {
    expect(toCsv(['b', 'a'], [{ a: 1, b: 2 }])).toBe('b,a\n2,1\n');
  });

  it('quotes commas, quotes and newlines per RFC 4180', () => {
    expect(toCsv(['x'], [{ x: 'a,b' }])).toBe('x\n"a,b"\n');
    expect(toCsv(['x'], [{ x: 'say "hi"' }])).toBe('x\n"say ""hi"""\n');
    expect(toCsv(['x'], [{ x: 'line1\nline2' }])).toBe('x\n"line1\nline2"\n');
  });

  it('writes nulls as empty cells and structures as JSON', () => {
    expect(toCsv(['a', 'b', 'c'], [{ a: null, b: ['x', 'y'], c: { k: 1 } }])).toBe('a,b,c\n,"[""x"",""y""]","{""k"":1}"\n');
  });

  it('produces identical bytes for identical data, which is what the manifest hash relies on', () => {
    const rows = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }];
    expect(sha256(toCsv(['a', 'b'], rows))).toBe(sha256(toCsv(['a', 'b'], rows)));
    expect(sha256(toCsv(['a', 'b'], rows))).not.toBe(sha256(toCsv(['b', 'a'], rows)));
  });
});

describe('the ledger list', () => {
  it('covers every ledger the pack cites, once each', () => {
    const names = DATA_ROOM_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      'files',
      'documents',
      'invoices',
      'invoice_lines',
      'bank_transactions',
      'recon_links',
      'resolutions',
      'derrama_ledger',
      'works_events',
      'findings',
      'finding_evidence',
      'parameters',
      'rules',
      'benchmark_records',
      'legal_sources',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('redacts the bank ledger and passes the catalogues through untouched', () => {
    expect(DATA_ROOM_TABLES.find((t) => t.name === 'bank_transactions')?.redaction).toBe('bank');
    expect(DATA_ROOM_TABLES.find((t) => t.name === 'rules')?.redaction).toBe('none');
    expect(DATA_ROOM_TABLES.find((t) => t.name === 'legal_sources')?.redaction).toBe('none');
  });

  it('is the only place the scores travel, and they travel with the methodology note', () => {
    const findings = DATA_ROOM_TABLES.find((t) => t.name === 'findings');
    for (const field of SCORE_FIELDS) expect(findings?.sql).toContain(field);
    for (const lang of ['es', 'en'] as const) {
      for (const field of SCORE_FIELDS) expect(METHODOLOGY_NOTE[lang]).toContain(field);
      expect(METHODOLOGY_NOTE[lang]).toMatch(/discrepancia a verificar|discrepancy to verify/);
    }
  });

  it('scopes every community ledger by community and leaves the global catalogues unscoped', () => {
    for (const spec of DATA_ROOM_TABLES) {
      const scoped = spec.sql.includes('$1');
      const isGlobal = ['rules', 'benchmark_records', 'legal_sources'].includes(spec.name);
      expect(scoped).toBe(!isGlobal);
    }
  });
});
