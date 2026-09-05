import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  actaFixture,
  clone,
  contratoFixture,
  derramaFixture,
  extractoFixture,
  facturaFixture,
  liquidacionFixture,
  CIF_VENDOR,
  IBAN_VENDOR,
  NIF_COMMUNITY,
} from '@viladomat/core/extraction/__fixtures__/documents';
import { loadEnv } from '../lib/env.ts';
import { hmacNif } from '../vendors/links.ts';
import { flattenParsed, type DocType } from './adapter.ts';
import { persistExtraction, type PersistPage, type Queryable } from './persist.ts';

/**
 * What each of the six unlocking document classes turns into, against a real database with the
 * migrations applied.
 *
 * Every case runs inside a transaction that is rolled back, so the database is left exactly as it
 * was and the cases cannot see each other. The database is the M2 one (`m2test`); the shared
 * development database is never touched.
 */

loadEnv();
if (!process.env.IBAN_HMAC_KEY) process.env.IBAN_HMAC_KEY = Buffer.from('m2-test-key-for-iban-hmac').toString('base64');

const DATABASE_URL = process.env.M2_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/m2test';

// the same DATE handling the worker's pool installs: ISO strings, never timezone-shifted Dates
pg.types.setTypeParser(1082, (v: string) => v);

// probed before the suites are collected, so an unavailable database skips rather than fails
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const reachable = await pool
  .query("select to_regclass('public.documents') as t")
  .then((r) => (r.rows[0] as { t: string | null } | undefined)?.t != null)
  .catch(() => false);
if (!reachable) {
  console.warn(`no migrated database at ${DATABASE_URL}; the persistence integration tests are skipped`);
}

afterAll(async () => {
  await pool.end();
});

const suite = reachable ? describe : describe.skip;

/** The units the fixtures refer to, by label only. */
const UNIT_LABELS = ['Pral 1a', '1r 1a', '2n 2a', '3r 1a', '4t 1a', '4t 2a'];

interface Scenario {
  client: pg.PoolClient;
  communityId: string;
  documentId: string;
  runId: string;
  pages: PersistPage[];
  pageIds: string[];
}

/**
 * Open a transaction, seed one community with its units, one file, `pageCount` pages and one
 * document over them, and hand the whole thing to the test. Everything is rolled back afterwards.
 */
