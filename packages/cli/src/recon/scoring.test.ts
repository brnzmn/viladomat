import { describe, expect, it } from 'vitest';
import {
  amountMatches,
  assignPayments,
  candidateDebits,
  daysBetween,
  decideMethod,
  decidePartialMethod,
  evidenceFor,
  findPartialSet,
  invoiceNumberInText,
  ledgerStatus,
  matchInvoice,
  milestoneStatus,
  nameSimilarity,
  periodForCredit,
  recurringDirectDebitIds,
  targetAmounts,
  withinPaymentWindow,
  withinPct,
  type DebitLeg,
  type InvoiceLeg,
} from './scoring.ts';

const VENDOR = 'v-1';
const IBANS = new Map<string, ReadonlySet<string>>([[VENDOR, new Set(['HMAC-VENDOR'])]]);

function invoice(over: Partial<InvoiceLeg> = {}): InvoiceLeg {
  return {
    id: 'i-1',
    total: 1210,
    date: '2024-03-10',
    numero: '2024/118',
    serie: null,
    vendorPartyId: VENDOR,
    vendorName: 'REFORMES EXEMPLE SL',
    ...over,
  };
}

function debit(over: Partial<DebitLeg> = {}): DebitLeg {
  return { id: 't-1', amount: 1210, date: '2024-03-20', ...over };
}

describe('payment window and amounts', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2024-03-10', '2024-03-20')).toBe(10);
    expect(daysBetween('2024-03-10', '2024-03-05')).toBe(-5);
  });

  it('accepts 5 days before and 120 days after the invoice date', () => {
    expect(withinPaymentWindow('2024-03-10', '2024-03-05')).toBe(true);
    expect(withinPaymentWindow('2024-03-10', '2024-03-04')).toBe(false);
    expect(withinPaymentWindow('2024-03-10', '2024-07-08')).toBe(true);
    expect(withinPaymentWindow('2024-03-10', '2024-07-09')).toBe(false);
  });

  it('matches the gross total and the total net of withholding', () => {
    const inv = invoice({ total: 1210, retentionPct: 15 });
    expect(targetAmounts(inv)).toEqual([1210, 1028.5]);
    expect(amountMatches(inv, 1210.01)).toBe(true);
    expect(amountMatches(inv, 1210.02)).toBe(false);
    expect(amountMatches(inv, 1028.5)).toBe(true);
  });

  it('prefers the stated withholding amount over the percentage', () => {
    expect(targetAmounts(invoice({ total: 1000, retentionAmount: 150, retentionPct: 15 }))).toEqual([1000, 850]);
  });
});

describe('evidence and method', () => {
  it('finds the invoice number inside the bank concept, ignoring separators', () => {
    expect(invoiceNumberInText(invoice(), 'TRANSF FRA 2024-118 REFORMES')).toBe(true);
    expect(invoiceNumberInText(invoice({ numero: '7' }), 'PAGO 7')).toBe(false);
    expect(invoiceNumberInText(invoice({ serie: 'A', numero: '118' }), 'REF A118')).toBe(true);
  });

  it('scores IBAN identity above the payee name, the number and the amount alone', () => {
    const iban = decideMethod(evidenceFor(invoice(), debit({ counterpartyIbanHmac: 'HMAC-VENDOR' }), new Set(['HMAC-VENDOR'])));
    expect(iban).toEqual({ method: 'iban', score: 1, status: 'accepted' });

    const byName = decideMethod(evidenceFor(invoice(), debit({ counterpartyName: 'REFORMES EXEMPLE, S.L.' }), new Set()));
    expect(byName).toEqual({ method: 'amount_date_name', score: 0.8, status: 'proposed' });

    const byRef = decideMethod(
      evidenceFor(invoice({ vendorName: 'UNRELATED NAME' }), debit({ conceptoText: 'FRA 2024/118' }), new Set()),
    );
    expect(byRef).toEqual({ method: 'reference', score: 0.9, status: 'proposed' });

    const bare = decideMethod(evidenceFor(invoice({ vendorName: null }), debit(), new Set()));
    expect(bare).toEqual({ method: 'amount_date', score: 0.6, status: 'proposed' });
  });

  it('never auto-accepts a partial-payment set', () => {
    const strong = decidePartialMethod([
      { ibanMatch: true, nameScore: 1, referenceMatch: false },
      { ibanMatch: true, nameScore: 1, referenceMatch: false },
    ]);
    expect(strong).toEqual({ method: 'partial_sum', score: 0.9, status: 'proposed' });
    expect(decidePartialMethod([{ ibanMatch: false, nameScore: 0.2, referenceMatch: false }]).score).toBe(0.5);
  });
});

describe('partial payments', () => {
  const inv = invoice({ total: 3000 });
  const debits: DebitLeg[] = [
    debit({ id: 'a', amount: 1000, date: '2024-03-15' }),
    debit({ id: 'b', amount: 2000, date: '2024-05-15' }),
    debit({ id: 'c', amount: 500, date: '2024-06-01' }),
  ];

  it('finds a set of debits summing to the total inside the window', () => {
    const set = findPartialSet(inv, debits);
    expect(set?.debits.map((d) => d.id)).toEqual(['a', 'b']);
    expect(set?.target).toBe(3000);
  });

  it('returns null when no set of at most three debits reaches the total', () => {
    expect(findPartialSet(invoice({ total: 9999 }), debits)).toBeNull();
  });

  it('only considers debits inside the payment window', () => {
    expect(candidateDebits(inv, [debit({ id: 'z', date: '2024-08-01' })])).toHaveLength(0);
  });

  it('falls back to a partial set when no single debit matches', () => {
    const m = matchInvoice(inv, debits, new Set());
    expect(m?.kind).toBe('partial');
    expect(m?.decision.method).toBe('partial_sum');
  });
});

