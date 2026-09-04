import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { facturaFixture, NIF_COMMUNITY } from '@viladomat/core/extraction/__fixtures__/documents';
import { setExtractionClient, type ExtractionClientLike, type PageClassification } from '../extract/adapter.ts';
import { closeDb, db, query } from '../lib/db.ts';
import { loadEnv } from '../lib/env.ts';
import { putObject, resetStorageClient } from '../lib/storage.ts';
import { groupStep } from './group.ts';
import { extractStep } from './extract.ts';
import { extractCommand } from '../commands/extract.ts';
import { batchCollectCommand } from '../commands/batch.ts';

/**
 * The M2 pipeline against a real database and a stand-in model: a delivery batch of four pages
 * becomes two documents, and one of them is read and written out in full.
 *
 * The point is to exercise the SQL and the storage keys, not the model: the classifier and the
 * extraction model are both fakes, so no API key and no network are involved. What is being checked
 * is that a PDF stays whole, that a photograph of another document does not join it, that the run
 * row records what was asked and answered, and that the invoice ends up in the domain tables with a
 * crosscheck job waiting behind it.
 */

loadEnv();
process.env.DATABASE_URL = process.env.M2_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/m2test';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.VX_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'vx-m2-pipeline-'));
if (!process.env.IBAN_HMAC_KEY) process.env.IBAN_HMAC_KEY = Buffer.from('m2-test-key-for-iban-hmac').toString('base64');
resetStorageClient();

const reachable = await query("select to_regclass('public.documents') as t")
  .then((rows) => (rows[0] as { t: string | null } | undefined)?.t != null)
  .catch(() => false);
if (!reachable) console.warn(`no migrated database at ${process.env.DATABASE_URL}; the M2 pipeline test is skipped`);
const suite = reachable ? describe : describe.skip;

const BATCH = `lot-m2-${process.pid}`;
const BATCH_ID = `msgbatch_test_${process.pid}`;
let communityId = '';
let submittedRequests: { custom_id: string }[] = [];

/**
 * Remove the rows this file created. The append-only tables refuse DELETE by design, which is the
 * custody guarantee, so the deletion runs with row triggers off — and because that also switches
 * off the foreign keys, the tables are emptied child first. Only ever against the test database.
 */
async function removeCommunity(id: string): Promise<void> {
  const statements = [
    'delete from public.field_revisions where community_id = $1',
    'delete from public.field_values where community_id = $1',
    'delete from public.validator_results where community_id = $1',
    'delete from public.invoice_vat_summary where invoice_id in (select id from public.invoices where community_id = $1)',
    'delete from public.invoice_lines where community_id = $1',
    'delete from public.invoices where community_id = $1',
    'delete from public.bank_transactions where community_id = $1',
    'delete from public.bank_statements where community_id = $1',
    'delete from public.bank_accounts where community_id = $1',
    'delete from public.derrama_ledger where community_id = $1',
    'delete from public.derramas where community_id = $1',
    'delete from public.contract_milestones where community_id = $1',
    'delete from public.contracts where community_id = $1',
    'delete from public.liquidation_unit_rows where community_id = $1',
    'delete from public.liquidation_lines where community_id = $1',
    'delete from public.liquidations where community_id = $1',
    'delete from public.resolutions where community_id = $1',
    'delete from public.meetings where community_id = $1',
    'delete from public.ocr_words where page_id in (select id from public.pages where community_id = $1)',
    'delete from public.document_pages where document_id in (select id from public.documents where community_id = $1)',
    'update public.documents set current_run_id = null where community_id = $1',
    'delete from public.extraction_runs where community_id = $1',
    'delete from public.documents where community_id = $1',
    'delete from public.pages where community_id = $1',
    'delete from public.files where community_id = $1',
    'delete from public.party_ibans where community_id = $1',
    'delete from public.parties where community_id = $1',
    'delete from public.units where community_id = $1',
    'delete from public.jobs where community_id = $1',
    'delete from public.audit_log where community_id = $1',
    'delete from public.communities where id = $1',
  ];
  const client = await db().connect();
  try {
    await client.query("set session_replication_role = 'replica'");
    for (const sql of statements) await client.query(sql, [id]);
  } catch {
    /* leaving rows behind in a scratch database is harmless */
  } finally {
    await client.query("set session_replication_role = 'origin'").catch(() => undefined);
    client.release();
  }
}

afterAll(async () => {
  if (reachable && communityId) await removeCommunity(communityId);
  setExtractionClient(null);
  await closeDb();
});

