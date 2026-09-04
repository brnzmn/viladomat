import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { collapse, type RuleContext, type RuleHit } from './engine.ts';
import {
  D11_loans,
  D1_residuals,
  D2_cashInstruments,
  D3_payees,
  D4_paymentTiming,
  D7_balanceContinuity,
  D8_subsidies,
  E1_authority,
  E2_worksSequence,
  E3_minutesIntegrity,
  independenceForSource,
  paymentBeforeContractKey,
  paymentBeforeResolutionKey,
} from './m3.ts';

type Rows = Array<Record<string, unknown>>;
interface Canned {
  match: string | RegExp;
  rows: Rows;
}

interface Call {
  text: string;
  params: unknown[];
}

/** Fake pg client: the first canned entry whose pattern appears in the SQL answers it. */
function fakeClient(canned: Canned[], calls: Call[] = []): pg.PoolClient {
  return {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const hit = canned.find((c) => (typeof c.match === 'string' ? text.includes(c.match) : c.match.test(text)));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    },
  } as unknown as pg.PoolClient;
}

const PARAMS: Record<string, number> = {
  outflow_min: 300,
  authority_threshold: 1000,
  pm_ordinary: 335,
  cash_limit: 1000,
};

function ctx(canned: Canned[], params: Record<string, number> = PARAMS, calls: Call[] = []): RuleContext {
  return {
    cid: 'c-1',
    client: fakeClient(canned, calls),
    today: '2026-09-04',
    param: async (key) => params[key] ?? null,
  };
}

function texts(hits: RuleHit[]): string {
  return hits.map((h) => `${h.summaryEs} ${h.summaryEn}`).join(' ');
}

describe('independence by provenance', () => {
  it('scores issuer-direct exports at 1.0 and photographs at 0.7', () => {
    expect(independenceForSource('norma43')).toBe(1);
    expect(independenceForSource('camt053')).toBe(1);
    expect(independenceForSource('csv')).toBe(1);
    expect(independenceForSource('pdf_native')).toBe(0.85);
    expect(independenceForSource('pdf_scan')).toBe(0.7);
    expect(independenceForSource('photo')).toBe(0.7);
    expect(independenceForSource(null)).toBe(0.7);
  });
});

describe('D1 three-way residuals', () => {
  const base: Canned[] = [
    { match: 'v_r1_invoices_without_payment', rows: [{ invoice_id: 'i-1', fecha_expedicion: '2024-03-10', total: '1210.00', works_package_id: null, vendor_party_id: 'v-1', document_id: 'd-1', numero: '118', serie: null }] },
    {
      match: 'v_r2_debits_without_invoice',
      rows: [
        { bank_transaction_id: 't-1', fecha_operacion: '2024-04-02', importe: '-900.00', tx_kind: 'transfer_out', flags: ['person_beneficiary'], person_beneficiary: true, concepto_text: 'TRANSF', counterparty_name_norm: null, bank_account_id: 'a-1', statement_id: 's-1', source: 'csv' },
        { bank_transaction_id: 't-2', fecha_operacion: '2024-04-03', importe: '-450.00', tx_kind: 'transfer_out', flags: [], person_beneficiary: false, concepto_text: 'TRANSF', counterparty_name_norm: null, bank_account_id: 'a-1', statement_id: 's-1', source: 'photo' },
      ],
    },
    { match: 'v_r3_liquidation_lines_unsupported', rows: [{ liquidation_line_id: 'l-1', ejercicio: 2024, concepto: 'Manteniment', proveedor_text: 'X', importe: '2000.00' }] },
    { match: 'bank_statements', rows: [{ bank_account_id: 'a-1', source: 'csv' }] },
  ];

  it('fires once per residual row with the catalogued severities', async () => {
    const hits = await D1_residuals(ctx(base));
    expect(hits.map((h) => `${h.computed.residual_set}:${h.severity}`)).toEqual(['R1:2', 'R2:4', 'R2:3', 'R3:3']);
  });

  it('says not yet matched, never unsupported spend, and dates the statement', async () => {
    const hits = await D1_residuals(ctx(base));
    const r2 = hits.find((h) => h.computed.residual_set === 'R2')!;
    expect(r2.summaryEn).toContain('not yet matched to an invoice in the corpus as of 2026-09-04');
    expect(texts(hits).toLowerCase()).not.toContain('unsupported');
  });

  it('takes independence from the source of the statement the movement came from', async () => {
    const hits = await D1_residuals(ctx(base));
    const [csvHit, photoHit] = hits.filter((h) => h.computed.residual_set === 'R2');
    expect(csvHit!.independence).toBe(1);
    expect(photoHit!.independence).toBe(0.7);
  });

  it('passes the outflow floor to the residual queries as a parameter', async () => {
    const calls: Call[] = [];
    await D1_residuals(ctx(base, { ...PARAMS, outflow_min: 5000 }, calls));
    const r1 = calls.find((c) => c.text.includes('v_r1_invoices_without_payment'))!;
    const r3 = calls.find((c) => c.text.includes('v_r3_liquidation_lines_unsupported'))!;
    expect(r1.params).toEqual(['c-1', 5000]);
    expect(r3.params).toEqual(['c-1', 5000]);
  });
});

