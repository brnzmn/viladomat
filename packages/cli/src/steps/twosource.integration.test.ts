import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CIF_VENDOR, clone, facturaFixture, NIF_COMMUNITY } from '@viladomat/core/extraction/__fixtures__/documents';
import { setExtractionClient, type ExtractionClientLike } from '../extract/adapter.ts';
import { flattenParsed } from '../extract/adapter.ts';
import { persistExtraction, type Queryable } from '../extract/persist.ts';
import { closeDb, db, query } from '../lib/db.ts';
import { loadEnv } from '../lib/env.ts';
import { putObject, resetStorageClient } from '../lib/storage.ts';
import { crosscheckStep } from './crosscheck.ts';
import { verifyStep } from './verify.ts';

/**
 * The two-source rule from end to end: a persisted invoice, real OCR words, the crosscheck step and
 * then a third reading by a stand-in for Sonnet.
 *
 * The three properties this has to demonstrate are the ones a reviewer relies on. A field is
 * accepted automatically only when the arithmetic held **and** the two readers said the same thing.
 * A field a person confirmed is never touched by either step. And the third reading can only take
 * acceptance away, never grant it.
 *
 * The rows are committed (the steps open their own transactions), so this test uses its own
 * database and removes its community at the end. The extraction client is a fake: no API key, no
 * network.
 */

loadEnv();
process.env.DATABASE_URL = process.env.M2_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/m2test';
// force the filesystem object store: the page renders live in a temporary directory
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.VX_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'vx-m2-'));
if (!process.env.IBAN_HMAC_KEY) process.env.IBAN_HMAC_KEY = Buffer.from('m2-test-key-for-iban-hmac').toString('base64');
resetStorageClient();

const reachable = await query("select to_regclass('public.documents') as t")
  .then((rows) => (rows[0] as { t: string | null } | undefined)?.t != null)
  .catch(() => false);
if (!reachable) console.warn(`no migrated database at ${process.env.DATABASE_URL}; the two-source integration tests are skipped`);
const suite = reachable ? describe : describe.skip;

const SHA = 'a1b2c3d4'.repeat(8);
let communityId = '';

/** A response from a stand-in model: one text block holding the JSON of a parsed document. */
function fakeMessage(parsed: unknown, model: string): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: JSON.stringify(parsed), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 800,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}

function fakeClient(parsed: unknown): ExtractionClientLike {
  const notUsed = (): never => {
    throw new Error('the fake client was asked for something this test does not exercise');
  };
  return {
    messages: {
      create: async (params) => fakeMessage(parsed, params.model) as never,
      parse: notUsed,
      batches: { create: notUsed, retrieve: notUsed, results: notUsed },
    },
  };
}

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

interface Fixture {
  documentId: string;
  pageId: string;
}

