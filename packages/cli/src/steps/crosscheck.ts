import { normaliseValue } from '@viladomat/core';
import { query, transaction } from '../lib/db.ts';
import { isCriticalPath, kindForPath, type DocType } from '../extract/adapter.ts';
import { valueKindOf } from '../extract/persist.ts';
import type { StepJob, StepResult } from './types.ts';

/**
 * Step `crosscheck` — the second reader.
 *
 * Every monetary or identity field the model returned carries a verbatim quote and, usually, a box.
 * This step finds that quote again in the Tesseract word boxes of the same page, normalises what
 * the words say with the same function that normalised the model's value, and compares the two.
 *
 * The comparison decides two things. `crop_status` records how firmly the value is anchored to the
 * paper — `anchored` when the located words sit inside the box the model returned (the only crops
 * that may ever be printed), `approximate` when they were found elsewhere on the page, `page_only`
 * when they were not found at all. And `status` implements the two-source rule: a field is
 * `auto_accepted` only when the validators of its family passed **and** the two readers agree,
 * `needs_review` otherwise.
 *
 * A field a person has confirmed or corrected is never touched.
 *
 * Idempotent: it recomputes from `ocr_words` and `field_values` and writes the same answer.
 */

/** Words are searched inside the model's box grown by this fraction of its size before falling back to the page. */
export const BBOX_MARGIN = 0.25;

/** A candidate window must reach this similarity to count as located. */
export const MATCH_MIN_SCORE = 0.82;