async function scenario(
  docType: DocType,
  opts: { pageCount?: number; mime?: string; hasTextLayer?: boolean; sha?: string } = {},
  run: (s: Scenario) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const one = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> => {
      const r = await client.query(sql, params);
      return (r.rows[0] ?? {}) as Record<string, unknown>;
    };
    const community = await one(
      `insert into public.communities (name, nif, address, fy_start_month) values ('Comunitat de prova M2', $1, 'Carrer Exemple 25', 1) returning id`,
      [NIF_COMMUNITY],
    );
    const communityId = String(community.id);
    for (const [i, label] of UNIT_LABELS.entries()) {
      await client.query(`insert into public.units (community_id, label, quota_pct) values ($1, $2, $3)`, [communityId, label, 6 + i * 0.4]);
    }
    const sha = opts.sha ?? `m2test${Math.random().toString(16).slice(2)}`.padEnd(64, '0').slice(0, 64);
    const file = await one(
      `insert into public.files (community_id, sha256, client_sha256, storage_path, original_name, mime, bytes, source,
                                 supplied_by_role, supplied_on, batch_label, status, hash_verified, server_sha256)
       values ($1, $2, $2, $3, $4, $5, 1024, 'admin_delivery', 'administrator', current_date, 'lot-de-prova', 'stored', true, $2)
       returning id`,
      [communityId, sha, `originals/${communityId}/${sha.slice(0, 2)}/${sha}.jpg`, 'document.jpg', opts.mime ?? 'image/jpeg'],
    );
    const pageCount = opts.pageCount ?? 1;
    const pageIds: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await one(
        `insert into public.pages (community_id, file_id, page_no, render_path, width, height, long_edge, has_text_layer)
         values ($1, $2, $3, $4, 1200, 1568, 1568, $5) returning id`,
        [communityId, file.id, i, `derived/${communityId}/${sha}/p${i}_1200x1568.jpg`, opts.hasTextLayer ?? false],
      );
      pageIds.push(String(page.id));
    }
    const document = await one(
      `insert into public.documents (community_id, doc_type, status, language, issuer_class, provenance_chain, grouped_by)
       values ($1, $2, 'classified', 'ca', 'administrator', array['administrator','requesting_owner'], 'auto') returning id`,
      [communityId, docType],
    );
    const documentId = String(document.id);
    for (const [i, pageId] of pageIds.entries()) {
      await client.query(`insert into public.document_pages (document_id, page_id, seq) values ($1, $2, $3)`, [documentId, pageId, i + 1]);
    }
    const runRow = await one(
      `insert into public.extraction_runs (community_id, document_id, stage, model, prompt_version, schema_version, status, idempotency_key)
       values ($1, $2, 'extract', 'claude-opus-5', 'p1', 's1', 'succeeded', $3) returning id`,
      [communityId, documentId, `test:${documentId}`],
    );
    await run({
      client,
      communityId,
      documentId,
      runId: String(runRow.id),
      pageIds,
      pages: pageIds.map((page_id, index) => ({
        index,
        page_id,
        mime: opts.mime ?? 'image/jpeg',
        has_text_layer: opts.hasTextLayer ?? false,
      })),
    });
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/** Run the whole persistence layer on a parsed document, the way the extract step does. */
async function persist(s: Scenario, docType: DocType, parsed: unknown): Promise<Awaited<ReturnType<typeof persistExtraction>>> {
  return persistExtraction(s.client as unknown as Queryable, {
    document: { id: s.documentId, community_id: s.communityId, pages: s.pages, community_nif: NIF_COMMUNITY },
    parsed,
    docType,
    flattened: flattenParsed(parsed, null, docType),
    runId: s.runId,
    now: new Date('2026-01-01T00:00:00Z'),
  });
}

