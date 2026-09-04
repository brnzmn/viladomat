/**
 * Document-level normalisation helpers: invoice-number parsing and the deterministic
 * dedupe key used before any counting rule runs.
 */
import { normaliseNif } from '../ids/nif.ts';
import { parseAmountEs, parseDateEs, stripDiacritics } from './amounts.ts';

/** Result of {@link normaliseInvoiceNumber}. */
export interface InvoiceNumberParts {
  /** Series: everything before the final digit run, upper case, separators removed. */
  series: string;
  /** Final digit run as an integer (leading zeros dropped), or null when there is none. */
  numberInt: number | null;
  /** Letters following the final digit run (e.g. `7 B` → `B`), upper case. */
  suffix: string;
  /** `series-numberInt[-suffix]`, or the cleaned raw text when there is no number. */
  canonical: string;
}

/**
 * Split an invoice number into series and sequential number.
 *
 * `F-2023/001` → `{ series: 'F2023', numberInt: 1, suffix: '', canonical: 'F2023-1' }`.
 * Separators (space, `-`, `/`, `.`, `_`, `:`) are removed from the series so that
 * `F 2023/001`, `F-2023-001` and `F2023/0001` produce the same canonical form.
 */
export function normaliseInvoiceNumber(raw: string | null | undefined): InvoiceNumberParts {
  const cleaned = stripDiacritics(String(raw ?? '').normalize('NFKC'))
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.*?)(\d+)[\s\-/._:]*([A-Z]*)[\s\-/._:]*$/.exec(cleaned);
  if (!m) {
    const series = cleaned.replace(/[\s\-/._:]+/g, '');
    return { series, numberInt: null, suffix: '', canonical: series };
  }
  const series = (m[1] ?? '').replace(/[\s\-/._:]+/g, '');
  const numberInt = Number.parseInt(m[2] ?? '0', 10);
  const suffix = m[3] ?? '';
  const canonical = [series, String(numberInt), suffix].filter(Boolean).join('-');
  return { series, numberInt, suffix, canonical };
}

/** Input of {@link dedupeKey}. */
export interface DedupeKeyInput {
  vendorNif: string | null | undefined;
  serie: string | null | undefined;
  numero: string | null | undefined;
  total: number | string | null | undefined;
  fecha: string | null | undefined;
}

/**
 * Deterministic document-level dedupe key on `(vendor_nif, serie+numero, total, fecha)`.
 *
 * `vendorNif` is normalised, the series field and the number's own series are concatenated,
 * the number is reduced to its integer value, the total is fixed to two decimals and the
 * date to ISO. Unparseable totals/dates fall back to their trimmed raw text so the key is
 * still deterministic. Format: `NIF|SERIES|NUMBER|TOTAL|DATE`.
 */
export function dedupeKey(input: DedupeKeyInput): string {
  const nif = normaliseNif(input.vendorNif);
  const serie = normaliseInvoiceNumber(input.serie).canonical.replace(/-/g, '');
  const numero = normaliseInvoiceNumber(input.numero);
  const series = `${serie}${numero.series}`;
  const number =
    numero.numberInt === null ? numero.canonical : `${numero.numberInt}${numero.suffix}`;
  const totalNum = parseAmountEs(input.total);
  const total = totalNum === null ? String(input.total ?? '').trim() : totalNum.toFixed(2);
  const fecha = parseDateEs(input.fecha) ?? String(input.fecha ?? '').trim();
  return [nif, series, number, total, fecha].join('|');
}