/** One OCR word with its box, in the pixel coordinates of the stored render. */
export interface OcrWord {
  idx: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Bbox = [number, number, number, number];

/** Comparison form used to line quote text up with OCR text: letters, digits and separators only. */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[€$£]/g, ' ')
    .replace(/[^0-9a-z.,%/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens of a quote, in order. */
export function tokenise(value: string): string[] {
  const folded = foldForMatch(value);
  return folded === '' ? [] : folded.split(' ');
}

/** Levenshtein distance, capped by the longer string's length. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? a.length;
}

/** 1 for identical strings, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** True when a word's box lies inside the given box grown by {@link BBOX_MARGIN}. */
export function insideBbox(word: OcrWord, bbox: Bbox, margin: number = BBOX_MARGIN): boolean {
  const [x0, y0, x1, y1] = bbox;
  const dx = Math.max(2, (x1 - x0) * margin);
  const dy = Math.max(2, (y1 - y0) * margin);
  const cx = (word.x0 + word.x1) / 2;
  const cy = (word.y0 + word.y1) / 2;
  return cx >= x0 - dx && cx <= x1 + dx && cy >= y0 - dy && cy <= y1 + dy;
}

/** Where a quote was found, and how firmly. */
export interface QuoteMatch {
  /** Text of the located words, joined with single spaces. */
  text: string;
  /** Indexes into the word array that were matched. */
  words: OcrWord[];
  score: number;
  /** True when every located word sits inside the model's box. */
  insideBbox: boolean;
  /** Which search found it. */
  scope: 'bbox' | 'page';
}

function windowSearch(words: readonly OcrWord[], target: string, tokenCount: number): { words: OcrWord[]; score: number } | null {
  if (words.length === 0 || tokenCount === 0) return null;
  let best: { words: OcrWord[]; score: number } | null = null;
  const sizes = [...new Set([tokenCount, tokenCount + 1, tokenCount - 1, tokenCount + 2].filter((n) => n >= 1))];
  for (const size of sizes) {
    for (let start = 0; start + size <= words.length; start++) {
      const slice = words.slice(start, start + size);
      const candidate = slice
        .map((w) => foldForMatch(w.text))
        .filter((t) => t !== '')
        .join(' ');
      if (candidate === '') continue;
      const score = similarity(candidate, target);
      if (!best || score > best.score) best = { words: slice, score };
      if (score === 1) return best;
    }
  }
  return best;
}

/**
 * Locate a verbatim quote in the OCR words of a page.
 *
 * The box the model returned is tried first — a value read from the right place on the page is
 * worth more than the same digits found in a different row of a table — and the whole page is the
 * fallback. Matching is fuzzy on purpose: Tesseract splits and joins tokens differently from the
 * model, so an exact string comparison would reject readings that plainly agree.
 */
export function locateQuote(words: readonly OcrWord[], quote: string | null, bbox: Bbox | null): QuoteMatch | null {
  const target = foldForMatch(quote ?? '');
  if (target === '') return null;
  const tokenCount = tokenise(quote ?? '').length;
  const ordered = [...words].sort((a, b) => a.idx - b.idx);

  const attempts: { scope: 'bbox' | 'page'; pool: OcrWord[] }[] = [];
  if (bbox) {
    const pool = ordered.filter((w) => insideBbox(w, bbox));
    if (pool.length > 0) attempts.push({ scope: 'bbox', pool });
  }
  attempts.push({ scope: 'page', pool: ordered });

  let best: QuoteMatch | null = null;
  for (const attempt of attempts) {
    const found = windowSearch(attempt.pool, target, tokenCount);
    if (!found || found.score < MATCH_MIN_SCORE) continue;
    const match: QuoteMatch = {
      text: found.words.map((w) => w.text).join(' '),
      words: found.words,
      score: found.score,
      insideBbox: bbox !== null && found.words.every((w) => insideBbox(w, bbox)),
      scope: attempt.scope,
    };
    if (!best || match.score > best.score) best = match;
    if (attempt.scope === 'bbox' && match.score >= MATCH_MIN_SCORE) break;
  }
  return best;
}

/** `field_values.crop_status` for a located (or unlocated) quote. */
export function cropStatusFor(match: QuoteMatch | null, bbox: Bbox | null): 'anchored' | 'approximate' | 'page_only' {
  if (!match) return 'page_only';
  if (bbox && match.insideBbox) return 'anchored';
  return 'approximate';
}

/** The two-source rule, in one line. */
export function twoSourceStatus(validatorOk: boolean | null, ocrAgrees: boolean | null): 'auto_accepted' | 'needs_review' {
  return validatorOk === true && ocrAgrees === true ? 'auto_accepted' : 'needs_review';
}

interface FieldRow {
  id: string;
  field_path: string;
  value: unknown;
  value_norm: string | null;
  page_id: string | null;
  bbox: number[] | null;
  quote: string | null;
  validator_ok: boolean | null;
  status: string;
}

/** Statuses this step must leave alone. */
export const PROTECTED_STATUSES: ReadonlySet<string> = new Set(['human_confirmed', 'corrected']);

export async function crosscheckStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const documentId = typeof payload.document_id === 'string' ? payload.document_id : '';
  if (!documentId) throw new Error('crosscheck: payload.document_id is required');

  const doc = (
    await query<{ id: string; doc_type: DocType; community_id: string }>('select id, doc_type, community_id from public.documents where id = $1', [
      documentId,
    ])
  )[0];
  if (!doc) throw new Error(`crosscheck: document ${documentId} not found`);

  const fields = await query<FieldRow>(
    `select id, field_path, value, value_norm, page_id, bbox, quote, validator_ok, status
       from public.field_values where document_id = $1 order by field_path`,
    [documentId],
  );

  const wordsByPage = new Map<string, OcrWord[]>();
  const loadWords = async (pageId: string): Promise<OcrWord[]> => {
    const cached = wordsByPage.get(pageId);
    if (cached) return cached;
    const rows = await query<OcrWord>('select idx, text, x0, y0, x1, y1 from public.ocr_words where page_id = $1 order by idx', [pageId]);
    wordsByPage.set(pageId, rows);
    return rows;
  };

  const counts = { checked: 0, auto_accepted: 0, needs_review: 0, anchored: 0, approximate: 0, page_only: 0, protected: 0, not_critical: 0 };
  const updates: { id: string; ocrValue: string | null; agrees: boolean | null; crop: string; status: string }[] = [];

  for (const field of fields) {
    if (!isCriticalPath(doc.doc_type, field.field_path)) {
      counts.not_critical += 1;
      continue;
    }
    if (PROTECTED_STATUSES.has(field.status)) {
      counts.protected += 1;
      continue;
    }
    counts.checked += 1;
    const bbox = field.bbox && field.bbox.length === 4 ? ([field.bbox[0], field.bbox[1], field.bbox[2], field.bbox[3]] as Bbox) : null;
    const words = field.page_id ? await loadWords(field.page_id) : [];
    const match = locateQuote(words, field.quote, bbox);
    const kind = kindForPath(field.field_path, field.value);
    const ocrValue = match ? normaliseValue(valueKindOf(kind), match.text) : null;
    const agrees = match ? field.value_norm !== null && ocrValue !== null && field.value_norm === ocrValue : null;
    const crop = cropStatusFor(match, bbox);
    const status = twoSourceStatus(field.validator_ok, agrees);
    counts[crop] += 1;
    if (status === 'auto_accepted') counts.auto_accepted += 1;
    else counts.needs_review += 1;
    updates.push({ id: field.id, ocrValue, agrees, crop, status });
  }

  await transaction(async (client) => {
    for (const u of updates) {
      await client.query(
        `update public.field_values
            set ocr_value_norm = $2, ocr_agrees = $3, crop_status = $4::public.crop_status, status = $5::public.field_status
          where id = $1 and status not in ('human_confirmed', 'corrected')`,
        [u.id, u.ocrValue, u.agrees, u.crop, u.status],
      );
    }
    await client.query(`update public.documents set status = 'verified' where id = $1 and status <> 'reviewed'`, [documentId]);
  });

  console.log(
    `crosscheck ${documentId}: ${counts.checked} critical field(s), ${counts.auto_accepted} auto-accepted, ` +
      `${counts.needs_review} for review, ${counts.anchored} anchored crop(s)` +
      `${counts.protected > 0 ? `, ${counts.protected} left as confirmed by a person` : ''}`,
  );
  return { document_id: documentId, ...counts };
}
