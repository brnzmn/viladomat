/**
 * Movement shape shared by the Norma 43 and camt.053 parsers so that downstream
 * classification and reconciliation do not depend on the export format.
 */

/** One bank movement, normalised across formats. Amounts are signed (negative = debit). */
export interface BankMovement {
  /** Operation (booking) date, ISO `yyyy-mm-dd`. */
  opDate: string;
  /** Value date, ISO `yyyy-mm-dd` (falls back to the operation date when absent). */
  valueDate: string;
  /** Norma 43 `concepto común` code (`01`…`99`); empty for camt.053. */
  conceptoComun: string;
  /** Norma 43 `concepto propio` (3 chars) or the camt.053 proprietary bank code. */
  conceptoPropio: string;
  /** Signed amount in account currency units (two decimals); negative for debits. */
  amount: number;
  /** Norma 43 document number; camt.053 end-to-end id when present. */
  documentNumber: string;
  /** Norma 43 reference 1; camt.053 `NtryRef`. */
  ref1: string;
  /** Norma 43 reference 2; camt.053 `AcctSvcrRef`. */
  ref2: string;
  /** Free-text lines: Norma 43 record-23 concepts or camt.053 `Ustrd` lines. */
  extraConcepts: string[];
  /**
   * Text naming the other party as the bank presents it. Norma 43 has no dedicated field,
   * so the joined record-23 text is used; camt.053 uses `RltdPties` debtor/creditor name.
   */
  counterpartyText: string;
  /** Other party's IBAN when the format carries it (camt.053 only). */
  counterpartyIban?: string;
  /** camt.053 bank transaction code `Domn/Fmly/SubFmly`, joined with `/`. */
  bankTxCode?: string;
  /** Amount in a foreign currency as reported by a Norma 43 record 24. */
  foreignCurrency?: { currency: string; amount: number };
}

/** Totals of an account block as reported by the bank (Norma 43 record 33). */
export interface BankTotals {
  debitCount: number;
  debitTotal: number;
  creditCount: number;
  creditTotal: number;
}

/** Currency numeric codes (ISO 4217) mapped to alphabetic codes. */
export const CURRENCY_NUMERIC: Readonly<Record<string, string>> = Object.freeze({
  '978': 'EUR',
  '840': 'USD',
  '826': 'GBP',
  '756': 'CHF',
  '392': 'JPY',
  '752': 'SEK',
  '578': 'NOK',
  '208': 'DKK',
  '985': 'PLN',
  '203': 'CZK',
  '348': 'HUF',
  '946': 'RON',
  '124': 'CAD',
  '036': 'AUD',
  '484': 'MXN',
  '032': 'ARS',
  '986': 'BRL',
  '156': 'CNY',
  '504': 'MAD',
});

/** Convert an ISO 4217 numeric code to its alphabetic code; unknown codes pass through. */
export function currencyFromNumeric(code: string): string {
  return CURRENCY_NUMERIC[code] ?? code;
}

/** Round to two decimals using integer arithmetic (avoids 0.1 + 0.2 artefacts). */
export function roundCents(n: number): number {
  return Math.round(n * 100 + Number.EPSILON * Math.sign(n)) / 100;
}

/** Integer cents from a number of currency units. */
export function toCents(n: number): number {
  return Math.round(n * 100);
}