describe('D2 cash and other instruments', () => {
  it('raises severity when a cash payment reaches the limit in force on that date', async () => {
    const hits = await D2_cashInstruments(
      ctx([
        { match: 'from public.bank_transactions t', rows: [
          { id: 't-1', fecha_operacion: '2024-02-01', importe: '-1200.00', tx_kind: 'cash', flags: [], concepto_text: 'REINTEGRO', bank_account_id: 'a-1', source: 'pdf_native' },
          { id: 't-2', fecha_operacion: '2024-02-02', importe: '-400.00', tx_kind: 'card', flags: [], concepto_text: 'COMPRA', bank_account_id: 'a-1', source: 'pdf_native' },
          { id: 't-3', fecha_operacion: '2024-02-03', importe: '-100.00', tx_kind: 'bizum', flags: [], concepto_text: 'BIZUM', bank_account_id: 'a-1', source: 'pdf_native' },
        ] },
        { match: 'public.norm_text(i.forma_pago)', rows: [] },
      ]),
    );
    expect(hits.map((h) => `${h.entityId}:${h.severity}`)).toEqual(['t-1:3', 't-2:2']);
    expect(hits[0]!.computed.cash_limit).toBe(1000);
    expect(hits[0]!.independence).toBe(0.85);
  });

  it('adds a yearly cash observation above 3.000 EUR and an invoice marked as paid in cash', async () => {
    const hits = await D2_cashInstruments(
      ctx([
        { match: 'from public.bank_transactions t', rows: [
          { id: 't-1', fecha_operacion: '2024-02-01', importe: '-1500.00', tx_kind: 'cash', flags: [], concepto_text: '', bank_account_id: 'a-1', source: 'csv' },
          { id: 't-2', fecha_operacion: '2024-03-01', importe: '-1600.00', tx_kind: 'cash', flags: [], concepto_text: '', bank_account_id: 'a-1', source: 'csv' },
        ] },
        { match: 'public.norm_text(i.forma_pago)', rows: [{ id: 'i-9', document_id: 'd-9', total: '1500.00', fecha_expedicion: '2024-05-05', forma_pago: 'Efectivo' }] },
      ]),
    );
    expect(hits.some((h) => h.eventKey === 'year:2024:cash_total')).toBe(true);
    expect(hits.some((h) => h.eventKey === 'invoice:i-9:cash')).toBe(true);
  });
});