const rowsOf = async (s: Scenario, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
  (await s.client.query(sql, params)).rows as Record<string, unknown>[];

suite('field revisions and validators', () => {
  it('writes one revision per monetary or identity field and materialises the value', async () => {
    await scenario('factura', {}, async (s) => {
      const result = await persist(s, 'factura', facturaFixture);
      expect(result.field_revisions).toBeGreaterThan(10);

      const revisions = await rowsOf(s, `select count(*)::int as n from public.field_revisions where document_id = $1 and source = 'model'`, [s.documentId]);
      expect(revisions[0]?.n).toBe(result.field_revisions);

      const total = (await rowsOf(s, `select * from public.field_values where document_id = $1 and field_path = 'total_factura'`, [s.documentId]))[0];
      expect(total?.value_norm).toBe('3253.80');
      expect(total?.quote).toBe('3.253,80 €');
      expect(total?.bbox).toEqual([820, 1300, 1010, 1332]);
      expect(total?.model_conf).toBe('0.990');
      expect(total?.page_id).toBe(s.pageIds[0]);
      expect(total?.status).toBe('needs_review');
      expect(total?.validator_ok).toBe(true);
    });
  });

  it('normalises the model value with the same function the OCR reading will use', async () => {
    await scenario('factura', {}, async (s) => {
      await persist(s, 'factura', facturaFixture);
      const nif = (await rowsOf(s, `select value_norm from public.field_values where document_id = $1 and field_path = 'emisor.nif'`, [s.documentId]))[0];
      expect(nif?.value_norm).toBe(CIF_VENDOR);
      const date = (await rowsOf(s, `select value_norm from public.field_values where document_id = $1 and field_path = 'fecha_expedicion'`, [s.documentId]))[0];
      expect(date?.value_norm).toBe('2024-03-15');
    });
  });

  it('stores the validator results and marks the family a failing check belongs to', async () => {
    await scenario('factura', {}, async (s) => {
      const wrong = clone(facturaFixture);
      wrong.total_factura = 9999.99; // the printed total no longer follows from base + IVA
      const result = await persist(s, 'factura', wrong);
      expect(result.validators.failed).toContain('factura.total');

      const total = (await rowsOf(s, `select validator_ok from public.field_values where document_id = $1 and field_path = 'total_factura'`, [s.documentId]))[0];
      expect(total?.validator_ok).toBe(false);
      // an identity field is judged by its own family, which still passes
      const nif = (await rowsOf(s, `select validator_ok from public.field_values where document_id = $1 and field_path = 'emisor.nif'`, [s.documentId]))[0];
      expect(nif?.validator_ok).toBe(true);
    });
  });

  it('never overwrites a value a person has confirmed', async () => {
    await scenario('factura', {}, async (s) => {
      await persist(s, 'factura', facturaFixture);
      await s.client.query(
        `update public.field_values set value = '4000'::jsonb, value_norm = '4000.00', status = 'human_confirmed'
          where document_id = $1 and field_path = 'total_factura'`,
        [s.documentId],
      );
      const second = await persist(s, 'factura', facturaFixture);
      expect(second.fields_kept_human).toBeGreaterThanOrEqual(1);
      const total = (await rowsOf(s, `select value_norm, status from public.field_values where document_id = $1 and field_path = 'total_factura'`, [s.documentId]))[0];
      expect(total?.value_norm).toBe('4000.00');
      expect(total?.status).toBe('human_confirmed');
    });
  });
});

suite('factura', () => {
  it('writes the vendor, its IBAN pseudonym, the invoice, its lines and its VAT summary', async () => {
    await scenario('factura', {}, async (s) => {
      const result = await persist(s, 'factura', facturaFixture);

      const vendor = (await rowsOf(s, 'select * from public.parties where community_id = $1 and nif = $2', [s.communityId, CIF_VENDOR]))[0];
      expect(vendor?.kind).toBe('vendor');
      expect(vendor?.legal_name_norm).toBeTruthy();
      expect(vendor?.nif_valid).toBe(true);
      expect(vendor?.nif_hmac).toBe(hmacNif(CIF_VENDOR, String(process.env.IBAN_HMAC_KEY)));

      const iban = (await rowsOf(s, 'select * from public.party_ibans where party_id = $1', [vendor?.id]))[0];
      expect(iban?.iban_last4).toBe(IBAN_VENDOR.slice(-4));
      expect(String(iban?.iban_hmac)).toMatch(/^[0-9a-f]{64}$/);
      expect(iban?.iban_enc).toBeNull();

      const invoice = (await rowsOf(s, 'select * from public.invoices where document_id = $1', [s.documentId]))[0];
      expect(invoice?.total).toBe('3253.80');
      expect(invoice?.numero).toBe('F-2024/017');
      expect(invoice?.numero_int).toBe('17');
      expect(invoice?.recipient_matches_community).toBe(true);
      expect(invoice?.vendor_party_id).toBe(vendor?.id);

      const lines = await rowsOf(s, 'select * from public.invoice_lines where invoice_id = $1 order by orden', [invoice?.id]);
      expect(lines).toHaveLength(3);
      expect(lines[0]?.base).toBe('2400.00');
      expect(lines[2]?.element_scope).toBe('unknown');

      const vat = await rowsOf(s, 'select * from public.invoice_vat_summary where invoice_id = $1 order by tipo_pct', [invoice?.id]);
      expect(vat.map((v) => v.tipo_pct)).toEqual(['10.00', '21.00']);
      expect(result.domain).toMatchObject({ lines: 3, vat_rows: 2 });
    });
  });

  it('writes a deterministic dedupe key and points the second copy at the first', async () => {
    await scenario('factura', {}, async (s) => {
      await persist(s, 'factura', facturaFixture);
      const first = (await rowsOf(s, 'select dedupe_key, duplicate_of_document_id from public.documents where id = $1', [s.documentId]))[0];
      expect(String(first?.dedupe_key)).toContain(CIF_VENDOR);
      expect(first?.duplicate_of_document_id).toBeNull();

      const twin = (
        await rowsOf(
          s,
          `insert into public.documents (community_id, doc_type, status, grouped_by) values ($1, 'factura', 'classified', 'auto') returning id`,
          [s.communityId],
        )
      )[0];
      const twinId = String(twin?.id);
      await persistExtraction(s.client as unknown as Queryable, {
        document: { id: twinId, community_id: s.communityId, pages: [], community_nif: NIF_COMMUNITY },
        parsed: facturaFixture,
        docType: 'factura',
        flattened: flattenParsed(facturaFixture, null, 'factura'),
        runId: null,
      });
      const second = (await rowsOf(s, 'select dedupe_key, duplicate_of_document_id from public.documents where id = $1', [twinId]))[0];
      expect(second?.dedupe_key).toBe(first?.dedupe_key);
      expect(second?.duplicate_of_document_id).toBe(s.documentId);
    });
  });

  it('is idempotent: the same extraction twice leaves the same rows', async () => {
    await scenario('factura', {}, async (s) => {
      await persist(s, 'factura', facturaFixture);
      await persist(s, 'factura', facturaFixture);
      const counts = (
        await rowsOf(
          s,
          `select (select count(*)::int from public.invoices where document_id = $1) as invoices,
                  (select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id where i.document_id = $1) as lines,
                  (select count(*)::int from public.parties where community_id = $2) as parties`,
          [s.documentId, s.communityId],
        )
      )[0];
      expect(counts).toMatchObject({ invoices: 1, lines: 3, parties: 1 });
    });
  });
});

suite('acta', () => {
  it('writes the meeting with unit labels only and one resolution per agenda item', async () => {
    await scenario('acta', { pageCount: 2 }, async (s) => {
      const result = await persist(s, 'acta', actaFixture);
      expect(result.domain).toMatchObject({ resolutions: 3, seed_row_kept: false });

      const meeting = (await rowsOf(s, 'select * from public.meetings where community_id = $1', [s.communityId]))[0];
      expect(meeting?.fecha).toBe('2023-03-14');
      expect(meeting?.tipo).toBe('ordinaria');
      expect(meeting?.quorum_pct).toBe('34.0000');
      expect(meeting?.document_id).toBe(s.documentId);
      expect(meeting?.entry_source).toBe('extraction');
      expect(meeting?.notice_days).toBe(13);

      const attendees = meeting?.attendees as { unit_label: string }[];
      expect(attendees.map((a) => a.unit_label)).toEqual(['Pral 1a', '1r 1a', '2n 2a', '3r 1a', '4t 2a']);
      // roles and labels only: nothing in the row may look like a person's name
      expect(JSON.stringify(attendees)).not.toMatch(/nombre|name|surname/i);

      const resolutions = await rowsOf(s, 'select * from public.resolutions where meeting_id = $1 order by punto', [meeting?.id]);
      expect(resolutions.map((r) => r.kind)).toEqual(['accounts', 'works_approval', 'derrama']);
      expect(resolutions[1]?.importe_aprobado).toBe('52800.00');
      expect(resolutions[1]?.delegation_to_role).toBe('president');
      expect(resolutions[1]?.delegation_scope).toBe('signar el contracte');
      expect(resolutions[1]?.cap_explicit).toBe(false);
      expect(resolutions[1]?.page_id).toBe(s.pageIds[1]);
      expect(resolutions[2]?.voters_favor).toBe(4);
      expect(resolutions[2]?.voters_total).toBe(5);
      expect(resolutions[0]?.challenge_3m_until).toBe('2023-06-14');
    });
  });

  it('keeps a seed row and leaves the model reading in the field revisions', async () => {
    await scenario('acta', { pageCount: 2 }, async (s) => {
      await s.client.query(
        `insert into public.meetings (community_id, tipo, fecha, quorum_pct, entry_source, notes)
         values ($1, 'ordinaria', '2023-03-14', 31.5, 'seed', 'transcrita a mà de l''acta en paper')`,
        [s.communityId],
      );
      const result = await persist(s, 'acta', actaFixture);
      expect(result.domain).toMatchObject({ seed_row_kept: true });

      const meeting = (await rowsOf(s, 'select * from public.meetings where community_id = $1', [s.communityId]))[0];
      expect(meeting?.entry_source).toBe('seed');
      expect(meeting?.quorum_pct).toBe('31.5000'); // the transcribed figure stays
      expect(meeting?.document_id).toBe(s.documentId); // but the row now points at the document

      const field = (await rowsOf(s, `select value_norm from public.field_values where document_id = $1 and field_path = 'quorum_pct'`, [s.documentId]))[0];
      expect(field?.value_norm).toBe('34.00'); // and the model's reading is visible next to it
    });
  });
});

suite('liquidación anual', () => {
  it('writes the administrator figures as an extraction, with lines and unit rows by label', async () => {
    await scenario('liquidacion_anual', { pageCount: 2 }, async (s) => {
      const result = await persist(s, 'liquidacion_anual', liquidacionFixture);
      expect(result.domain).toMatchObject({ ejercicio: 2024, lines: 8, unit_rows: 3, unit_labels_without_unit: 0 });

      const liq = (await rowsOf(s, 'select * from public.liquidations where document_id = $1', [s.documentId]))[0];
      expect(liq?.basis).toBe('cash');
      expect(liq?.total_gastos).toBe('16380.00');
      expect(liq?.fondo_reserva_final).toBe('1136.00');
      expect(liq?.entry_source).toBe('extraction');

      const lines = await rowsOf(s, 'select * from public.liquidation_lines where liquidation_id = $1 order by side, concepto', [liq?.id]);
      expect(lines.filter((l) => l.side === 'ingreso')).toHaveLength(2);
      expect(lines.filter((l) => l.side === 'gasto')).toHaveLength(6);
      const withVendor = lines.filter((l) => l.vendor_party_id !== null);
      expect(withVendor.length).toBe(4);
      expect(lines.some((l) => l.page_id === s.pageIds[1])).toBe(true);

      const unitRows = await rowsOf(s, 'select * from public.liquidation_unit_rows where liquidation_id = $1 order by unit_label_as_shown', [liq?.id]);
      expect(unitRows).toHaveLength(3);
      expect(unitRows.every((r) => r.unit_id !== null)).toBe(true);
      expect(unitRows.map((r) => r.unit_label_as_shown)).toEqual(['1r 1a', '4t 1a', 'Pral 1a']);
    });
  });

  it('reports a unit label that matches no unit instead of inventing one', async () => {
    await scenario('liquidacion_anual', {}, async (s) => {
      const doc = clone(liquidacionFixture);
      const firstUnitRow = doc.cuotas_por_unidad[0];
      if (firstUnitRow) doc.cuotas_por_unidad[0] = { ...firstUnitRow, entidad_label: 'Àtic 9a' };
      const result = await persist(s, 'liquidacion_anual', doc);
      expect(result.domain).toMatchObject({ unit_labels_without_unit: 1 });
      const orphan = (
        await rowsOf(s, `select unit_id, unit_label_as_shown from public.liquidation_unit_rows where unit_label_as_shown = 'Àtic 9a'`)
      )[0];
      expect(orphan?.unit_id).toBeNull();
    });
  });
});

suite('extracto bancario', () => {
  it('creates the account, the statement and the movements, with a photo confidence of 0.7', async () => {
    await scenario('extracto_bancario', {}, async (s) => {
      const result = await persist(s, 'extracto_bancario', extractoFixture);
      expect(result.domain).toMatchObject({ source: 'photo', transactions: 4, bank_account_created: true, continuity_ok: true });

      const statement = (await rowsOf(s, 'select * from public.bank_statements where document_id = $1', [s.documentId]))[0];
      expect(statement?.source).toBe('photo');
      expect(statement?.saldo_inicial).toBe('12500.40');
      expect(statement?.continuity_ok).toBe(true);
      expect(statement?.self_check_ok).toBe(true);

      const txs = await rowsOf(s, 'select * from public.bank_transactions where statement_id = $1 order by fecha_operacion', [statement?.id]);
      expect(txs).toHaveLength(4);
      expect(txs.map((t) => t.importe)).toEqual(['60.00', '-3253.80', '-12.00', '-180.00']);
      expect(txs.map((t) => t.tx_kind)).toEqual(['quota_in', 'transfer_out', 'fee', 'direct_debit']);
      expect(txs.every((t) => t.confidence === '0.700')).toBe(true);
      expect(txs.every((t) => t.page_id === s.pageIds[0])).toBe(true);
      expect(String(txs[1]?.counterparty_iban_hmac)).toMatch(/^[0-9a-f]{64}$/);
      expect(txs[1]?.counterparty_iban_last4).toBe(IBAN_VENDOR.slice(-4));
      // the counterparty of the first movement is a natural person: no name is stored
      expect(txs[0]?.counterparty_name_norm).toBeNull();
      expect(String(txs[0]?.dedupe_key)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('reads a native PDF with a higher confidence than a photograph', async () => {
    await scenario('extracto_bancario', { mime: 'application/pdf', hasTextLayer: true }, async (s) => {
      const result = await persist(s, 'extracto_bancario', extractoFixture);
      expect(result.domain).toMatchObject({ source: 'pdf_native' });
      const txs = await rowsOf(s, 'select confidence from public.bank_transactions where community_id = $1', [s.communityId]);
      expect(txs.every((t) => t.confidence === '0.850')).toBe(true);
    });
  });

  it('matches an existing account by the last four digits shown on the statement', async () => {
    await scenario('extracto_bancario', {}, async (s) => {
      await s.client.query(
        `insert into public.bank_accounts (community_id, label, iban_last4, holder_kind, purpose, titled_to_community)
         values ($1, 'Compte ordinari', $2, 'community', 'ordinary', true)`,
        [s.communityId, extractoFixture.iban_o_cuenta_mostrada?.slice(-4)],
      );
      const result = await persist(s, 'extracto_bancario', extractoFixture);
      expect(result.domain).toMatchObject({ bank_account_created: false });
      expect(String((result.domain as Record<string, unknown>)['bank_account_resolved_by'])).toContain('last four digits');
      const accounts = await rowsOf(s, 'select id from public.bank_accounts where community_id = $1', [s.communityId]);
      expect(accounts).toHaveLength(1);
    });
  });

  it('records that the balances printed on the statement do not add up', async () => {
    await scenario('extracto_bancario', {}, async (s) => {
      const doc = clone(extractoFixture);
      doc.saldo_final = 9000;
      const result = await persist(s, 'extracto_bancario', doc);
      expect(result.domain).toMatchObject({ continuity_ok: false });
      expect(result.validators.failed).toContain('extracto.continuidad_saldo');
    });
  });
});

suite('contrato', () => {
  it('writes the contract, its milestones and the advance ceiling for a lift installation', async () => {
    await scenario('contrato_ascensor', { pageCount: 2 }, async (s) => {
      const result = await persist(s, 'contrato_ascensor', contratoFixture);
      expect(result.domain).toMatchObject({ kind: 'ascensor_instalacion', milestones: 3, upfront_max_pct: 60 });

      const contract = (await rowsOf(s, 'select * from public.contracts where document_id = $1', [s.documentId]))[0];
      expect(contract?.precio_con_iva).toBe('52800.00');
      expect(contract?.upfront_max_pct).toBe('60.00');
      expect(contract?.community_signer_role).toBe('president');
      expect(contract?.entry_source).toBe('extraction');
      expect(contract?.elevator_spec).toMatchObject({ paradas: 6 });

      const vendor = (await rowsOf(s, 'select display_name from public.parties where id = $1', [contract?.vendor_party_id]))[0];
      expect(vendor?.display_name).toBe('Ascensors Exemple S.A.');

      const milestones = await rowsOf(s, 'select * from public.contract_milestones where contract_id = $1 order by seq', [contract?.id]);
      expect(milestones).toHaveLength(3);
      expect(milestones[0]?.is_advance).toBe(true);
      expect(milestones[0]?.importe).toBe('15840.00');
      expect(milestones.slice(1).every((m) => m.is_advance === false)).toBe(true);
    });
  });

  it('caps a works contract at 40 % instead', async () => {
    await scenario('contrato_obra', {}, async (s) => {
      const doc = clone(contratoFixture);
      doc.kind = 'obra';
      doc.doc_type_confirmed = 'contrato_obra';
      const result = await persist(s, 'contrato_obra', doc);
      expect(result.domain).toMatchObject({ upfront_max_pct: 40 });
    });
  });
});

suite('aviso de derrama', () => {
  it('writes the levy and one expected ledger row per unit and month', async () => {
    await scenario('aviso_derrama', {}, async (s) => {
      const result = await persist(s, 'aviso_derrama', derramaFixture);
      expect(result.domain).toMatchObject({ objeto: 'Obres ascensor', unit_labels_without_unit: 0 });

      const derrama = (await rowsOf(s, 'select * from public.derramas where community_id = $1', [s.communityId]))[0];
      expect(derrama?.criterio).toBe('partes_iguales');
      expect(derrama?.importe_total).toBe('2160.00');
      expect(derrama?.months).toBe(12);
      expect(derrama?.starts_on).toBe('2023-04-01');
      expect(derrama?.entry_source).toBe('extraction');

      const ledger = await rowsOf(
        s,
        `select l.period, l.expected, l.basis, l.status, u.label
           from public.derrama_ledger l join public.units u on u.id = l.unit_id
          where l.derrama_id = $1 order by u.label, l.period`,
        [derrama?.id],
      );
      // Pral 1a prints two instalments; the other two units print only a total, dated by the notice
      expect(ledger).toHaveLength(4);
      expect(ledger.filter((r) => r.label === 'Pral 1a').map((r) => r.period)).toEqual(['2023-04-01', '2023-05-01']);
      expect(ledger.every((r) => r.basis === 'assertion')).toBe(true);
      expect(ledger.every((r) => r.status === 'expected')).toBe(true);
    });
  });

  it('leaves the ledger empty for a unit label that matches no unit', async () => {
    await scenario('aviso_derrama', {}, async (s) => {
      const doc = clone(derramaFixture);
      const firstCuota = doc.cuotas[0];
      if (firstCuota) doc.cuotas = [{ ...firstCuota, entidad_label: 'Local carrer' }];
      const result = await persist(s, 'aviso_derrama', doc);
      expect(result.domain).toMatchObject({ ledger_rows: 0, unit_labels_without_unit: 2 });
    });
  });
});

suite('document header', () => {
  it('dates the document and derives its fiscal year from the parsed content', async () => {
    await scenario('factura', {}, async (s) => {
      await persist(s, 'factura', facturaFixture);
      const doc = (await rowsOf(s, 'select doc_date, fiscal_year, language from public.documents where id = $1', [s.documentId]))[0];
      expect(doc?.doc_date).toBe('2024-03-15');
      expect(doc?.fiscal_year).toBe(2024);
      expect(doc?.language).toBe('ca');
    });
  });
});
