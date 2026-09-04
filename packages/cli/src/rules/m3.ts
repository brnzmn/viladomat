/**
 * M3 rules: the tests that become possible once bank movements, invoices and the
 * reconciliation links exist.
 *
 * D1 three-way residuals, D2 cash/cheque/card/instant payments, D3 payees, D4 payment
 * timing, D7 balance continuity and control totals, D8 subsidy pass-through, D11 loan
 * flows, E1 spending authority, E2 works sequence, E3 minutes integrity.
 *
 * Every hit is a discrepancy to verify: it carries its innocent explanations, the document
 * that would resolve it and the next check. People appear by role, never by name.
 * Independence is scored by provenance: a bank export obtained from the issuer is 1.0, a
 * bank PDF that passed through the administrator 0.85, a photograph of a printout 0.7; an
 * invoice leg is 0.7 and the liquidación — the assertion of the party under review — is
 * never an independent leg.
 */
import { fmtEur, fp, money, type Rule, type RuleHit } from './engine.ts';
import { sequenceEvents, type WorksEventDraft, type WorksEventType } from '../recon/works-events.ts';

/** Provenance of a bank leg, by how the statement reached the corpus. */
export function independenceForSource(source: string | null | undefined): number {
  switch (source) {
    case 'norma43':
    case 'camt053':
    case 'csv':
      return 1;
    case 'pdf_native':
      return 0.85;
    case 'pdf_scan':
    case 'photo':
    case 'seed':
      return 0.7;
    default:
      return 0.7;
  }
}

/** An invoice is a single document supplied through the administrator. */
const INVOICE_INDEPENDENCE = 0.7;
/** The liquidación is the assertion of the party under review; it is never independent. */
const LIQUIDATION_INDEPENDENCE = 0.7;
const EXTRACTED_QUALITY = 0.9;
const RECORD_QUALITY = 1;

/** Event key shared by every rule that fires on a payment made before a contract signature. */
export function paymentBeforeContractKey(contractId: string, txId: string): string {
  return `contract:${contractId}:payment_before_signature:${txId}`;
}

/** Event key shared by every rule that fires on a payment made before the approving meeting. */
export function paymentBeforeResolutionKey(resolutionId: string, txId: string): string {
  return `resolution:${resolutionId}:payment_before_approval:${txId}`;
}

function iso(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10);
}

function maybeIso(v: unknown): string | null {
  return v == null ? null : iso(v);
}

/** Independence of every bank account of the community, from the source of its statements. */
async function bankIndependence(cid: string, client: Parameters<Rule>[0]['client']): Promise<Map<string, number>> {
  const res = await client.query<{ bank_account_id: string; source: string }>(
    `select bank_account_id, source::text as source from public.bank_statements where community_id = $1`,
    [cid],
  );
  const map = new Map<string, number>();
  for (const r of res.rows) {
    const value = independenceForSource(r.source);
    const prev = map.get(r.bank_account_id);
    // the weakest provenance of the account's statements governs
    map.set(r.bank_account_id, prev == null ? value : Math.min(prev, value));
  }
  return map;
}

// ---------------------------------------------------------------------------
// D1 — three-way residuals (R1, R2, R3)
// ---------------------------------------------------------------------------

