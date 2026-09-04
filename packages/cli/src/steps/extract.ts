import { maybeOne, query, transaction } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import { sha256 } from '../lib/images.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import {
  LIMITS,
  MODELS,
  extractDocument,
  extractionClient,
  flattenParsed,
  runStatusOf,
  schemaKeyFor,
  type DocType,
  type ExtractDocumentResult,
  type Language,
  type PageImage,
} from '../extract/adapter.ts';
import { persistExtraction, type PersistPage } from '../extract/persist.ts';
import type { StepJob, StepResult } from './types.ts';

/**
 * Step `extract` — one document is read once by `claude-opus-5` and everything it produced is
 * written in one transaction.
 *
 * The run row is the receipt: the request as sent minus the image bytes, plus the SHA-256 and the
 * render parameters of every page, the full response with its `stop_reason`, the token usage and
 * the estimated cost. Any figure that later appears in a pack can be traced back to it.
 *
 * Documents longer than the 20-image limit are split into chunks, each sent with the page indexes
 * it has in the document, so the evidence page numbers stay document-wide and the row arrays of the
 * chunks concatenate without renumbering.
 *
 * Failure modes are recorded, not swallowed: a refusal is stored as a `refused` run and re-read once
 * with `claude-sonnet-5` (a second run row), and output that will not parse — after the module's own
 * repair turn — is stored as `parse_failed`. Neither writes domain rows.
 *
 * Idempotent through `extraction_runs.idempotency_key`
 * (`doc:<document>:<prompt_version>:<schema_version>:<model>`): a document whose key already carries
 * a succeeded run is skipped.
 */

/** Arrays that are concatenated when a long document is read in several chunks. */
export const MERGEABLE_ARRAYS: readonly string[] = Object.freeze([
  'lineas',
  'resumen_iva',
  'movimientos',
  'acuerdos',
  'asistentes',
  'orden_del_dia',
  'cargos_elegidos',
  'derramas_aprobadas',
  'ingresos',
  'gastos',
  'deudores',
  'acreedores',
  'derramas',
  'cuotas_por_unidad',
  'cuotas',
  'capitulos',
  'partidas',
  'partes',
  'calendario_pagos',
  'penalizaciones',
  'firmas',
  'clausulas_relevantes',
  'anotaciones_manuscritas',
  'evidence',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge the parsed objects of the chunks of one document: listed arrays concatenate in chunk order,
 * every other value is taken from the first chunk that printed one.
 */
export function mergeParsedChunks(parts: readonly unknown[]): unknown {
  const usable = parts.filter(isRecord);
  const firstPart = usable[0];
  if (!firstPart) return parts[0] ?? null;
  if (usable.length === 1) return firstPart;
  const out: Record<string, unknown> = {};
  const keys = new Set<string>();
  for (const part of usable) for (const k of Object.keys(part)) keys.add(k);
  for (const key of keys) {
    if (MERGEABLE_ARRAYS.includes(key)) {
      const merged: unknown[] = [];
      for (const part of usable) {
        const value = part[key];
        if (Array.isArray(value)) merged.push(...value);
      }
      out[key] = merged;
      continue;
    }
    let picked: unknown = null;
    for (const part of usable) {
      const value = part[key];
      if (value !== null && value !== undefined) {
        picked = value;
        break;
      }
    }
    out[key] = picked;
  }
  return out;
}

/** `document.pages` in chunks of at most `LIMITS.maxImagesPerRequest`. */
export function chunkPages<T>(pages: readonly T[], size: number = LIMITS.maxImagesPerRequest): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < pages.length; i += size) chunks.push(pages.slice(i, i + size));
  return chunks;
}

/** `extraction_runs.idempotency_key` of a document read by one model at one prompt/schema version. */
export function extractionKey(documentId: string, promptVersion: string, schemaVersion: string, model: string): string {
  return `doc:${documentId}:${promptVersion}:${schemaVersion}:${model}`;
}

