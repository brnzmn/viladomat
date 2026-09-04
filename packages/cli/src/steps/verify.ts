import { normaliseValue } from '@viladomat/core';
import { maybeOne, query, transaction } from '../lib/db.ts';
import { MODELS, criticalSeeds, flattenParsed, kindForPath, type DocType, type FieldValueSeed } from '../extract/adapter.ts';
import { valueKindOf } from '../extract/persist.ts';
import { insertRun, chunkPages, extractionKey, mergeParsedChunks, type LoadedPage } from './extract.ts';
import { extractDocument, extractionClient, type ExtractDocumentResult, type Language } from '../extract/adapter.ts';
import { sha256 } from '../lib/images.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import type { StepJob, StepResult } from './types.ts';

/**
 * Step `verify` — a third opinion from `claude-sonnet-5`, at low effort.
 *
 * The point of a third reader is asymmetric and deliberately so: it can only take confidence away.
 * When Sonnet reads a different number from the one Opus and Tesseract agreed on, the field stops
 * being `auto_accepted` and goes to a person. When Sonnet agrees, nothing is promoted — two readers
 * agreeing does not become three, and a field that already needed review still needs it.
 *
 * A field a person has confirmed or corrected is never touched.
 *
 * Idempotent: `sonnet_value_norm` / `sonnet_agrees` are recomputed, and a demotion applied twice is
 * the same demotion.
 */

/** Effort used for the third opinion: it re-reads printed figures, it does not reason about them. */
export const VERIFY_EFFORT = 'low' as const;

interface DocumentRow {
  id: string;
  community_id: string;
  doc_type: DocType;
  language: string | null;
}

interface DocPageRow {
  page_id: string;
  seq: number;
  render_path: string | null;
  width: number | null;
  height: number | null;
  render_params: Record<string, unknown> | null;
  file_id: string;
  file_sha256: string;
  mime: string | null;
  has_text_layer: boolean | null;
}

async function loadPages(documentId: string): Promise<LoadedPage[]> {
  const rows = await query<DocPageRow>(
    `select dp.page_id, dp.seq, p.render_path, p.width, p.height, p.render_params,
            p.file_id, f.sha256 as file_sha256, f.mime, p.has_text_layer
       from public.document_pages dp
       join public.pages p on p.id = dp.page_id
       join public.files f on f.id = p.file_id
      where dp.document_id = $1
      order by dp.seq`,
    [documentId],
  );
  const pages: LoadedPage[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.render_path) throw new Error(`verify: page ${row.page_id} has no render yet`);
    const { bucket, key } = parseStoragePath(row.render_path);
    const jpeg = await getObject(bucket, key);
    pages.push({ row, image: { index, jpeg, width: row.width ?? 0, height: row.height ?? 0, sha256: sha256(jpeg) } });
  }
  return pages;
}

interface FieldRow {
  id: string;
  field_path: string;
  value: unknown;
  value_norm: string | null;
  status: string;
}

/** Statuses the third opinion must leave alone. */
export const PROTECTED_STATUSES: ReadonlySet<string> = new Set(['human_confirmed', 'corrected']);

/** Sonnet may demote an accepted field; it never promotes one. */
export function statusAfterVerify(current: string, sonnetAgrees: boolean | null): string {
  return current === 'auto_accepted' && sonnetAgrees === false ? 'needs_review' : current;
}

export async function verifyStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const documentId = typeof payload.document_id === 'string' ? payload.document_id : '';
  if (!documentId) throw new Error('verify: payload.document_id is required');

  const document = await maybeOne<DocumentRow>('select id, community_id, doc_type, language from public.documents where id = $1', [documentId]);
  if (!document) throw new Error(`verify: document ${documentId} not found`);

  const pages = await loadPages(documentId);
  if (pages.length === 0) throw new Error(`verify: document ${documentId} has no pages`);

  const client = extractionClient();
  const language = (['es', 'ca', 'mixed'] as const).includes(document.language as Language) ? (document.language as Language) : undefined;
  const chunks = chunkPages(pages);
  const results: ExtractDocumentResult[] = [];
  const runIds: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const result = await extractDocument(
      { docType: document.doc_type, pages: chunk.map((p) => p.image), ...(language ? { language } : {}) },
      { client: client.raw, model: MODELS.verification, effort: VERIFY_EFFORT },
    );
    results.push(result);
    runIds.push(
      await insertRun({
        communityId: document.community_id,
        documentId,
        stage: 'verify',
        effort: VERIFY_EFFORT,
        result,
        pages: chunk,
        idempotencyKey:
          `verify:${extractionKey(documentId, result.promptVersion, result.schemaVersion, result.model)}` + (chunks.length > 1 ? `:c${i}` : ''),
      }),
    );
    if (result.refused) break;
  }

  const parsedParts = results.map((r) => r.parsed).filter((p) => p !== null);
  if (parsedParts.length === 0) {
    console.log(`verify ${documentId}: the third reading produced nothing usable; the fields keep their current status`);
    return { document_id: documentId, run_ids: runIds, status: results.some((r) => r.refused) ? 'refused' : 'parse_failed', compared: 0 };
  }
  const parsed = mergeParsedChunks(parsedParts);
  const seeds = new Map<string, FieldValueSeed>();
  for (const seed of criticalSeeds(flattenParsed(parsed, null, document.doc_type))) seeds.set(seed.field_path, seed);

  const fields = await query<FieldRow>('select id, field_path, value, value_norm, status from public.field_values where document_id = $1', [documentId]);
  const counts = { compared: 0, agreed: 0, disagreed: 0, missing: 0, demoted: 0, protected: 0 };
  const updates: { id: string; sonnetValue: string | null; agrees: boolean | null; status: string }[] = [];

  for (const field of fields) {
    if (PROTECTED_STATUSES.has(field.status)) {
      counts.protected += 1;
      continue;
    }
    const seed = seeds.get(field.field_path);
    if (!seed) continue;
    const kind = kindForPath(field.field_path, field.value);
    const sonnetValue = normaliseValue(valueKindOf(kind), seed.value as string | number | null);
    const agrees = field.value_norm === null && sonnetValue === null ? null : field.value_norm === sonnetValue;
    const status = statusAfterVerify(field.status, agrees);
    counts.compared += 1;
    if (agrees === true) counts.agreed += 1;
    else if (agrees === false) counts.disagreed += 1;
    else counts.missing += 1;
    if (status !== field.status) counts.demoted += 1;
    updates.push({ id: field.id, sonnetValue, agrees, status });
  }

  await transaction(async (c) => {
    for (const u of updates) {
      await c.query(
        `update public.field_values
            set sonnet_value_norm = $2, sonnet_agrees = $3, status = $4::public.field_status
          where id = $1 and status not in ('human_confirmed', 'corrected')`,
        [u.id, u.sonnetValue, u.agrees, u.status],
      );
    }
  });

  const cost = results.reduce((sum, r) => sum + r.costUsd, 0);
  console.log(
    `verify ${documentId}: ${counts.compared} field(s) re-read, ${counts.disagreed} differ, ` +
      `${counts.demoted} moved back to review, $${cost.toFixed(4)}`,
  );
  return { document_id: documentId, run_ids: runIds, cost_usd: Number(cost.toFixed(6)), ...counts };
}
