/**
 * Minimal AEB Norma 43 (Cuaderno 43) writer: the mirror image of
 * `packages/core/src/bank/norma43.ts`'s reader, using the exact same field offsets, so a
 * file written here round-trips through the real parser with `selfCheckOk === true`. Records
 * 11 (header), 22 (movement), 23 (complementary concepts) and 33 (trailer) are supported —
 * enough for the synthetic corpus; record 24 (foreign currency) is not needed (everything is
 * EUR) and is left out.
 *
 * Free-text fields are transliterated to plain ASCII (accents and the — dash stripped),
 * matching how real Norma 43 exports — a legacy fixed-width format — usually carry names and
 * concepts, rather than embedding multi-byte UTF-8 in a byte-oriented fixed-width record.
 */
import { stripDiacritics } from '../../../packages/core/src/text/amounts.ts';

function ascii(s: string): string {
  return stripDiacritics(s)
    .replace(/[—–]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
}

export interface N43WriteMovement {
  /** Operation date, ISO `yyyy-mm-dd`. */
  opDate: string;
  /** Value date, ISO `yyyy-mm-dd` (defaults to `opDate`). */
  valueDate?: string;
  /** AEB `concepto común` (2 digits). */
  conceptoComun: string;
  /** `concepto propio` (up to 3 chars). */
  conceptoPropio?: string;
  /** Signed amount, EUR, 2 decimals; negative = debit. */
  amount: number;
  documentNumber?: string;
  ref1?: string;
  ref2?: string;
  /** Free-text concept lines (record 23), up to 2 of 38 chars each; longer text is truncated. */
  concepts?: string[];
}

export interface N43WriteAccount {
  entidad: string; // 4 digits
  oficina: string; // 4 digits
  cuenta: string; // 10 digits
  periodFrom: string; // ISO
  periodTo: string; // ISO
  openingBalance: number;
  holderName: string;
  movements: N43WriteMovement[];
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s.padEnd(len, ' ');
}
function zeros(n: number, len: number): string {
  const neg = n < 0;
  const digits = Math.round(Math.abs(n)).toString().padStart(len, '0');
  if (digits.length > len) throw new RangeError(`value ${n} does not fit in ${len} digits`);
  return digits;
}
function cents(n: number): number {
  return Math.round(n * 100);
}
function toAammdd(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${(y ?? '').slice(2)}${m}${d}`;
}
function signChar(n: number): '1' | '2' {
  return n < 0 ? '1' : '2';
}
function line80(s: string): string {
  if (s.length !== 80) throw new RangeError(`record must be exactly 80 chars, got ${s.length}: ${s}`);
  return s;
}

function record11(a: N43WriteAccount): string {
  const openC = cents(a.openingBalance);
  return line80(
    '11' +
      pad(a.entidad, 4) +
      pad(a.oficina, 4) +
      pad(a.cuenta, 10) +
      toAammdd(a.periodFrom) +
      toAammdd(a.periodTo) +
      signChar(openC) +
      zeros(openC, 14) +
      '978' + // EUR
      '1' + // modalidad
      pad(ascii(a.holderName), 26) +
      pad('', 3),
  );
}

function record22(a: N43WriteAccount, m: N43WriteMovement): string {
  const amtC = cents(m.amount);
  return line80(
    '22' +
      pad(a.entidad, 4) +
      pad(a.oficina, 4) +
      toAammdd(m.opDate) +
      toAammdd(m.valueDate ?? m.opDate) +
      pad(m.conceptoComun, 2) +
      pad(m.conceptoPropio ?? '', 3) +
      signChar(amtC) +
      zeros(amtC, 14) +
      pad(m.documentNumber ?? '', 10) +
      pad(ascii(m.ref1 ?? ''), 12) +
      pad(ascii(m.ref2 ?? ''), 16),
  );
}

function record23(c1: string, c2: string): string {
  return line80('23' + '01' + pad(ascii(c1), 38) + pad(ascii(c2), 38));
}

function record33(a: N43WriteAccount): string {
  let debitCount = 0;
  let debitCents = 0;
  let creditCount = 0;
  let creditCents = 0;
  for (const m of a.movements) {
    const c = cents(m.amount);
    if (c < 0) {
      debitCount++;
      debitCents += -c;
    } else {
      creditCount++;
      creditCents += c;
    }
  }
  const closingCents = cents(a.openingBalance) - debitCents + creditCents;
  return line80(
    '33' +
      pad(a.entidad, 4) +
      pad(a.oficina, 4) +
      pad(a.cuenta, 10) +
      zeros(debitCount, 5) +
      zeros(debitCents, 14) +
      zeros(creditCount, 5) +
      zeros(creditCents, 14) +
      signChar(closingCents) +
      zeros(closingCents, 14) +
      '978' +
      pad('', 4),
  );
}

function record88(declaredCount: number): string {
  return line80('88' + pad('', 18) + zeros(declaredCount, 6) + pad('', 54));
}

/** Serialise one or more account blocks to a Norma 43 file (CRLF-separated 80-char records). */
export function writeNorma43(accounts: readonly N43WriteAccount[]): string {
  const lines: string[] = [];
  let recordCount = 0;
  for (const a of accounts) {
    lines.push(record11(a));
    recordCount++;
    for (const m of a.movements) {
      lines.push(record22(a, m));
      recordCount++;
      const concepts = m.concepts ?? [];
      if (concepts.length > 0) {
        lines.push(record23(concepts[0] ?? '', concepts[1] ?? ''));
        recordCount++;
      }
    }
    lines.push(record33(a));
    recordCount++;
  }
  lines.push(record88(recordCount));
  return lines.join('\r\n') + '\r\n';
}

/** Closing balance implied by an account's movements (mirrors the reader's own derivation). */
export function impliedClosing(a: N43WriteAccount): number {
  const sum = a.movements.reduce((acc, m) => acc + m.amount, 0);
  return Math.round((a.openingBalance + sum) * 100) / 100;
}