export const D1_residuals: Rule = async ({ cid, client, today, param }) => {
  const hits: RuleHit[] = [];
  const outflowMin = (await param('outflow_min')) ?? 300;
  const accounts = await bankIndependence(cid, client);

  const r1 = await client.query(
    `select r.invoice_id, r.fecha_expedicion, r.total, r.works_package_id, r.vendor_party_id,
            i.document_id, i.numero, i.serie
       from public.v_r1_invoices_without_payment r
       join public.invoices i on i.id = r.invoice_id
      where r.community_id = $1 and r.total > $2
      order by r.fecha_expedicion, r.invoice_id`,
    [cid, outflowMin],
  );
  for (const r of r1.rows as Array<Record<string, unknown>>) {
    const total = money(r.total);
    const date = iso(r.fecha_expedicion);
    hits.push({
      ruleCode: 'D1',
      severity: 2,
      eventKey: `invoice:${String(r.invoice_id)}:unmatched`,
      fingerprint: fp('D1', 'R1', String(r.invoice_id)),
      entityType: 'invoice',
      entityId: String(r.invoice_id),
      worksPackageId: (r.works_package_id as string | null) ?? null,
      amountAtStake: total,
      actDateFirst: date,
      computed: { residual_set: 'R1', total, fecha_expedicion: date, numero: r.numero, serie: r.serie },
      summaryEs: `Factura de ${fmtEur(total)} de ${date} no conciliada con ningún cargo bancario localizado a ${today}. Verificar.`,
      summaryEn: `Invoice of ${fmtEur(total)} dated ${date} not reconciled with any bank debit located as of ${today}. Verify.`,
      innocentExplanations: [
        'The invoice may have been paid from another account or in a later period.',
        'Statement months may be missing from the corpus (R7).',
        'The payment may be a partial or netted settlement recorded differently in the bank.',
      ],
      nextCheck: 'Ask the administrator for the proof of payment of this invoice and for the statements of the months around its due date.',
      resolvingDocument: 'Justificante de pago; extracto bancario del período',
      independence: INVOICE_INDEPENDENCE,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'invoice', documentId: (r.document_id as string | null) ?? null, computed: { invoice_id: r.invoice_id, total } }],
    });
  }

  const r2 = await client.query(
    `select r.bank_transaction_id, r.fecha_operacion, r.importe, r.tx_kind::text as tx_kind, r.flags,
            r.person_beneficiary, t.concepto_text, t.counterparty_name_norm, t.bank_account_id, t.statement_id,
            s.source::text as source
       from public.v_r2_debits_without_invoice r
       join public.bank_transactions t on t.id = r.bank_transaction_id
       left join public.bank_statements s on s.id = t.statement_id
      where r.community_id = $1 and not (t.flags @> array['direct_debit_recurring'])
      order by r.fecha_operacion, r.bank_transaction_id`,
    [cid],
  );
  for (const r of r2.rows as Array<Record<string, unknown>>) {
    const amount = Math.abs(money(r.importe));
    const date = iso(r.fecha_operacion);
    const person = r.person_beneficiary === true;
    const independence = r.source != null ? independenceForSource(String(r.source)) : (accounts.get(String(r.bank_account_id)) ?? 0.7);
    hits.push({
      ruleCode: 'D1',
      severity: person ? 4 : 3,
      eventKey: `tx:${String(r.bank_transaction_id)}:unmatched`,
      fingerprint: fp('D1', 'R2', String(r.bank_transaction_id)),
      entityType: 'bank_transaction',
      entityId: String(r.bank_transaction_id),
      amountAtStake: amount,
      actDateFirst: date,
      computed: {
        residual_set: 'R2',
        importe: amount,
        fecha_operacion: date,
        tx_kind: r.tx_kind,
        flags: r.flags,
        person_beneficiary: person,
        statement_source: r.source ?? null,
      },
      summaryEs: `Cargo de ${fmtEur(amount)} el ${date}${person ? ' a favor de una persona física' : ''}: no conciliado con ninguna factura del corpus a ${today}. Verificar.`,
      summaryEn: `Debit of ${fmtEur(amount)} on ${date}${person ? ' to a natural person' : ''}: not yet matched to an invoice in the corpus as of ${today}. Verify.`,
      innocentExplanations: [
        'The invoice may exist but not yet have been delivered to the review (document requests are open).',
        'Recurring charges whose invoices are never filed are pre-classified and excluded; this one is not classified as recurring.',
        'The debit may correspond to a partial payment, a retention release or a transfer between the community\'s own accounts.',
      ],
      nextCheck: 'Request the invoice or receipt for this movement and the identity of the beneficiary as shown on the transfer receipt.',
      resolvingDocument: 'Factura o recibo del movimiento; justificante de transferencia con beneficiario',
      independence,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'bank movement', bankTransactionId: String(r.bank_transaction_id), computed: { importe: amount, fecha: date, concepto: r.concepto_text } }],
    });
  }

  const r3 = await client.query(
    `select liquidation_line_id, ejercicio, concepto, proveedor_text, importe
       from public.v_r3_liquidation_lines_unsupported
      where community_id = $1 and importe > $2
      order by ejercicio, liquidation_line_id`,
    [cid, outflowMin],
  );
  for (const r of r3.rows as Array<Record<string, unknown>>) {
    const importe = money(r.importe);
    hits.push({
      ruleCode: 'D1',
      severity: 3,
      eventKey: `liquidation_line:${String(r.liquidation_line_id)}:unsupported`,
      fingerprint: fp('D1', 'R3', String(r.liquidation_line_id)),
      entityType: 'liquidation_line',
      entityId: String(r.liquidation_line_id),
      fiscalYear: Number(r.ejercicio),
      amountAtStake: importe,
      computed: { residual_set: 'R3', importe, concepto: r.concepto, proveedor_text: r.proveedor_text },
      summaryEs: `Partida de gasto "${String(r.concepto)}" de ${fmtEur(importe)} en la liquidación de ${String(r.ejercicio)}: sin factura ni cargo bancario conciliados a ${today}. Verificar.`,
      summaryEn: `Expense line "${String(r.concepto)}" of ${fmtEur(importe)} in the ${String(r.ejercicio)} accounts: no invoice and no bank debit matched as of ${today}. Verify.`,
      innocentExplanations: [
        'The line may aggregate several invoices or a whole chapter.',
        'The supporting invoices may be held by the administrator and not yet delivered.',
        'The accounts may be kept on an accrual basis, so the payment falls in another year.',
      ],
      nextCheck: 'Ask for the detail behind this line: invoices, dates and the account it was paid from.',
      resolvingDocument: 'Detalle de la partida; facturas correspondientes',
      independence: LIQUIDATION_INDEPENDENCE,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'liquidation line', computed: { liquidation_line_id: r.liquidation_line_id, importe } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D2 — cash, cheque, card and instant payments
// ---------------------------------------------------------------------------

const CASH_KINDS = new Set(['cash', 'cheque', 'card', 'bizum']);

const INSTRUMENT_ES: Record<string, string> = { cash: 'efectivo', cheque: 'cheque', card: 'tarjeta', bizum: 'pago inmediato' };
const INSTRUMENT_EN: Record<string, string> = { cash: 'cash', cheque: 'cheque', card: 'card', bizum: 'instant payment' };

export const D2_cashInstruments: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const outflowMin = (await param('outflow_min')) ?? 300;
  const res = await client.query(
    `select t.id, t.fecha_operacion, t.importe, t.tx_kind::text as tx_kind, t.flags, t.concepto_text,
            t.bank_account_id, s.source::text as source
       from public.bank_transactions t
       left join public.bank_statements s on s.id = t.statement_id
      where t.community_id = $1 and t.importe < 0
        and (t.tx_kind::text in ('cash', 'cheque', 'card', 'bizum') or t.flags && array['cash', 'cheque', 'card', 'bizum'])
      order by t.fecha_operacion, t.id`,
    [cid],
  );
  const yearlyCash = new Map<number, number>();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const amount = Math.abs(money(r.importe));
    const date = iso(r.fecha_operacion);
    const flags = (r.flags as string[] | null) ?? [];
    const kind = CASH_KINDS.has(String(r.tx_kind)) ? String(r.tx_kind) : (flags.find((f) => CASH_KINDS.has(f)) ?? 'cash');
    const limit = (await param('cash_limit', date)) ?? (date >= '2021-07-11' ? 1000 : 2500);
    if (kind === 'cash') yearlyCash.set(Number(date.slice(0, 4)), (yearlyCash.get(Number(date.slice(0, 4))) ?? 0) + amount);
    if (amount <= outflowMin) continue;
    const atLimit = kind === 'cash' && amount >= limit;
    hits.push({
      ruleCode: 'D2',
      severity: atLimit ? 3 : 2,
      eventKey: `tx:${String(r.id)}:instrument`,
      fingerprint: fp('D2', String(r.id)),
      entityType: 'bank_transaction',
      entityId: String(r.id),
      amountAtStake: amount,
      actDateFirst: date,
      computed: { instrument: kind, importe: amount, cash_limit: limit, limit_applies_from: date >= '2021-07-11' ? '2021-07-11' : 'before 2021-07-11', outflow_min: outflowMin },
      summaryEs: atLimit
        ? `Pago en ${INSTRUMENT_ES[kind] ?? kind} de ${fmtEur(amount)} el ${date}, igual o superior al límite legal en efectivo vigente en esa fecha (${fmtEur(limit)}, límite a verificar en el texto archivado). Verificar la naturaleza de la operación y de las partes.`
        : `Pago en ${INSTRUMENT_ES[kind] ?? kind} de ${fmtEur(amount)} el ${date}, por encima del umbral de observación (${fmtEur(outflowMin)}). Verificar el soporte documental.`,
      summaryEn: atLimit
        ? `${INSTRUMENT_EN[kind] ?? kind} payment of ${fmtEur(amount)} on ${date}, at or above the cash limit in force on that date (${fmtEur(limit)}; the limit is to be verified against the archived text). Verify the nature of the operation and of the parties.`
        : `${INSTRUMENT_EN[kind] ?? kind} payment of ${fmtEur(amount)} on ${date}, above the observation threshold (${fmtEur(outflowMin)}). Verify the supporting document.`,
      innocentExplanations: [
        'Small repairs are sometimes paid in cash and reimbursed against receipts.',
        'The statutory limit applies to an operation, not to each payment, and only when one party acts as a business.',
        'The instrument may be misclassified in the statement text.',
      ],
      nextCheck: 'Request the receipt and the identity of the card or account holder by role, and the vendor\'s confirmation of the amount received.',
      resolvingDocument: 'Recibo del pago; confirmación del proveedor',
      independence: r.source != null ? independenceForSource(String(r.source)) : 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'bank movement', bankTransactionId: String(r.id), computed: { importe: amount, fecha: date, instrument: kind } }],
    });
  }
  for (const [year, total] of yearlyCash) {
    if (total <= 3000) continue;
    hits.push({
      ruleCode: 'D2',
      severity: 3,
      eventKey: `year:${year}:cash_total`,
      fingerprint: fp('D2', 'year', String(year)),
      entityType: 'community',
      entityId: cid,
      fiscalYear: year,
      amountAtStake: Math.round(total * 100) / 100,
      computed: { year, cash_total: Math.round(total * 100) / 100, threshold: 3000 },
      summaryEs: `Pagos en efectivo identificados en ${year}: ${fmtEur(total)}, por encima de ${fmtEur(3000)} anuales. Verificar el conjunto de operaciones y sus justificantes.`,
      summaryEn: `Cash payments identified in ${year}: ${fmtEur(total)}, above ${fmtEur(3000)} for the year. Verify the set of operations and their receipts.`,
      innocentExplanations: ['Petty cash reimbursed to an office-holder against receipts may appear as several cash movements.'],
      nextCheck: 'Request the petty-cash record and the receipts for the year.',
      resolvingDocument: 'Registro de caja y recibos del ejercicio',
      independence: 0.85,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'cash movements of the year', computed: { year, total: Math.round(total * 100) / 100 } }],
    });
  }

  const invoiceRes = await client.query(
    `select i.id, i.document_id, i.total, i.fecha_expedicion, i.forma_pago
       from public.invoices i join public.documents d on d.id = i.document_id
      where i.community_id = $1 and d.duplicate_of_document_id is null and i.total is not null
        and public.norm_text(i.forma_pago) ~ '(efectivo|metalico|metal.lic|cash)'`,
    [cid],
  );
  for (const r of invoiceRes.rows as Array<Record<string, unknown>>) {
    const total = money(r.total);
    const date = iso(r.fecha_expedicion);
    const limit = (await param('cash_limit', date)) ?? (date >= '2021-07-11' ? 1000 : 2500);
    if (total < limit) continue;
    hits.push({
      ruleCode: 'D2',
      severity: 3,
      eventKey: `invoice:${String(r.id)}:cash`,
      fingerprint: fp('D2', 'invoice', String(r.id)),
      entityType: 'invoice',
      entityId: String(r.id),
      amountAtStake: total,
      actDateFirst: date,
      computed: { total, forma_pago: r.forma_pago, cash_limit: limit },
      summaryEs: `Factura de ${fmtEur(total)} (${date}) con forma de pago en efectivo, igual o superior al límite legal vigente en esa fecha (${fmtEur(limit)}, a verificar). Verificar.`,
      summaryEn: `Invoice of ${fmtEur(total)} (${date}) stating cash payment, at or above the limit in force on that date (${fmtEur(limit)}, to be verified). Verify.`,
      innocentExplanations: ['The stated payment method may be a template default and not the method actually used.'],
      nextCheck: 'Request the proof of payment for this invoice.',
      resolvingDocument: 'Justificante de pago de la factura',
      independence: INVOICE_INDEPENDENCE,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'invoice', documentId: (r.document_id as string | null) ?? null, computed: { invoice_id: r.id, total } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D3 — payees
// ---------------------------------------------------------------------------

export const D3_payees: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const outflowMin = (await param('outflow_min')) ?? 300;

  const personRes = await client.query(
    `select t.id, t.fecha_operacion, t.importe, t.concepto_text, t.flags, t.counterparty_party_id,
            p.legal_form, p.nif_kind, s.source::text as source
       from public.bank_transactions t
       left join public.parties p on p.id = t.counterparty_party_id
       left join public.bank_statements s on s.id = t.statement_id
      where t.community_id = $1 and t.importe < 0 and t.flags @> array['person_beneficiary']
        and -t.importe > $2
      order by t.fecha_operacion, t.id`,
    [cid, outflowMin],
  );
  for (const r of personRes.rows as Array<Record<string, unknown>>) {
    const legalForm = r.legal_form == null ? '' : String(r.legal_form).toLowerCase();
    const isCompany = String(r.nif_kind ?? '') === 'CIF' || /s\.?l|s\.?a|sociedad|societat|slu|sau|scp/.test(legalForm);
    if (!isCompany) continue;
    const amount = Math.abs(money(r.importe));
    const date = iso(r.fecha_operacion);
    hits.push({
      ruleCode: 'D3',
      severity: 3,
      eventKey: `tx:${String(r.id)}:payee`,
      fingerprint: fp('D3', 'person', String(r.id)),
      entityType: 'bank_transaction',
      entityId: String(r.id),
      amountAtStake: amount,
      actDateFirst: date,
      computed: { importe: amount, fecha: date, legal_form: r.legal_form, nif_kind: r.nif_kind },
      summaryEs: `Transferencia de ${fmtEur(amount)} el ${date} a una persona física, mientras la facturación correspondiente figura a nombre de una sociedad. Verificar.`,
      summaryEn: `Transfer of ${fmtEur(amount)} on ${date} to a natural person while the corresponding invoicing is in the name of a company. Verify.`,
      innocentExplanations: [
        'A sole trader may operate under a trade name.',
        'A company\'s sole administrator may collect under a valid endorsement or assignment.',
        'The payment may reimburse expenses advanced by an office-holder against receipts (suplidos).',
      ],
      nextCheck: 'Request the endorsement or assignment document and the transfer receipt showing the beneficiary.',
      resolvingDocument: 'Endoso o cesión de crédito; justificante de transferencia con beneficiario',
      independence: r.source != null ? independenceForSource(String(r.source)) : 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'bank movement', bankTransactionId: String(r.id), computed: { importe: amount, fecha: date } }],
    });
  }

  const keys = await client.query<{ role: string; iban_hmacs: string[] }>(
    `select role::text as role, iban_hmacs from public.reference_match_keys($1)`,
    [cid],
  );
  const presidencyIbans = new Set<string>();
  for (const k of keys.rows) {
    if (k.role !== 'president') continue;
    for (const h of k.iban_hmacs ?? []) presidencyIbans.add(h);
  }
  if (presidencyIbans.size > 0) {
    const res = await client.query(
      `select t.id, t.fecha_operacion, t.importe, t.concepto_text, s.source::text as source
         from public.bank_transactions t
         left join public.bank_statements s on s.id = t.statement_id
        where t.community_id = $1 and t.importe < 0 and t.counterparty_iban_hmac = any($2::text[])
        order by t.fecha_operacion, t.id`,
      [cid, [...presidencyIbans]],
    );
    for (const r of res.rows as Array<Record<string, unknown>>) {
      const amount = Math.abs(money(r.importe));
      const date = iso(r.fecha_operacion);
      hits.push({
        ruleCode: 'D3',
        severity: 4,
        eventKey: `tx:${String(r.id)}:payee`,
        fingerprint: fp('D3', 'presidency', String(r.id)),
        entityType: 'bank_transaction',
        entityId: String(r.id),
        amountAtStake: amount,
        actDateFirst: date,
        computed: { importe: amount, fecha: date, match: 'iban_hmac equality with a presidency-role account' },
        summaryEs: `Pago de ${fmtEur(amount)} el ${date} a una cuenta asociada al rol de presidencia, más allá de honorarios o reembolsos documentados. Verificar.`,
        summaryEn: `Payment of ${fmtEur(amount)} on ${date} to an account associated with the presidency role beyond documented fees or reimbursements — verify.`,
        innocentExplanations: [
          'Reimbursement of expenses advanced by the office-holder, evidenced by receipts (suplidos).',
          'A reimbursement approved in a meeting whose minutes are not yet in the corpus.',
        ],
        nextCheck: 'Request the receipts and the resolution approving any reimbursement or fee to the office-holder.',
        resolvingDocument: 'Recibos de gastos anticipados; acuerdo de junta',
        independence: r.source != null ? independenceForSource(String(r.source)) : 0.7,
        extractionQuality: RECORD_QUALITY,
        evidence: [{ label: 'bank movement', bankTransactionId: String(r.id), computed: { importe: amount, fecha: date } }],
      });
    }
  }

  const foreign = await client.query(
    `select t.id, t.fecha_operacion, t.importe, t.flags, s.source::text as source
       from public.bank_transactions t
       left join public.bank_statements s on s.id = t.statement_id
      where t.community_id = $1 and t.importe < 0 and -t.importe > $2
        and t.flags && array['foreign_iban', 'neobank']
      order by t.fecha_operacion, t.id`,
    [cid, outflowMin],
  );
  for (const r of foreign.rows as Array<Record<string, unknown>>) {
    const amount = Math.abs(money(r.importe));
    const date = iso(r.fecha_operacion);
    hits.push({
      ruleCode: 'D3',
      severity: 2,
      eventKey: `tx:${String(r.id)}:payee_account`,
      fingerprint: fp('D3', 'foreign', String(r.id)),
      entityType: 'bank_transaction',
      entityId: String(r.id),
      amountAtStake: amount,
      actDateFirst: date,
      computed: { importe: amount, fecha: date, flags: r.flags },
      summaryEs: `Pago de ${fmtEur(amount)} el ${date} a una cuenta extranjera o de banco digital. Verificar la titularidad de la cuenta.`,
      summaryEn: `Payment of ${fmtEur(amount)} on ${date} to a foreign or neobank account. Verify the account holder.`,
      innocentExplanations: ['A local vendor may bank with an EU neobank; factoring companies often use accounts in another member state.'],
      nextCheck: 'Ask the vendor, through the administrator, to confirm the account holder.',
      resolvingDocument: 'Certificado de titularidad de la cuenta del proveedor',
      independence: r.source != null ? independenceForSource(String(r.source)) : 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'bank movement', bankTransactionId: String(r.id), computed: { importe: amount, fecha: date } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D4 — payment timing
// ---------------------------------------------------------------------------

export const D4_paymentTiming: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select i.id as invoice_id, i.document_id, i.fecha_expedicion, i.total, i.forma_pago, i.works_package_id,
            t.id as tx_id, t.fecha_operacion, t.importe, t.concepto_text,
            s.source::text as source,
            (select r.id from public.recon_links rl2
               join public.resolutions r on rl2.to_type = 'resolution' and rl2.to_id = r.id
              where rl2.from_type = 'invoice' and rl2.from_id = i.id and rl2.link_type = 'authorised_by'
              order by rl2.score desc limit 1) as resolution_id,
            (select m.fecha from public.recon_links rl3
               join public.resolutions r2 on rl3.to_type = 'resolution' and rl3.to_id = r2.id
               join public.meetings m on m.id = r2.meeting_id
              where rl3.from_type = 'invoice' and rl3.from_id = i.id and rl3.link_type = 'authorised_by'
              order by rl3.score desc limit 1) as resolution_date,
            (select c.id from public.recon_links rl4
               join public.contracts c on rl4.to_type = 'contract' and rl4.to_id = c.id
              where rl4.from_type = 'invoice' and rl4.from_id = i.id and rl4.link_type = 'under_contract'
              order by rl4.score desc limit 1) as contract_id,
            (select c2.fecha_firma from public.recon_links rl5
               join public.contracts c2 on rl5.to_type = 'contract' and rl5.to_id = c2.id
              where rl5.from_type = 'invoice' and rl5.from_id = i.id and rl5.link_type = 'under_contract'
              order by rl5.score desc limit 1) as contract_signed
       from public.recon_links rl
       join public.invoices i on rl.from_type = 'invoice' and rl.from_id = i.id
       join public.bank_transactions t on rl.to_type = 'bank_transaction' and rl.to_id = t.id
       left join public.bank_statements s on s.id = t.statement_id
      where rl.community_id = $1 and rl.link_type = 'paid_by' and rl.status = 'accepted'
      order by t.fecha_operacion, t.id`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const paymentDate = iso(r.fecha_operacion);
    const invoiceDate = iso(r.fecha_expedicion);
    const amount = Math.abs(money(r.importe));
    const independence = r.source != null ? independenceForSource(String(r.source)) : 0.7;
    const txId = String(r.tx_id);
    const invoiceId = String(r.invoice_id);
    const advanceMentioned = /anticip|a cuenta|bestret|provisi/i.test(`${String(r.forma_pago ?? '')} ${String(r.concepto_text ?? '')}`);

    if (paymentDate < invoiceDate && !advanceMentioned) {
      hits.push({
        ruleCode: 'D4',
        severity: 2,
        eventKey: `payment:${txId}:before_invoice:${invoiceId}`,
        fingerprint: fp('D4', 'before_invoice', invoiceId, txId),
        entityType: 'bank_transaction',
        entityId: txId,
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: amount,
        actDateFirst: paymentDate,
        actDateLast: invoiceDate,
        computed: { payment_date: paymentDate, invoice_date: invoiceDate, advance_mentioned: advanceMentioned },
        summaryEs: `Pago de ${fmtEur(amount)} el ${paymentDate}, anterior a la fecha de la factura conciliada (${invoiceDate}), sin mención de anticipo. Verificar.`,
        summaryEn: `Payment of ${fmtEur(amount)} on ${paymentDate}, earlier than the date of the matched invoice (${invoiceDate}), with no advance stated. Verify.`,
        innocentExplanations: [
          'The administrator may have paid from a pro-forma and the vendor invoiced later.',
          'Advances on order are customary for made-to-order equipment.',
        ],
        nextCheck: 'Ask for the advance invoice or pro-forma and the final invoice that replaced it.',
        resolvingDocument: 'Factura de anticipo o proforma; factura final',
        independence,
        extractionQuality: RECORD_QUALITY,
        evidence: [
          { label: 'bank movement', bankTransactionId: txId, computed: { fecha: paymentDate, importe: amount } },
          { label: 'invoice', documentId: (r.document_id as string | null) ?? null, computed: { invoice_id: invoiceId, fecha: invoiceDate } },
        ],
      });
    }

    const resolutionDate = maybeIso(r.resolution_date);
    if (resolutionDate && r.resolution_id != null && paymentDate < resolutionDate) {
      hits.push({
        ruleCode: 'D4',
        severity: 3,
        eventKey: paymentBeforeResolutionKey(String(r.resolution_id), txId),
        fingerprint: fp('D4', 'before_resolution', String(r.resolution_id), txId),
        entityType: 'bank_transaction',
        entityId: txId,
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: amount,
        actDateFirst: paymentDate,
        actDateLast: resolutionDate,
        computed: { payment_date: paymentDate, resolution_date: resolutionDate },
        summaryEs: `Pago de ${fmtEur(amount)} el ${paymentDate}, anterior al acuerdo de junta que lo autorizaría (${resolutionDate}). Verificar.`,
        summaryEn: `Payment of ${fmtEur(amount)} on ${paymentDate}, earlier than the resolution that would authorise it (${resolutionDate}). Verify.`,
        innocentExplanations: [
          'The approval may have been recorded in a later meeting ratifying the spend.',
          'Urgent repairs may be paid first and approved afterwards under the applicable procedure.',
        ],
        nextCheck: 'Check the minutes for an earlier approval or a delegation covering this spend.',
        resolvingDocument: 'Acta con el acuerdo o la delegación',
        independence,
        extractionQuality: RECORD_QUALITY,
        evidence: [
          { label: 'bank movement', bankTransactionId: txId, computed: { fecha: paymentDate, importe: amount } },
          { label: 'resolution', resolutionId: String(r.resolution_id), computed: { fecha: resolutionDate } },
        ],
      });
    }

    const contractSigned = maybeIso(r.contract_signed);
    if (contractSigned && r.contract_id != null && paymentDate < contractSigned) {
      hits.push({
        ruleCode: 'D4',
        severity: 3,
        eventKey: paymentBeforeContractKey(String(r.contract_id), txId),
        fingerprint: fp('D4', 'before_contract', String(r.contract_id), txId),
        entityType: 'bank_transaction',
        entityId: txId,
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: amount,
        actDateFirst: paymentDate,
        actDateLast: contractSigned,
        computed: { payment_date: paymentDate, contract_signed: contractSigned },
        summaryEs: `Pago de ${fmtEur(amount)} el ${paymentDate}, anterior a la firma del contrato conciliado (${contractSigned}). Verificar.`,
        summaryEn: `Payment of ${fmtEur(amount)} on ${paymentDate}, earlier than the signature of the matched contract (${contractSigned}). Verify.`,
        innocentExplanations: [
          'The contract copy may be signed later than the works were agreed.',
          'A payment schedule agreed by e-mail may precede the signed document.',
        ],
        nextCheck: 'Check the contract\'s payment schedule and the date the works were commissioned.',
        resolvingDocument: 'Contrato con calendario de pagos',
        independence,
        extractionQuality: RECORD_QUALITY,
        evidence: [
          { label: 'bank movement', bankTransactionId: txId, computed: { fecha: paymentDate, importe: amount } },
          { label: 'contract', computed: { contract_id: r.contract_id, fecha_firma: contractSigned } },
        ],
      });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D7 — balance continuity, control totals and custody of funds
// ---------------------------------------------------------------------------

export const D7_balanceContinuity: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const cont = await client.query(
    `select fiscal_year, liquidation_id, saldo_inicial, prev_saldo_final, opening_gap, saldo_final,
            bank_saldo_at_close, saldo_en_poder_administrador, pm_ordinary
       from public.v_year_balance_continuity where community_id = $1 order by fiscal_year`,
    [cid],
  );
  for (const r of cont.rows as Array<Record<string, unknown>>) {
    const year = Number(r.fiscal_year);
    const liquidationId = String(r.liquidation_id);
    const gap = r.opening_gap == null ? null : money(r.opening_gap);
    if (gap != null && Math.abs(gap) > 0.01) {
      hits.push({
        ruleCode: 'D7',
        severity: 3,
        eventKey: `liquidation:${liquidationId}:opening`,
        fingerprint: fp('D7', liquidationId, 'opening'),
        entityType: 'liquidation',
        entityId: liquidationId,
        fiscalYear: year,
        amountAtStake: Math.abs(gap),
        computed: { saldo_inicial: money(r.saldo_inicial), prev_saldo_final: money(r.prev_saldo_final), opening_gap: gap },
        summaryEs: `Saldo inicial del ejercicio ${year} (${fmtEur(money(r.saldo_inicial))}) distinto del saldo final del ejercicio anterior (${fmtEur(money(r.prev_saldo_final))}); diferencia ${fmtEur(gap)}. Verificar.`,
        summaryEn: `Opening balance of ${year} (${fmtEur(money(r.saldo_inicial))}) differs from the prior year's closing balance (${fmtEur(money(r.prev_saldo_final))}); difference ${fmtEur(gap)}. Verify.`,
        innocentExplanations: [
          'A change of accounting basis (cash vs accrual) or a reclassification between accounts may explain the step.',
          'An adjustment approved with the accounts may have been recorded only in the following year.',
        ],
        nextCheck: 'Ask for the reconciliation between the closing balance of one year and the opening balance of the next.',
        resolvingDocument: 'Conciliación de saldos entre ejercicios',
        independence: LIQUIDATION_INDEPENDENCE,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'liquidations', computed: { liquidation_id: liquidationId, fiscal_year: year } }],
      });
    }
    const closing = r.saldo_final == null ? null : money(r.saldo_final);
    const bankClose = r.bank_saldo_at_close == null ? null : money(r.bank_saldo_at_close);
    if (closing != null && bankClose != null && Math.abs(closing - bankClose) > 0.01) {
      const diff = Math.round((closing - bankClose) * 100) / 100;
      hits.push({
        ruleCode: 'D7',
        severity: 3,
        eventKey: `liquidation:${liquidationId}:closing_vs_bank`,
        fingerprint: fp('D7', liquidationId, 'closing_vs_bank'),
        entityType: 'liquidation',
        entityId: liquidationId,
        fiscalYear: year,
        amountAtStake: Math.abs(diff),
        computed: { saldo_final: closing, bank_saldo_at_close: bankClose, difference: diff },
        summaryEs: `Saldo de cierre declarado en la liquidación de ${year} (${fmtEur(closing)}) distinto del saldo bancario a la misma fecha (${fmtEur(bankClose)}); diferencia ${fmtEur(diff)}. Verificar.`,
        summaryEn: `Closing cash reported in the ${year} accounts (${fmtEur(closing)}) differs from the bank balance at the same date (${fmtEur(bankClose)}); difference ${fmtEur(diff)}. Verify.`,
        innocentExplanations: [
          'Payments in transit at the cut-off date.',
          'Funds held in an account whose statements are not yet in the corpus.',
        ],
        nextCheck: 'Request the statements of every account at the closing date and the bank certificate of holder and signatories.',
        resolvingDocument: 'Extractos a fecha de cierre; certificado bancario de titularidad',
        independence: 0.85,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'liquidation vs statements', computed: { liquidation_id: liquidationId, saldo_final: closing, bank_saldo_at_close: bankClose } }],
      });
    }
    const held = r.saldo_en_poder_administrador == null ? 0 : money(r.saldo_en_poder_administrador);
    if (held > 0) {
      // Same event key and fingerprint as the M0 hit: one finding, whichever module runs.
      hits.push({
        ruleCode: 'D7',
        severity: 3,
        eventKey: `liquidation:${liquidationId}:funds_held`,
        fingerprint: fp('D7', liquidationId, 'held'),
        entityType: 'liquidation',
        entityId: liquidationId,
        fiscalYear: year,
        amountAtStake: held,
        computed: { held },
        summaryEs: `La liquidación de ${year} declara ${fmtEur(held)} en poder de la administración, fuera de una cuenta titularidad de la comunidad. Verificar.`,
        summaryEn: `The ${year} accounts report ${fmtEur(held)} held by the administration outside an account titled to the community. Verify.`,
        innocentExplanations: ['A client sub-ledger reconciled monthly; the amount may be the timing of transfers.'],
        nextCheck: 'Request the bank certificate of account holder and signatories and the sub-ledger statement.',
        resolvingDocument: 'Certificado bancario de titularidad; extracto de la cuenta de clientes',
        independence: LIQUIDATION_INDEPENDENCE,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'liquidation', computed: { liquidation_id: liquidationId } }],
      });
    }
  }

  const totals = await client.query(
    `select fiscal_year, basis, liq_expenses, bank_debits, invoices_total, opening_payables, closing_payables,
            retentions_held, bridged_difference, pm_ordinary
       from public.v_control_totals where community_id = $1 order by fiscal_year`,
    [cid],
  );
  for (const r of totals.rows as Array<Record<string, unknown>>) {
    if (r.bridged_difference == null) continue;
    const year = Number(r.fiscal_year);
    const diff = money(r.bridged_difference);
    const pmOrdinary = r.pm_ordinary != null ? money(r.pm_ordinary) : ((await param('pm_ordinary', `${year}-12-31`)) ?? 0);
    if (pmOrdinary <= 0 || Math.abs(diff) <= pmOrdinary) continue;
    hits.push({
      ruleCode: 'D7',
      severity: 3,
      eventKey: `year:${year}:control_totals`,
      fingerprint: fp('D7', 'control_totals', String(year)),
      entityType: 'community',
      entityId: cid,
      fiscalYear: year,
      amountAtStake: Math.abs(diff),
      computed: {
        basis: r.basis,
        liq_expenses: money(r.liq_expenses),
        bank_debits: money(r.bank_debits),
        invoices_total: money(r.invoices_total),
        opening_payables: r.opening_payables == null ? null : money(r.opening_payables),
        closing_payables: r.closing_payables == null ? null : money(r.closing_payables),
        retentions_held: r.retentions_held == null ? null : money(r.retentions_held),
        bridged_difference: diff,
        pm_ordinary: pmOrdinary,
      },
      summaryEs: `Ejercicio ${year}: tras el puente de cierre (acreedores de apertura y cierre, retenciones), los gastos de la liquidación y los cargos bancarios difieren en ${fmtEur(diff)}, por encima de la materialidad ordinaria (${fmtEur(pmOrdinary)}). Verificar.`,
      summaryEn: `Fiscal year ${year}: after the cut-off bridge (opening and closing payables, retentions), the liquidación expenses and the bank debits differ by ${fmtEur(diff)}, above ordinary materiality (${fmtEur(pmOrdinary)}). Verify.`,
      innocentExplanations: [
        'Statement months may be missing from the corpus (R7).',
        'Cut-off items other than payables and retentions (prepayments, transit accounts) are not in the bridge.',
        'Payments made from an account not yet in the corpus.',
      ],
      nextCheck: 'Ask for the list of debtors and creditors at closing and a statement of the accounting basis used.',
      resolvingDocument: 'Relación de deudores y acreedores al cierre; nota sobre el criterio contable',
      independence: 0.85,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'control totals', computed: { fiscal_year: year, bridged_difference: diff } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D8 — subsidy pass-through
// ---------------------------------------------------------------------------

export const D8_subsidies: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select s.id, s.programa, s.expedient, s.estat::text as estat, s.import_atorgat, s.import_pagat,
            s.paid_to_is_community, s.shown_in_liquidation_line_id, s.received_bank_tx_id, s.works_package_id,
            (select count(*) from public.recon_links rl
              where rl.from_type = 'bank_transaction' and rl.to_type = 'subsidy' and rl.to_id = s.id and rl.link_type = 'funds') as fund_links,
            (select count(*) from public.liquidation_lines ll
              where ll.community_id = s.community_id and ll.side = 'ingreso'
                and abs(ll.importe - coalesce(s.import_pagat, s.import_atorgat, 0)) <= greatest(1, coalesce(s.import_pagat, s.import_atorgat, 0) * 0.01)) as income_lines
       from public.subsidies s
      where s.community_id = $1 and s.estat::text in ('granted', 'paid')
      order by s.id`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const amount = money(r.import_pagat ?? r.import_atorgat);
    const inLiquidation = r.shown_in_liquidation_line_id != null || Number(r.income_lines ?? 0) > 0;
    const inBank = r.received_bank_tx_id != null || Number(r.fund_links ?? 0) > 0;
    if (!inLiquidation && !inBank) {
      hits.push({
        ruleCode: 'D8',
        severity: 4,
        eventKey: `subsidy:${String(r.id)}:pass_through`,
        fingerprint: fp('D8', String(r.id), 'not_in_accounts'),
        entityType: 'subsidy',
        entityId: String(r.id),
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: amount,
        computed: { estat: r.estat, programa: r.programa, expedient: r.expedient, amount, in_liquidation: inLiquidation, in_bank: inBank },
        summaryEs: `Subvención en estado "${String(r.estat)}" por ${fmtEur(amount)} sin ingreso correspondiente en la liquidación ni abono bancario localizado a ${today}. Verificar.`,
        summaryEn: `Subsidy in state "${String(r.estat)}" for ${fmtEur(amount)} with no corresponding income line in the accounts and no bank credit located as of ${today}. Verify.`,
        innocentExplanations: [
          'The grant may be paid only after the final certificate and its justification.',
          'The credit may fall in a fiscal year whose statements are not in the corpus.',
        ],
        nextCheck: 'Check the granting resolution and the payment date in the subsidy file, and search the statements for the credit.',
        resolvingDocument: 'Resolución de concesión y de pago; extracto con el abono',
        independence: 0.85,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'subsidy', computed: { subsidy_id: r.id, estat: r.estat, amount } }],
      });
    }
    if (r.paid_to_is_community === false) {
      hits.push({
        ruleCode: 'D8',
        severity: 4,
        eventKey: `subsidy:${String(r.id)}:destination`,
        fingerprint: fp('D8', String(r.id), 'destination'),
        entityType: 'subsidy',
        entityId: String(r.id),
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: amount,
        computed: { paid_to_is_community: false, amount },
        summaryEs: `Subvención de ${fmtEur(amount)} abonada a una cuenta que no consta a nombre de la comunidad. Verificar la titularidad de la cuenta de destino.`,
        summaryEn: `Subsidy of ${fmtEur(amount)} paid to an account not recorded as the community's. Verify the holder of the destination account.`,
        innocentExplanations: ['The programme may pay the contractor directly under the call\'s rules, with the community as beneficiary.'],
        nextCheck: 'Check the payment order in the subsidy file and the account holder certificate.',
        resolvingDocument: 'Orden de pago del expediente; certificado de titularidad',
        independence: 0.85,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'subsidy', computed: { subsidy_id: r.id, amount } }],
      });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// D11 — loan flows