/** The classification the fake returns for a page, by its position in the batch. */
function classificationFor(index: number): PageClassification {
  const acta = index < 3;
  return {
    page_index: index,
    doc_type: acta ? 'acta' : 'factura',
    page_role: acta ? (index === 0 ? 'first' : index === 2 ? 'last' : 'continuation') : 'single',
    issuer_name_hint: acta ? null : 'Instal·lacions Exemple S.L.',
    doc_number_hint: acta ? null : 'F-2024/017',
    date_hint: acta ? '2023-03-14' : '2024-03-15',
    page_marker: acta ? `${index + 1}/3` : null,
    language: 'ca',
    legibility: 0.93,
    is_handwritten_mostly: false,
    continues_previous: acta && index > 0,
    continues_previous_confidence: acta && index > 0 ? 0.93 : 0,
    reason: 'canned classification',
  };
}

function message(payload: unknown, model: string): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: JSON.stringify(payload), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 2200,
      output_tokens: 900,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}

/** The page index a classifier request is asking about: the block labelled "Page n:". */
function targetIndex(params: { messages: { content: unknown }[] }): number {
  const content = params.messages[0]?.content;
  if (!Array.isArray(content)) return 0;
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    const m = b.type === 'text' && b.text ? /^Page (\d+):$/.exec(b.text) : null;
    if (m) return Number(m[1]);
  }
  return 0;
}

