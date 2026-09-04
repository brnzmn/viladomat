/**
 * The matcher: proposes reconciliation links between invoices, bank movements,
 * liquidación lines, resolutions and contracts, keeps the derrama ledger on a bank basis
 * and materialises the works timeline.
 *
 * Every link it writes is a *proposal to verify*. Only an identity match (the debit's
 * counterparty IBAN is one of the vendor's known IBANs) is accepted without a reviewer;
 * a decision already recorded by a human — `accepted` or `rejected` — is never overwritten.
 */
import type pg from 'pg';
import { loadResidualCounts, type ResidualCounts } from './control-totals.ts';
import { emptyCounts, upsertLink, type LinkCounts, type LinkInput, type LinkType } from './links.ts';
import {
  assignPayments,
  ledgerStatus,
  milestoneStatus,
  nameSimilarity,
  periodForCredit,
  recurringDirectDebitIds,
  round2,
  withinPct,
  LIQUIDATION_NAME_THRESHOLD,
  LIQUIDATION_TOLERANCE,
  type DebitLeg,
  type InvoiceLeg,
} from './scoring.ts';
import { materialiseWorksEvents, type WorksEventsResult } from './works-events.ts';
import { RECON_ENGINE_VERSION } from './version.ts';

/** Counterparty texts that identify a municipal tax or permit payment (ICIO / taxa). */
const MUNICIPAL_PAYEE_RE = '(ajuntament|ayuntamiento|institut municipal d.?hisenda|hisenda municipal|icio)';

export interface MatchOptions {
  /** Date the pass is run on (ISO); recorded with the result. Defaults to today. */
  today?: string;
}

export interface DerramaResult {
  attributedCredits: number;
  unattributedCredits: number;
  ledgerRowsPaid: number;
  ledgerRowsMissing: number;
}

export interface MatchResult {
  linkCounts: Map<string, LinkCounts>;
  residuals: ResidualCounts;
  derrama: DerramaResult;
  milestonesUpdated: number;
  recurringPromoted: number;
  municipalFlagged: number;
  worksEvents: WorksEventsResult;
  engineVersion: string;
  runOn: string;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

interface InvoiceRow extends InvoiceLeg {
  worksPackageId: string | null;
  fiscalYear: number | null;
}

interface CreditRow {
  id: string;
  amount: number;
  date: string;
  unitId: string | null;
  derramaId: string | null;
  concepto: string | null;
  txKind: string;
  counterpartyIbanHmac: string | null;
}

/** Run the whole matching pass for one community inside the caller's transaction. */
export async function runMatch(client: pg.PoolClient, cid: string, opts: MatchOptions = {}): Promise<MatchResult> {
  const runOn = opts.today ?? new Date().toISOString().slice(0, 10);
  const counts = new Map<string, LinkCounts>();
  const record = async (link: LinkInput): Promise<void> => {
    const outcome = await upsertLink(client, cid, RECON_ENGINE_VERSION, link);
    const c = counts.get(link.linkType) ?? emptyCounts();
    if (outcome === 'inserted') c.inserted++;
    else if (outcome === 'updated') c.updated++;
    else c.keptDecision++;
    counts.set(link.linkType, c);
  };

  const recurringPromoted = await classifyRecurringDirectDebits(client, cid);
  const municipalFlagged = await flagMunicipalPayments(client, cid);

  const invoices = await loadInvoices(client, cid);
  const debits = await loadDebits(client, cid);
  const ibansByVendor = await loadVendorIbans(client, cid);

  await matchInvoicesToDebits(invoices, debits, ibansByVendor, record);
  await matchInvoicesToLiquidationLines(client, cid, invoices, record);
  await matchInvoicesToResolutions(client, cid, invoices, record);
  const milestonesUpdated = await matchInvoicesToContracts(client, cid, invoices, record);
  const derrama = await reconcileDerramaLedger(client, cid, record);
  await matchExternalFunding(client, cid, record);
  await matchRefunds(client, cid, ibansByVendor, record);

  const worksEvents = await materialiseWorksEvents(client, cid);
  const residuals = await loadResidualCounts(client, cid);

  return {
    linkCounts: counts,
    residuals,
    derrama,
    milestonesUpdated,
    recurringPromoted,
    municipalFlagged,
    worksEvents,
    engineVersion: RECON_ENGINE_VERSION,
    runOn,
  };
}

// ---------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------

async function loadInvoices(client: pg.PoolClient, cid: string): Promise<InvoiceRow[]> {
  const res = await client.query(
    `select i.id, i.total, i.retencion_irpf_importe, i.retencion_irpf_pct, i.fecha_expedicion, i.serie, i.numero,
            i.vendor_party_id, i.works_package_id,
            coalesce(p.legal_name_norm, p.display_name) as vendor_name,
            public.fiscal_year(i.fecha_expedicion, c.fy_start_month) as fiscal_year
       from public.invoices i
       join public.documents d on d.id = i.document_id
       join public.communities c on c.id = i.community_id
       left join public.parties p on p.id = i.vendor_party_id
      where i.community_id = $1 and d.duplicate_of_document_id is null
        and i.total is not null and i.fecha_expedicion is not null
      order by i.fecha_expedicion, i.id`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    total: num(r.total),
    retentionAmount: maybeNum(r.retencion_irpf_importe),
    retentionPct: maybeNum(r.retencion_irpf_pct),
    date: iso(r.fecha_expedicion),
    serie: r.serie == null ? null : String(r.serie),
    numero: r.numero == null ? null : String(r.numero),
    vendorPartyId: r.vendor_party_id == null ? null : String(r.vendor_party_id),
    vendorName: r.vendor_name == null ? null : String(r.vendor_name),
    worksPackageId: r.works_package_id == null ? null : String(r.works_package_id),
    fiscalYear: r.fiscal_year == null ? null : Number(r.fiscal_year),
  }));
}

