import { resolveCommunity } from '../lib/community.ts';
import { query } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import { sha256 } from '../lib/images.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  buildBatchRequest,
  extractionClient,
  redactRequest,
  schemaKeyFor,
  type BatchRequest,
  type DocType,
  type Language,
  type PageImage,
} from '../extract/adapter.ts';
import { chunkPages, extractStep, extractionKey } from '../steps/extract.ts';

/**
 * `vx extract` — schedule the reading of documents.
 *
 * Three routes, one selection. By default the documents are handed to the worker as `extract` jobs
 * and read one at a time; `--sync` runs the same step here and now, which is what a single document
 * under review needs; `--batch-api` submits them all as one Message Batch, which is half the price
 * and the right choice for a whole delivery, at the cost of waiting.
 *
 * The Batch route stores one `submitted` run per document carrying the batch and custom ids, so a
 * batch that is never collected still leaves a trace of what was asked. `vx batch collect` writes
 * the answers as separate run rows — `extraction_runs` is append-only, so a submitted row is never
 * updated in place.
 */

export interface ExtractOptions {
  document?: string;
  batch?: string;
  pending?: boolean;
  sync?: boolean;
  batchApi?: boolean;
  community?: string;
  /** Stop after this many documents. */
  limit?: string;
  dryRun?: boolean;
}

interface PendingDocument {
  id: string;
  doc_type: DocType;
  status: string;
  language: string | null;
  pages: number;
}

/** Documents that have a schema and no succeeded `extract` run yet. */
export async function selectDocuments(communityId: string, opts: ExtractOptions): Promise<PendingDocument[]> {
  const where: string[] = ['d.community_id = $1'];
  const params: unknown[] = [communityId];
  if (opts.document) {
    params.push(opts.document);
    where.push(`d.id = $${params.length}`);
  } else if (opts.batch) {
    params.push(opts.batch);
    where.push(`exists (select 1 from public.document_pages dp
                          join public.pages p on p.id = dp.page_id
                          join public.files f on f.id = p.file_id
                         where dp.document_id = d.id and f.batch_label = $${params.length})`);
  } else {
    where.push("d.status in ('grouped', 'classified')");
    where.push(`not exists (select 1 from public.extraction_runs r
                             where r.document_id = d.id and r.stage = 'extract' and r.status = 'succeeded')`);
  }
  const limit = Number(opts.limit ?? '0');
  const rows = await query<PendingDocument>(
    `select d.id, d.doc_type, d.status, d.language,
            (select count(*)::int from public.document_pages dp where dp.document_id = d.id) as pages
       from public.documents d
      where ${where.join(' and ')} and d.duplicate_of_document_id is null
      order by d.created_at
      ${Number.isFinite(limit) && limit > 0 ? `limit ${Math.floor(limit)}` : ''}`,
    params,
  );
  return rows.filter((r) => schemaKeyFor(r.doc_type) !== null && r.pages > 0);
}

interface PageRow {
  page_id: string;
  render_path: string | null;
  width: number | null;
  height: number | null;
}

async function loadImages(documentId: string): Promise<PageImage[]> {
  const rows = await query<PageRow>(
    `select dp.page_id, p.render_path, p.width, p.height
       from public.document_pages dp join public.pages p on p.id = dp.page_id
      where dp.document_id = $1 order by dp.seq`,
    [documentId],
  );
  const images: PageImage[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.render_path) throw new Error(`extract: page ${row.page_id} has no render yet`);
    const { bucket, key } = parseStoragePath(row.render_path);
    const jpeg = await getObject(bucket, key);
    images.push({ index, jpeg, width: row.width ?? 0, height: row.height ?? 0, sha256: sha256(jpeg) });
  }
  return images;
}

export interface ExtractSummary {
  communityId: string;
  selected: number;
  queued: number;
  extracted: number;
  submitted: number;
  batchId: string | null;
  skipped: { document_id: string; reason: string }[];
}

