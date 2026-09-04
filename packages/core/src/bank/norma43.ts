/**
 * Parser for AEB Norma 43 (Cuaderno 43) account-statement files: fixed-width 80-character
 * records with types 11 (account header), 22 (movement), 23 (complementary concepts),
 * 24 (foreign-currency equivalence), 33 (account trailer) and 88 (end of file).
 *
 * The parser is deterministic and tolerant: malformed lines produce warnings rather than
 * exceptions, and every account block reports whether the bank's own totals reconcile
 * with the movements (`selfCheckOk`).
 */
import { toIsoDate, expandTwoDigitYear } from '../text/amounts.ts';
import { currencyFromNumeric, type BankMovement, type BankTotals } from './types.ts';

/**
 * AEB `concepto común` codes (record 22, positions 23–24).
 *
 * Codes 01–11 and 98–99 are stable across published legends. For 12–17 the published
 * sources disagree on the exact wording (and some banks re-purpose them), so the bank's own
 * legend for the account must be archived before any rule relies on those codes.
 */
export const N43_CONCEPTO_COMUN: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Reintegros / talones',
  '02': 'Abonos / ingresos',
  '03': 'Domiciliaciones / recibos',
  '04': 'Giros y transferencias',
  '05': 'Amortización de préstamos y créditos',
  '06': 'Remesas de efectos',
  '07': 'Suscripciones / dividendos pasivos',
  '08': 'Cupones / dividendos',
  '09': 'Compra-venta de valores',
  '10': 'Cheques',
  '11': 'Efectos',
  '12': 'Tarjeta / cajero',
  '13': 'Operaciones en el extranjero',
  '14': 'Devoluciones / impagados',
  '15': 'Nóminas / seguros sociales',
  '16': 'Timbres / impuestos',
  '17': 'Intereses / comisiones',
  '98': 'Anulaciones',
  '99': 'Varios',
});

/** One account block (records 11 … 33) of a Norma 43 file. */
export interface N43Account {
  /** Four-digit entity code. */
  entidad: string;
  /** Four-digit office code. */
  oficina: string;
  /** Ten-digit account number (without the CCC control digits, which the format omits). */
  cuenta: string;
  /** Not derivable from the file; see `cccToIban` in `ids/iban.ts` to compute it. */
  iban?: string;
  /** Period start, ISO date. */
  periodFrom: string;
  /** Period end, ISO date. */
  periodTo: string;
  /** Signed opening balance. */
  openingBalance: number;
  /** Signed closing balance as reported by record 33 (or derived when record 33 is missing). */
  closingBalance: number;
  /** ISO 4217 alphabetic currency code (`EUR`). */
  currency: string;
  /** Abbreviated holder name from the header. */
  holderName: string;
  /** Header `modalidad de información` flag (1, 2 or 3). */
  modalidad: string;
  movements: BankMovement[];
  /** Totals as reported by record 33 (zeros when absent). */
  totals: BankTotals;
  /** True when record 33 matches the movements and opening + movements = closing. */
  selfCheckOk: boolean;
}

/** Result of {@link parseNorma43}. */
export interface N43File {
  accounts: N43Account[];
  /** Records actually parsed, excluding the end-of-file record 88. */
  recordCount: number;
  /** Record count declared by record 88, when present. */
  declaredRecordCount?: number;
  warnings: string[];
}

/** 1-based inclusive substring of a fixed-width record. */
function field(line: string, from: number, to: number): string {
  return line.slice(from - 1, to);
}

/** Parse an `AAMMDD` date; null when not a calendar date. */
export function parseN43Date(aammdd: string): string | null {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return toIsoDate(expandTwoDigitYear(yy), mm, dd);
}