/** One community, one photographed invoice page, the invoice persisted, and canned OCR words. */
async function seed(): Promise<Fixture> {
  const community = (
    await query<{ id: string }>(
      `insert into public.communities (name, nif, fy_start_month) values ('Comunitat de prova dues fonts', $1, 1) returning id`,
      [NIF_COMMUNITY],
    )
  )[0];
  communityId = String(community?.id);
  const file = (
    await query<{ id: string }>(
      `insert into public.files (community_id, sha256, client_sha256, server_sha256, storage_path, original_name, mime, bytes,
                                 source, supplied_by_role, supplied_on, batch_label, status, hash_verified)
       values ($1, $2, $2, $2, $3, 'factura.jpg', 'image/jpeg', 2048, 'admin_delivery', 'administrator', current_date,
               'lot-dues-fonts', 'stored', true)
       returning id`,
      [communityId, SHA, `originals/${communityId}/${SHA.slice(0, 2)}/${SHA}.jpg`],
    )
  )[0];
  const renderKey = `${communityId}/${SHA}/p1_1200x1568.jpg`;
  await putObject('derived', renderKey, Buffer.from('not a real jpeg, the model is a fake'), 'image/jpeg');
  const page = (
    await query<{ id: string }>(
      `insert into public.pages (community_id, file_id, page_no, render_path, width, height, long_edge, has_text_layer)
       values ($1, $2, 1, $3, 1200, 1568, 1568, false) returning id`,
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
  const pageId = String(page?.id);
  await query('insert into public.document_pages (document_id, page_id, seq) values ($1, $2, 1)', [documentId, pageId]);
  const run = (
    await query<{ id: string }>(
      `insert into public.extraction_runs (community_id, document_id, stage, model, prompt_version, schema_version, status, idempotency_key)
       values ($1, $2, 'extract', 'claude-opus-5', 'p1', 's1', 'succeeded', $3) returning id`,
      [communityId, documentId, `twosource:${documentId}`],
    )
  )[0];

  await persistExtraction(db() as unknown as Queryable, {
    document: {
      id: documentId,
      community_id: communityId,
      pages: [{ index: 0, page_id: pageId, mime: 'image/jpeg', has_text_layer: false }],
      community_nif: NIF_COMMUNITY,
    },
    parsed: facturaFixture,
    docType: 'factura',
    flattened: flattenParsed(facturaFixture, null, 'factura'),
    runId: String(run?.id),
    now: new Date('2026-01-01T00:00:00Z'),
  });

  // Tesseract words for this page. The totals block agrees with the model; the VAT figure is
  // misread by one digit; the NIF is printed away from the box the model returned; every other
  // field has no words at all.
  const words: [string, number, number, number, number][] = [
    ['3.253,80', 830, 1302, 990, 1330],
    ['€', 995, 1302, 1008, 1330],
    ['318,80', 120, 205, 240, 226],
    [CIF_VENDOR, 300, 900, 460, 926],
  ];
  await query(
    `insert into public.ocr_words (page_id, idx, text, x0, y0, x1, y1, confidence, engine, lang)
     select $1, t.idx, t.text, t.x0, t.y0, t.x1, t.y1, 92, 'tesseract', 'spa+cat'
       from unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[]) as t(idx, text, x0, y0, x1, y1)`,
    [
      pageId,
      words.map((_, i) => i),
      words.map((w) => w[0]),
      words.map((w) => w[1]),
      words.map((w) => w[2]),
      words.map((w) => w[3]),
      words.map((w) => w[4]),
    ],
  );
  return { documentId, pageId };
}

const fieldOf = async (documentId: string, path_: string): Promise<Record<string, unknown> | undefined> =>
  (
    await query<Record<string, unknown>>(
      `select value_norm, ocr_value_norm, ocr_agrees, sonnet_value_norm, sonnet_agrees, crop_status, status, validator_ok
         from public.field_values where document_id = $1 and field_path = $2`,
      [documentId, path_],
    )
  )[0];

suite('the two-source rule end to end', () => {
  it('accepts, holds back and demotes exactly the fields it should', async () => {
    const { documentId } = await seed();

    // a person has already confirmed the invoice number by hand
    await query(
      `update public.field_values set value = '"F-2024/017 (confirmat)"'::jsonb, value_norm = 'f-2024/017 (confirmat)',
              status = 'human_confirmed' where document_id = $1 and field_path = 'numero'`,
      [documentId],
    );

    const crosscheck = await crosscheckStep({ document_id: documentId }, {
      id: 'test',
      community_id: communityId,
      idempotency_key: `${documentId}:crosscheck:1`,
      step: 'crosscheck',
      attempts: 1,
      max_attempts: 1,
      payload: {},
    });
    expect(crosscheck.checked).toBeGreaterThan(5);

    // the total: validators passed, the words in the model's box say the same thing
    const total = await fieldOf(documentId, 'total_factura');
    expect(total).toMatchObject({
      value_norm: '3253.80',
      ocr_value_norm: '3253.80',
      ocr_agrees: true,
      crop_status: 'anchored',
      status: 'auto_accepted',
      validator_ok: true,
    });

    // the VAT figure: located, but the two readers differ by a digit
    const iva = await fieldOf(documentId, 'iva_total');
    expect(iva).toMatchObject({ value_norm: '313.80', ocr_value_norm: '318.80', ocr_agrees: false, status: 'needs_review' });

    // the issuer's NIF: found on the page but outside the box, which does not stop acceptance —
    // it only means no crop of it may be printed
    const nif = await fieldOf(documentId, 'emisor.nif');
    expect(nif).toMatchObject({ ocr_agrees: true, crop_status: 'approximate', status: 'auto_accepted' });

    // a field the OCR never found stays for a person
    const base = await fieldOf(documentId, 'base_imponible_total');
    expect(base).toMatchObject({ ocr_agrees: null, crop_status: 'page_only', status: 'needs_review' });

    // the confirmed field was not touched
    const numero = await fieldOf(documentId, 'numero');
    expect(numero).toMatchObject({ status: 'human_confirmed', value_norm: 'f-2024/017 (confirmat)', ocr_value_norm: null });

    const status = (await query<{ status: string }>('select status from public.documents where id = $1', [documentId]))[0];
    expect(status?.status).toBe('verified');

    // ---- the third opinion -------------------------------------------------
    const sonnetReading = clone(facturaFixture);
    sonnetReading.total_factura = 3299.8; // Sonnet reads the accepted total differently
    setExtractionClient(fakeClient(sonnetReading));

    const verified = await verifyStep({ document_id: documentId }, {
      id: 'test',
      community_id: communityId,
      idempotency_key: `${documentId}:verify:1`,
      step: 'verify',
      attempts: 1,
      max_attempts: 1,
      payload: {},
    });
    expect(verified.disagreed).toBe(1);
    expect(verified.demoted).toBe(1);

    // demoted: two readers agreed, the third did not
    const totalAfter = await fieldOf(documentId, 'total_factura');
    expect(totalAfter).toMatchObject({ sonnet_value_norm: '3299.80', sonnet_agrees: false, status: 'needs_review' });

    // never promoted: the third reader agreeing does not accept a field the OCR could not confirm
    const ivaAfter = await fieldOf(documentId, 'iva_total');
    expect(ivaAfter).toMatchObject({ sonnet_value_norm: '313.80', sonnet_agrees: true, status: 'needs_review' });
    const baseAfter = await fieldOf(documentId, 'base_imponible_total');
    expect(baseAfter).toMatchObject({ sonnet_agrees: true, status: 'needs_review' });

    // an accepted field the third reader confirms stays accepted, and is not raised any higher
    const nifAfter = await fieldOf(documentId, 'emisor.nif');
    expect(nifAfter).toMatchObject({ sonnet_agrees: true, status: 'auto_accepted' });

    // and the confirmed field is still untouched
    const numeroAfter = await fieldOf(documentId, 'numero');
    expect(numeroAfter).toMatchObject({ status: 'human_confirmed', sonnet_value_norm: null });

    // the third reading was recorded as its own run
    const runs = await query<{ n: number }>(
      `select count(*)::int as n from public.extraction_runs where document_id = $1 and stage = 'verify'`,
      [documentId],
    );
    expect(runs[0]?.n).toBe(1);

    // running the crosscheck again changes nothing
    await crosscheckStep({ document_id: documentId }, {
      id: 'test',
      community_id: communityId,
      idempotency_key: `${documentId}:crosscheck:1`,
      step: 'crosscheck',
      attempts: 1,
      max_attempts: 1,
      payload: {},
    });
    const numeroFinal = await fieldOf(documentId, 'numero');
    expect(numeroFinal).toMatchObject({ status: 'human_confirmed', value_norm: 'f-2024/017 (confirmat)' });
  });
});
