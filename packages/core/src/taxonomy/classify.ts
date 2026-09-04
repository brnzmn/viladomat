/**
 * Mapping a line description to a taxonomy category, and reading the quantity and unit out of
 * it. Matching is accent-insensitive and lightly stemmed so that Spanish and Catalan plurals
 * and gender endings collapse onto the same token.
 *
 * The order follows `docs/taxonomy.md` §1: vendor memory first, then keywords; the model
 * classifier and the human override live outside this module and are stored in separate
 * columns so both values stay visible.
 */
import { parseAmountEs, stripDiacritics } from '../text/amounts.ts';
import {
  CATEGORIES,
  UNCLASSIFIED_CODE,
  categoryByCode,
  type BenchmarkCategory,
} from './categories.ts';

/** Options for {@link classifyLine}. */
export interface ClassifyOptions {
  /**
   * Category the vendor has already been mapped to. It is kept unless the line clearly points
   * somewhere else (see {@link VENDOR_OVERRIDE_MARGIN}).
   */
  vendorHint?: string;
}

/** Result of {@link classifyLine}. */
export interface Classification {
  /** Category code, `MISC` when nothing matched. */
  code: string;
  /** Confidence in [0, 1]; below `0.6` the line belongs in the review queue. */
  confidence: number;
  /** Keywords that matched, in the form written in `categories.ts`. */
  matchedKeywords: string[];
}

/**
 * Weighted keyword advantage another category needs before it overrides the vendor memory.
 * One two-word keyword (weight 2) is enough; a single generic word is not.
 */
export const VENDOR_OVERRIDE_MARGIN = 2;

/** Confidence at or above which a classification may be used without a human look. */
export const CLASSIFY_ACCEPT_THRESHOLD = 0.6;

/**
 * Normalise text for matching: NFD accent stripping, geminate `l·l` collapsed to `ll`,
 * lowercase, everything that is not a letter or digit turned into a separator.
 */