/** Parse a 14-digit amount with two implied decimals into integer cents; null when malformed. */
function parseCents(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** Sign multiplier for a `clave debe/haber` (1 = debe/negative, 2 = haber/positive). */
function signFor(clave: string): number | null {
  if (clave === '1') return -1;
  if (clave === '2') return 1;
  return null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface AccountState {
  account: N43Account;
  openingCents: number;
  closingCents: number | null;
  movementCents: number[];
  hasTrailer: boolean;
  trailer?: { debitCount: number; debitCents: number; creditCount: number; creditCents: number };
  lastMovement?: BankMovement;
  extraCount: number;
}

function finishAccount(state: AccountState, warnings: string[], label: string): N43Account {
  const acct = state.account;
  let debitCount = 0;
  let debitCents = 0;
  let creditCount = 0;
  let creditCents = 0;
  for (const c of state.movementCents) {
    if (c < 0) {
      debitCount++;
      debitCents += -c;
    } else {
      creditCount++;
      creditCents += c;
    }
  }
  const derivedClosing = state.openingCents - debitCents + creditCents;
  let ok = true;
  if (!state.hasTrailer || !state.trailer) {
    warnings.push(`${label}: record 33 missing; totals derived from movements`);
    acct.totals = {
      debitCount,
      debitTotal: debitCents / 100,
      creditCount,
      creditTotal: creditCents / 100,
    };
    acct.closingBalance = derivedClosing / 100;
    ok = false;
  } else {
    const t = state.trailer;
    acct.totals = {
      debitCount: t.debitCount,
      debitTotal: t.debitCents / 100,
      creditCount: t.creditCount,
      creditTotal: t.creditCents / 100,
    };
    if (t.debitCount !== debitCount || t.debitCents !== debitCents) {
      warnings.push(
        `${label}: record 33 debit totals (${t.debitCount} / ${(t.debitCents / 100).toFixed(2)}) differ from movements (${debitCount} / ${(debitCents / 100).toFixed(2)})`,
      );
      ok = false;
    }
    if (t.creditCount !== creditCount || t.creditCents !== creditCents) {
      warnings.push(
        `${label}: record 33 credit totals (${t.creditCount} / ${(t.creditCents / 100).toFixed(2)}) differ from movements (${creditCount} / ${(creditCents / 100).toFixed(2)})`,
      );
      ok = false;
    }
    if (state.closingCents === null) {
      warnings.push(`${label}: record 33 closing balance unreadable`);
      acct.closingBalance = derivedClosing / 100;
      ok = false;
    } else {
      acct.closingBalance = state.closingCents / 100;
      if (state.closingCents !== derivedClosing) {
        warnings.push(
          `${label}: opening balance plus movements (${(derivedClosing / 100).toFixed(2)}) differs from record 33 closing balance (${(state.closingCents / 100).toFixed(2)})`,
        );
        ok = false;
      }
    }
  }
  acct.selfCheckOk = ok;
  return acct;
}

/**
 * Parse the text of a Norma 43 file.
 *
 * Dates use the AEB century rule (`AA` < 70 → 20AA, else 19AA). Amounts have two implied
 * decimals and are returned as signed numbers (debits negative). Each account's
 * `selfCheckOk` is true only when the record-33 counts and totals equal the movements and
 * opening + credits − debits equals the reported closing balance.
 */
export function parseNorma43(text: string): N43File {
  const warnings: string[] = [];
  const accounts: N43Account[] = [];
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n|\r/)
    .filter((l) => l.trim().length > 0);

  let current: AccountState | null = null;
  let recordCount = 0;
  let declaredRecordCount: number | undefined;

  const closeCurrent = (): void => {
    if (!current) return;
    accounts.push(finishAccount(current, warnings, `account ${current.account.cuenta}`));
    current = null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? '';
    const lineNo = idx + 1;
    if (rawLine.length !== 80) {
      warnings.push(`line ${lineNo}: length ${rawLine.length} (expected 80), padded/truncated`);
    }
    const line = rawLine.length >= 80 ? rawLine.slice(0, 80) : rawLine.padEnd(80, ' ');
    const type = field(line, 1, 2);

    switch (type) {
      case '11': {
        recordCount++;
        closeCurrent();
        const from = parseN43Date(field(line, 21, 26));
        const to = parseN43Date(field(line, 27, 32));
        const sign = signFor(field(line, 33, 33));
        const cents = parseCents(field(line, 34, 47));
        if (!from || !to) warnings.push(`line ${lineNo}: record 11 has an unreadable period date`);
        if (sign === null || cents === null) {
          warnings.push(`line ${lineNo}: record 11 opening balance unreadable`);
        }
        const openingCents = (sign ?? 1) * (cents ?? 0);
        current = {
          account: {
            entidad: field(line, 3, 6),
            oficina: field(line, 7, 10),
            cuenta: field(line, 11, 20),
            periodFrom: from ?? '',
            periodTo: to ?? '',
            openingBalance: openingCents / 100,
            closingBalance: openingCents / 100,
            currency: currencyFromNumeric(field(line, 48, 50)),
            holderName: collapse(field(line, 52, 77)),
            modalidad: field(line, 51, 51),
            movements: [],
            totals: { debitCount: 0, debitTotal: 0, creditCount: 0, creditTotal: 0 },
            selfCheckOk: false,
          },
          openingCents,
          closingCents: null,
          movementCents: [],
          hasTrailer: false,
          extraCount: 0,
        };
        break;
      }
      case '22': {
        recordCount++;
        if (!current) {
          warnings.push(`line ${lineNo}: record 22 before any record 11; skipped`);
          break;
        }
        const opDate = parseN43Date(field(line, 11, 16));
        const valueDate = parseN43Date(field(line, 17, 22));
        const sign = signFor(field(line, 28, 28));
        const cents = parseCents(field(line, 29, 42));
        if (!opDate) warnings.push(`line ${lineNo}: record 22 operation date unreadable`);
        if (sign === null || cents === null) {
          warnings.push(`line ${lineNo}: record 22 amount unreadable; skipped`);
          break;
        }
        const signedCents = sign * cents;
        const movement: BankMovement = {
          opDate: opDate ?? '',
          valueDate: valueDate ?? opDate ?? '',
          conceptoComun: field(line, 23, 24),
          conceptoPropio: field(line, 25, 27),
          amount: signedCents / 100,
          documentNumber: field(line, 43, 52).trim(),
          ref1: field(line, 53, 64).trim(),
          ref2: field(line, 65, 80).trim(),
          extraConcepts: [],
          counterpartyText: '',
        };
        current.account.movements.push(movement);
        current.movementCents.push(signedCents);
        current.lastMovement = movement;
        current.extraCount = 0;
        break;
      }
      case '23': {
        recordCount++;
        if (!current || !current.lastMovement) {
          warnings.push(`line ${lineNo}: record 23 without a preceding record 22; skipped`);
          break;
        }
        current.extraCount++;
        if (current.extraCount > 5) {
          warnings.push(`line ${lineNo}: more than five record 23 for one movement`);
        }
        const c1 = collapse(field(line, 5, 42));
        const c2 = collapse(field(line, 43, 80));
        const mv = current.lastMovement;
        if (c1) mv.extraConcepts.push(c1);
        if (c2) mv.extraConcepts.push(c2);
        mv.counterpartyText = collapse(mv.extraConcepts.join(' '));
        break;
      }
      case '24': {
        recordCount++;
        if (!current || !current.lastMovement) {
          warnings.push(`line ${lineNo}: record 24 without a preceding record 22; skipped`);
          break;
        }
        const currency = currencyFromNumeric(field(line, 5, 7));
        const cents = parseCents(field(line, 8, 21));
        if (cents === null) {
          warnings.push(`line ${lineNo}: record 24 amount unreadable; ignored`);
          break;
        }
        current.lastMovement.foreignCurrency = { currency, amount: cents / 100 };
        break;
      }
      case '33': {
        recordCount++;
        if (!current) {
          warnings.push(`line ${lineNo}: record 33 without a record 11; skipped`);
          break;
        }
        const entidad = field(line, 3, 6);
        const oficina = field(line, 7, 10);
        const cuenta = field(line, 11, 20);
        const a = current.account;
        if (entidad !== a.entidad || oficina !== a.oficina || cuenta !== a.cuenta) {
          warnings.push(`line ${lineNo}: record 33 account does not match record 11`);
        }
        const debitCount = parseCents(field(line, 21, 25));
        const debitCents = parseCents(field(line, 26, 39));
        const creditCount = parseCents(field(line, 40, 44));
        const creditCents = parseCents(field(line, 45, 58));
        const sign = signFor(field(line, 59, 59));
        const closing = parseCents(field(line, 60, 73));
        const currency = currencyFromNumeric(field(line, 74, 76));
        if (currency !== a.currency) {
          warnings.push(
            `line ${lineNo}: record 33 currency ${currency} differs from header ${a.currency}`,
          );
        }
        if (
          debitCount === null ||
          debitCents === null ||
          creditCount === null ||
          creditCents === null
        ) {
          warnings.push(`line ${lineNo}: record 33 totals unreadable`);
        }
        current.hasTrailer = true;
        current.trailer = {
          debitCount: debitCount ?? -1,
          debitCents: debitCents ?? -1,
          creditCount: creditCount ?? -1,
          creditCents: creditCents ?? -1,
        };
        current.closingCents = sign !== null && closing !== null ? sign * closing : null;
        closeCurrent();
        break;
      }
      case '88': {
        const declared = parseCents(field(line, 21, 26));
        if (declared === null) {
          warnings.push(`line ${lineNo}: record 88 record count unreadable`);
        } else {
          declaredRecordCount = declared;
        }
        if (idx !== lines.length - 1) {
          warnings.push(`line ${lineNo}: record 88 is not the last record`);
        }
        break;
      }
      default:
        recordCount++;
        warnings.push(`line ${lineNo}: unknown record type "${type}"; skipped`);
    }
  }
  closeCurrent();

  if (declaredRecordCount !== undefined && declaredRecordCount !== recordCount) {
    warnings.push(
      `record 88 declares ${declaredRecordCount} records but ${recordCount} were parsed`,
    );
  }
  if (declaredRecordCount === undefined) {
    warnings.push('record 88 (end of file) missing');
  }

  const out: N43File = { accounts, recordCount, warnings };
  if (declaredRecordCount !== undefined) out.declaredRecordCount = declaredRecordCount;
  return out;
}
