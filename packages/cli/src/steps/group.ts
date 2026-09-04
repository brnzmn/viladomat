import sharp from 'sharp';
import { maybeOne, one, query, transaction } from '../lib/db.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import {
  MODELS,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  classifyPagesDetailed,
  extractionClient,
  type DocType,
  type PageClassification,
  type PageImage,
} from '../extract/adapter.ts';
import type { StepJob, StepResult } from './types.ts';

/**
 * Step `group` — pages of one delivery batch become documents.
 *
 * Three stages, in this order, because each one is only allowed to use what the previous one
 * established:
 *
 *   A. **Deterministic order.** The sequence of pages is fixed before any model sees them, so the
 *      grouping is reproducible and a re-run cannot reorder the corpus: pages of one file keep the
 *      file's own order (a PDF is already a sequence), and files are ordered by capture time, then
 *      by a natural sort of the original name, then by upload time.
 *   B. **Page classification.** `claude-sonnet-5` reads the 768 px thumbnail of each page with two
 *      previous and one following page as context, and returns type, role, issuer/number/date
 *      hints, the printed page marker and whether the page continues the previous one. One
 *      `extraction_runs` row per page (stage `classify`), request stored without the image bytes.
 *   C. **Union-find.** Consecutive pages are joined by the rules in {@link linkPages}: the
 *      classifier's `continues_previous`, a shared document number and issuer, a printed page-marker
 *      chain, or simply being consecutive pages of the same PDF. Groups are capped at 30 pages.
 *
 * Nothing is enqueued afterwards: a human confirms the grouping, and `vx extract` takes over.
 *
 * Idempotent: pages that already belong to a document are excluded before stage A, so a re-run only
 * groups what is left; a page classification already stored as a succeeded run is reused instead of
 * being requested again.
 */

/** A group never exceeds this many pages; the cap breaks runaway chains, it is not a document rule. */
export const MAX_GROUP_PAGES = 30;

/** `continues_previous` is only acted on at or above this confidence. */
export const CONTINUES_MIN_CONFIDENCE = 0.8;

/** Confidence attributed to each kind of deterministic link (the classifier supplies its own). */
export const LINK_CONFIDENCE = Object.freeze({
  samePdfFile: 0.9,
  pageMarkerChain: 0.9,
  numberAndIssuer: 0.85,
  /** A group of one page: no join was made, so no join can be wrong. */
  singlePage: 1,
});

// ---------------------------------------------------------------------------
// Stage A — deterministic ordering
// ---------------------------------------------------------------------------

/** One page of the batch, with what stage A needs to place it and stage C needs to join it. */
export interface BatchPage {
  page_id: string;
  file_id: string;
  page_no: number;
  /** `derived/<cid>/<sha>/t<n>.jpg`. */
  thumb_path: string | null;
  mime: string | null;
  original_name: string;
  /** Seconds since the epoch, or null when the file carries no capture time. */
  capture_epoch: number | null;
  uploaded_epoch: number;
  supplied_by_role: string | null;
  file_source: string;
}

/** True for a page that came out of a PDF (its neighbours in the same file are a real sequence). */
export function isPdfPage(page: Pick<BatchPage, 'mime'>): boolean {
  return page.mime === 'application/pdf';
}