async function loadDebits(client: pg.PoolClient, cid: string): Promise<DebitLeg[]> {
  const res = await client.query(
    `select id, importe, fecha_operacion, counterparty_iban_hmac, counterparty_name_norm, concepto_text
       from public.bank_transactions
      where community_id = $1 and importe < 0 and tx_kind <> 'internal'
      order by fecha_operacion, id`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    amount: round2(Math.abs(num(r.importe))),
    date: iso(r.fecha_operacion),
    counterpartyIbanHmac: r.counterparty_iban_hmac == null ? null : String(r.counterparty_iban_hmac),
    counterpartyName: r.counterparty_name_norm == null ? null : String(r.counterparty_name_norm),
    conceptoText: r.concepto_text == null ? null : String(r.concepto_text),
  }));
}

async function loadVendorIbans(client: pg.PoolClient, cid: string): Promise<Map<string, Set<string>>> {
  const res = await client.query<{ party_id: string; iban_hmac: string }>(
    `select party_id, iban_hmac from public.party_ibans where community_id = $1`,
    [cid],
  );
  const map = new Map<string, Set<string>>();
  for (const r of res.rows) {
    const set = map.get(r.party_id) ?? new Set<string>();
    set.add(r.iban_hmac);
    map.set(r.party_id, set);
  }
  return map;
}

// ---------------------------------------------------------------------------
// (a) invoice ↔ bank outflow
// ---------------------------------------------------------------------------