interface DocumentRow {
  id: string;
  community_id: string;
  doc_type: DocType;
  status: string;
  language: string | null;
  community_nif: string | null;
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

/** The pages of a document with their renders loaded, in document order. */
export interface LoadedPage {
  row: DocPageRow;
  image: PageImage;
}

async function loadDocument(documentId: string): Promise<{ document: DocumentRow; pages: LoadedPage[] }> {
  const document = await maybeOne<DocumentRow>(
    `select d.id, d.community_id, d.doc_type, d.status, d.language, c.nif as community_nif
       from public.documents d join public.communities c on c.id = d.community_id
      where d.id = $1`,
    [documentId],
  );
  if (!document) throw new Error(`extract: document ${documentId} not found`);
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
  if (rows.length === 0) throw new Error(`extract: document ${documentId} has no pages`);
  const pages: LoadedPage[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.render_path) throw new Error(`extract: page ${row.page_id} has no render yet (run the render step)`);
    const { bucket, key } = parseStoragePath(row.render_path);
    const jpeg = await getObject(bucket, key);
    pages.push({
      row,
      image: { index, jpeg, width: row.width ?? 0, height: row.height ?? 0, sha256: sha256(jpeg) },
    });
  }
  return { document, pages };
}

interface RunInsert {
  communityId: string;
  documentId: string;
  stage: 'extract' | 'verify';
  effort: string | null;
  result: ExtractDocumentResult;
  pages: readonly LoadedPage[];
  idempotencyKey: string;
  status?: string;
  batchId?: string | null;
  customId?: string | null;
}

/**
 * Store one run. The request is the redacted one from the extraction module (no base64), extended
 * with the identity of every page it carried: the file hash, the page id, the SHA-256 of the render
 * that was actually sent and the parameters that produced it.
 */
