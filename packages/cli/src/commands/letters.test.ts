import { describe, expect, it } from 'vitest';
import { renderLetter, REPLY_WINDOW_DAYS, type LetterData } from './letters.ts';

const data: LetterData = {
  community: { id: 'c-1', name: 'Comunitat de prova', address: 'Carrer de prova 1' },
  finding: {
    id: '3e78d54c-4a07-44e5-891c-1dbddbf1acb7',
    ref: 'F-3e78d54c',
    summaryEs: 'Cargo de 900,00 € el 2024-06-01: no conciliado con ninguna factura del corpus a 2026-09-04. Verificar.',
    summaryEn: 'Debit of 900.00 € on 2024-06-01: not yet matched to an invoice in the corpus as of 2026-09-04. Verify.',
    amountAtStake: 900,
    actDateFirst: '2024-06-01',
    actDateLast: null,
    nextCheck: 'Request the invoice or receipt for this movement.',
    resolvingDocument: 'Factura o recibo del movimiento',
    status: 'in_review',
    evidence: [{ label: 'bank movement', ref: 'D-12345678 · p. 3 · sha256 abcdef01' }],
  },
  today: '2026-09-04',
  deadline: '2026-09-14',
  requestDate: '2026-07-01',
};

describe('explanation letter', () => {
  it('gives at least ten calendar days and prints the deadline', () => {
    expect(REPLY_WINDOW_DAYS).toBeGreaterThanOrEqual(10);
    const html = renderLetter(data, 'es');
    expect(html).toContain('plazo de diez días naturales');
    expect(html).toContain('2026-09-14');
    expect(html).toContain('sin respuesta a 2026-09-14');
  });

  it('states the right of reply and that the item is a discrepancy to verify', () => {
    const es = renderLetter(data, 'es');
    expect(es).toContain('discrepancia a verificar');
    expect(es).toContain('se reproducirá íntegramente');
    const en = renderLetter(data, 'en');
    expect(en).toContain('discrepancy to verify');
    expect(en).toContain('reproduced in full');
  });

  it('carries no scores, tier labels or rule names', () => {
    const html = `${renderLetter(data, 'es')} ${renderLetter(data, 'en')}`;
    for (const f of ['hit_score', 'specificity', 'independence', 'Tier ', 'T1', 'T2', 'rule_code', 'D1', 'severity']) {
      expect(html).not.toContain(f);
    }
  });

  it('lists the item, its amount, dates, evidence references and the document requested', () => {
    const html = renderLetter(data, 'es');
    expect(html).toContain('F-3e78d54c');
    expect(html).toContain('900,00');
    expect(html).toContain('2024-06-01');
    expect(html).toContain('D-12345678 · p. 3 · sha256 abcdef01');
    expect(html).toContain('Factura o recibo del movimiento');
  });

  it('does not refer to a meeting request that is not on file', () => {
    const html = renderLetter({ ...data, requestDate: null }, 'es');
    expect(html).not.toContain('dicha junta');
    expect(html).toContain('derecho de información');
  });
});