describe('assignPayments', () => {
  it('gives each debit to the invoice with the strongest evidence and never reuses it', () => {
    const invA = invoice({ id: 'A', total: 500, date: '2024-03-01', vendorName: 'REFORMES EXEMPLE SL' });
    const invB = invoice({ id: 'B', total: 500, date: '2024-03-02', vendorName: 'ALTRA EMPRESA SL', vendorPartyId: 'v-2' });
    const tx = debit({ id: 'T', amount: 500, date: '2024-03-05', counterpartyIbanHmac: 'HMAC-VENDOR' });
    const out = assignPayments([invA, invB], [tx], IBANS);
    expect(out).toHaveLength(1);
    expect(out[0]!.invoice.id).toBe('A');
    expect(out[0]!.match.decision.status).toBe('accepted');
  });

  it('is stable regardless of the order invoices arrive in', () => {
    const invA = invoice({ id: 'A', total: 100, date: '2024-01-10', vendorName: null, vendorPartyId: null });
    const invB = invoice({ id: 'B', total: 100, date: '2024-01-11', vendorName: null, vendorPartyId: null });
    const t1 = debit({ id: 't1', amount: 100, date: '2024-01-12' });
    const t2 = debit({ id: 't2', amount: 100, date: '2024-01-20' });
    const forward = assignPayments([invA, invB], [t1, t2], IBANS).map((a) => `${a.invoice.id}:${a.match.debits[0]!.id}`);
    const backward = assignPayments([invB, invA], [t2, t1], IBANS).map((a) => `${a.invoice.id}:${a.match.debits[0]!.id}`);
    expect(forward).toEqual(backward);
  });
});

describe('names, percentages and ledger status', () => {
  it('scores token-set similarity of company names', () => {
    expect(nameSimilarity('REFORMES EXEMPLE SL', 'Reformes Exemple, S.L.')).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity('REFORMES EXEMPLE SL', 'FUSTERIA ALTRA SCP')).toBeLessThan(0.6);
    expect(nameSimilarity(null, 'X')).toBe(0);
  });

  it('compares amounts within a relative tolerance', () => {
    expect(withinPct(1000, 1009, 1)).toBe(true);
    expect(withinPct(1000, 1011, 1)).toBe(false);
  });

  it('derives the ledger status from expected and collected', () => {
    expect(ledgerStatus(60, 60)).toBe('paid');
    expect(ledgerStatus(60, 0)).toBe('missing');
    expect(ledgerStatus(60, 30)).toBe('partial');
    expect(ledgerStatus(60, 90)).toBe('excess');
  });

  it('reads the period from the concept, else from the operation date', () => {
    expect(periodForCredit('2024-04-03', 'CUOTA MARZO 2024 PISO 2-1')).toBe('2024-03-01');
    expect(periodForCredit('2024-04-03', 'QUOTA GENER')).toBe('2024-01-01');
    expect(periodForCredit('2024-04-03', 'RECIBO 03/2024')).toBe('2024-03-01');
    expect(periodForCredit('2024-04-03', null)).toBe('2024-04-01');
  });

  it('moves a milestone out of pending only with an invoice or a payment', () => {
    expect(milestoneStatus({ importe: 1000, invoiceTotal: null, paidTotal: null, paidWithoutInvoice: false })).toBe('pending');
    expect(milestoneStatus({ importe: 1000, invoiceTotal: 1000, paidTotal: null, paidWithoutInvoice: false })).toBe('invoiced');
    expect(milestoneStatus({ importe: 1000, invoiceTotal: 1000, paidTotal: 1000, paidWithoutInvoice: false })).toBe('paid');
    expect(milestoneStatus({ importe: 1000, invoiceTotal: null, paidTotal: 1000, paidWithoutInvoice: true })).toBe('paid_without_invoice');
    expect(milestoneStatus({ importe: 1000, invoiceTotal: 1000, paidTotal: 1500, paidWithoutInvoice: false })).toBe('overpaid');
  });
});

describe('recurring direct debits', () => {
  it('needs three movements from one counterparty within ±30% of the median', () => {
    const rows = [
      { id: '1', amount: -100, txKind: 'direct_debit', key: 'UTILITY' },
      { id: '2', amount: -110, txKind: 'direct_debit', key: 'UTILITY' },
      { id: '3', amount: -95, txKind: 'direct_debit', key: 'UTILITY' },
      { id: '4', amount: -900, txKind: 'direct_debit', key: 'UTILITY' },
      { id: '5', amount: -100, txKind: 'direct_debit', key: 'OTHER' },
      { id: '6', amount: -100, txKind: 'transfer_out', key: 'UTILITY' },
    ];
    expect(recurringDirectDebitIds(rows)).toEqual(['1', '2', '3']);
  });
});
