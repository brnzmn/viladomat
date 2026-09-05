import { describe, expect, it } from 'vitest';
import { DATA_ROOM_TABLES, METHODOLOGY_NOTE, toCsv } from './dataroom.ts';
import { sha256 } from './sections.ts';
import { SCORE_FIELDS } from './gates.ts';
import { CHECK_PARTY_NIF_KIND, emptyRedactionContext, redactExternalCheckRow, redactRecord } from './redact.ts';

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
      'external_checks',
      'registry_sources',
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
      const isGlobal = ['rules', 'benchmark_records', 'legal_sources', 'registry_sources'].includes(spec.name);
      expect(scoped).toBe(!isGlobal);
    }
  });
});

describe('the registry-lookup ledgers', () => {
  it('exports the provenance of every external check without the archived body or the officer names', () => {
    const spec = DATA_ROOM_TABLES.find((t) => t.name === 'external_checks');
    expect(spec?.redaction).toBe('external_check');
    for (const column of ['party_id', 'check_type', 'status', 'source_url', 'fetched_at', 'evidence_storage_path'])
      expect(spec?.sql).toContain(column);
    expect(spec?.sql).not.toContain('raw_response');
    expect(spec?.sql).toContain("- 'officers'");
    // The party's kind of identifier travels with the row so the natural-person rule can apply.
    expect(spec?.sql).toContain(`p.nif_kind::text as ${CHECK_PARTY_NIF_KIND}`);
    expect(spec?.sql).toContain('left join public.parties p on p.id = c.party_id');
  });

  it('exports a natural person’s lookup without any name, through the same chain the bundle applies', () => {
    // The placeholder stands for a sole trader's name as printed on an invoice; no real name is used.
    const NAME = 'SOLE TRADER NAME PLACEHOLDER';
    const rows = [
      {
        id: 'c-1',
        party_id: 'p-1',
        check_type: 'aeat_census',
        status: 'ok',
        request: JSON.stringify({ nif: '12345678Z', name_sent: NAME, natural_person: true }),
        normalised: JSON.stringify({ census_match: true, name_sent: NAME, natural_person: true }),
        [CHECK_PARTY_NIF_KIND]: 'DNI',
      },
      {
        id: 'c-2',
        party_id: 'p-1',
        check_type: 'insolvency',
        status: 'manual_pending',
        request: JSON.stringify({ query: `12345678Z · ${NAME}`, source: 'insolvency' }),
        normalised: JSON.stringify({ manual: true, query: `12345678Z · ${NAME}`, url: 'https://example.test/rpc' }),
        [CHECK_PARTY_NIF_KIND]: 'DNI',
      },
      {
        id: 'c-3',
        party_id: 'p-2',
        check_type: 'aeat_census',
        status: 'ok',
        request: JSON.stringify({ nif: 'B12345674', name_sent: 'OBRES EXEMPLE BARNA SL', natural_person: false }),
        normalised: JSON.stringify({ census_match: true, name_registered: 'OBRES EXEMPLE BARNA SL', natural_person: false }),
        [CHECK_PARTY_NIF_KIND]: 'CIF',
      },
    ];
    const ctx = emptyRedactionContext('en');
    const out = rows.map((r) => redactRecord(redactExternalCheckRow(r), ctx));
    const exported = JSON.stringify(out) + toCsv(Object.keys(out[0] ?? {}), out);
    expect(exported).not.toContain('PLACEHOLDER');
    expect(exported).not.toContain(CHECK_PARTY_NIF_KIND);
    expect(exported).toContain('12345678Z');
    expect(exported).toContain('OBRES EXEMPLE BARNA SL');
    expect(JSON.parse(String(out[0]?.normalised))).toEqual({ census_match: true, natural_person: true });
    expect(JSON.parse(String(out[1]?.request))).toEqual({ source: 'insolvency' });
  });

  it('exports the source register with its verification state', () => {
    const spec = DATA_ROOM_TABLES.find((t) => t.name === 'registry_sources');
    expect(spec?.redaction).toBe('none');
    for (const column of ['verified_at', 'verified_by', 'probe_check_id', 'licence_note']) expect(spec?.sql).toContain(column);
  });
});
