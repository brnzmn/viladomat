/**
 * Amount and date parsing for Spanish/Catalan documents, plus the canonical value
 * normalisation used by the two-source rule (a field is auto-accepted only when two
 * independent readers produce the same canonical string).
 */
import { normaliseNif } from '../ids/nif.ts';
import { normaliseIban } from '../ids/iban.ts';

/** Strip diacritics (NFD, remove combining marks). */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Groups separated by `sep` must be a leading group of 1–3 digits followed by 3-digit groups. */
function joinThousands(part: string, sep: string): string | null {
  const groups = part.split(sep);
  if (groups.length === 1) return part;
  const first = groups[0] ?? '';
  if (first.length < 1 || first.length > 3) return null;
  for (let i = 1; i < groups.length; i++) {
    if ((groups[i] ?? '').length !== 3) return null;
  }
  return groups.join('');
}

/**
 * Parse an amount written in Spanish or international notation.
 *
 * Accepted: `1.234,56`, `1234,56`, `1,234.56`, `1234.56`, `€ 1.234,56`, `1.234,56 €`,
 * `-1.234,56`, `1.234,56-` (trailing minus as on some statements), `(1.234,56)`,
 * `1.234` (a single dot followed by exactly three digits is read as a thousands separator,
 * so → 1234). A single comma is always a decimal separator (`1,234` → 1.234).
 *
 * @returns the number, or `null` when the text is not an amount.
 */
export function parseAmountEs(text: string | number | null | undefined): number | null {
  if (text == null) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  let s = String(text).normalize('NFKC').trim();
  if (!s) return null;
  s = s.replace(/€|\$|£/g, ' ');
  s = s.replace(/\b(EUR|EUROS?|USD|GBP)\b/gi, ' ');
  s = s.replace(/[\s\u00A0\u202F]+/g, '');
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^(\d[\d.,]*|[.,]\d+)$/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let fracPart = '';

  if (lastComma >= 0 && lastDot >= 0) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const parts = s.split(decSep);
    if (parts.length !== 2) return null;
    const joined = joinThousands(parts[0] ?? '', thouSep);
    if (joined === null) return null;
    intPart = joined;
    fracPart = parts[1] ?? '';
    if (fracPart.includes(thouSep)) return null;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length === 2) {
      intPart = parts[0] ?? '';
      fracPart = parts[1] ?? '';
    } else {
      const joined = joinThousands(s, ',');
      if (joined === null) return null;
      intPart = joined;
    }
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length === 2 && (parts[1] ?? '').length !== 3) {
      intPart = parts[0] ?? '';
      fracPart = parts[1] ?? '';
    } else {
      const joined = joinThousands(s, '.');
      if (joined === null) return null;
      intPart = joined;
    }
  } else {
    intPart = s;
  }

  if (intPart === '' && fracPart === '') return null;
  const value = Number(`${intPart || '0'}.${fracPart || '0'}`);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Options for {@link formatAmountEs}. */
export interface FormatAmountOptions {
  /** Number of decimals (default 2). */
  decimals?: number;
  /** Append ` €` (default false). */
  currency?: boolean;
}

/** Format a number in Spanish notation: `1.234,56` (optionally with ` €`). */
export function formatAmountEs(n: number, options: FormatAmountOptions = {}): string {
  const decimals = options.decimals ?? 2;
  const sign = n < 0 ? '-' : '';
  const factor = 10 ** decimals;
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * factor) / factor;
  const fixed = rounded.toFixed(decimals);
  const [intPart = '0', fracPart = ''] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = fracPart ? `${grouped},${fracPart}` : grouped;
  return `${sign}${body}${options.currency ? ' €' : ''}`;
}