// ---------------------------------------------------------------------------

export const D11_loans: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select l.id, l.principal, l.disbursed_on, l.disbursement_tx_id, l.paid_to_is_community, l.amortisation,
            l.works_package_id, l.resolution_id,
            (select count(*) from public.recon_links rl
              where rl.from_type = 'bank_transaction' and rl.to_type = 'loan' and rl.to_id = l.id and rl.link_type = 'funds') as fund_links
       from public.loans l where l.community_id = $1 order by l.id`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const principal = money(r.principal);
    const credited = r.disbursement_tx_id != null || Number(r.fund_links ?? 0) > 0;
    if (!credited || r.paid_to_is_community === false) {
      hits.push({
        ruleCode: 'D11',
        severity: 4,
        eventKey: `loan:${String(r.id)}:disbursement`,
        fingerprint: fp('D11', String(r.id), 'disbursement'),
        entityType: 'loan',
        entityId: String(r.id),
        worksPackageId: (r.works_package_id as string | null) ?? null,
        amountAtStake: principal,
        actDateFirst: maybeIso(r.disbursed_on),
        computed: { principal, credited, paid_to_is_community: r.paid_to_is_community },
        summaryEs: `Préstamo de ${fmtEur(principal)} sin abono localizado en una cuenta de la comunidad a ${today}. Verificar el destino de la disposición.`,
        summaryEn: `Loan of ${fmtEur(principal)} with no disbursement located in a community account as of ${today}. Verify where the disbursement was credited.`,
        innocentExplanations: [
          'A financed-works product may pay the contractor directly, as documented in the loan contract.',
          'The disbursement may fall in a period whose statements are not in the corpus.',
        ],
        nextCheck: 'Check the loan contract and the disbursement order, and search the statements for the credit.',
        resolvingDocument: 'Contrato de préstamo; orden de disposición',
        independence: 0.85,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'loan', computed: { loan_id: r.id, principal } }],
      });
    }
    const schedule = Array.isArray(r.amortisation) ? (r.amortisation as Array<Record<string, unknown>>) : [];
    if (schedule.length > 0) {
      const paidRes = await client.query<{ n: string }>(
        `select count(*)::text as n from public.bank_transactions t
          where t.community_id = $1 and t.importe < 0 and t.tx_kind::text = 'loan'`,
        [cid],
      );
      if (Number(paidRes.rows[0]?.n ?? 0) === 0) {
        hits.push({
          ruleCode: 'D11',
          severity: 2,
          eventKey: `loan:${String(r.id)}:repayments`,
          fingerprint: fp('D11', String(r.id), 'repayments'),
          entityType: 'loan',
          entityId: String(r.id),
          worksPackageId: (r.works_package_id as string | null) ?? null,
          amountAtStake: principal,
          computed: { scheduled_instalments: schedule.length, repayments_located: 0 },
          summaryEs: `Cuadro de amortización con ${schedule.length} vencimiento(s) sin cargos de amortización localizados en los extractos a ${today}. Verificar.`,
          summaryEn: `Amortisation table with ${schedule.length} instalment(s) and no repayment debits located in the statements as of ${today}. Verify.`,
          innocentExplanations: [
            'Repayments may be charged to an account whose statements are not in the corpus.',
            'The instalments may be classified under another concept in the statement text.',
          ],
          nextCheck: 'Request the loan account statements and the amortisation table issued by the lender.',
          resolvingDocument: 'Extractos de la cuenta del préstamo; cuadro de amortización',
          independence: 0.85,
          extractionQuality: EXTRACTED_QUALITY,
          evidence: [{ label: 'loan', computed: { loan_id: r.id, instalments: schedule.length } }],
        });
      }
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// E1 — spending authority
// ---------------------------------------------------------------------------

export const E1_authority: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const threshold = (await param('authority_threshold')) ?? 1000;
  const r4 = await client.query(
    `select r.invoice_id, r.fecha_expedicion, r.total, r.works_package_id, i.document_id
       from public.v_r4_spend_without_resolution r
       join public.invoices i on i.id = r.invoice_id
      where r.community_id = $1 order by r.fecha_expedicion, r.invoice_id`,
    [cid],
  );
  for (const r of r4.rows as Array<Record<string, unknown>>) {
    const total = money(r.total);
    const date = iso(r.fecha_expedicion);
    hits.push({
      ruleCode: 'E1',
      severity: 2,
      eventKey: `invoice:${String(r.invoice_id)}:authority`,
      fingerprint: fp('E1', 'R4', String(r.invoice_id)),
      entityType: 'invoice',
      entityId: String(r.invoice_id),
      worksPackageId: (r.works_package_id as string | null) ?? null,
      amountAtStake: total,
      actDateFirst: date,
      computed: { residual_set: 'R4', total, authority_threshold: threshold },
      summaryEs: `Gasto de ${fmtEur(total)} (${date}) por encima del umbral de autorización considerado (${fmtEur(threshold)}) sin acuerdo de junta ni contrato autorizado conciliados. Verificar.`,
      summaryEn: `Spend of ${fmtEur(total)} (${date}) above the authority threshold used (${fmtEur(threshold)}) with no matched resolution or authorised contract. Verify.`,
      innocentExplanations: [
        'Items covered by the approved ordinary budget need no separate resolution.',
        'The approval may appear in minutes not yet in the corpus, or in a delegation with an implicit cap.',
        'The community has no written rule on the threshold; the value used is stated in the methodology.',
      ],
      nextCheck: 'Check the minutes for an approval or delegation covering this spend and the budget line it falls under.',
      resolvingDocument: 'Acta con el acuerdo o la delegación; presupuesto aprobado',
      independence: INVOICE_INDEPENDENCE,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'invoice', documentId: (r.document_id as string | null) ?? null, computed: { invoice_id: r.invoice_id, total } }],
    });
  }

  const delegated = await client.query(
    `select w.id as works_package_id, w.code::text as code, w.label,
            max(r.importe_aprobado) as highest_quote,
            max(coalesce(r.tolerance_pct, 0)) as tolerance_pct,
            bool_or(r.kind::text = 'delegation') as has_delegation,
            coalesce(sum(distinct_invoices.total), 0) as invoiced
       from public.works_packages w
       join public.resolutions r on r.works_package_id = w.id and r.resultado = 'aprobado'
         and r.kind::text in ('delegation', 'contractor_choice', 'works_approval')
       left join lateral (
         select sum(i.total) as total from public.invoices i
           join public.documents d on d.id = i.document_id
          where i.works_package_id = w.id and d.duplicate_of_document_id is null
       ) distinct_invoices on true
      where w.community_id = $1
      group by w.id, w.code, w.label
      having max(r.importe_aprobado) is not null`,
    [cid],
  );
  for (const r of delegated.rows as Array<Record<string, unknown>>) {
    if (r.has_delegation !== true) continue;
    const cap = money(r.highest_quote) * (1 + money(r.tolerance_pct) / 100);
    const invoiced = money(r.invoiced);
    if (cap <= 0 || invoiced <= cap) continue;
    hits.push({
      ruleCode: 'E1',
      severity: 3,
      eventKey: `works_package:${String(r.works_package_id)}:delegated_cap`,
      fingerprint: fp('E1', 'delegation', String(r.works_package_id)),
      entityType: 'works_package',
      entityId: String(r.works_package_id),
      worksPackageId: String(r.works_package_id),
      amountAtStake: Math.round((invoiced - cap) * 100) / 100,
      computed: { highest_amount_considered: money(r.highest_quote), tolerance_pct: money(r.tolerance_pct), cap, invoiced },
      summaryEs: `Paquete de obra ${String(r.code)}: facturación acumulada ${fmtEur(invoiced)} frente al importe más alto considerado en los acuerdos de delegación (${fmtEur(cap)} con tolerancia). Verificar.`,
      summaryEn: `Works package ${String(r.code)}: invoiced ${fmtEur(invoiced)} against the highest amount considered in the delegating resolutions (${fmtEur(cap)} including tolerance). Verify.`,
      innocentExplanations: [
        'A delegation without an explicit cap is a ceiling on the choice, not on the price.',
        'Extras genuinely arising from hidden conditions may have been approved later.',
      ],
      nextCheck: 'Read the delegation wording and check for a later resolution approving the higher amount.',
      resolvingDocument: 'Acta de la delegación; acuerdo posterior de aprobación',
      independence: 0.7,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'works package', computed: { works_package_id: r.works_package_id, cap, invoiced } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// E2 — works sequence
// ---------------------------------------------------------------------------

export const E2_worksSequence: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select e.works_package_id, w.code::text as code, e.event_type::text as event_type, e.event_date,
            e.ref_type, e.ref_id, e.amount, e.suspension_reason::text as suspension_reason
       from public.works_events e join public.works_packages w on w.id = e.works_package_id
      where e.community_id = $1
      order by e.works_package_id, e.event_date, e.event_type`,
    [cid],
  );
  const byPackage = new Map<string, { code: string; drafts: WorksEventDraft[] }>();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const key = String(r.works_package_id);
    const entry = byPackage.get(key) ?? { code: String(r.code), drafts: [] };
    entry.drafts.push({
      eventType: String(r.event_type) as WorksEventType,
      eventDate: maybeIso(r.event_date),
      refType: r.ref_type == null ? null : String(r.ref_type),
      refId: r.ref_id == null ? null : String(r.ref_id),
      amount: r.amount == null ? null : money(r.amount),
      suspensionReason: r.suspension_reason == null ? null : String(r.suspension_reason),
    });
    byPackage.set(key, entry);
  }
  for (const [packageId, entry] of byPackage) {
    for (const e of sequenceEvents(entry.drafts)) {
      if (e.seqOk !== false) continue;
      for (const v of e.violations) {
        const severity = e.eventType === 'payment' || v.predecessorType === 'permit_granted' ? 3 : 2;
        const eventKey =
          e.eventType === 'payment' && v.predecessorType === 'contract_signed' && v.predecessorRefId && e.refId
            ? paymentBeforeContractKey(v.predecessorRefId, e.refId)
            : e.eventType === 'payment' && v.predecessorType === 'acta_approval' && v.predecessorRefId && e.refId
              ? paymentBeforeResolutionKey(v.predecessorRefId, e.refId)
              : `works_package:${packageId}:${e.eventType}:${v.predecessorType}:${e.refId ?? e.eventDate ?? ''}`;
        hits.push({
          ruleCode: 'E2',
          severity,
          eventKey,
          fingerprint: fp('E2', packageId, e.eventType, v.predecessorType, e.refId ?? '', e.eventDate ?? ''),
          entityType: 'works_package',
          entityId: packageId,
          worksPackageId: packageId,
          amountAtStake: e.amount,
          actDateFirst: e.eventDate,
          actDateLast: v.predecessorDate,
          computed: {
            works_package: entry.code,
            event_type: e.eventType,
            event_date: e.eventDate,
            precedes: v.predecessorType,
            predecessor_date: v.predecessorDate,
            days: v.days,
            ref_type: e.refType,
            ref_id: e.refId,
          },
          summaryEs: `Paquete de obra ${entry.code}: el hito "${e.eventType}" del ${e.eventDate} es anterior en ${v.days} día(s) a "${v.predecessorType}" del ${v.predecessorDate}, frente al orden esperado. Verificar las fechas.`,
          summaryEn: `Works package ${entry.code}: the "${e.eventType}" milestone of ${e.eventDate} precedes "${v.predecessorType}" of ${v.predecessorDate} by ${v.days} day(s), against the expected order. Verify the dates.`,
          innocentExplanations: [
            'Quotes are commonly gathered before the meeting that approves the works (a 15-day tolerance is already applied).',
            'Permits are often filed by the contractor in the week works start.',
            'Dates may have been transcribed from photographs of printouts.',
          ],
          nextCheck: 'Check the permit file, the contractor\'s dated start notice and the signed copies of the documents concerned.',
          resolvingDocument: 'Expediente de licencia; comunicación de inicio; documentos firmados',
          independence: 0.7,
          extractionQuality: EXTRACTED_QUALITY,
          evidence: [
            { label: `works event ${e.eventType}`, computed: { ref_type: e.refType, ref_id: e.refId, event_date: e.eventDate } },
            { label: `expected predecessor ${v.predecessorType}`, computed: { ref_id: v.predecessorRefId, date: v.predecessorDate } },
          ],
        });
      }
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// E3 — minutes integrity
// ---------------------------------------------------------------------------

interface AttendeeRow {
  unit_label?: unknown;
  quota_pct?: unknown;
  present?: unknown;
  represented?: unknown;
}

export const E3_minutesIntegrity: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const unitsRes = await client.query<{ label: string }>('select label from public.units where community_id = $1', [cid]);
  const unitLabels = new Set(unitsRes.rows.map((u) => normaliseLabel(u.label)));

  const meetings = await client.query(
    `select m.id, m.tipo::text as tipo, m.fecha, m.attendees, m.cuentas_aprobadas, m.document_id,
            (select count(*) from public.resolutions r where r.meeting_id = m.id and r.kind::text = 'accounts') as accounts_items
       from public.meetings m where m.community_id = $1 order by m.fecha`,
    [cid],
  );
  for (const m of meetings.rows as Array<Record<string, unknown>>) {
    const fecha = iso(m.fecha);
    const attendees = Array.isArray(m.attendees) ? (m.attendees as AttendeeRow[]) : [];
    if (attendees.length > 0 && unitLabels.size > 0) {
      let quotaSum = 0;
      const unknownLabels: string[] = [];
      for (const a of attendees) {
        const q = a.quota_pct == null ? 0 : Number(a.quota_pct);
        if (Number.isFinite(q)) quotaSum += q;
        const label = a.unit_label == null ? '' : String(a.unit_label);
        if (label && !unitLabels.has(normaliseLabel(label))) unknownLabels.push(label);
      }
      quotaSum = Math.round(quotaSum * 10000) / 10000;
      if (quotaSum > 100.05) {
        hits.push({
          ruleCode: 'E3',
          severity: 2,
          eventKey: `meeting:${String(m.id)}:quotas`,
          fingerprint: fp('E3', String(m.id), 'quota_sum'),
          entityType: 'meeting',
          entityId: String(m.id),
          actDateFirst: fecha,
          computed: { quota_sum: quotaSum, attendees: attendees.length },
          summaryEs: `Junta del ${fecha}: la suma de las cuotas de los asistentes registrados asciende a ${quotaSum}%, por encima del 100% del cuadro de entidades. Verificar.`,
          summaryEn: `Meeting of ${fecha}: the recorded attendees' quotas add up to ${quotaSum}%, above the 100% of the unit table. Verify.`,
          innocentExplanations: ['Quotas are frequently rounded in the minutes; proxies may be counted twice in the transcription.'],
          nextCheck: 'Compare the attendance list with the unit table and the proxies presented.',
          resolvingDocument: 'Lista de asistentes y delegaciones de voto; cuadro de coeficientes',
          independence: 0.7,
          extractionQuality: EXTRACTED_QUALITY,
          evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { quota_sum: quotaSum } }],
        });
      }
      if (unknownLabels.length > 0) {
        hits.push({
          ruleCode: 'E3',
          severity: 2,
          eventKey: `meeting:${String(m.id)}:unit_labels`,
          fingerprint: fp('E3', String(m.id), 'unit_labels'),
          entityType: 'meeting',
          entityId: String(m.id),
          actDateFirst: fecha,
          computed: { unknown_unit_labels: unknownLabels },
          summaryEs: `Junta del ${fecha}: ${unknownLabels.length} entidad(es) de la lista de asistentes no figuran en el cuadro de entidades (${unknownLabels.join(', ')}). Verificar.`,
          summaryEn: `Meeting of ${fecha}: ${unknownLabels.length} unit label(s) in the attendance list are not in the unit table (${unknownLabels.join(', ')}). Verify.`,
          innocentExplanations: ['Unit labels are written differently in the minutes and in the Cadastre extract (floor/door notation).'],
          nextCheck: 'Reconcile the unit labels used in the minutes with the constitutive title.',
          resolvingDocument: 'Título constitutivo; cuadro de coeficientes',
          independence: 0.7,
          extractionQuality: EXTRACTED_QUALITY,
          evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { unknown_unit_labels: unknownLabels } }],
        });
      }
    }
    if (String(m.tipo) === 'ordinaria' && Number(m.accounts_items ?? 0) === 0 && m.cuentas_aprobadas !== true) {
      hits.push({
        ruleCode: 'E3',
        severity: 2,
        eventKey: `meeting:${String(m.id)}:accounts_item`,
        fingerprint: fp('E3', String(m.id), 'accounts_item'),
        entityType: 'meeting',
        entityId: String(m.id),
        actDateFirst: fecha,
        computed: { tipo: m.tipo, accounts_items: Number(m.accounts_items ?? 0), cuentas_aprobadas: m.cuentas_aprobadas },
        summaryEs: `Junta ordinaria del ${fecha} sin punto de aprobación de cuentas registrado. Verificar.`,
        summaryEn: `Ordinary meeting of ${fecha} with no accounts approval item recorded. Verify.`,
        innocentExplanations: ['The accounts item may be recorded in the minutes without a separate resolution row, or in an adjourned session.'],
        nextCheck: 'Read the convocation and the minutes of the meeting for the accounts item.',
        resolvingDocument: 'Convocatoria y acta de la junta',
        independence: 0.7,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { meeting_id: m.id } }],
      });
    }
  }
  return hits;
};

function normaliseLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export const M3_RULES: Record<string, Rule> = {
  D1: D1_residuals,
  D2: D2_cashInstruments,
  D3: D3_payees,
  D4: D4_paymentTiming,
  D7: D7_balanceContinuity,
  D8: D8_subsidies,
  D11: D11_loans,
  E1: E1_authority,
  E2: E2_worksSequence,
  E3: E3_minutesIntegrity,
};
