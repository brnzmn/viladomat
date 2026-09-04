/**
 * Pure matching primitives for the reconciliation engine.
 *
 * Nothing here touches the database: every function is a deterministic test over values
 * already read from it, so the matcher's arithmetic can be unit-tested on its own.
 * A match is a *proposal to verify*; only an IBAN-identity match is strong enough to be
 * accepted without a human (see `interfaces.md`, "Reconciliation links").
 */
import { tokenSetSimilarity } from '@viladomat/core';

/** Payment window around an invoice: 5 days before issue, 120 days after. */
export const WINDOW_BEFORE_DAYS = 5;
export const WINDOW_AFTER_DAYS = 120;
/** Amount tolerance for an invoice ↔ debit match, in EUR. */
export const AMOUNT_TOLERANCE = 0.01;
/** Amount tolerance for an invoice ↔ liquidation line match, in EUR. */
export const LIQUIDATION_TOLERANCE = 0.05;
/** Token-set similarity at or above which a counterparty text is treated as the vendor. */
export const NAME_THRESHOLD = 0.85;
/** Token-set similarity at or above which a liquidation line's `proveedor_text` is the vendor. */
export const LIQUIDATION_NAME_THRESHOLD = 0.6;
/** Maximum number of debits that may make up one invoice payment. */
export const MAX_PARTIALS = 3;
/** Score at or above which an `exact`/`iban` link is accepted without a reviewer. */
export const AUTO_ACCEPT_SCORE = 0.95;

export type LinkMethod =
  | 'exact'
  | 'amount_date'
  | 'amount_date_name'
  | 'partial_sum'
  | 'iban'
  | 'reference'
  | 'trigram'
  | 'human'
  | 'seed';

export type LinkStatus = 'proposed' | 'accepted' | 'rejected';

export interface InvoiceLeg {
  id: string;
  /** Gross total as invoiced. */
  total: number;
  /** Withholding already computed on the invoice, if any. */
  retentionAmount?: number | null;
  /** Withholding percentage, used when no amount is stated. */
  retentionPct?: number | null;
  /** `fecha_expedicion`. */
  date: string;
  numero?: string | null;
  serie?: string | null;
  vendorPartyId?: string | null;
  vendorName?: string | null;
}

export interface DebitLeg {
  id: string;
  /** Magnitude of the debit (positive). */
  amount: number;
  date: string;
  counterpartyIbanHmac?: string | null;
  counterpartyName?: string | null;
  conceptoText?: string | null;
}