describe('D3 payees', () => {
  it('flags a transfer to a natural person for a company vendor', async () => {
    const hits = await D3_payees(
      ctx([
        { match: "array['person_beneficiary']", rows: [
          { id: 't-1', fecha_operacion: '2024-05-05', importe: '-2000.00', concepto_text: 'TRANSF', flags: ['person_beneficiary'], counterparty_party_id: 'v-1', legal_form: 'S.L.', nif_kind: 'CIF', source: 'csv' },
          { id: 't-2', fecha_operacion: '2024-05-06', importe: '-800.00', concepto_text: 'TRANSF', flags: ['person_beneficiary'], counterparty_party_id: 'v-2', legal_form: 'autónomo', nif_kind: 'DNI', source: 'csv' },
        ] },
        { match: 'reference_match_keys', rows: [] },
        { match: "array['foreign_iban', 'neobank']", rows: [] },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entityId).toBe('t-1');
    expect(hits[0]!.severity).toBe(3);
  });

  it('fires at severity 4 on an account associated with the presidency role', async () => {
    const hits = await D3_payees(
      ctx([
        { match: "array['person_beneficiary']", rows: [] },
        { match: 'reference_match_keys', rows: [{ role: 'president', iban_hmacs: ['HMAC-PRES'] }] },
        { match: 'counterparty_iban_hmac = any', rows: [{ id: 't-9', fecha_operacion: '2024-06-01', importe: '-3500.00', concepto_text: 'TRANSF', source: 'norma43' }] },
        { match: "array['foreign_iban', 'neobank']", rows: [] },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe(4);
    expect(hits[0]!.summaryEn).toContain('account associated with the presidency role');
    expect(hits[0]!.independence).toBe(1);
  });
});

describe('D4 payment timing', () => {
  const row = {
    invoice_id: 'i-1',
    document_id: 'd-1',
    fecha_expedicion: '2024-03-10',
    total: '5000.00',
    forma_pago: 'Transferencia',
    works_package_id: 'w-1',
    tx_id: 't-1',
    fecha_operacion: '2024-03-01',
    importe: '-5000.00',
    concepto_text: 'TRANSF OBRA',
    source: 'csv',
    resolution_id: 'r-1',
    resolution_date: '2024-03-20',
    contract_id: 'c-1',
    contract_signed: '2024-04-01',
  };

  it('fires on payment before the invoice, the resolution and the contract', async () => {
    const hits = await D4_paymentTiming(ctx([{ match: "rl.link_type = 'paid_by'", rows: [row] }]));
    expect(hits.map((h) => h.severity)).toEqual([2, 3, 3]);
    expect(hits[1]!.eventKey).toBe(paymentBeforeResolutionKey('r-1', 't-1'));
    expect(hits[2]!.eventKey).toBe(paymentBeforeContractKey('c-1', 't-1'));
  });

  it('does not fire on a payment before the invoice when an advance is stated', async () => {
    const hits = await D4_paymentTiming(
      ctx([{ match: "rl.link_type = 'paid_by'", rows: [{ ...row, forma_pago: 'Anticipo 40%', resolution_date: null, resolution_id: null, contract_signed: null, contract_id: null }] }]),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('D7 balance continuity and control totals', () => {
  it('fires on an opening step, a closing that differs from the bank and funds held', async () => {
    const hits = await D7_balanceContinuity(
      ctx([
        { match: 'v_year_balance_continuity', rows: [{ fiscal_year: 2024, liquidation_id: 'l-1', saldo_inicial: '1000.00', prev_saldo_final: '800.00', opening_gap: '200.00', saldo_final: '5000.00', bank_saldo_at_close: '4500.00', saldo_en_poder_administrador: '300.00', pm_ordinary: '335' }] },
        { match: 'v_control_totals', rows: [] },
      ]),
    );
    expect(hits.map((h) => h.eventKey)).toEqual([
      'liquidation:l-1:opening',
      'liquidation:l-1:closing_vs_bank',
      'liquidation:l-1:funds_held',
    ]);
    expect(hits.every((h) => h.severity === 3)).toBe(true);
  });

  it('tests the control totals only after the cut-off bridge and against pm_ordinary', async () => {
    const canned = (diff: string): Canned[] => [
      { match: 'v_year_balance_continuity', rows: [] },
      { match: 'v_control_totals', rows: [{ fiscal_year: 2024, basis: 'cash', liq_expenses: '20000', bank_debits: '19000', invoices_total: '18000', opening_payables: '100', closing_payables: '200', retentions_held: '50', bridged_difference: diff, pm_ordinary: '335' }] },
    ];
    expect(await D7_balanceContinuity(ctx(canned('300.00')))).toHaveLength(0);
    const hits = await D7_balanceContinuity(ctx(canned('900.00')));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.eventKey).toBe('year:2024:control_totals');
    expect(hits[0]!.computed.pm_ordinary).toBe(335);
  });
});

describe('D8 subsidies and D11 loans', () => {
  it('fires when a granted subsidy is in neither the accounts nor the bank', async () => {
    const hits = await D8_subsidies(
      ctx([
        { match: 'from public.subsidies', rows: [{ id: 's-1', programa: 'Programa', expedient: 'X/2024', estat: 'paid', import_atorgat: '20000', import_pagat: '20000', paid_to_is_community: false, shown_in_liquidation_line_id: null, received_bank_tx_id: null, works_package_id: 'w-1', fund_links: '0', income_lines: '0' }] },
      ]),
    );
    expect(hits.map((h) => h.eventKey)).toEqual(['subsidy:s-1:pass_through', 'subsidy:s-1:destination']);
    expect(hits.every((h) => h.severity === 4)).toBe(true);
  });

  it('stays silent when the credit is linked', async () => {
    const hits = await D8_subsidies(
      ctx([
        { match: 'from public.subsidies', rows: [{ id: 's-2', programa: null, expedient: null, estat: 'paid', import_atorgat: '20000', import_pagat: '20000', paid_to_is_community: true, shown_in_liquidation_line_id: null, received_bank_tx_id: null, works_package_id: null, fund_links: '1', income_lines: '1' }] },
      ]),
    );
    expect(hits).toHaveLength(0);
  });

  it('fires on a loan with no disbursement located and on absent repayments', async () => {
    const hits = await D11_loans(
      ctx([
        { match: 'from public.loans', rows: [{ id: 'ln-1', principal: '30000', disbursed_on: '2024-02-01', disbursement_tx_id: null, paid_to_is_community: false, amortisation: [{ date: '2024-03-01', amount: 500 }], works_package_id: 'w-1', resolution_id: null, fund_links: '0' }] },
        { match: 'count(*)::text as n', rows: [{ n: '0' }] },
      ]),
    );
    expect(hits.map((h) => `${h.eventKey}:${h.severity}`)).toEqual(['loan:ln-1:disbursement:4', 'loan:ln-1:repayments:2']);
  });
});

describe('E1 authority', () => {
  it('reports spend without a resolution and delegated spend above the highest amount considered', async () => {
    const hits = await E1_authority(
      ctx([
        { match: 'v_r4_spend_without_resolution', rows: [{ invoice_id: 'i-1', fecha_expedicion: '2024-03-10', total: '4000.00', works_package_id: 'w-1', document_id: 'd-1' }] },
        { match: 'from public.works_packages w', rows: [{ works_package_id: 'w-1', code: 'ELEVATOR', label: 'Ascensor', highest_quote: '50000', tolerance_pct: '10', has_delegation: true, invoiced: '60000' }] },
      ]),
    );
    expect(hits.map((h) => `${h.ruleCode}:${h.severity}`)).toEqual(['E1:2', 'E1:3']);
    expect(hits[1]!.amountAtStake).toBe(5000);
  });
});

describe('E2 works sequence', () => {
  const events = [
    { works_package_id: 'w-1', code: 'ELEVATOR', event_type: 'acta_approval', event_date: '2024-03-20', ref_type: 'resolution', ref_id: 'r-1', amount: '50000', suspension_reason: null },
    { works_package_id: 'w-1', code: 'ELEVATOR', event_type: 'contract_signed', event_date: '2024-04-01', ref_type: 'contract', ref_id: 'c-1', amount: '48000', suspension_reason: null },
    { works_package_id: 'w-1', code: 'ELEVATOR', event_type: 'payment', event_date: '2024-03-25', ref_type: 'bank_transaction', ref_id: 't-1', amount: '10000', suspension_reason: null },
  ];

  it('uses the same event key as D4 for a payment before the contract', async () => {
    const hits = await E2_worksSequence(ctx([{ match: 'from public.works_events', rows: events }]));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.eventKey).toBe(paymentBeforeContractKey('c-1', 't-1'));
    expect(hits[0]!.severity).toBe(3);
  });

  it('collapses with the D4 hit on the same underlying event', async () => {
    const e2 = await E2_worksSequence(ctx([{ match: 'from public.works_events', rows: events }]));
    const d4 = await D4_paymentTiming(
      ctx([
        { match: "rl.link_type = 'paid_by'", rows: [{
          invoice_id: 'i-1', document_id: 'd-1', fecha_expedicion: '2024-03-20', total: '10000.00', forma_pago: 'Transferencia',
          works_package_id: 'w-1', tx_id: 't-1', fecha_operacion: '2024-03-25', importe: '-10000.00', concepto_text: 'TRANSF',
          source: 'csv', resolution_id: null, resolution_date: null, contract_id: 'c-1', contract_signed: '2024-04-01',
        }] },
      ]),
    );
    const collapsed = collapse([...d4, ...e2]);
    expect(d4.some((h) => h.eventKey === paymentBeforeContractKey('c-1', 't-1'))).toBe(true);
    expect(collapsed.filter((h) => h.eventKey === paymentBeforeContractKey('c-1', 't-1'))).toHaveLength(1);
  });
});

describe('E3 minutes integrity', () => {
  it('checks attendee quotas, unit labels and the accounts item of an ordinary meeting', async () => {
    const hits = await E3_minutesIntegrity(
      ctx([
        { match: 'from public.units', rows: [{ label: 'Pral 1a' }, { label: '1r 2a' }] },
        { match: 'from public.meetings m', rows: [{
          id: 'm-1', tipo: 'ordinaria', fecha: '2024-03-20',
          attendees: [
            { unit_label: 'Pral 1a', quota_pct: 60 },
            { unit_label: '1r 2a', quota_pct: 41 },
            { unit_label: 'Àtic', quota_pct: 0 },
          ],
          cuentas_aprobadas: false, document_id: 'd-1', accounts_items: '0',
        }] },
      ]),
    );
    expect(hits.map((h) => h.eventKey)).toEqual([
      'meeting:m-1:quotas',
      'meeting:m-1:unit_labels',
      'meeting:m-1:accounts_item',
    ]);
    expect(hits[1]!.computed.unknown_unit_labels).toEqual(['Àtic']);
  });

  it('stays silent on a consistent ordinary meeting', async () => {
    const hits = await E3_minutesIntegrity(
      ctx([
        { match: 'from public.units', rows: [{ label: 'Pral 1a' }] },
        { match: 'from public.meetings m', rows: [{ id: 'm-2', tipo: 'ordinaria', fecha: '2024-03-20', attendees: [{ unit_label: 'PRAL 1A', quota_pct: 60 }], cuentas_aprobadas: true, document_id: null, accounts_items: '1' }] },
      ]),
    );
    expect(hits).toHaveLength(0);
  });
});