/** Split a name into text/number chunks so `img2` sorts before `img10`. */
export function naturalKey(name: string): (string | number)[] {
  return name
    .toLowerCase()
    .split(/(\d+)/)
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Order the pages of a batch. Files sort by capture time (photos in the order they were taken),
 * then by a natural sort of the original name (the index-sheet sequence of a scan run), then by
 * upload time and file id; pages inside a file keep their own page number. Files without a capture
 * time sort after those that have one, which keeps the comparison a total order — the property that
 * makes the sequence reproducible.
 */
export function orderPages(pages: readonly BatchPage[]): BatchPage[] {
  return [...pages].sort((a, b) => {
    const ca = a.capture_epoch ?? Number.POSITIVE_INFINITY;
    const cb = b.capture_epoch ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    const byName = compareNatural(a.original_name, b.original_name);
    if (byName !== 0) return byName;
    if (a.uploaded_epoch !== b.uploaded_epoch) return a.uploaded_epoch - b.uploaded_epoch;
    if (a.file_id !== b.file_id) return a.file_id < b.file_id ? -1 : 1;
    return a.page_no - b.page_no;
  });
}

// ---------------------------------------------------------------------------
// Stage C — page markers, union-find, groups
// ---------------------------------------------------------------------------

/** A printed pagination marker, or the carry-forward note that a table continues overleaf. */
export interface PageMarker {
  /** Printed page number, when one is legible. */
  page: number | null;
  /** Printed total, when one is legible ("de 5", "/5"). */
  of: number | null;
  /** "Suma y sigue" / "Suma i segueix" / "continúa": the next page continues this one. */
  carry: boolean;
}

const CARRY_RE = /\b(suma\s*(y|i)\s*sigue|suma\s*i\s*segueix|continua|continuacion|continuacio|sigue\b|segueix\b|passa\s*full)/;

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a printed page marker: `Pág. 2/3`, `Pagina 2 de 5`, `Hoja 2 de 3`, `Full 2 de 3`, `2/5`,
 * `Página 2`, or a carry-forward note. Returns null when nothing is legible.
 */
export function parsePageMarker(raw: string | null | undefined): PageMarker | null {
  if (!raw) return null;
  const text = fold(raw);
  const carry = CARRY_RE.test(text);
  const pair = /(\d{1,3})\s*(?:\/|de|d'|of)\s*(\d{1,3})/.exec(text);
  if (pair) return { page: Number(pair[1]), of: Number(pair[2]), carry };
  const single = /(?:pag(?:ina)?|pg|p|hoja|full|foli|folio|hoja n|pagina n)\.?\s*(\d{1,3})\b/.exec(text);
  if (single) return { page: Number(single[1]), of: null, carry };
  if (carry) return { page: null, of: null, carry: true };
  return null;
}

/** Comparison form of an issuer or document-number hint: nothing but letters and digits. */
export function hintKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return fold(raw).replace(/[^a-z0-9]/g, '');
}

/** What stage C needs about one ordered page. */
export interface GroupablePage {
  /** Stable identity of the page (the `pages.id` in the worker, any string in tests). */
  key: string;
  file_id: string;
  page_no: number;
  is_pdf: boolean;
  cls: PageClassification;
}

/** The reason one page was (or was not) joined to the previous one. */
export interface LinkDecision {
  link: boolean;
  confidence: number;
  reason: string;
}

/**
 * Decide whether `cur` continues `prev`.
 *
 * Pages of one PDF are consecutive by construction and stay together unless the classifier marks
 * the page as the `first` page of a **different** document type — the only signal strong enough to
 * cut a file that arrived as one sequence. Across files, a join needs a positive signal: the
 * classifier saying the page continues the previous one at ≥ 0.8, the same document number from the
 * same issuer, or a printed page-marker chain (`2/3` after `1/3`, or a page that says the table is
 * carried forward).
 */
export function linkPages(prev: GroupablePage, cur: GroupablePage, groupDocType: DocType): LinkDecision {
  const reasons: string[] = [];
  let confidence = 0;

  if (prev.file_id === cur.file_id && cur.is_pdf) {
    if (cur.cls.page_role === 'first' && cur.cls.doc_type !== groupDocType) {
      return {
        link: false,
        confidence: 0,
        reason: `classifier marks a new first page of type ${cur.cls.doc_type} inside the same PDF`,
      };
    }
    reasons.push('consecutive pages of the same PDF');
    confidence = Math.max(confidence, LINK_CONFIDENCE.samePdfFile);
  }

  if (cur.cls.continues_previous && cur.cls.continues_previous_confidence >= CONTINUES_MIN_CONFIDENCE) {
    reasons.push(`classifier: continues the previous page (${cur.cls.continues_previous_confidence.toFixed(2)})`);
    confidence = Math.max(confidence, cur.cls.continues_previous_confidence);
  }

  const numberKey = hintKey(cur.cls.doc_number_hint);
  const issuerKey = hintKey(cur.cls.issuer_name_hint);
  if (numberKey && issuerKey && numberKey === hintKey(prev.cls.doc_number_hint) && issuerKey === hintKey(prev.cls.issuer_name_hint)) {
    reasons.push('same document number and issuer as the previous page');
    confidence = Math.max(confidence, LINK_CONFIDENCE.numberAndIssuer);
  }

  const prevMarker = parsePageMarker(prev.cls.page_marker);
  const curMarker = parsePageMarker(cur.cls.page_marker);
  const chained =
    prevMarker !== null &&
    curMarker !== null &&
    prevMarker.page !== null &&
    curMarker.page !== null &&
    curMarker.page === prevMarker.page + 1 &&
    (prevMarker.of === null || curMarker.of === null || prevMarker.of === curMarker.of);
  if (chained) {
    reasons.push(`page-marker chain ${prevMarker.page}→${curMarker.page}`);
    confidence = Math.max(confidence, LINK_CONFIDENCE.pageMarkerChain);
  } else if (prevMarker?.carry === true) {
    reasons.push('previous page is marked as carried forward');
    confidence = Math.max(confidence, LINK_CONFIDENCE.pageMarkerChain);
  }

  if (reasons.length === 0) return { link: false, confidence: 0, reason: 'no continuation signal' };
  return { link: true, confidence, reason: reasons.join('; ') };
}

/** One group of consecutive pages that will become one document. */
export interface PageGroup {
  /** Indexes into the ordered input array, in order. */
  members: number[];
  docType: DocType;
  language: string;
  /** Lowest confidence of the joins that built the group; 1 for a single page. */
  confidence: number;
  reason: string;
}

/** Most frequent document type of the pages, ties broken by the first page. */
export function majorityDocType(pages: readonly GroupablePage[]): DocType {
  const first = pages[0];
  if (!first) throw new RangeError('majorityDocType: no pages');
  const counts = new Map<DocType, number>();
  for (const p of pages) counts.set(p.cls.doc_type, (counts.get(p.cls.doc_type) ?? 0) + 1);
  let best = first.cls.doc_type;
  let bestCount = counts.get(best) ?? 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

const DOCUMENT_LANGUAGES = new Set(['es', 'ca', 'mixed', 'en', 'unknown']);

/** Most frequent page language; `mixed` when two languages tie, `unknown` when nothing is legible. */
export function majorityLanguage(pages: readonly GroupablePage[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const lang = DOCUMENT_LANGUAGES.has(p.cls.language) ? p.cls.language : 'unknown';
    if (lang === 'unknown') continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  if (counts.size === 0) return 'unknown';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = sorted[0];
  if (!top) return 'unknown';
  if (sorted.length > 1 && (sorted[1]?.[1] ?? 0) === top[1]) return 'mixed';
  return top[0];
}

/**
 * Stage C: walk the ordered pages once, joining each page to the previous one when
 * {@link linkPages} says so and the group still has room, and close the group otherwise.
 */
export function groupPages(pages: readonly GroupablePage[]): PageGroup[] {
  const groups: PageGroup[] = [];
  let members: number[] = [];
  let linkConfidences: number[] = [];
  let reasons: string[] = [];

  const close = (): void => {
    if (members.length === 0) return;
    const members_ = members;
    const rows = members_.map((i) => pages[i] as GroupablePage);
    groups.push({
      members: members_,
      docType: majorityDocType(rows),
      language: majorityLanguage(rows),
      confidence: linkConfidences.length === 0 ? LINK_CONFIDENCE.singlePage : Math.min(...linkConfidences),
      reason: `${members_.length} page(s); ${reasons.length > 0 ? reasons.join(' | ') : 'single page, no continuation signal'}`,
    });
    members = [];
    linkConfidences = [];
    reasons = [];
  };

  pages.forEach((page, i) => {
    if (members.length === 0) {
      members = [i];
      return;
    }
    const prev = pages[i - 1] as GroupablePage;
    const soFar = members.map((m) => pages[m] as GroupablePage);
    const decision = linkPages(prev, page, majorityDocType(soFar));
    if (decision.link && members.length >= MAX_GROUP_PAGES) {
      reasons.push(`cap of ${MAX_GROUP_PAGES} pages reached, remaining pages continue in the next group`);
      close();
      members = [i];
      return;
    }
    if (!decision.link) {
      close();
      members = [i];
      return;
    }
    members.push(i);
    linkConfidences.push(decision.confidence);
    if (!reasons.includes(decision.reason)) reasons.push(decision.reason);
  });
  close();
  return groups;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Issuer class, provenance chain and directness derived from who supplied the file. */
export interface Provenance {
  issuer_class: string;
  provenance_chain: string[];
  obtained_directly: boolean;
  /** 0 = most independent leg. Used to pick the weakest link of a multi-file document. */
  rank: number;
}

/**
 * Provenance of a document from the role that supplied its pages.
 *
 * Independence is a property of the route the bytes travelled, not of who signed the paper: a bank
 * statement handed over by the administrator is administrator evidence. The table is keyed by
 * `files.supplied_by_role` and, for the two entries that are recorded as a `files.source`
 * (`bank_export`, `onsite`), by that source as well.
 */
export const PROVENANCE_BY_ROLE: Readonly<Record<string, Provenance>> = Object.freeze({
  bank_export: { issuer_class: 'bank', provenance_chain: ['bank'], obtained_directly: true, rank: 0 },
  bank: { issuer_class: 'bank', provenance_chain: ['bank'], obtained_directly: true, rank: 0 },
  public_body: { issuer_class: 'public_registry', provenance_chain: ['public_registry'], obtained_directly: true, rank: 1 },
  requesting_owner: { issuer_class: 'requesting_owner', provenance_chain: ['requesting_owner'], obtained_directly: true, rank: 2 },
  operator: { issuer_class: 'requesting_owner', provenance_chain: ['requesting_owner'], obtained_directly: true, rank: 2 },
  president: { issuer_class: 'president', provenance_chain: ['president', 'requesting_owner'], obtained_directly: false, rank: 3 },
  vendor_via_administrator: { issuer_class: 'administrator', provenance_chain: ['vendor_direct', 'administrator', 'requesting_owner'], obtained_directly: false, rank: 4 },
  administrator: { issuer_class: 'administrator', provenance_chain: ['administrator', 'requesting_owner'], obtained_directly: false, rank: 4 },
  onsite: { issuer_class: 'administrator', provenance_chain: ['administrator', 'requesting_owner'], obtained_directly: false, rank: 4 },
  other_owner: { issuer_class: 'unknown', provenance_chain: ['other_owner', 'requesting_owner'], obtained_directly: false, rank: 5 },
});

const UNKNOWN_PROVENANCE: Provenance = Object.freeze({
  issuer_class: 'unknown',
  provenance_chain: ['unknown'],
  obtained_directly: false,
  rank: 6,
});

/** Provenance of one file: the supplying role first, then the intake source, else unknown. */
export function provenanceOf(suppliedByRole: string | null, source: string | null): Provenance {
  return (
    (suppliedByRole ? PROVENANCE_BY_ROLE[suppliedByRole] : undefined) ??
    (source ? PROVENANCE_BY_ROLE[source] : undefined) ??
    UNKNOWN_PROVENANCE
  );
}

/** Provenance of a document whose pages came from several files: the least independent leg wins. */
export function weakestProvenance(files: ReadonlyArray<{ supplied_by_role: string | null; file_source: string }>): Provenance {
  let worst = provenanceOf(files[0]?.supplied_by_role ?? null, files[0]?.file_source ?? null);
  let directly = worst.obtained_directly;
  for (const f of files.slice(1)) {
    const p = provenanceOf(f.supplied_by_role, f.file_source);
    directly = directly && p.obtained_directly;
    if (p.rank > worst.rank) worst = p;
  }
  return { ...worst, obtained_directly: directly };
}

// ---------------------------------------------------------------------------
// Stage B — the classifier pass, persisted one run per page
// ---------------------------------------------------------------------------

/** Two previous and one following page of context, as the sliding window of the plan. */
export const WINDOW_PREV = 2;
export const WINDOW_NEXT = 1;

function classifyKey(pageId: string, model: string): string {
  return `page:${pageId}:classify:${PROMPT_VERSION}:${SCHEMA_VERSION}:${model}`;
}

async function thumbImage(page: BatchPage, index: number): Promise<PageImage> {
  if (!page.thumb_path) throw new Error(`group: page ${page.page_id} has no thumbnail yet (run the render step)`);
  const { bucket, key } = parseStoragePath(page.thumb_path);
  const jpeg = await getObject(bucket, key);
  const meta = await sharp(jpeg).metadata();
  return { index, jpeg, width: meta.width ?? 0, height: meta.height ?? 0, sha256: '' };
}

interface StoredRun {
  id: string;
  response_json: { parsed?: PageClassification } | null;
}

/**
 * Classify one page with its window. Returns the classification and the id of the run row that
 * holds it; a succeeded run under the same key is reused instead of calling the model again.
 */
async function classifyOne(
  communityId: string,
  ordered: readonly BatchPage[],
  index: number,
  images: Map<number, PageImage>,
): Promise<{ cls: PageClassification; runId: string; cached: boolean }> {
  const page = ordered[index] as BatchPage;
  const model = MODELS.classification;
  const key = classifyKey(page.page_id, model);
  const existing = await maybeOne<StoredRun>(
    `select id, response_json from public.extraction_runs where idempotency_key = $1 and status = 'succeeded'`,
    [key],
  );
  const cachedCls = existing?.response_json?.parsed;
  if (existing && cachedCls) return { cls: cachedCls, runId: existing.id, cached: true };

  const target = images.get(index);
  if (!target) throw new Error(`group: no thumbnail loaded for page ${page.page_id}`);
  const prev: PageImage[] = [];
  for (let i = Math.max(0, index - WINDOW_PREV); i < index; i++) {
    const img = images.get(i);
    if (img) prev.push(img);
  }
  const next: PageImage[] = [];
  for (let i = index + 1; i <= Math.min(ordered.length - 1, index + WINDOW_NEXT); i++) {
    const img = images.get(i);
    if (img) next.push(img);
  }

  const client = extractionClient();
  const result = await classifyPagesDetailed({ thumbs: [target], window: { prev, next } }, { client: client.raw });
  const cls = result.pages[0];
  if (!cls) throw new Error(`group: classifier returned nothing for page ${page.page_id}`);
  const status = result.refused ? 'refused' : result.parseError ? 'parse_failed' : 'succeeded';

  const run = await one<{ id: string }>(
    `insert into public.extraction_runs (community_id, page_id, stage, model, prompt_version, schema_version, effort,
                                         request_json, response_json, status, stop_reason,
                                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, idempotency_key)
     values ($1, $2, 'classify', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::public.run_status, $10, $11, $12, $13, $14, $15, $16)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      communityId,
      page.page_id,
      result.model,
      result.promptVersion,
      result.schemaVersion,
      null,
      JSON.stringify(result.requestJson),
      JSON.stringify({ message: result.raw, parsed: cls, missing: result.missing }),
      status,
      result.stopReason,
      result.usage.input_tokens,
      result.usage.output_tokens,
      result.usage.cache_read_input_tokens,
      result.usage.cache_creation_input_tokens,
      result.costUsd,
      key,
    ],
  ).catch(async (e: unknown) => {
    // a concurrent worker stored the same run first
    const row = await maybeOne<{ id: string }>('select id from public.extraction_runs where idempotency_key = $1', [key]);
    if (row) return row;
    throw e;
  });
  return { cls, runId: run.id, cached: false };
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

type BatchPageRow = BatchPage & { capture_epoch: string | number | null; uploaded_epoch: string | number };

export async function groupStep(payload: Record<string, unknown>, job: StepJob): Promise<StepResult> {
  const batchLabel = typeof payload.batch_label === 'string' ? payload.batch_label : '';
  if (!batchLabel) throw new Error('group: payload.batch_label is required');
  const communityId = job.community_id;

  const rows = await query<BatchPageRow>(
    `select p.id as page_id, p.file_id, p.page_no, p.thumb_path,
            f.mime, f.original_name, f.supplied_by_role, f.source as file_source,
            extract(epoch from f.capture_time)::float8 as capture_epoch,
            extract(epoch from f.uploaded_at)::float8 as uploaded_epoch
       from public.pages p
       join public.files f on f.id = p.file_id
      where f.community_id = $1 and f.batch_label = $2 and f.status = 'stored'
        and p.dedupe_of_page_id is null
        and not exists (select 1 from public.document_pages dp where dp.page_id = p.id)`,
    [communityId, batchLabel],
  );
  if (rows.length === 0) {
    console.log(`group ${batchLabel}: no ungrouped pages`);
    return { batch_label: batchLabel, pages: 0, documents: 0, skipped: 'nothing to group' };
  }

  const ordered = orderPages(
    rows.map((r) => ({
      page_id: r.page_id,
      file_id: r.file_id,
      page_no: r.page_no,
      thumb_path: r.thumb_path,
      mime: r.mime,
      original_name: r.original_name,
      capture_epoch: r.capture_epoch === null ? null : Number(r.capture_epoch),
      uploaded_epoch: Number(r.uploaded_epoch),
      supplied_by_role: r.supplied_by_role,
      file_source: r.file_source,
    })),
  );

  // stage B: one classification per page, with a two-back / one-forward window of thumbnails
  const images = new Map<number, PageImage>();
  const classifications: PageClassification[] = [];
  const runIds: string[] = [];
  let cachedRuns = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = Math.max(0, i - WINDOW_PREV); j <= Math.min(ordered.length - 1, i + WINDOW_NEXT); j++) {
      if (!images.has(j)) images.set(j, await thumbImage(ordered[j] as BatchPage, j));
    }
    const { cls, runId, cached } = await classifyOne(communityId, ordered, i, images);
    classifications.push(cls);
    runIds.push(runId);
    if (cached) cachedRuns += 1;
    images.delete(i - WINDOW_PREV - 1);
  }

  // stage C
  const groupable: GroupablePage[] = ordered.map((p, i) => ({
    key: p.page_id,
    file_id: p.file_id,
    page_no: p.page_no,
    is_pdf: isPdfPage(p),
    cls: classifications[i] as PageClassification,
  }));
  const groups = groupPages(groupable);

  const created: { document_id: string; doc_type: string; pages: number }[] = [];
  await transaction(async (client) => {
    for (const group of groups) {
      const pages = group.members.map((i) => ordered[i] as BatchPage);
      const provenance = weakestProvenance(pages.map((p) => ({ supplied_by_role: p.supplied_by_role, file_source: p.file_source })));
      const doc = await client.query<{ id: string }>(
        `insert into public.documents (community_id, doc_type, status, language, issuer_class, provenance_chain,
                                       obtained_directly, grouping_confidence, grouping_reason, grouped_by)
         values ($1, $2, 'classified', $3, $4::public.issuer_class, $5::text[], $6, $7, $8, 'auto')
         returning id`,
        [
          communityId,
          group.docType,
          group.language,
          provenance.issuer_class,
          provenance.provenance_chain,
          provenance.obtained_directly,
          group.confidence,
          group.reason,
        ],
      );
      const documentId = String(doc.rows[0]?.id);
      for (const [seq, page] of pages.entries()) {
        await client.query(
          `insert into public.document_pages (document_id, page_id, seq) values ($1, $2, $3)
           on conflict (page_id) do nothing`,
          [documentId, page.page_id, seq + 1],
        );
      }
      created.push({ document_id: documentId, doc_type: group.docType, pages: pages.length });
    }
  });

  console.log(
    `group ${batchLabel}: ${ordered.length} page(s) → ${created.length} document(s)` +
      ` (${runIds.length - cachedRuns} classification(s) requested, ${cachedRuns} reused)`,
  );
  for (const g of groups) {
    console.log(`  ${g.docType.padEnd(20)} ${String(g.members.length).padStart(3)} page(s)  conf ${g.confidence.toFixed(2)}  ${g.reason}`);
  }
  return {
    batch_label: batchLabel,
    pages: ordered.length,
    documents: created.length,
    created,
    classifications_requested: runIds.length - cachedRuns,
    classifications_reused: cachedRuns,
  };
}