async function matchInvoicesToDebits(
  invoices: readonly InvoiceRow[],
  debits: readonly DebitLeg[],
  ibansByVendor: ReadonlyMap<string, ReadonlySet<string>>,
  record: (link: LinkInput) => Promise<void>,
): Promise<void> {
  for (const assignment of assignPayments(invoices, debits, ibansByVendor)) {
    const { invoice, match } = assignment;
    for (const debit of match.debits) {
      await record({
        fromType: 'invoice',
        fromId: invoice.id,
        toType: 'bank_transaction',
        toId: debit.id,
        linkType: 'paid_by',
        method: match.decision.method,
        score: match.decision.score,
        amountMatched: round2(Math.min(debit.amount, match.target)),
        status: match.decision.status,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// (b) invoice ↔ liquidation line (how the spend was reported)
// ---------------------------------------------------------------------------

async function matchInvoicesToLiquidationLines(
  client: pg.PoolClient,
  cid: string,
  invoices: readonly InvoiceRow[],
  record: (link: LinkInput) => Promise<void>,
): Promise<void> {
  const res = await client.query(
    `select ll.id, ll.importe, ll.proveedor_text, ll.vendor_party_id, l.ejercicio
       from public.liquidation_lines ll
       join public.liquidations l on l.id = ll.liquidation_id
      where ll.community_id = $1 and ll.side = 'gasto'
      order by l.ejercicio, ll.id`,
    [cid],
  );
  const lines = (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    importe: num(r.importe),
    proveedorText: r.proveedor_text == null ? null : String(r.proveedor_text),
    vendorPartyId: r.vendor_party_id == null ? null : String(r.vendor_party_id),
    ejercicio: Number(r.ejercicio),
  }));
  const used = new Set<string>();
  for (const inv of invoices) {
    if (inv.fiscalYear == null) continue;
    let best: { lineId: string; similarity: number } | null = null;
    for (const line of lines) {
      if (used.has(line.id) || line.ejercicio !== inv.fiscalYear) continue;
      if (Math.abs(Math.abs(line.importe) - inv.total) > LIQUIDATION_TOLERANCE) continue;
      const similarity =
        line.vendorPartyId && inv.vendorPartyId && line.vendorPartyId === inv.vendorPartyId
          ? 1
          : nameSimilarity(line.proveedorText, inv.vendorName);
      if (similarity < LIQUIDATION_NAME_THRESHOLD) continue;
      if (!best || similarity > best.similarity) best = { lineId: line.id, similarity };
    }
    if (!best) continue;
    used.add(best.lineId);
    await record({
      fromType: 'invoice',
      fromId: inv.id,
      toType: 'liquidation_line',
      toId: best.lineId,
      linkType: 'reported_as',
      method: 'amount_date_name',
      score: 0.7,
      amountMatched: round2(inv.total),
      status: 'proposed',
    });
  }
}

// ---------------------------------------------------------------------------
// (c) invoice → authorising resolution
// ---------------------------------------------------------------------------

async function matchInvoicesToResolutions(
  client: pg.PoolClient,
  cid: string,
  invoices: readonly InvoiceRow[],
  record: (link: LinkInput) => Promise<void>,
): Promise<void> {
  const res = await client.query(
    `select r.id, r.kind, r.works_package_id, r.vendor_party_id, r.importe_aprobado, r.tolerance_pct,
            r.delegation_cap, m.fecha
       from public.resolutions r join public.meetings m on m.id = r.meeting_id
      where r.community_id = $1 and r.resultado = 'aprobado'
        and r.kind in ('works_approval', 'contractor_choice', 'delegation', 'budget')
      order by m.fecha, r.id`,
    [cid],
  );
  const resolutions = (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    worksPackageId: r.works_package_id == null ? null : String(r.works_package_id),
    vendorPartyId: r.vendor_party_id == null ? null : String(r.vendor_party_id),
    importeAprobado: maybeNum(r.importe_aprobado),
    tolerancePct: maybeNum(r.tolerance_pct),
    delegationCap: maybeNum(r.delegation_cap),
    fecha: iso(r.fecha),
  }));
  for (const inv of invoices) {
    const deadline = addDays(inv.date, 15);
    let best: { id: string; score: number; method: 'amount_date' | 'amount_date_name'; fecha: string } | null = null;
    for (const r of resolutions) {
      if (r.fecha > deadline) continue;
      const packageMatches = r.worksPackageId != null && r.worksPackageId === inv.worksPackageId;
      if (r.worksPackageId != null && !packageMatches) continue;
      const cap =
        r.delegationCap != null
          ? r.delegationCap
          : r.importeAprobado != null
            ? r.importeAprobado * (1 + (r.tolerancePct ?? 0) / 100)
            : null;
      const withinCap = cap == null ? null : inv.total <= cap * 1.001;
      const vendorMatches = r.vendorPartyId != null && r.vendorPartyId === inv.vendorPartyId;
      const strong = packageMatches && vendorMatches && withinCap !== false;
      const score = strong ? 0.9 : 0.7;
      const method = strong ? ('amount_date_name' as const) : ('amount_date' as const);
      if (!best || score > best.score || (score === best.score && r.fecha > best.fecha)) {
        best = { id: r.id, score, method, fecha: r.fecha };
      }
    }
    if (!best) continue;
    await record({
      fromType: 'invoice',
      fromId: inv.id,
      toType: 'resolution',
      toId: best.id,
      linkType: 'authorised_by',
      method: best.method,
      score: best.score,
      amountMatched: round2(inv.total),
      status: 'proposed',
    });
  }
}

// ---------------------------------------------------------------------------
// (d) invoice → contract, and the contract's payment milestones
// ---------------------------------------------------------------------------

async function matchInvoicesToContracts(
  client: pg.PoolClient,
  cid: string,
  invoices: readonly InvoiceRow[],
  record: (link: LinkInput) => Promise<void>,
): Promise<number> {
  const res = await client.query(
    `select id, vendor_party_id, works_package_id, fecha_firma from public.contracts where community_id = $1`,
    [cid],
  );
  const contracts = (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    vendorPartyId: r.vendor_party_id == null ? null : String(r.vendor_party_id),
    worksPackageId: r.works_package_id == null ? null : String(r.works_package_id),
  }));
  const invoicesByContract = new Map<string, InvoiceRow[]>();
  for (const inv of invoices) {
    if (!inv.vendorPartyId) continue;
    let chosen: { id: string; score: number } | null = null;
    for (const c of contracts) {
      if (c.vendorPartyId !== inv.vendorPartyId) continue;
      const packageMatches = c.worksPackageId != null && c.worksPackageId === inv.worksPackageId;
      const score = packageMatches ? 0.8 : inv.worksPackageId == null ? 0.6 : 0;
      if (score === 0) continue;
      if (!chosen || score > chosen.score) chosen = { id: c.id, score };
    }
    if (!chosen) continue;
    await record({
      fromType: 'invoice',
      fromId: inv.id,
      toType: 'contract',
      toId: chosen.id,
      linkType: 'under_contract',
      // the link rests on identity references (vendor and works package), not on amounts
      method: 'reference',
      score: chosen.score,
      amountMatched: round2(inv.total),
      status: 'proposed',
    });
    const list = invoicesByContract.get(chosen.id) ?? [];
    list.push(inv);
    invoicesByContract.set(chosen.id, list);
  }
  return updateMilestones(client, cid, invoicesByContract);
}

