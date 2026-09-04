import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_BODY_ID,
  canonicalSha256,
  esc,
  evidenceRef,
  extractCanonicalBody,
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtPct,
  gateStatsBlock,
  packDocument,
  scopeAndLimits,
  table,
} from './sections.ts';
import { scoreFieldsPresent } from './gates.ts';

const body = `<h1>Informe</h1>${table(['a', 'b'], [['1', '2']], 'none')}`;

describe('canonical body', () => {
  it('hashes the same body identically however the header differs', () => {
    const first = packDocument({ lang: 'es', title: 'Informe', headerLines: [['Generado el', '2026-09-04']], body });
    const second = packDocument({ lang: 'es', title: 'Informe', headerLines: [['Generado el', '2027-01-31'], ['Ruta', '/tmp/x.html']], body });
    expect(first).not.toBe(second);
    expect(createHash('sha256').update(first).digest('hex')).not.toBe(createHash('sha256').update(second).digest('hex'));
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
  });

  it('changes the canonical hash as soon as the body changes', () => {
    const a = packDocument({ lang: 'es', title: 't', headerLines: [], body });
    const b = packDocument({ lang: 'es', title: 't', headerLines: [], body: `${body}<p>extra</p>` });
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it('keeps the volatile header out of the canonical span', () => {
    const html = packDocument({ lang: 'es', title: 't', headerLines: [['Generado el', '2026-09-04']], body });
    const canonical = extractCanonicalBody(html);
    expect(canonical.startsWith(`<main id="${CANONICAL_BODY_ID}">`)).toBe(true);
    expect(canonical.endsWith('</main>')).toBe(true);
    expect(canonical).not.toContain('2026-09-04');
    expect(html).toContain('2026-09-04');
  });

  it('refuses to hash a document it did not build, rather than hashing the wrong span', () => {
    expect(() => canonicalSha256('<html><body><p>hand-made</p></body></html>')).toThrow(/canonical body/);
  });
});

describe('deterministic formatting', () => {
  it('formats money without depending on the host locale data', () => {
    expect(fmtMoney(1234.5, 'es')).toBe('1.234,50 €');
    expect(fmtMoney(1234.5, 'en')).toBe('€1,234.50');
    expect(fmtMoney('1234567.891', 'es')).toBe('1.234.567,89 €');
    expect(fmtMoney(-900, 'es')).toBe('−900,00 €');
    expect(fmtMoney(0, 'en')).toBe('€0.00');
    expect(fmtMoney(null, 'es')).toBe('—');
    expect(fmtMoney('not a number', 'es')).toBe('—');
  });

  it('formats percentages and integers the same way on every run', () => {
    expect(fmtPct(87.25, 'es')).toBe('87,3 %');
    expect(fmtPct(87.25, 'en')).toBe('87.3 %');
    expect(fmtPct(null, 'en')).toBe('—');
    expect(fmtInt(15000, 'es')).toBe('15.000');
    expect(fmtInt(15000, 'en')).toBe('15,000');
  });

  it('prints dates as ISO references, never as prose', () => {
    expect(fmtDate('2024-06-01T10:11:12.000Z')).toBe('2024-06-01');
    expect(fmtDate(new Date('2024-06-01T00:00:00Z'))).toBe('2024-06-01');
    expect(fmtDate(null)).toBe('');
  });
});

describe('evidence references', () => {
  it('builds the reproducibility reference and omits the parts that are unknown', () => {
    expect(
      evidenceRef({
        documentId: 'd1e2f3a4-5678-4abc-9def-000000000000',
        pageNo: 3,
        runId: 'aabbccdd-1111-4222-8333-444444444444',
        ruleCode: 'D1',
        ruleVersion: 2,
        parameterVersion: 1,
      }),
    ).toBe('[D-d1e2f3a4 · p.3 · run aabbccdd · rule D1@v2 · par v1]');
    expect(evidenceRef({ ruleCode: 'D6' })).toBe('[rule D6]');
    expect(evidenceRef({})).toBe('');
  });
});

describe('pack furniture', () => {
  it('prints the scope-and-limits text with its non-exculpatory sentence, in both languages', () => {
    expect(scopeAndLimits('es')).toContain('La ausencia de discrepancias en una prueba no acredita la regularidad');
    expect(scopeAndLimits('en')).toContain('The absence of discrepancies in a test does not establish the regularity');
  });

  it('prints the gate statistics without leaking a score field', () => {
    const html = gateStatsBlock('es', {
      findings_distributed: 3,
      withheld_pending_reply: 2,
      withheld_pending_legal_source: 5,
      annex_only: 7,
    });
    expect(html).toContain('pendiente de derecho de respuesta — no distribuido');
    expect(html).toContain('<dd>3</dd>');
    expect(scoreFieldsPresent(html)).toEqual([]);
  });

  it('escapes text so a quotation cannot inject markup', () => {
    expect(esc('<script>"x" & y')).toBe('&lt;script&gt;&quot;x&quot; &amp; y');
    expect(table(['a'], [['<b>bold</b>']], 'none')).toContain('<td><b>bold</b></td>');
    expect(table(['a'], [['plain <b>']], 'none')).toContain('<td>plain &lt;b&gt;</td>');
    expect(table(['a'], [], 'no records')).toBe('<p class="muted">no records</p>');
  });
});