/** Whole days from `a` to `b` (negative when `b` precedes `a`). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/** A debit may pay an invoice when it falls in the −5 / +120 day window around its issue date. */
export function withinPaymentWindow(invoiceDate: string, txDate: string): boolean {
  const d = daysBetween(invoiceDate, txDate);
  return d >= -WINDOW_BEFORE_DAYS && d <= WINDOW_AFTER_DAYS;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The amounts a payment of this invoice may take: the gross total and the total net of withholding. */
export function targetAmounts(inv: InvoiceLeg): number[] {
  const out = [round2(inv.total)];
  const retention =
    inv.retentionAmount != null && inv.retentionAmount > 0
      ? inv.retentionAmount
      : inv.retentionPct != null && inv.retentionPct > 0
        ? (inv.total * inv.retentionPct) / 100
        : 0;
  if (retention > 0) out.push(round2(inv.total - retention));
  return out;
}

/** True when `amount` equals one of the invoice's payable amounts within tolerance. */
export function amountMatches(inv: InvoiceLeg, amount: number, tolerance = AMOUNT_TOLERANCE): boolean {
  return targetAmounts(inv).some((t) => Math.abs(t - amount) <= tolerance);
}

/** Uppercase alphanumeric form used to look an invoice number up inside a bank concept. */
export function normaliseRef(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * True when the invoice number (with or without its series) appears in the bank concept.
 * References shorter than three characters are ignored: they match by chance.
 */
export function invoiceNumberInText(inv: InvoiceLeg, text: string | null | undefined): boolean {
  const hay = normaliseRef(text);
  if (!hay) return false;
  const candidates = [
    normaliseRef(`${inv.serie ?? ''}${inv.numero ?? ''}`),
    normaliseRef(inv.numero),
  ].filter((c) => c.length >= 3);
  return candidates.some((c) => hay.includes(c));
}

export interface MatchEvidence {
  /** The debit's counterparty IBAN is one of the vendor's known IBANs. */
  ibanMatch: boolean;
  /** Token-set similarity between the bank counterparty text and the vendor name. */
  nameScore: number;
  /** The invoice number appears in the bank concept. */
  referenceMatch: boolean;
}

/** Collect the evidence that ties a debit to an invoice (amount and date are tested separately). */
export function evidenceFor(
  inv: InvoiceLeg,
  tx: DebitLeg,
  vendorIbanHmacs: ReadonlySet<string>,
): MatchEvidence {
  const ibanMatch = Boolean(tx.counterpartyIbanHmac && vendorIbanHmacs.has(tx.counterpartyIbanHmac));
  const counterparty = tx.counterpartyName ?? tx.conceptoText ?? '';
  const nameScore = inv.vendorName ? round3(tokenSetSimilarity(counterparty, inv.vendorName)) : 0;
  return { ibanMatch, nameScore, referenceMatch: invoiceNumberInText(inv, tx.conceptoText) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface MatchDecision {
  method: LinkMethod;
  score: number;
  status: LinkStatus;
}

/**
 * Method and score of a single-debit match, in the order fixed by the plan:
 * counterparty IBAN identity (1.0, accepted) → payee name (0.8) → invoice number in the
 * concept (0.9) → amount and date alone (0.6). Only the IBAN leg is auto-accepted.
 */
export function decideMethod(ev: MatchEvidence): MatchDecision {
  if (ev.ibanMatch) return { method: 'iban', score: 1, status: 'accepted' };
  if (ev.nameScore >= NAME_THRESHOLD) return { method: 'amount_date_name', score: 0.8, status: 'proposed' };
  if (ev.referenceMatch) return { method: 'reference', score: 0.9, status: 'proposed' };
  return { method: 'amount_date', score: 0.6, status: 'proposed' };
}

/**
 * Method and score of a partial-payment set: always `partial_sum` and always proposed —
 * a split payment is a reading of the data, never an identity.
 */
export function decidePartialMethod(evidences: readonly MatchEvidence[]): MatchDecision {
  if (evidences.length > 0 && evidences.every((e) => e.ibanMatch)) {
    return { method: 'partial_sum', score: 0.9, status: 'proposed' };
  }
  if (evidences.some((e) => e.ibanMatch || e.nameScore >= NAME_THRESHOLD || e.referenceMatch)) {
    return { method: 'partial_sum', score: 0.7, status: 'proposed' };
  }
  return { method: 'partial_sum', score: 0.5, status: 'proposed' };
}

export interface SingleMatch {
  kind: 'single';
  debits: DebitLeg[];
  target: number;
  evidence: MatchEvidence[];
  decision: MatchDecision;
}

export interface PartialMatch {
  kind: 'partial';
  debits: DebitLeg[];
  target: number;
  evidence: MatchEvidence[];
  decision: MatchDecision;
}

export type InvoiceMatch = SingleMatch | PartialMatch;

/** Debits inside the payment window, oldest first. */
export function candidateDebits(inv: InvoiceLeg, debits: readonly DebitLeg[]): DebitLeg[] {
  return debits
    .filter((d) => withinPaymentWindow(inv.date, d.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/**
 * Sets of 2–3 debits, all within 120 days of each other, summing to one of the invoice's
 * payable amounts. Returns the earliest, smallest such set (deterministic).
 */
export function findPartialSet(inv: InvoiceLeg, debits: readonly DebitLeg[]): { debits: DebitLeg[]; target: number } | null {
  const cands = candidateDebits(inv, debits).slice(0, 12);
  const targets = targetAmounts(inv);
  for (let size = 2; size <= MAX_PARTIALS; size++) {
    const found = combinations(cands, size);
    for (const set of found) {
      const span = daysBetween(set[0]!.date, set[set.length - 1]!.date);
      if (span > WINDOW_AFTER_DAYS) continue;
      const sum = round2(set.reduce((s, d) => s + d.amount, 0));
      const target = targets.find((t) => Math.abs(t - sum) <= AMOUNT_TOLERANCE * set.length);
      if (target != null) return { debits: set, target };
    }
  }
  return null;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const current: T[] = [];
  const walk = (start: number): void => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Best payment reading for one invoice: a single debit when one matches the amount,
 * otherwise a set of at most three partial debits. `usedDebitIds` excludes debits already
 * attached to an earlier invoice so one payment is never counted twice.
 */
export function matchInvoice(
  inv: InvoiceLeg,
  debits: readonly DebitLeg[],
  vendorIbanHmacs: ReadonlySet<string>,
  usedDebitIds: ReadonlySet<string> = new Set(),
): InvoiceMatch | null {
  const cands = candidateDebits(inv, debits).filter((d) => !usedDebitIds.has(d.id));
  let best: SingleMatch | null = null;
  for (const d of cands) {
    if (!amountMatches(inv, d.amount)) continue;
    const ev = evidenceFor(inv, d, vendorIbanHmacs);
    const decision = decideMethod(ev);
    const target = targetAmounts(inv).find((t) => Math.abs(t - d.amount) <= AMOUNT_TOLERANCE) ?? inv.total;
    const candidate: SingleMatch = { kind: 'single', debits: [d], target, evidence: [ev], decision };
    if (!best || betterThan(candidate, best, inv)) best = candidate;
  }
  if (best) return best;

  const partial = findPartialSet(inv, cands);
  if (!partial) return null;
  const evidence = partial.debits.map((d) => evidenceFor(inv, d, vendorIbanHmacs));
  return { kind: 'partial', debits: partial.debits, target: partial.target, evidence, decision: decidePartialMethod(evidence) };
}

export interface PaymentAssignment {
  invoice: InvoiceLeg;
  match: InvoiceMatch;
}

/**
 * Assign debits to invoices across the whole corpus: the strongest evidence wins first
 * (IBAN identity before payee name before invoice number before amount and date alone),
 * ties broken by date proximity and then by id, so the result does not depend on the
 * order rows come back from the database. A debit is used at most once; invoices left
 * without a single matching debit are then offered sets of two or three partial debits.
 */
export function assignPayments(
  invoices: readonly InvoiceLeg[],
  debits: readonly DebitLeg[],
  ibansByVendor: ReadonlyMap<string, ReadonlySet<string>>,
): PaymentAssignment[] {
  const empty: ReadonlySet<string> = new Set<string>();
  const ibansOf = (inv: InvoiceLeg): ReadonlySet<string> =>
    (inv.vendorPartyId ? ibansByVendor.get(inv.vendorPartyId) : undefined) ?? empty;

  interface Pair {
    inv: InvoiceLeg;
    debit: DebitLeg;
    evidence: MatchEvidence;
    decision: MatchDecision;
    target: number;
    distance: number;
  }
  const pairs: Pair[] = [];
  for (const inv of invoices) {
    for (const d of candidateDebits(inv, debits)) {
      if (!amountMatches(inv, d.amount)) continue;
      const evidence = evidenceFor(inv, d, ibansOf(inv));
      const target = targetAmounts(inv).find((t) => Math.abs(t - d.amount) <= AMOUNT_TOLERANCE) ?? inv.total;
      pairs.push({ inv, debit: d, evidence, decision: decideMethod(evidence), target, distance: Math.abs(daysBetween(inv.date, d.date)) });
    }
  }
  pairs.sort(
    (a, b) =>
      b.decision.score - a.decision.score ||
      a.distance - b.distance ||
      a.inv.date.localeCompare(b.inv.date) ||
      a.inv.id.localeCompare(b.inv.id) ||
      a.debit.id.localeCompare(b.debit.id),
  );

  const out: PaymentAssignment[] = [];
  const usedInvoices = new Set<string>();
  const usedDebits = new Set<string>();
  for (const p of pairs) {
    if (usedInvoices.has(p.inv.id) || usedDebits.has(p.debit.id)) continue;
    usedInvoices.add(p.inv.id);
    usedDebits.add(p.debit.id);
    out.push({
      invoice: p.inv,
      match: { kind: 'single', debits: [p.debit], target: p.target, evidence: [p.evidence], decision: p.decision },
    });
  }

  for (const inv of [...invoices].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (usedInvoices.has(inv.id)) continue;
    const free = debits.filter((d) => !usedDebits.has(d.id));
    const partial = findPartialSet(inv, free);
    if (!partial) continue;
    const evidence = partial.debits.map((d) => evidenceFor(inv, d, ibansOf(inv)));
    usedInvoices.add(inv.id);
    for (const d of partial.debits) usedDebits.add(d.id);
    out.push({
      invoice: inv,
      match: { kind: 'partial', debits: partial.debits, target: partial.target, evidence, decision: decidePartialMethod(evidence) },
    });
  }
  return out.sort((a, b) => a.invoice.date.localeCompare(b.invoice.date) || a.invoice.id.localeCompare(b.invoice.id));
}

function betterThan(a: SingleMatch, b: SingleMatch, inv: InvoiceLeg): boolean {
  if (a.decision.score !== b.decision.score) return a.decision.score > b.decision.score;
  const da = Math.abs(daysBetween(inv.date, a.debits[0]!.date));
  const db = Math.abs(daysBetween(inv.date, b.debits[0]!.date));
  if (da !== db) return da < db;
  return a.debits[0]!.id < b.debits[0]!.id;
}

/** Name similarity used for liquidation lines and payee comparisons. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return round3(tokenSetSimilarity(a, b));
}

/** Amounts equal within a relative tolerance (used for subsidies, loans and milestones). */
export function withinPct(a: number, b: number, pct: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) <= (scale * pct) / 100;
}

export interface RecurringInput {
  id: string;
  amount: number;
  txKind: string;
  key: string;
}

/**
 * Direct debits from the same counterparty seen at least three times form a series;
 * members within ±30% of the series' median magnitude are recurring. Returns the ids to
 * promote to `direct_debit_recurring` (only rows currently classified `direct_debit`).
 */
export function recurringDirectDebitIds(rows: readonly RecurringInput[]): string[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const r of rows) {
    if (r.txKind !== 'direct_debit' || !r.key) continue;
    const list = groups.get(r.key) ?? [];
    list.push(r);
    groups.set(r.key, list);
  }
  const out: string[] = [];
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const med = median(list.map((r) => Math.abs(r.amount)));
    if (med <= 0) continue;
    for (const r of list) {
      const abs = Math.abs(r.amount);
      if (abs >= med * 0.7 && abs <= med * 1.3) out.push(r.id);
    }
  }
  return out.sort();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const MONTHS: ReadonlyArray<readonly string[]> = [
  ['ENERO', 'GENER', 'JANUARY'],
  ['FEBRERO', 'FEBRER', 'FEBRUARY'],
  ['MARZO', 'MARC', 'MARCH'],
  ['ABRIL', 'APRIL'],
  ['MAYO', 'MAIG', 'MAY'],
  ['JUNIO', 'JUNY', 'JUNE'],
  ['JULIO', 'JULIOL', 'JULY'],
  ['AGOSTO', 'AGOST', 'AUGUST'],
  ['SEPTIEMBRE', 'SETEMBRE', 'SEPTEMBER'],
  ['OCTUBRE', 'OCTOBER'],
  ['NOVIEMBRE', 'NOVEMBRE', 'NOVEMBER'],
  ['DICIEMBRE', 'DESEMBRE', 'DECEMBER'],
];

/**
 * Period a quota credit belongs to: the month named in the concept when there is one,
 * otherwise the month of the operation date. Returns the first day of the month, ISO.
 */
export function periodForCredit(fechaOperacion: string, concepto: string | null | undefined): string {
  const date = fechaOperacion.slice(0, 10);
  const year = Number(date.slice(0, 4));
  const text = (concepto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  const numeric = /(^|[^0-9])(0[1-9]|1[0-2])[\/\-.](20\d{2})([^0-9]|$)/.exec(text);
  if (numeric) return `${numeric[3]}-${numeric[2]}-01`;
  for (let i = 0; i < MONTHS.length; i++) {
    if (MONTHS[i]!.some((name) => text.includes(name))) {
      const withYear = new RegExp(`(${MONTHS[i]!.join('|')})[^0-9]{0,10}(20\\d{2})`).exec(text);
      const y = withYear ? Number(withYear[2]) : year;
      return `${y}-${String(i + 1).padStart(2, '0')}-01`;
    }
  }
  return `${date.slice(0, 7)}-01`;
}

export type LedgerStatus = 'expected' | 'paid' | 'partial' | 'missing' | 'excess';

/** Ledger status of a unit-period from the expected and the collected amount. */
export function ledgerStatus(expected: number, paid: number): LedgerStatus {
  const e = round2(expected);
  const p = round2(paid);
  if (p <= 0) return e > 0 ? 'missing' : 'paid';
  if (Math.abs(p - e) <= 0.01) return 'paid';
  return p > e ? 'excess' : 'partial';
}

export type MilestoneStatus = 'pending' | 'invoiced' | 'paid' | 'paid_without_invoice' | 'overpaid';

export interface MilestoneInput {
  /** Amount of the milestone, EUR; null when the schedule only states a percentage. */
  importe: number | null;
  /** Invoices linked to the contract that match this milestone's amount. */
  invoiceTotal: number | null;
  /** Amount actually debited for this milestone (through the invoice or directly). */
  paidTotal: number | null;
  /** True when the debit was found without any invoice behind it. */
  paidWithoutInvoice: boolean;
}

/** Status a pending milestone moves to once invoices and payments are linked. */
export function milestoneStatus(m: MilestoneInput): MilestoneStatus {
  const importe = m.importe ?? 0;
  const paid = m.paidTotal ?? 0;
  if (importe > 0 && paid > 0 && paid > importe * 1.01) return 'overpaid';
  if (paid > 0 && m.paidWithoutInvoice) return 'paid_without_invoice';
  if (paid > 0) return 'paid';
  if (m.invoiceTotal != null && m.invoiceTotal > 0) return 'invoiced';
  return 'pending';
}
