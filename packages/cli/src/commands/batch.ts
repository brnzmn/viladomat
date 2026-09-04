import { resolveCommunity } from '../lib/community.ts';
import { maybeOne, query, transaction } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  estimateCostUsd,
  extractionClient,
  flattenParsed,
  parseBatchResult,
  type BatchOutcome,
  type DocType,
} from '../extract/adapter.ts';
import { persistExtraction, type PersistPage } from '../extract/persist.ts';
import { extractionKey } from '../steps/extract.ts';

/**
 * `vx batch collect` — read back a Message Batch and write what came out of it.
 *
 * The submitted run rows recorded what was asked; this command records what was answered, as new
 * run rows (`extraction_runs` is append-only, so the submitted row is a separate, earlier fact and
 * is never overwritten). From there the path is the same as the synchronous step: field revisions,
 * validators, domain rows, and a `crosscheck` job.
 *
 * The three non-answers are handled rather than hidden. An `expired` request goes back into the
 * queue as an ordinary `extract` job. An `errored` request is stored with its error and re-queued
 * only when the API called it retryable. A refusal or unparseable output is stored as such and left
 * for a person, exactly as in the synchronous path.
 */

export interface BatchCollectOptions {
  community?: string;
  /** Print what would happen and write nothing. */
  dryRun?: boolean;
}

export interface BatchCollectSummary {
  batchId: string;
  processingStatus: string;
  results: number;
  persisted: number;
  refused: number;
  parseFailed: number;
  expired: number;
  errored: number;
  requeued: number;
  unknownCustomIds: string[];
  costUsd: number;
}

interface SubmittedRun {
  document_id: string;
  custom_id: string;
  model: string;
  community_id: string;
  doc_type: DocType;
  community_nif: string | null;
}

interface DocPageRow {
  page_id: string;
  seq: number;
  mime: string | null;
  has_text_layer: boolean | null;
  file_id: string;
}

async function persistPagesOf(documentId: string): Promise<PersistPage[]> {
  const rows = await query<DocPageRow>(
    `select dp.page_id, dp.seq, f.mime, p.has_text_layer, p.file_id
       from public.document_pages dp
       join public.pages p on p.id = dp.page_id
       join public.files f on f.id = p.file_id
      where dp.document_id = $1 order by dp.seq`,
    [documentId],
  );
  return rows.map((r, index) => ({ index, page_id: r.page_id, mime: r.mime, has_text_layer: r.has_text_layer, file_id: r.file_id }));
}