async function updateMilestones(
  client: pg.PoolClient,
  cid: string,
  invoicesByContract: ReadonlyMap<string, InvoiceRow[]>,
): Promise<number> {
  const msRes = await client.query(
    `select id, contract_id, seq, importe, status from public.contract_milestones
      where community_id = $1 and status = 'pending' order by contract_id, seq`,
    [cid],
  );
  if (msRes.rows.length === 0) return 0;

  const payRes = await client.query(
    `select rl.from_id as invoice_id, t.id as tx_id, coalesce(rl.amount_matched, -t.importe) as amount
       from public.recon_links rl
       join public.bank_transactions t on rl.to_type = 'bank_transaction' and rl.to_id = t.id
      where rl.community_id = $1 and rl.from_type = 'invoice' and rl.link_type = 'paid_by'
        and rl.status in ('accepted', 'proposed')`,
    [cid],
  );
  const paymentsByInvoice = new Map<string, Array<{ txId: string; amount: number }>>();
  for (const r of payRes.rows as Array<Record<string, unknown>>) {
    const key = String(r.invoice_id);
    const list = paymentsByInvoice.get(key) ?? [];
    list.push({ txId: String(r.tx_id), amount: round2(num(r.amount)) });
    paymentsByInvoice.set(key, list);
  }

  // Debits to the contract's vendor that no invoice explains: a milestone paid without an invoice.
  const looseRes = await client.query(
    `select c.id as contract_id, t.id as tx_id, -t.importe as amount
       from public.contracts c
       join public.party_ibans pi on pi.party_id = c.vendor_party_id
       join public.bank_transactions t on t.counterparty_iban_hmac = pi.iban_hmac and t.community_id = c.community_id
      where c.community_id = $1 and t.importe < 0
        and not exists (select 1 from public.recon_links rl
                         where rl.to_type = 'bank_transaction' and rl.to_id = t.id and rl.link_type = 'paid_by')`,
    [cid],
  );
  const looseByContract = new Map<string, Array<{ txId: string; amount: number }>>();
  for (const r of looseRes.rows as Array<Record<string, unknown>>) {
    const key = String(r.contract_id);
    const list = looseByContract.get(key) ?? [];
    list.push({ txId: String(r.tx_id), amount: round2(num(r.amount)) });
    looseByContract.set(key, list);
  }

  let updated = 0;
  const usedInvoices = new Set<string>();
  const usedTx = new Set<string>();
  for (const m of msRes.rows as Array<Record<string, unknown>>) {
    const contractId = String(m.contract_id);
    const importe = maybeNum(m.importe);
    if (importe == null || importe <= 0) continue;
    const invoiceMatch = (invoicesByContract.get(contractId) ?? []).find(
      (inv) => !usedInvoices.has(inv.id) && withinPct(inv.total, importe, 1),
    );
    let matchedTx: string | null = null;
    let paidTotal = 0;
    let paidWithoutInvoice = false;
    if (invoiceMatch) {
      usedInvoices.add(invoiceMatch.id);
      for (const p of paymentsByInvoice.get(invoiceMatch.id) ?? []) {
        if (usedTx.has(p.txId)) continue;
        usedTx.add(p.txId);
        matchedTx = matchedTx ?? p.txId;
        paidTotal = round2(paidTotal + p.amount);
      }
    } else {
      const loose = (looseByContract.get(contractId) ?? []).find((p) => !usedTx.has(p.txId) && withinPct(p.amount, importe, 1));
      if (loose) {
        usedTx.add(loose.txId);
        matchedTx = loose.txId;
        paidTotal = loose.amount;
        paidWithoutInvoice = true;
      }
    }
    const status = milestoneStatus({
      importe,
      invoiceTotal: invoiceMatch ? invoiceMatch.total : null,
      paidTotal,
      paidWithoutInvoice,
    });
    if (status === 'pending') continue;
    await client.query(
      `update public.contract_milestones
          set status = $2::public.milestone_status, matched_invoice_id = coalesce($3, matched_invoice_id), matched_tx_id = coalesce($4, matched_tx_id)
        where id = $1 and status = 'pending'`,
      [String(m.id), status, invoiceMatch?.id ?? null, matchedTx],
    );
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// (e) derrama ledger on a bank basis
// ---------------------------------------------------------------------------

async function reconcileDerramaLedger(
  client: pg.PoolClient,
  cid: string,
  record: (link: LinkInput) => Promise<void>,
): Promise<DerramaResult> {
  const creditRes = await client.query(
    `select id, importe, fecha_operacion, unit_id, derrama_id, concepto_text, tx_kind, counterparty_iban_hmac
       from public.bank_transactions
      where community_id = $1 and importe > 0 and tx_kind = 'quota_in'
      order by fecha_operacion, id`,
    [cid],
  );
  const credits: CreditRow[] = (creditRes.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    amount: round2(num(r.importe)),
    date: iso(r.fecha_operacion),
    unitId: r.unit_id == null ? null : String(r.unit_id),
    derramaId: r.derrama_id == null ? null : String(r.derrama_id),
    concepto: r.concepto_text == null ? null : String(r.concepto_text),
    txKind: String(r.tx_kind),
    counterpartyIbanHmac: r.counterparty_iban_hmac == null ? null : String(r.counterparty_iban_hmac),
  }));
  const attributed = credits.filter((c) => c.unitId != null);
  const result: DerramaResult = {
    attributedCredits: attributed.length,
    unattributedCredits: credits.length - attributed.length,
    ledgerRowsPaid: 0,
    ledgerRowsMissing: 0,
  };
  if (credits.length === 0) return result;

  const ledgerRes = await client.query(
    `select id, derrama_id, unit_id, period, expected, paid, basis, status from public.derrama_ledger
      where community_id = $1`,
    [cid],
  );
  const ledger = (ledgerRes.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    derramaId: String(r.derrama_id),
    unitId: String(r.unit_id),
    period: iso(r.period),
    expected: num(r.expected),
  }));
  if (ledger.length === 0) return result;

  const byUnitPeriod = new Map<string, typeof ledger>();
  for (const row of ledger) {
    const key = `${row.unitId}|${row.period}`;
    const list = byUnitPeriod.get(key) ?? [];
    list.push(row);
    byUnitPeriod.set(key, list);
  }

  const paidByLedgerRow = new Map<string, { paid: number; txIds: string[] }>();
  for (const credit of attributed) {
    const period = periodForCredit(credit.date, credit.concepto);
    const candidates = (byUnitPeriod.get(`${credit.unitId}|${period}`) ?? []).filter(
      (row) => credit.derramaId == null || row.derramaId === credit.derramaId,
    );
    if (candidates.length === 0) continue;
    const chosen = [...candidates].sort(
      (a, b) => Math.abs(a.expected - credit.amount) - Math.abs(b.expected - credit.amount) || a.id.localeCompare(b.id),
    )[0]!;
    const acc = paidByLedgerRow.get(chosen.id) ?? { paid: 0, txIds: [] };
    acc.paid = round2(acc.paid + credit.amount);
    acc.txIds.push(credit.id);
    paidByLedgerRow.set(chosen.id, acc);
    await record({
      fromType: 'bank_transaction',
      fromId: credit.id,
      toType: 'derrama',
      toId: chosen.derramaId,
      linkType: 'funds',
      method: 'amount_date',
      score: 0.8,
      amountMatched: credit.amount,
      status: 'proposed',
    });
  }

  for (const [rowId, acc] of paidByLedgerRow) {
    const row = ledger.find((l) => l.id === rowId)!;
    const status = ledgerStatus(row.expected, acc.paid);
    await client.query(
      `update public.derrama_ledger
          set paid = $2, basis = 'bank', status = $3::public.ledger_status, bank_transaction_id = coalesce($4, bank_transaction_id)
        where id = $1`,
      [rowId, acc.paid, status, acc.txIds[0] ?? null],
    );
    result.ledgerRowsPaid++;
  }

  // Units with at least one attributed credit can be tested for the months in the bank
  // coverage window; units whose payments were never attributed stay untested.
  const attributableUnits = new Set(attributed.map((c) => c.unitId!));
  const periods = attributed.map((c) => periodForCredit(c.date, c.concepto)).sort();
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];
  if (firstPeriod && lastPeriod) {
    for (const row of ledger) {
      if (paidByLedgerRow.has(row.id)) continue;
      if (!attributableUnits.has(row.unitId)) continue;
      if (row.period < firstPeriod || row.period > lastPeriod) continue;
      await client.query(
        `update public.derrama_ledger set paid = 0, basis = 'bank', status = 'missing' where id = $1 and basis <> 'bank'`,
        [row.id],
      );
      result.ledgerRowsMissing++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// (f) subsidy and loan credits; municipal (ICIO / taxa) debits
// ---------------------------------------------------------------------------

async function matchExternalFunding(
  client: pg.PoolClient,
  cid: string,
  record: (link: LinkInput) => Promise<void>,
): Promise<void> {
  const creditRes = await client.query(
    `select id, importe, fecha_operacion, tx_kind from public.bank_transactions
      where community_id = $1 and importe > 0 and tx_kind in ('subsidy', 'loan') order by fecha_operacion, id`,
    [cid],
  );
  if (creditRes.rows.length === 0) return;
  const subsidyRes = await client.query(
    `select id, import_pagat, import_atorgat from public.subsidies where community_id = $1`,
    [cid],
  );
  const loanRes = await client.query(`select id, principal from public.loans where community_id = $1`, [cid]);

  for (const c of creditRes.rows as Array<Record<string, unknown>>) {
    const amount = round2(num(c.importe));
    const kind = String(c.tx_kind);
    const targets: Array<{ id: string; type: 'subsidy' | 'loan'; amount: number }> = [];
    if (kind === 'subsidy') {
      for (const s of subsidyRes.rows as Array<Record<string, unknown>>) {
        const value = maybeNum(s.import_pagat) ?? maybeNum(s.import_atorgat);
        if (value != null && value > 0) targets.push({ id: String(s.id), type: 'subsidy', amount: value });
      }
    } else {
      for (const l of loanRes.rows as Array<Record<string, unknown>>) {
        const value = maybeNum(l.principal);
        if (value != null && value > 0) targets.push({ id: String(l.id), type: 'loan', amount: value });
      }
    }
    const hit = targets.find((t) => withinPct(t.amount, amount, 1));
    if (!hit) continue;
    await record({
      fromType: 'bank_transaction',
      fromId: String(c.id),
      toType: hit.type,
      toId: hit.id,
      linkType: 'funds',
      method: 'amount_date',
      score: 0.8,
      amountMatched: amount,
      status: 'proposed',
    });
  }
}

/** Flag debits payable to the city council or its tax office, for the permit/ICIO checks. */
async function flagMunicipalPayments(client: pg.PoolClient, cid: string): Promise<number> {
  const res = await client.query(
    `update public.bank_transactions
        set flags = array_append(flags, 'municipal_payee')
      where community_id = $1 and importe < 0 and not (flags @> array['municipal_payee'])
        and public.norm_text(coalesce(counterparty_name_norm, '') || ' ' || coalesce(concepto_text, '')) ~ $2
      returning id`,
    [cid, MUNICIPAL_PAYEE_RE],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// (g) refunds and returned debits
// ---------------------------------------------------------------------------

async function matchRefunds(
  client: pg.PoolClient,
  cid: string,
  ibansByVendor: ReadonlyMap<string, ReadonlySet<string>>,
  record: (link: LinkInput) => Promise<void>,
): Promise<void> {
  const vendorIbans = new Set<string>();
  for (const set of ibansByVendor.values()) for (const h of set) vendorIbans.add(h);
  if (vendorIbans.size === 0) return;
  const creditRes = await client.query(
    `select id, importe, fecha_operacion, counterparty_iban_hmac, tx_kind, concepto_text
       from public.bank_transactions
      where community_id = $1 and importe > 0 and counterparty_iban_hmac = any($2::text[])
      order by fecha_operacion, id`,
    [cid, [...vendorIbans]],
  );
  if (creditRes.rows.length === 0) return;
  const debitRes = await client.query(
    `select id, importe, fecha_operacion, counterparty_iban_hmac from public.bank_transactions
      where community_id = $1 and importe < 0 and counterparty_iban_hmac = any($2::text[])
      order by fecha_operacion, id`,
    [cid, [...vendorIbans]],
  );
  const debits = (debitRes.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    amount: round2(Math.abs(num(r.importe))),
    date: iso(r.fecha_operacion),
    hmac: r.counterparty_iban_hmac == null ? null : String(r.counterparty_iban_hmac),
  }));
  const used = new Set<string>();
  for (const c of creditRes.rows as Array<Record<string, unknown>>) {
    const credit = {
      id: String(c.id),
      amount: round2(num(c.importe)),
      date: iso(c.fecha_operacion),
      hmac: c.counterparty_iban_hmac == null ? null : String(c.counterparty_iban_hmac),
      txKind: String(c.tx_kind),
    };
    const match = debits.find(
      (d) =>
        !used.has(d.id) &&
        d.hmac === credit.hmac &&
        d.date <= credit.date &&
        Date.parse(`${credit.date}T00:00:00Z`) - Date.parse(`${d.date}T00:00:00Z`) <= 90 * 86400000 &&
        Math.abs(d.amount - credit.amount) <= 0.01,
    );
    if (!match) continue;
    used.add(match.id);
    const linkType: LinkType = credit.txKind === 'returned' ? 'returns' : 'refunds';
    await record({
      fromType: 'bank_transaction',
      fromId: credit.id,
      toType: 'bank_transaction',
      toId: match.id,
      linkType,
      method: 'iban',
      score: 0.95,
      amountMatched: credit.amount,
      status: 'accepted',
    });
  }
}

// ---------------------------------------------------------------------------
// (h) recurring direct debits
// ---------------------------------------------------------------------------

async function classifyRecurringDirectDebits(client: pg.PoolClient, cid: string): Promise<number> {
  const res = await client.query(
    `select id, importe, tx_kind,
            coalesce(counterparty_party_id::text, counterparty_iban_hmac, counterparty_name_norm, '') as key
       from public.bank_transactions
      where community_id = $1 and importe < 0 and tx_kind = 'direct_debit'`,
    [cid],
  );
  const ids = recurringDirectDebitIds(
    (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      amount: num(r.importe),
      txKind: String(r.tx_kind),
      key: String(r.key ?? ''),
    })),
  );
  if (ids.length === 0) return 0;
  const upd = await client.query(
    `update public.bank_transactions set tx_kind = 'direct_debit_recurring'
      where community_id = $1 and id = any($2::uuid[]) and tx_kind = 'direct_debit' returning id`,
    [cid, ids],
  );
  return upd.rowCount ?? 0;
}

