import { describe, expect, it } from 'vitest';
import {
  classifyTransaction,
  counterpartyKey,
  detectRecurringDirectDebits,
  isRoundAmount,
  looksLikePersonName,
  type ClassifiedTransaction,
} from './classify.ts';

describe('classifyTransaction — text-driven kinds', () => {
  it('detects Bizum, cash, cheques', () => {
    expect(
      classifyTransaction({ amount: -50, conceptText: 'BIZUM A PROVADOR EXEMPLE' }),
    ).toMatchObject({ txKind: 'bizum' });
    expect(
      classifyTransaction({ amount: -620, conceptText: 'REINTEGRO EFECTIVO OFICINA' }),
    ).toMatchObject({ txKind: 'cash', flags: ['cash'] });
    expect(classifyTransaction({ amount: -600, conceptText: 'DISP. EFECTIVO CAJERO' }).txKind).toBe(
      'cash',
    );
    expect(classifyTransaction({ amount: 300, conceptText: 'INGRESO EFECTIVO' }).txKind).toBe(
      'cash',
    );
    expect(classifyTransaction({ amount: -1200, conceptText: 'PAGO CHEQUE 0001' }).txKind).toBe(
      'cheque',
    );
  });
  it('detects fees, interest, taxes and loans', () => {
    expect(
      classifyTransaction({ amount: -12, conceptText: 'COMISION MANTENIMIENTO CUENTA' }).txKind,
    ).toBe('fee');
    expect(classifyTransaction({ amount: -12, conceptText: 'COMISSIÓ ADMINISTRACIÓ' }).txKind).toBe(
      'fee',
    );
    expect(classifyTransaction({ amount: 1.2, conceptText: 'LIQUIDACION INTERESES' }).txKind).toBe(
      'interest',
    );
    expect(classifyTransaction({ amount: -400, conceptText: 'AEAT MODELO 111' }).txKind).toBe(
      'tax',
    );
    expect(
      classifyTransaction({ amount: -400, conceptText: 'AJUNTAMENT DE BARCELONA IBI' }).txKind,
    ).toBe('tax');
    expect(
      classifyTransaction({ amount: -900, conceptText: 'AMORTIZACION PRESTAMO 123' }).txKind,
    ).toBe('loan');
    expect(classifyTransaction({ amount: -900, conceptText: 'QUOTA PRÉSTEC' }).txKind).toBe('loan');
  });
  it('detects subsidies, refunds and returned items by sign', () => {
    expect(
      classifyTransaction({ amount: 15000, conceptText: 'SUBVENCIO CONSORCI HABITATGE' }).txKind,
    ).toBe('subsidy');
    expect(
      classifyTransaction({ amount: 15000, conceptText: 'TRANSF GENERALITAT AJUT REHABILITACIO' })
        .txKind,
    ).toBe('subsidy');
    expect(classifyTransaction({ amount: 120, conceptText: 'DEVOLUCION VENDOR A' }).txKind).toBe(
      'refund',
    );
    expect(
      classifyTransaction({ amount: -120, conceptText: 'DEVOLUCION RECIBO IMPAGADO' }).txKind,
    ).toBe('returned');
  });
  it('detects card, internal, transfers, direct debits and quota credits', () => {
    expect(classifyTransaction({ amount: -30, conceptText: 'COMPRA TARJETA 1234' })).toMatchObject({
      txKind: 'card',
      flags: ['card'],
    });
    expect(
      classifyTransaction({ amount: -1000, conceptText: 'TRASPASO A CUENTA PROPIA' }).txKind,
    ).toBe('internal');
    expect(
      classifyTransaction({ amount: -2500, conceptText: 'TRANSFERENCIA A VENDOR A SL' }).txKind,
    ).toBe('transfer_out');
    expect(
      classifyTransaction({ amount: 2500, conceptText: 'TRANSFERENCIA DE VENDOR A SL' }).txKind,
    ).toBe('transfer_in');
    expect(
      classifyTransaction({ amount: -123.45, conceptText: 'RECIBO COMPANYIA ELECTRICA C SA' })
        .txKind,
    ).toBe('direct_debit');
    expect(
      classifyTransaction({ amount: -123.45, conceptText: 'ADEUDO SEPA CORE VENDOR B' }).txKind,
    ).toBe('direct_debit');
    expect(
      classifyTransaction({ amount: 200, conceptText: 'TRANSFERENCIA QUOTA COMUNITAT GENER' })
        .txKind,
    ).toBe('quota_in');
    expect(
      classifyTransaction({ amount: 200, conceptText: 'REMESA RECIBOS DERRAMA ASCENSOR' }).txKind,
    ).toBe('quota_in');
    expect(classifyTransaction({ amount: 200, conceptText: 'CUOTA COMUNIDAD 3A' }).txKind).toBe(
      'quota_in',
    );
  });
  it('falls back to the concepto común when the text is uninformative', () => {
    expect(
      classifyTransaction({ amount: -100, conceptoComun: '01', conceptText: 'OPERACION' }).txKind,
    ).toBe('cash');
    expect(classifyTransaction({ amount: -100, conceptoComun: '03', conceptText: '' }).txKind).toBe(
      'direct_debit',
    );
    expect(classifyTransaction({ amount: 100, conceptoComun: '04' }).txKind).toBe('transfer_in');
    expect(classifyTransaction({ amount: -100, conceptoComun: '04' }).txKind).toBe('transfer_out');
    expect(classifyTransaction({ amount: -100, conceptoComun: '05' }).txKind).toBe('loan');
    expect(classifyTransaction({ amount: -100, conceptoComun: '10' }).txKind).toBe('cheque');
    expect(classifyTransaction({ amount: -100, conceptoComun: '12' }).txKind).toBe('card');
    expect(classifyTransaction({ amount: -100, conceptoComun: '14' }).txKind).toBe('returned');
    expect(classifyTransaction({ amount: -100, conceptoComun: '16' }).txKind).toBe('tax');
    expect(classifyTransaction({ amount: -100, conceptoComun: '17' }).txKind).toBe('fee');
    expect(classifyTransaction({ amount: 100, conceptoComun: '17' }).txKind).toBe('interest');
    expect(classifyTransaction({ amount: -100, conceptoComun: '99' }).txKind).toBe('other');
    expect(classifyTransaction({ amount: -100 }).txKind).toBe('other');
  });
  it('lets the text win over the concepto común', () => {
    expect(
      classifyTransaction({ amount: -100, conceptoComun: '04', conceptText: 'BIZUM A EXEMPLE' })
        .txKind,
    ).toBe('bizum');
  });
});

