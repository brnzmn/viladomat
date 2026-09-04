/**
 * Control totals per fiscal year: the liquidación ↔ bank ↔ invoices bridge and the
 * continuity of balances between years.
 *
 * The bridge is printed before anything is tested: only the residual that survives the
 * cut-off items (opening and closing payables, retentions held) is compared with
 * `pm_ordinary` by rule D7. The liquidación is the assertion of the party under review and
 * never counts as an independent leg.
 */
import type pg from 'pg';

export interface ControlTotalRow {
  fiscalYear: number;
  basis: string | null;
  liqExpenses: number | null;
  bankDebits: number | null;
  invoicesTotal: number | null;
  invoiceCount: number | null;
  liqIncome: number | null;
  ownerCredits: number | null;
  externalCredits: number | null;
  openingPayables: number | null;
  closingPayables: number | null;
  retentionsHeld: number | null;
  bridgedDifference: number | null;
  pmOrdinary: number | null;
}

export interface BalanceContinuityRow {
  fiscalYear: number;
  liquidationId: string;
  saldoInicial: number | null;
  prevSaldoFinal: number | null;
  openingGap: number | null;
  saldoFinal: number | null;
  bankSaldoAtClose: number | null;
  saldoEnPoderAdministrador: number | null;
  fondoReservaFinal: number | null;
  pmOrdinary: number | null;
}

export interface ControlTotals {
  totals: ControlTotalRow[];
  continuity: BalanceContinuityRow[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Read `v_control_totals` and `v_year_balance_continuity` for one community. */
export async function loadControlTotals(client: pg.PoolClient, cid: string): Promise<ControlTotals> {
  const totalsRes = await client.query(
    `select fiscal_year, basis, liq_expenses, bank_debits, invoices_total, invoice_count,
            liq_income, owner_credits, external_credits, opening_payables, closing_payables,
            retentions_held, bridged_difference, pm_ordinary
       from public.v_control_totals where community_id = $1 order by fiscal_year`,
    [cid],
  );
  const contRes = await client.query(
    `select fiscal_year, liquidation_id, saldo_inicial, prev_saldo_final, opening_gap, saldo_final,
            bank_saldo_at_close, saldo_en_poder_administrador, fondo_reserva_final, pm_ordinary
       from public.v_year_balance_continuity where community_id = $1 order by fiscal_year`,
    [cid],
  );
  const totals = (totalsRes.rows as Array<Record<string, unknown>>).map((r) => ({
    fiscalYear: Number(r.fiscal_year),
    basis: r.basis == null ? null : String(r.basis),
    liqExpenses: num(r.liq_expenses),
    bankDebits: num(r.bank_debits),
    invoicesTotal: num(r.invoices_total),
    invoiceCount: r.invoice_count == null ? null : Number(r.invoice_count),
    liqIncome: num(r.liq_income),
    ownerCredits: num(r.owner_credits),
    externalCredits: num(r.external_credits),
    openingPayables: num(r.opening_payables),
    closingPayables: num(r.closing_payables),
    retentionsHeld: num(r.retentions_held),
    bridgedDifference: num(r.bridged_difference),
    pmOrdinary: num(r.pm_ordinary),
  }));
  const continuity = (contRes.rows as Array<Record<string, unknown>>).map((r) => ({
    fiscalYear: Number(r.fiscal_year),
    liquidationId: String(r.liquidation_id),
    saldoInicial: num(r.saldo_inicial),
    prevSaldoFinal: num(r.prev_saldo_final),
    openingGap: num(r.opening_gap),
    saldoFinal: num(r.saldo_final),
    bankSaldoAtClose: num(r.bank_saldo_at_close),
    saldoEnPoderAdministrador: num(r.saldo_en_poder_administrador),
    fondoReservaFinal: num(r.fondo_reserva_final),
    pmOrdinary: num(r.pm_ordinary),
  }));
  return { totals, continuity };
}

function eur(n: number | null): string {
  return n == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
}

/**
 * Printable bridge, one block per fiscal year. Wording is descriptive: a difference is a
 * figure to explain, not a conclusion.
 */
export function formatControlTotals(ct: ControlTotals): string[] {
  const lines: string[] = [];
  lines.push('control totals per fiscal year (liquidación vs bank vs invoices)');
  if (ct.totals.length === 0) lines.push('  (no liquidación, bank or invoice rows yet)');
  for (const t of ct.totals) {
    lines.push(`  ${t.fiscalYear} [basis ${t.basis ?? 'unknown'}]`);
    lines.push(
      `    liquidación expenses ${eur(t.liqExpenses)} | bank debits ${eur(t.bankDebits)} | invoices ${eur(t.invoicesTotal)} (${t.invoiceCount ?? 0})`,
    );
    lines.push(
      `    cut-off bridge: − closing payables ${eur(t.closingPayables)} + opening payables ${eur(t.openingPayables)} − retentions held ${eur(t.retentionsHeld)}`,
    );
    lines.push(
      `    bridged difference ${eur(t.bridgedDifference)} (materiality pm_ordinary ${eur(t.pmOrdinary)})`,
    );
    lines.push(
      `    income: liquidación ${eur(t.liqIncome)} | owner credits ${eur(t.ownerCredits)} | subsidy/loan credits ${eur(t.externalCredits)}`,
    );
  }
  lines.push('balance continuity');
  if (ct.continuity.length === 0) lines.push('  (no liquidación rows yet)');
  for (const c of ct.continuity) {
    lines.push(
      `  ${c.fiscalYear}: opening ${eur(c.saldoInicial)} vs prior closing ${eur(c.prevSaldoFinal)} (gap ${eur(c.openingGap)}); closing ${eur(c.saldoFinal)} vs bank at close ${eur(c.bankSaldoAtClose)}; held by the administration ${eur(c.saldoEnPoderAdministrador)}`,
    );
  }
  return lines;
}

export interface ResidualCounts {
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
  r6: number;
  r7: number;
}

/** Sizes of the residual sets R1–R7 straight from the views. */
export async function loadResidualCounts(client: pg.PoolClient, cid: string): Promise<ResidualCounts> {
  const res = await client.query<Record<string, string>>(
    `select (select count(*) from public.v_r1_invoices_without_payment where community_id = $1) as r1,
            (select count(*) from public.v_r2_debits_without_invoice where community_id = $1) as r2,
            (select count(*) from public.v_r3_liquidation_lines_unsupported where community_id = $1) as r3,
            (select count(*) from public.v_r4_spend_without_resolution where community_id = $1) as r4,
            (select count(*) from public.v_r5_milestones_paid_without_invoice where community_id = $1) as r5,
            (select count(*) from public.v_r6_derrama_residual where community_id = $1) as r6,
            (select count(*) from public.v_r7_statement_months_missing where community_id = $1) as r7`,
    [cid],
  );
  const r = res.rows[0] ?? {};
  return {
    r1: Number(r.r1 ?? 0),
    r2: Number(r.r2 ?? 0),
    r3: Number(r.r3 ?? 0),
    r4: Number(r.r4 ?? 0),
    r5: Number(r.r5 ?? 0),
    r6: Number(r.r6 ?? 0),
    r7: Number(r.r7 ?? 0),
  };
}