export async function insertRun(input: RunInsert): Promise<string> {
  const { result } = input;
  const requestJson = {
    request: result.requestJson,
    repair_request: result.repairRequestJson,
    pages: input.pages.map((p) => ({
      page_index: p.image.index,
      page_id: p.row.page_id,
      file_id: p.row.file_id,
      file_sha256: p.row.file_sha256,
      render_sha256: p.image.sha256,
      render_params: p.row.render_params,
      width: p.image.width,
      height: p.image.height,
    })),
    attempts: result.attempts,
  };
  const responseJson = {
    responses: result.responses,
    parsed: result.parsed,
    refinement_issues: result.refinementIssues,
    parse_error: result.parseError,
    repaired: result.repaired,
  };
  const row = await maybeOne<{ id: string }>(
    `insert into public.extraction_runs (community_id, document_id, stage, model, prompt_version, schema_version, effort,
                                         request_json, response_json, batch_id, custom_id, status, stop_reason,
                                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, idempotency_key)
     values ($1, $2, $3::public.run_stage, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::public.run_status, $13,
             $14, $15, $16, $17, $18, $19)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      input.communityId,
      input.documentId,
      input.stage,
      result.model,
      result.promptVersion,
      result.schemaVersion,
      input.effort,
      JSON.stringify(requestJson),
      JSON.stringify(responseJson),
      input.batchId ?? null,
      input.customId ?? null,
      input.status ?? runStatusOf(result),
      result.stopReason,
      result.usage.input_tokens,
      result.usage.output_tokens,
      result.usage.cache_read_input_tokens,
      result.usage.cache_creation_input_tokens,
      result.costUsd,
      input.idempotencyKey,
    ],
  );
  if (row) return row.id;
  const existing = await maybeOne<{ id: string }>('select id from public.extraction_runs where idempotency_key = $1', [input.idempotencyKey]);
  if (!existing) throw new Error(`extract: could not store the run for document ${input.documentId}`);
  return existing.id;
}

/** Read one document with one model, chunking when it is longer than the image limit. */
async function readDocument(
  document: DocumentRow,
  pages: readonly LoadedPage[],
  model: string,
): Promise<{ results: ExtractDocumentResult[]; parsed: unknown }> {
  const client = extractionClient();
  const language = (['es', 'ca', 'mixed'] as const).includes(document.language as Language) ? (document.language as Language) : undefined;
  const results: ExtractDocumentResult[] = [];
  for (const chunk of chunkPages(pages)) {
    const result = await extractDocument(
      {
        docType: document.doc_type,
        pages: chunk.map((p) => p.image),
        ...(language ? { language } : {}),
      },
      { client: client.raw, model },
    );
    results.push(result);
    if (result.refused) break;
  }
  const parsedParts = results.map((r) => r.parsed).filter((p) => p !== null);
  return { results, parsed: parsedParts.length === 0 ? null : mergeParsedChunks(parsedParts) };
}

export async function extractStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const documentId = typeof payload.document_id === 'string' ? payload.document_id : '';
  if (!documentId) throw new Error('extract: payload.document_id is required');

  const { document, pages } = await loadDocument(documentId);
  if (!schemaKeyFor(document.doc_type)) {
    console.log(`extract ${documentId}: ${document.doc_type} has no extraction schema`);
    return { document_id: documentId, skipped: `no schema for ${document.doc_type}` };
  }

  const chunks = chunkPages(pages);
  const done = await maybeOne<{ id: string; model: string }>(
    `select id, model from public.extraction_runs
      where document_id = $1 and stage = 'extract' and status = 'succeeded'
      order by created_at desc limit 1`,
    [documentId],
  );
  if (done) {
    console.log(`extract ${documentId}: already extracted by run ${done.id.slice(0, 8)} (${done.model})`);
    return { document_id: documentId, skipped: 'a succeeded extract run already exists', run_id: done.id };
  }

  let { results, parsed } = await readDocument(document, pages, MODELS.extraction);
  let runIds: string[] = [];
  const store = async (list: readonly ExtractDocumentResult[]): Promise<void> => {
    for (const [i, result] of list.entries()) {
      const chunkPagesOfRun = chunks[i] ?? [];
      runIds.push(
        await insertRun({
          communityId: document.community_id,
          documentId,
          stage: 'extract',
          effort: 'medium',
          result,
          pages: chunkPagesOfRun,
          idempotencyKey:
            extractionKey(documentId, result.promptVersion, result.schemaVersion, result.model) + (chunks.length > 1 ? `:c${i}` : ''),
        }),
      );
    }
  };
  await store(results);

  // a refusal is a fact about the request, recorded as such; the document is read once more by
  // Sonnet before it is handed to a person
  let refusalRetried = false;
  if (results.some((r) => r.refused)) {
    refusalRetried = true;
    const retry = await readDocument(document, pages, MODELS.verification);
    runIds = [];
    await store(retry.results);
    results = retry.results;
    parsed = retry.parsed;
  }

  const last = results[results.length - 1];
  const runId = runIds[runIds.length - 1] ?? null;
  if (!last || parsed === null) {
    const status = last?.refused ? 'refused' : 'parse_failed';
    console.log(`extract ${documentId}: ${status}${last?.parseError ? ` (${last.parseError})` : ''}`);
    return {
      document_id: documentId,
      status,
      run_ids: runIds,
      refusal_retried: refusalRetried,
      parse_error: last?.parseError ?? null,
    };
  }

  const flattened = flattenParsed(parsed, null, document.doc_type);
  const persistPages: PersistPage[] = pages.map((p) => ({
    index: p.image.index,
    page_id: p.row.page_id,
    mime: p.row.mime,
    has_text_layer: p.row.has_text_layer,
    file_id: p.row.file_id,
  }));

  const persisted = await transaction(async (client) => {
    const result = await persistExtraction(client, {
      document: {
        id: document.id,
        community_id: document.community_id,
        pages: persistPages,
        community_nif: document.community_nif,
      },
      parsed,
      docType: document.doc_type,
      flattened,
      runId,
    });
    await client.query(`update public.documents set current_run_id = $2, status = 'extracted' where id = $1`, [documentId, runId]);
    return result;
  });

  await query(
    `insert into public.jobs (community_id, idempotency_key, step, payload)
     values ($1, $2, 'crosscheck', $3::jsonb) on conflict (idempotency_key) do nothing`,
    [document.community_id, `${documentId}:crosscheck:${PIPELINE_VERSION()}`, JSON.stringify({ document_id: documentId })],
  );

  const cost = results.reduce((sum, r) => sum + r.costUsd, 0);
  console.log(
    `extract ${documentId} (${document.doc_type}, ${pages.length} page(s)): ${persisted.field_revisions} field revision(s), ` +
      `${persisted.validators.total} validator(s)${persisted.validators.failed.length > 0 ? ` (${persisted.validators.failed.length} not satisfied)` : ''}, ` +
      `$${cost.toFixed(4)}`,
  );
  return {
    document_id: documentId,
    status: 'extracted',
    run_ids: runIds,
    chunks: chunks.length,
    refusal_retried: refusalRetried,
    cost_usd: Number(cost.toFixed(6)),
    ...persisted,
  };
}