/** A classifier when asked with Sonnet, an extraction model when asked with Opus. */
const fakeClient: ExtractionClientLike = {
  messages: {
    create: async (params) => {
      if (params.model.startsWith('claude-sonnet')) {
        return message({ pages: [classificationFor(targetIndex(params as never))] }, params.model) as never;
      }
      return message(facturaFixture, params.model) as never;
    },
    parse: () => {
      throw new Error('not exercised');
    },
    batches: {
      create: async (params) => {
        submittedRequests = params.requests.map((r) => ({ custom_id: r.custom_id }));
        return {
          id: BATCH_ID,
          type: 'message_batch',
          processing_status: 'in_progress',
          request_counts: { processing: submittedRequests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
          created_at: new Date().toISOString(),
          expires_at: new Date().toISOString(),
          ended_at: null,
          archived_at: null,
          cancel_initiated_at: null,
          results_url: null,
        } as never;
      },
      retrieve: async (id) =>
        ({
          id,
          type: 'message_batch',
          processing_status: 'ended',
          request_counts: { processing: 0, succeeded: submittedRequests.length, errored: 0, canceled: 0, expired: 0 },
          created_at: new Date().toISOString(),
          expires_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          archived_at: null,
          cancel_initiated_at: null,
          results_url: 'https://example.invalid/results',
        }) as never,
      results: async () => {
        const rows = submittedRequests.map((r) => ({
          custom_id: r.custom_id,
          result: { type: 'succeeded', message: message(facturaFixture, 'claude-opus-5') },
        }));
        return (async function* iterate() {
          for (const row of rows) yield row as never;
        })();
      },
    },
  },
};

async function jpeg(size: number): Promise<Buffer> {
  return sharp({ create: { width: size, height: Math.round(size * 1.3), channels: 3, background: { r: 240, g: 240, b: 235 } } })
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** One delivery batch: a three-page PDF and one photograph, rendered and thumbnailed. */
async function seedBatch(): Promise<{ pageIds: string[] }> {
  const community = (
    await query<{ id: string }>(
      `insert into public.communities (name, nif, fy_start_month) values ('Comunitat de prova pipeline M2', $1, 1) returning id`,
      [NIF_COMMUNITY],
    )
  )[0];
  communityId = String(community?.id);
  const thumb = await jpeg(768);
  const render = await jpeg(1200);
  const pageIds: string[] = [];

  const files: { name: string; mime: string; pages: number; sha: string }[] = [
    { name: 'a-acta.pdf', mime: 'application/pdf', pages: 3, sha: `11${'0'.repeat(62)}` },
    { name: 'b-factura.jpg', mime: 'image/jpeg', pages: 1, sha: `22${'0'.repeat(62)}` },
  ];
  for (const f of files) {
    const file = (
      await query<{ id: string }>(
        `insert into public.files (community_id, sha256, client_sha256, server_sha256, storage_path, original_name, mime, bytes,
                                   source, supplied_by_role, supplied_on, batch_label, status, hash_verified, page_count)
         values ($1, $2, $2, $2, $3, $4, $5, 4096, 'admin_delivery', 'administrator', current_date, $6, 'stored', true, $7)
         returning id`,
        [communityId, f.sha, `originals/${communityId}/${f.sha.slice(0, 2)}/${f.sha}`, f.name, f.mime, BATCH, f.pages],
      )
    )[0];
    for (let n = 1; n <= f.pages; n++) {
      const renderKey = `${communityId}/${f.sha}/p${n}_1200x1560.jpg`;
      const thumbKey = `${communityId}/${f.sha}/t${n}.jpg`;
      await putObject('derived', renderKey, render, 'image/jpeg');
      await putObject('derived', thumbKey, thumb, 'image/jpeg');
      const page = (
        await query<{ id: string }>(
          `insert into public.pages (community_id, file_id, page_no, render_path, thumb_path, width, height, long_edge,
                                     render_params, has_text_layer)
           values ($1, $2, $3, $4, $5, 1200, 1560, 1568, '{"long_edge":1568,"source":"pdfium"}'::jsonb, false)
           returning id`,
          [communityId, file?.id, n, `derived/${renderKey}`, `derived/${thumbKey}`],
        )
      )[0];
      pageIds.push(String(page?.id));
    }
  }
  return { pageIds };
}

const job = (step: string) => ({
  id: 'test',
  community_id: communityId,
  idempotency_key: `test:${step}`,
  step,
  attempts: 1,
  max_attempts: 1,
  payload: {},
});

suite('a delivery batch through grouping and extraction', () => {
  it('groups four pages into two documents and reads the invoice', async () => {
    await seedBatch();
    setExtractionClient(fakeClient);

    // ---- grouping ----------------------------------------------------------
    const grouped = await groupStep({ batch_label: BATCH }, job('group'));
    expect(grouped.pages).toBe(4);
    expect(grouped.documents).toBe(2);
    expect(grouped.classifications_requested).toBe(4);

    const documents = await query<{ id: string; doc_type: string; status: string; n: number; grouping_confidence: string; issuer_class: string; provenance_chain: string[]; language: string }>(
      `select d.id, d.doc_type, d.status, d.grouping_confidence, d.issuer_class, d.provenance_chain, d.language,
              (select count(*)::int from public.document_pages dp where dp.document_id = d.id) as n
         from public.documents d where d.community_id = $1 order by d.doc_type`,
      [communityId],
    );
    expect(documents.map((d) => [d.doc_type, d.n])).toEqual([
      ['acta', 3],
      ['factura', 1],
    ]);
    const acta = documents[0];
    expect(acta?.status).toBe('classified');
    expect(acta?.issuer_class).toBe('administrator');
    expect(acta?.provenance_chain).toEqual(['administrator', 'requesting_owner']);
    expect(acta?.language).toBe('ca');
    expect(Number(acta?.grouping_confidence)).toBeGreaterThanOrEqual(0.9);

    const seqs = await query<{ seq: number }>(
      'select seq from public.document_pages where document_id = $1 order by seq',
      [acta?.id],
    );
    expect(seqs.map((s) => s.seq)).toEqual([1, 2, 3]);

    const classifyRuns = await query<{ n: number }>(
      `select count(*)::int as n from public.extraction_runs where community_id = $1 and stage = 'classify' and status = 'succeeded'`,
      [communityId],
    );
    expect(classifyRuns[0]?.n).toBe(4);

    // re-running the grouping neither re-classifies nor re-groups
    const again = await groupStep({ batch_label: BATCH }, job('group'));
    expect(again.documents).toBe(0);
    expect(again.skipped).toBe('nothing to group');

    // ---- extraction --------------------------------------------------------
    const invoiceDoc = String(documents[1]?.id);
    const extracted = await extractStep({ document_id: invoiceDoc }, job('extract'));
    expect(extracted.status).toBe('extracted');
    expect(extracted.chunks).toBe(1);
    expect(extracted.refusal_retried).toBe(false);
    expect(Number(extracted.field_revisions)).toBeGreaterThan(10);

    const run = (
      await query<{ id: string; status: string; model: string; request_json: Record<string, unknown>; input_tokens: number; cost_usd: string; idempotency_key: string }>(
        `select id, status, model, request_json, input_tokens, cost_usd, idempotency_key
           from public.extraction_runs where document_id = $1 and stage = 'extract'`,
        [invoiceDoc],
      )
    )[0];
    expect(run?.status).toBe('succeeded');
    expect(run?.model).toBe('claude-opus-5');
    expect(run?.idempotency_key).toMatch(/^doc:[0-9a-f-]+:p1:s1:claude-opus-5$/);
    expect(run?.input_tokens).toBe(2200);
    expect(Number(run?.cost_usd)).toBeGreaterThan(0);
    // the request carries the page hashes and render parameters, never the bytes
    const requestPages = run?.request_json['pages'] as { render_sha256: string; render_params: unknown }[];
    expect(requestPages).toHaveLength(1);
    expect(requestPages[0]?.render_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(requestPages[0]?.render_params).toMatchObject({ long_edge: 1568 });
    expect(JSON.stringify(run?.request_json)).not.toContain('"data"');

    const doc = (await query<{ status: string; current_run_id: string; dedupe_key: string }>('select status, current_run_id, dedupe_key from public.documents where id = $1', [invoiceDoc]))[0];
    expect(doc?.status).toBe('extracted');
    expect(doc?.current_run_id).toBe(run?.id);
    expect(doc?.dedupe_key).toBeTruthy();

    const invoice = (await query<{ total: string }>('select total from public.invoices where document_id = $1', [invoiceDoc]))[0];
    expect(invoice?.total).toBe('3253.80');

    const queued = await query<{ step: string; payload: Record<string, unknown> }>(
      `select step, payload from public.jobs where community_id = $1 and step = 'crosscheck'`,
      [communityId],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ document_id: invoiceDoc });

    // re-running the extraction is a no-op at the same prompt and schema version
    const repeat = await extractStep({ document_id: invoiceDoc }, job('extract'));
    expect(repeat.skipped).toBe('a succeeded extract run already exists');
  });
});

suite('the Batches route', () => {
  it('submits one batch, records what was asked, and writes the answers as their own runs', async () => {
    setExtractionClient(fakeClient);
    const sha = `33${'0'.repeat(62)}`;
    const file = (
      await query<{ id: string }>(
        `insert into public.files (community_id, sha256, client_sha256, server_sha256, storage_path, original_name, mime, bytes,
                                   source, supplied_by_role, supplied_on, batch_label, status, hash_verified, page_count)
         values ($1, $2, $2, $2, $3, 'c-factura.jpg', 'image/jpeg', 4096, 'admin_delivery', 'administrator', current_date, $4,
                 'stored', true, 1)
         returning id`,
        [communityId, sha, `originals/${communityId}/33/${sha}`, BATCH],
      )
    )[0];
    const renderKey = `${communityId}/${sha}/p1_1200x1560.jpg`;
    await putObject('derived', renderKey, await jpeg(1200), 'image/jpeg');
    const page = (
      await query<{ id: string }>(
        `insert into public.pages (community_id, file_id, page_no, render_path, width, height, long_edge, has_text_layer)
         values ($1, $2, 1, $3, 1200, 1560, 1568, false) returning id`,
        [communityId, file?.id, `derived/${renderKey}`],
      )
    )[0];
    const document = (
      await query<{ id: string }>(
        `insert into public.documents (community_id, doc_type, status, language, issuer_class, provenance_chain, grouped_by)
         values ($1, 'factura', 'classified', 'ca', 'administrator', array['administrator','requesting_owner'], 'auto') returning id`,
        [communityId],
      )
    )[0];
    const documentId = String(document?.id);
    await query('insert into public.document_pages (document_id, page_id, seq) values ($1, $2, 1)', [documentId, page?.id]);

    const submitted = await extractCommand({ document: documentId, batchApi: true, community: communityId });
    expect(submitted.submitted).toBe(1);
    expect(submitted.batchId).toBe(BATCH_ID);

    const asked = (
      await query<{ status: string; batch_id: string; custom_id: string; request_json: Record<string, unknown> }>(
        `select status, batch_id, custom_id, request_json from public.extraction_runs
          where document_id = $1 and status = 'submitted'`,
        [documentId],
      )
    )[0];
    expect(asked?.batch_id).toBe(BATCH_ID);
    expect(asked?.custom_id).toMatch(/^d_[0-9a-f]{12}_s1$/);
    expect(JSON.stringify(asked?.request_json)).not.toContain('"data"');

    const collected = await batchCollectCommand(BATCH_ID, { community: communityId });
    expect(collected).toMatchObject({ processingStatus: 'ended', results: 1, persisted: 1, expired: 0, errored: 0 });
    expect(collected.costUsd).toBeGreaterThan(0);

    // the submitted row is untouched (extraction_runs is append-only); the answer is its own row
    const runs = await query<{ status: string }>(
      `select status from public.extraction_runs where document_id = $1 and stage = 'extract' order by created_at`,
      [documentId],
    );
    expect(runs.map((r) => r.status)).toEqual(['submitted', 'succeeded']);

    const doc = (await query<{ status: string }>('select status from public.documents where id = $1', [documentId]))[0];
    expect(doc?.status).toBe('extracted');
    const invoice = (await query<{ total: string }>('select total from public.invoices where document_id = $1', [documentId]))[0];
    expect(invoice?.total).toBe('3253.80');
  });
});
