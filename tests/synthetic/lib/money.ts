/**
 * Amount helpers, built on `@viladomat/core`'s Spanish-notation formatter so every printed
 * figure (`1.234,56 €`) and every `expected.json` figure (plain number, 2 decimals) agree.
 */
import { formatAmountEs, parseAmountEs } from '../../../packages/core/src/text/amounts.ts';

export { parseAmountEs };

/** Round to 2 decimals (cents), banker's-rounding-free (half-up on the absolute value). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** `1234.5` -> `"1.234,50 €"`. */
export function eur(n: number): string {
  return formatAmountEs(round2(n), { currency: true });
}

/** `1234.5` -> `"1.234,50"` (no currency sign; used inside table cells with a header unit). */
export function num(n: number): string {
  return formatAmountEs(round2(n));
}

/** One invoice/quote line. */
export interface Line {
  desc: string;
  qty: number;
  unit: string;
  unitPrice: number;
}

export function lineAmount(l: Line): number {
  return round2(l.qty * l.unitPrice);
}

export function sumLines(lines: readonly Line[]): number {
  return round2(lines.reduce((acc, l) => acc + lineAmount(l), 0));
}

/** Result of {@link computeInvoiceTotals}. */
export interface InvoiceTotals {
  /** True sum of the printed line amounts. */
  lineSum: number;
  /** "Base imponible" as printed on the invoice (may deliberately differ from `lineSum`). */
  base: number;
  ivaPct: number;
  iva: number;
  irpfPct: number;
  irpf: number;
  total: number;
}

/**
 * Compute an invoice's totals. `printedBaseOverride`, when given, is what the document
 * *prints* as "Base imponible" even though it differs from the true sum of its lines — this
 * is exactly how the planted C2 arithmetic mismatch is built: the vendor's own error, not a
 * rendering bug.
 */
export function computeInvoiceTotals(
  lines: readonly Line[],
  ivaPct: number,
  irpfPct = 0,
  printedBaseOverride?: number,
): InvoiceTotals {
  const lineSum = sumLines(lines);
  const base = printedBaseOverride ?? lineSum;
  const iva = round2((base * ivaPct) / 100);
  const irpf = irpfPct ? round2((base * irpfPct) / 100) : 0;
  const total = round2(base + iva - irpf);
  return { lineSum, base, ivaPct, iva, irpfPct, irpf, total };
}