export async function extractCommand(opts: ExtractOptions): Promise<ExtractSummary> {
  const community = await resolveCommunity(opts.community);
  const documents = await selectDocuments(community.id, opts);
  const summary: ExtractSummary = {
    communityId: community.id,
    selected: documents.length,
    queued: 0,
    extracted: 0,
    submitted: 0,
    batchId: null,
    skipped: [],
  };
  if (documents.length === 0) {
    console.log('no document is waiting for extraction');
    return summary;
  }
  console.log(`${documents.length} document(s) selected${opts.dryRun ? ' (dry run)' : ''}`);
  for (const d of documents) console.log(`  ${d.id.slice(0, 8)}  ${d.doc_type.padEnd(20)} ${String(d.pages).padStart(3)} page(s)  ${d.status}`);
  if (opts.dryRun) return summary;

  if (opts.batchApi) {
    const client = extractionClient();
    const requests: BatchRequest[] = [];
    const byCustomId = new Map<string, { documentId: string; images: PageImage[] }>();
    for (const d of documents) {
      const images = await loadImages(d.id);
      const chunks = chunkPages(images);
      if (chunks.length > 1) {
        // one custom id per document: a chunked document is read synchronously instead
        summary.skipped.push({ document_id: d.id, reason: `${images.length} pages exceed one batch request; run it with --sync` });
        continue;
      }
      const language = (['es', 'ca', 'mixed'] as const).includes(d.language as Language) ? (d.language as Language) : undefined;
      const request = buildBatchRequest({ documentId: d.id, docType: d.doc_type, pages: images, ...(language ? { language } : {}) });
      requests.push(request);
      byCustomId.set(request.custom_id, { documentId: d.id, images });
    }
    if (requests.length === 0) {
      console.log('nothing could be submitted as a batch');
      return summary;
    }
    const batch = await client.submitBatch(requests);
    summary.batchId = batch.id;
    for (const request of requests) {
      const entry = byCustomId.get(request.custom_id);
      if (!entry) continue;
      await query(
        `insert into public.extraction_runs (community_id, document_id, stage, model, prompt_version, schema_version, effort,
                                             request_json, batch_id, custom_id, status, idempotency_key)
         values ($1, $2, 'extract', $3, $4, $5, 'medium', $6::jsonb, $7, $8, 'submitted', $9)
         on conflict (idempotency_key) do nothing`,
        [
          community.id,
          entry.documentId,
          request.params.model,
          PROMPT_VERSION,
          SCHEMA_VERSION,
          JSON.stringify({
            request: redactRequest(request.params, entry.images),
            pages: entry.images.map((i) => ({ page_index: i.index, render_sha256: i.sha256, width: i.width, height: i.height })),
          }),
          batch.id,
          request.custom_id,
          `${extractionKey(entry.documentId, PROMPT_VERSION, SCHEMA_VERSION, request.params.model)}:submit:${request.custom_id}`,
        ],
      );
      summary.submitted += 1;
    }
    console.log(`batch ${batch.id}: ${summary.submitted} document(s) submitted (${batch.processing_status})`);
    console.log(`next: vx batch collect ${batch.id}`);
    return summary;
  }

  for (const d of documents) {
    if (opts.sync) {
      await extractStep({ document_id: d.id }, {
        id: 'sync',
        community_id: community.id,
        idempotency_key: `${d.id}:extract:${PIPELINE_VERSION()}`,
        step: 'extract',
        attempts: 1,
        max_attempts: 1,
        payload: { document_id: d.id },
      });
      summary.extracted += 1;
      continue;
    }
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'extract', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [community.id, `${d.id}:extract:${PIPELINE_VERSION()}`, JSON.stringify({ document_id: d.id })],
    );
    summary.queued += 1;
  }

  if (summary.queued > 0) {
    console.log(`${summary.queued} extract job(s) queued; run: vx process --steps extract`);
  }
  if (summary.extracted > 0) console.log(`${summary.extracted} document(s) extracted`);
  return summary;
}