describe('classifyTransaction — flags', () => {
  it('flags person-looking beneficiaries on debits only', () => {
    const debit = classifyTransaction({
      amount: -900,
      conceptText: 'TRANSFERENCIA',
      counterpartyText: 'Josep Exemple Prova',
    });
    expect(debit.txKind).toBe('transfer_out');
    expect(debit.flags).toContain('person_beneficiary');
    const credit = classifyTransaction({
      amount: 900,
      conceptText: 'TRANSFERENCIA',
      counterpartyText: 'Josep Exemple Prova',
    });
    expect(credit.flags).not.toContain('person_beneficiary');
    const company = classifyTransaction({
      amount: -900,
      conceptText: 'TRANSFERENCIA',
      counterpartyText: 'Vendor A, S.L.',
    });
    expect(company.flags).not.toContain('person_beneficiary');
    const org = classifyTransaction({
      amount: -900,
      conceptText: 'TRANSFERENCIA',
      counterpartyText: 'Ascensors Exemple',
    });
    expect(org.flags).not.toContain('person_beneficiary');
  });
  it('flags foreign IBANs and round amounts', () => {
    const r = classifyTransaction({
      amount: -1500,
      conceptText: 'TRANSF VENDOR X',
      counterpartyIban: 'DE89 3704 0044 0532 0130 00',
    });
    expect(r.flags).toContain('foreign_iban');
    expect(r.flags).toContain('round_amount');
    const es = classifyTransaction({
      amount: -1500.5,
      conceptText: 'TRANSF VENDOR X',
      counterpartyIban: 'ES9121000418450200051332',
    });
    expect(es.flags).not.toContain('foreign_iban');
    expect(es.flags).not.toContain('round_amount');
  });
  it('round-amount helper', () => {
    expect(isRoundAmount(500)).toBe(true);
    expect(isRoundAmount(-2000)).toBe(true);
    expect(isRoundAmount(400)).toBe(false);
    expect(isRoundAmount(550)).toBe(false);
    expect(isRoundAmount(1000.01)).toBe(false);
  });
  it('flags reversals by concepto común 98', () => {
    expect(
      classifyTransaction({ amount: 100, conceptoComun: '98', conceptText: 'ANULACION' }).flags,
    ).toContain('reversal');
  });
  it('person-name heuristic', () => {
    expect(looksLikePersonName('Josep Exemple Prova')).toBe(true);
    expect(looksLikePersonName("Núria D'Exemple")).toBe(true);
    expect(looksLikePersonName('Vendor A SLU')).toBe(false);
    expect(looksLikePersonName('COMPANYIA ELECTRICA C')).toBe(false);
    expect(looksLikePersonName('EXEMPLE')).toBe(false);
    expect(looksLikePersonName('EXEMPLE 123')).toBe(false);
    expect(looksLikePersonName('')).toBe(false);
  });
});