export async function batchCollectCommand(batchId: string, opts: BatchCollectOptions = {}): Promise<BatchCollectSummary> {
  const community = await resolveCommunity(opts.community);
  const client = extractionClient();
  const batch = await client.raw.messages.batches.retrieve(batchId);
  const summary: BatchCollectSummary = {
    batchId,
    processingStatus: batch.processing_status,
    results: 0,
    persisted: 0,
    refused: 0,
    parseFailed: 0,
    expired: 0,
    errored: 0,
    requeued: 0,
    unknownCustomIds: [],
    costUsd: 0,
  };
  if (batch.processing_status !== 'ended') {
    const counts = batch.request_counts;
    console.log(
      `batch ${batchId}: ${batch.processing_status}` +
        (counts ? ` (${counts.processing} processing, ${counts.succeeded} succeeded, ${counts.errored} errored, ${counts.expired} expired)` : ''),
    );
    console.log('nothing to collect yet; run this again when the batch has ended');
    return summary;
  }

  const submitted = await query<SubmittedRun>(
    `select distinct on (r.custom_id) r.document_id, r.custom_id, r.model, r.community_id, d.doc_type, c.nif as community_nif
       from public.extraction_runs r
       join public.documents d on d.id = r.document_id
       join public.communities c on c.id = d.community_id
      where r.batch_id = $1 and r.custom_id is not null
      order by r.custom_id, r.created_at`,
    [batchId],
  );
  const byCustomId = new Map(submitted.map((r) => [r.custom_id, r]));

  const results = await client.readBatchResults(batchId);
  summary.results = results.length;

  for (const raw of results) {
    const entry = byCustomId.get(raw.custom_id);
    if (!entry) {
      summary.unknownCustomIds.push(raw.custom_id);
      continue;
    }
    const outcome: BatchOutcome = parseBatchResult(raw, entry.doc_type);

    if (outcome.status === 'expired' || outcome.status === 'canceled') {
      summary.expired += 1;
      if (!opts.dryRun) {
        await storeOutcomeRun(entry, batchId, outcome.status === 'expired' ? 'expired' : 'errored', { batch_status: outcome.status }, 0);
        await requeue(entry);
        summary.requeued += 1;
      }
      console.log(`  ${entry.document_id.slice(0, 8)}  ${outcome.status}; re-queued as an extract job`);
      continue;
    }
    if (outcome.status === 'errored') {
      summary.errored += 1;
      if (!opts.dryRun) {
        await storeOutcomeRun(entry, batchId, 'errored', { error: outcome.error, retryable: outcome.retryable }, 0);
        if (outcome.retryable) {
          await requeue(entry);
          summary.requeued += 1;
        }
      }
      console.log(`  ${entry.document_id.slice(0, 8)}  errored${outcome.retryable ? ', re-queued' : ', not retryable — needs a person'}`);
      continue;
    }

    const cost = outcome.costUsd || estimateCostUsd(outcome.usage, outcome.model, { batch: true });
    summary.costUsd += cost;
    const status = outcome.refused ? 'refused' : outcome.parsed === null ? 'parse_failed' : 'succeeded';
    if (status === 'refused') summary.refused += 1;
    if (status === 'parse_failed') summary.parseFailed += 1;
    if (opts.dryRun) {
      console.log(`  ${entry.document_id.slice(0, 8)}  ${status} (dry run)`);
      continue;
    }

    const runId = await storeOutcomeRun(
      entry,
      batchId,
      status,
      {
        message: outcome.raw,
        parsed: outcome.parsed,
        refinement_issues: outcome.refinementIssues,
        parse_error: outcome.parseError,
      },
      cost,
      { usage: outcome.usage, stopReason: outcome.stopReason, model: outcome.model },
    );

    if (status !== 'succeeded' || outcome.parsed === null) {
      console.log(`  ${entry.document_id.slice(0, 8)}  ${status}; left for a person`);
      continue;
    }

    const pages = await persistPagesOf(entry.document_id);
    const flattened = flattenParsed(outcome.parsed, null, entry.doc_type);
    const persisted = await transaction(async (c) => {
      const out = await persistExtraction(c, {
        document: { id: entry.document_id, community_id: entry.community_id, pages, community_nif: entry.community_nif },
        parsed: outcome.parsed,
        docType: entry.doc_type,
        flattened,
        runId,
      });
      await c.query(`update public.documents set current_run_id = $2, status = 'extracted' where id = $1`, [entry.document_id, runId]);
      return out;
    });
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'crosscheck', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [entry.community_id, `${entry.document_id}:crosscheck:${PIPELINE_VERSION()}`, JSON.stringify({ document_id: entry.document_id })],
    );
    summary.persisted += 1;
    console.log(
      `  ${entry.document_id.slice(0, 8)}  ${entry.doc_type.padEnd(20)} ${persisted.field_revisions} field revision(s), ` +
        `${persisted.validators.failed.length} validator(s) not satisfied`,
    );
  }

  console.log(
    `batch ${batchId}: ${summary.results} result(s), ${summary.persisted} persisted, ${summary.refused} refused, ` +
      `${summary.parseFailed} unparseable, ${summary.expired} expired, ${summary.errored} errored, ` +
      `${summary.requeued} re-queued, $${summary.costUsd.toFixed(4)}`,
  );
  if (summary.unknownCustomIds.length > 0) {
    console.log(`  ${summary.unknownCustomIds.length} result(s) carried a custom id this database does not know`);
  }
  if (community.id !== submitted[0]?.community_id && submitted.length > 0) {
    console.log('  note: the batch belongs to another community than the one selected');
  }
  return summary;
}

async function storeOutcomeRun(
  entry: SubmittedRun,
  batchId: string,
  status: string,
  responseJson: unknown,
  costUsd: number,
  extra?: { usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }; stopReason: string; model: string },
): Promise<string> {
  const model = extra?.model ?? entry.model;
  const key = extractionKey(entry.document_id, PROMPT_VERSION, SCHEMA_VERSION, model);
  const inserted = await maybeOne<{ id: string }>(
    `insert into public.extraction_runs (community_id, document_id, stage, model, prompt_version, schema_version, effort,
                                         response_json, batch_id, custom_id, status, stop_reason,
                                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, idempotency_key)
     values ($1, $2, 'extract', $3, $4, $5, 'medium', $6::jsonb, $7, $8, $9::public.run_status, $10, $11, $12, $13, $14, $15, $16)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      entry.community_id,
      entry.document_id,
      model,
      PROMPT_VERSION,
      SCHEMA_VERSION,
      JSON.stringify(responseJson),
      batchId,
      entry.custom_id,
      status,
      extra?.stopReason ?? null,
      extra?.usage.input_tokens ?? null,
      extra?.usage.output_tokens ?? null,
      extra?.usage.cache_read_input_tokens ?? null,
      extra?.usage.cache_creation_input_tokens ?? null,
      costUsd,
      key,
    ],
  );
  if (inserted) return inserted.id;
  const existing = await maybeOne<{ id: string }>('select id from public.extraction_runs where idempotency_key = $1', [key]);
  if (!existing) throw new Error(`batch collect: could not store the run for document ${entry.document_id}`);
  return existing.id;
}

async function requeue(entry: SubmittedRun): Promise<void> {
  await query(
    `insert into public.jobs (community_id, idempotency_key, step, payload)
     values ($1, $2, 'extract', $3::jsonb) on conflict (idempotency_key) do nothing`,
    [entry.community_id, `${entry.document_id}:extract:${PIPELINE_VERSION()}`, JSON.stringify({ document_id: entry.document_id })],
  );
}