/** Printable summary of a matching run. */
export function formatMatchResult(result: MatchResult): string[] {
  const lines: string[] = [];
  lines.push(`links written on ${result.runOn} (engine ${result.engineVersion}) — proposals to verify, decisions preserved:`);
  const types = [...result.linkCounts.keys()].sort();
  if (types.length === 0) lines.push('  (no links)');
  for (const t of types) {
    const c = result.linkCounts.get(t)!;
    lines.push(`  ${t.padEnd(16)} inserted ${c.inserted}, refreshed ${c.updated}, decided already ${c.keptDecision}`);
  }
  lines.push(
    `derrama ledger: ${result.derrama.ledgerRowsPaid} unit-period(s) with bank credits, ${result.derrama.ledgerRowsMissing} without; ` +
      `${result.derrama.attributedCredits} credit(s) attributed to a unit, ${result.derrama.unattributedCredits} not attributed`,
  );
  lines.push(
    `contract milestones updated: ${result.milestonesUpdated}; recurring direct debits classified: ${result.recurringPromoted}; municipal payees flagged: ${result.municipalFlagged}`,
  );
  lines.push(
    `works timeline: ${result.worksEvents.events} event(s) over ${result.worksEvents.packages} package(s), ${result.worksEvents.violations} ordering discrepancy(ies) to verify` +
      (result.worksEvents.missingTables.length > 0 ? ` (not in the schema yet: ${result.worksEvents.missingTables.join(', ')})` : ''),
  );
  const r = result.residuals;
  lines.push('residual sets');
  lines.push(`  R1 invoices without a matched debit          ${r.r1}`);
  lines.push(`  R2 debits not yet matched to an invoice      ${r.r2}`);
  lines.push(`  R3 liquidación lines with neither            ${r.r3}`);
  lines.push(`  R4 spend without a resolution                ${r.r4}`);
  lines.push(`  R5 milestones paid without an invoice        ${r.r5}`);
  lines.push(`  R6 derrama residual per unit and period      ${r.r6}`);
  lines.push(`  R7 statement months not located              ${r.r7}`);
  return lines;
}