export function normaliseForMatch(s: string): string {
  return stripDiacritics(s.normalize('NFC').replace(/[·‧]/g, ''))
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/**
 * Trim the endings that separate Spanish and Catalan plurals and gender forms from their stem
 * (`parets` → `paret`, `graons` → `graon`, `plástica` → `plastic`). Deliberately shallow: it
 * only has to make the keyword lists and the document text meet.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length > 5 && (t.endsWith('ces') || t.endsWith('nes') || t.endsWith('res'))) {
    t = t.slice(0, -2);
  } else if (t.length > 5 && t.endsWith('es')) {
    t = t.slice(0, -2);
  } else if (t.length > 4 && t.endsWith('s')) {
    t = t.slice(0, -1);
  }
  if (t.length > 4 && (t.endsWith('a') || t.endsWith('o'))) t = t.slice(0, -1);
  return t;
}

/** Normalise, split and stem a piece of text. */
export function tokenise(s: string): string[] {
  const norm = normaliseForMatch(s);
  if (!norm) return [];
  return norm.split(' ').filter(Boolean).map(stem);
}

interface KeywordPattern {
  /** Keyword as written in `categories.ts`. */
  raw: string;
  /** Stemmed tokens of the keyword. */
  tokens: string[];
}

interface CompiledCategory {
  category: BenchmarkCategory;
  keywords: KeywordPattern[];
}

function compile(): CompiledCategory[] {
  return CATEGORIES.map((category) => {
    const seen = new Set<string>();
    const keywords: KeywordPattern[] = [];
    for (const raw of [...category.keywordsEs, ...category.keywordsCa]) {
      const tokens = tokenise(raw);
      if (tokens.length === 0) continue;
      const key = tokens.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      keywords.push({ raw, tokens });
    }
    return { category, keywords };
  });
}

const COMPILED = compile();

/** Whether `needle` appears as a contiguous run inside `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

interface Score {
  code: string;
  score: number;
  matched: string[];
}

function scoreAll(description: string): Score[] {
  const tokens = tokenise(description);
  const scores: Score[] = [];
  for (const { category, keywords } of COMPILED) {
    let score = 0;
    const matched: string[] = [];
    for (const kw of keywords) {
      if (!containsRun(tokens, kw.tokens)) continue;
      // a multi-word keyword is that much more specific than a single generic word
      score += kw.tokens.length;
      matched.push(kw.raw);
    }
    if (score > 0) scores.push({ code: category.code, score, matched });
  }
  scores.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return scores;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Confidence from the best score and the runner-up. */
function confidenceOf(best: number, second: number): number {
  const margin = best > 0 ? (best - second) / best : 0;
  const strength = Math.min(1, best / 3);
  return round2(Math.min(0.95, 0.35 + 0.35 * strength + 0.25 * margin));
}

/**
 * Map a line description to a category.
 *
 * With a `vendorHint` the vendor's category is kept unless the line's keywords point elsewhere
 * by at least {@link VENDOR_OVERRIDE_MARGIN} weighted points. With no keyword hit and no hint
 * the line goes to `MISC` with confidence 0, which sends it to the review queue.
 */
export function classifyLine(
  description: string | null | undefined,
  options: ClassifyOptions = {},
): Classification {
  const hint = categoryByCode(options.vendorHint)?.code;
  const scores = description ? scoreAll(description) : [];
  const best = scores[0];
  const second = scores[1];

  if (!best) {
    return hint
      ? { code: hint, confidence: 0.5, matchedKeywords: [] }
      : { code: UNCLASSIFIED_CODE, confidence: 0, matchedKeywords: [] };
  }

  const bestConfidence = confidenceOf(best.score, second?.score ?? 0);
  if (!hint) return { code: best.code, confidence: bestConfidence, matchedKeywords: best.matched };

  if (best.code === hint) {
    return {
      code: hint,
      confidence: round2(Math.min(0.98, bestConfidence + 0.1)),
      matchedKeywords: best.matched,
    };
  }

  const hintScore = scores.find((s) => s.code === hint);
  if (
    best.code !== UNCLASSIFIED_CODE &&
    best.score - (hintScore?.score ?? 0) >= VENDOR_OVERRIDE_MARGIN
  ) {
    // the line says otherwise: follow it, but with a little less confidence
    return {
      code: best.code,
      confidence: round2(bestConfidence * 0.9),
      matchedKeywords: best.matched,
    };
  }
  return { code: hint, confidence: 0.55, matchedKeywords: hintScore?.matched ?? [] };
}

/** Units a quantity can be read in. */
export type QuantityUnit = 'm2' | 'ml' | 'ud' | 'pa' | 'h' | 'mes' | 'pct' | 'kg' | 'm3';

/** Result of {@link extractQuantity}. */
export interface ExtractedQuantity {
  /** Quantity, or null when only a unit was recognised (a lump sum, for instance). */
  qty: number | null;
  /** Normalised unit, or null when none was recognised. */
  unit: QuantityUnit | null;
  /** The text that produced the match, for the evidence quote. */
  raw: string | null;
}

/**
 * Unit tokens, longest first so that `m2` wins over `m`. A bare `m` is read as linear metres:
 * it is the only way a linear metre is written in a partida, and square metres always carry
 * the `2`/`²`.
 */
const UNIT_TOKENS: ReadonlyArray<readonly [RegExp, QuantityUnit]> = [
  [/^(m2|m²|m\.2|metros?cuadrados?|metres?quadrats?)$/, 'm2'],
  [/^(m3|m³|metros?cubicos?|metres?cubics?)$/, 'm3'],
  [/^(ml|m\.l\.?|metros?lineales?|metres?lineals?)$/, 'ml'],
  [/^(ud|uds|u|unidad|unidades|unitat|unitats)$/, 'ud'],
  [/^(pa|p\.a\.?)$/, 'pa'],
  [/^(h|hora|horas|hores)$/, 'h'],
  [/^(mes|meses|mesos|mensual|mensualidad|mensualitat)$/, 'mes'],
  [/^(kg|kgs|kilos?|quilos?)$/, 'kg'],
  [/^(m)$/, 'ml'],
];

/** Lump-sum markers that stand for a unit even without a number. */
const LUMP_SUM = /\b(p\.?\s*a\.?|partida\s+alzada|partida\s+alcada|a\s+justificar)\b/;

function unitOf(token: string): QuantityUnit | null {
  const t = token.toLowerCase();
  for (const [re, unit] of UNIT_TOKENS) {
    if (re.test(t)) return unit;
  }
  return null;
}

/**
 * Read the quantity and unit out of a line description.
 *
 * Recognises `m2`/`m²`, `ml`, a bare `m`, `ud`/`uds`, `pa` (partida alzada), `h`, `mes`/
 * `mesos`, `%`, `kg` and `m3`. Quantities written as `1.234,56` are normalised to `1234.56`.
 * The first number followed by a recognised unit wins; a percentage anywhere in the line is
 * returned only when no other unit was found, because percentages usually label a neighbouring
 * figure (VAT, retention, general expenses) rather than the line quantity.
 */
export function extractQuantity(description: string | null | undefined): ExtractedQuantity {
  const empty: ExtractedQuantity = { qty: null, unit: null, raw: null };
  if (!description) return empty;

  const text = stripDiacritics(description.normalize('NFC').replace(/[·‧]/g, '')).toLowerCase();

  // number followed by a unit token, with an optional separator
  const numberUnit =
    /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(m2|m²|m3|m³|ml|m\.l\.?|m\.2|kgs|kg|kilos|quilos|uds|ud|unidades|unidad|unitats|unitat|u|p\.a\.?|pa|horas|hores|hora|h|mensualidades|mensualitats|meses|mesos|mensual|mes|metros? cuadrados|metres? quadrats|metros? lineales|metres? lineals|metros? cubicos|metres? cubics|m)\b/g;
  let match: RegExpExecArray | null;
  while ((match = numberUnit.exec(text)) !== null) {
    const unit = unitOf((match[2] ?? '').replace(/\s+/g, ''));
    if (!unit) continue;
    const qty = parseAmountEs(match[1] ?? '');
    if (qty === null) continue;
    return { qty, unit, raw: match[0].trim() };
  }

  if (LUMP_SUM.test(text)) {
    const lump = LUMP_SUM.exec(text);
    return { qty: null, unit: 'pa', raw: lump ? lump[0].trim() : null };
  }

  const pct = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
  if (pct) return { qty: parseAmountEs(pct[1] ?? ''), unit: 'pct', raw: pct[0].trim() };

  return empty;
}