/** Month names and abbreviations (Spanish, Catalan, English), diacritics stripped, lower case. */
const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  enero: 1,
  ene: 1,
  gener: 1,
  gen: 1,
  january: 1,
  jan: 1,
  febrero: 2,
  feb: 2,
  febrer: 2,
  febr: 2,
  february: 2,
  marzo: 3,
  mar: 3,
  marc: 3,
  march: 3,
  abril: 4,
  abr: 4,
  april: 4,
  apr: 4,
  mayo: 5,
  may: 5,
  maig: 5,
  junio: 6,
  jun: 6,
  juny: 6,
  june: 6,
  julio: 7,
  jul: 7,
  juliol: 7,
  july: 7,
  agosto: 8,
  ago: 8,
  agost: 8,
  ag: 8,
  august: 8,
  aug: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  sept: 9,
  set: 9,
  setembre: 9,
  september: 9,
  octubre: 10,
  oct: 10,
  october: 10,
  noviembre: 11,
  nov: 11,
  novembre: 11,
  november: 11,
  diciembre: 12,
  dic: 12,
  desembre: 12,
  des: 12,
  december: 12,
  dec: 12,
});

/** Two-digit years: < 70 → 20xx, otherwise 19xx (same convention as Norma 43). */
export function expandTwoDigitYear(yy: number): number {
  return yy < 70 ? 2000 + yy : 1900 + yy;
}

/** Build an ISO date string when the calendar date exists, else null. */
export function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function yearFrom(text: string): number {
  const n = Number(text);
  return text.length === 2 ? expandTwoDigitYear(n) : n;
}

const ISO_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const NUMERIC_RE = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/;
const TEXTUAL_RE =
  /(?<!\d)(\d{1,2})(?:r|n|er|e|a|st|nd|rd|th)?[\s\-/.]*(?:de\s+|d')?([a-z]{2,10})\.?[\s\-/.]*(?:de\s+|del\s+|de\s+l')?(\d{4}|\d{2})(?!\d)/;

/**
 * Parse a date written as `dd/mm/yyyy`, `dd-mm-yyyy`, `dd.mm.yy`, `d de <mes> de yyyy`
 * (Spanish and Catalan month names, including `d'abril` and `del 2023`), or ISO
 * `yyyy-mm-dd`. The date may be embedded in a short text ("Barcelona, 3 de març de 2023").
 *
 * @returns ISO `yyyy-mm-dd`, or `null` when no valid date is found.
 */
export function parseDateEs(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = stripDiacritics(String(text).normalize('NFKC')).toLowerCase().trim();
  if (!s) return null;

  const iso = ISO_RE.exec(s);
  if (iso) {
    const r = toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (r) return r;
  }

  const num = NUMERIC_RE.exec(s);
  if (num) {
    const r = toIsoDate(yearFrom(num[3] ?? ''), Number(num[2]), Number(num[1]));
    if (r) return r;
  }

  const txt = TEXTUAL_RE.exec(s);
  if (txt) {
    const month = MONTHS[txt[2] ?? ''];
    if (month) {
      const r = toIsoDate(yearFrom(txt[3] ?? ''), month, Number(txt[1]));
      if (r) return r;
    }
  }

  return null;
}

/** Field kinds understood by {@link normaliseValue}. */
export type ValueKind = 'amount' | 'date' | 'nif' | 'iban' | 'text';

/**
 * Canonical comparison string for the two-source rule.
 *
 * - `amount` → fixed two decimals (`"1234.56"`), or null when unparseable;
 * - `date` → ISO `yyyy-mm-dd`, or null;
 * - `nif` → {@link normaliseNif};
 * - `iban` → {@link normaliseIban};
 * - `text` → diacritics stripped, lower case, whitespace collapsed.
 */
export function normaliseValue(
  kind: ValueKind,
  raw: string | number | null | undefined,
): string | null {
  if (raw == null) return null;
  switch (kind) {
    case 'amount': {
      const n = parseAmountEs(raw);
      return n === null
        ? null
        : (Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100).toFixed(2);
    }
    case 'date':
      return parseDateEs(String(raw));
    case 'nif': {
      const n = normaliseNif(String(raw));
      return n || null;
    }
    case 'iban': {
      const n = normaliseIban(String(raw));
      return n || null;
    }
    case 'text': {
      const t = stripDiacritics(String(raw).normalize('NFKC'))
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      return t || null;
    }
    default:
      return null;
  }
}