describe('detectRecurringDirectDebits', () => {
  const dd = (amount: number, counterpartyText: string): ClassifiedTransaction => ({
    amount,
    counterpartyText,
    txKind: 'direct_debit',
    flags: [],
  });

  it('marks a series of three or more similar direct debits from the same counterparty', () => {
    const txs = [
      dd(-120.5, 'RECIBO COMPANYIA ELECTRICA C SA REF 0001'),
      dd(-131.2, 'RECIBO COMPANYIA ELECTRICA C SA REF 0002'),
      dd(-118.9, 'RECIBO COMPANYIA ELECTRICA C SA REF 0003'),
      dd(-400, 'RECIBO COMPANYIA ELECTRICA C SA REF 0004'), // outside ±30% of the median
      dd(-99, 'RECIBO ASSEGURANCES D SA'),
      dd(-99, 'RECIBO ASSEGURANCES D SA'),
      {
        amount: -120,
        counterpartyText: 'RECIBO COMPANYIA ELECTRICA C SA',
        txKind: 'transfer_out' as const,
        flags: ['x'],
      },
    ];
    const out = detectRecurringDirectDebits(txs);
    expect(out[0]!.flags).toContain('direct_debit_recurring');
    expect(out[1]!.flags).toContain('direct_debit_recurring');
    expect(out[2]!.flags).toContain('direct_debit_recurring');
    expect(out[3]!.flags).not.toContain('direct_debit_recurring');
    expect(out[4]!.flags).not.toContain('direct_debit_recurring');
    expect(out[6]!.flags).toEqual(['x']);
  });
  it('does not mutate the input and does not duplicate the flag', () => {
    const txs = [dd(-10, 'RECIBO X Y'), dd(-10, 'RECIBO X Y'), dd(-10, 'RECIBO X Y')];
    txs[0]!.flags.push('direct_debit_recurring');
    const out = detectRecurringDirectDebits(txs);
    expect(txs[1]!.flags).toEqual([]);
    expect(out[0]!.flags).toEqual(['direct_debit_recurring']);
    expect(out[1]!.flags).toEqual(['direct_debit_recurring']);
  });
  it('builds a counterparty key from alphabetic tokens only', () => {
    expect(counterpartyKey('RECIBO COMPANYIA ELECTRICA C SA REF 0001')).toBe(
      'COMPANYIA ELECTRICA C SA',
    );
    expect(counterpartyKey('')).toBe('');
  });
});
