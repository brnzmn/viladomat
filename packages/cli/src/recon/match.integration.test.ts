/**
 * End-to-end check of the matcher and the M3 rules against a real Postgres with the
 * migrations applied. The whole scenario is seeded inside one transaction and rolled back,
 * so the database is left exactly as it was. Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { envOptional } from '../lib/env.ts';
import { collapse, type RuleContext, type RuleHit } from '../rules/engine.ts';
import { D1_residuals, D4_paymentTiming, E1_authority, E2_worksSequence, paymentBeforeContractKey, paymentBeforeResolutionKey } from '../rules/m3.ts';
import { runMatch } from './match.ts';
import { loadResidualCounts } from './control-totals.ts';

const DATABASE_URL = envOptional('DATABASE_URL');
const suite = DATABASE_URL ? describe : describe.skip;

const VENDOR_HMAC = 'HMAC-VENDOR-TEST';

interface Seeded {
  cid: string;
  vendorId: string;
  invoiceA: string;
  invoiceB: string;
  txA: string;
  txB: string;
  txPerson: string;
  resolutionId: string;
  contractId: string;
  worksPackageId: string;
}

async function seed(client: pg.PoolClient): Promise<Seeded> {
  const one = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> => {
    const r = await client.query(sql, params);
    return r.rows[0] as Record<string, unknown>;
  };
  const community = await one(
    `insert into public.communities (name, nif, address, fy_start_month, ordinary_budget_default)
     values ('Comunitat de prova', 'H00000000', 'Carrer de prova 1', 1, 6700) returning id`,
  );
  const cid = String(community.id);
  await client.query(
    `insert into public.parameters (community_id, key, value_num, unit, version, valid_from) values
       ($1, 'outflow_min', 300, 'EUR', 1, '1900-01-01'),
       ($1, 'authority_threshold', 1000, 'EUR', 1, '1900-01-01'),
       ($1, 'pm_ordinary', 335, 'EUR', 1, '1900-01-01'),
       ($1, 'cash_limit', 2500, 'EUR', 1, '1900-01-01'),
       ($1, 'cash_limit', 1000, 'EUR', 1, '2021-07-11')`,
    [cid],
  );
  const vendor = await one(
    `insert into public.parties (community_id, kind, display_name, legal_name_norm, nif, nif_kind, legal_form)
     values ($1, 'vendor', 'Reformes Exemple SL', 'reformes exemple sl', 'B00000000', 'CIF', 'S.L.') returning id`,
    [cid],
  );
  await client.query(
    `insert into public.party_ibans (community_id, party_id, iban_hmac, iban_last4) values ($1, $2, $3, '1234')`,
    [cid, vendor.id, VENDOR_HMAC],
  );
  const account = await one(
    `insert into public.bank_accounts (community_id, label, iban_last4, holder_kind, purpose, titled_to_community)
     values ($1, 'Compte ordinari', '9999', 'community', 'ordinary', true) returning id`,
    [cid],
  );
  const statement = await one(
    `insert into public.bank_statements (community_id, bank_account_id, source, periodo_desde, periodo_hasta, saldo_inicial, saldo_final)
     values ($1, $2, 'csv', '2024-01-01', '2024-12-31', 1000, 500) returning id`,
    [cid, account.id],
  );
  const works = await one(
    `insert into public.works_packages (community_id, code, label, status) values ($1, 'ELEVATOR', 'Ascensor', 'in_progress') returning id`,
    [cid],
  );
  const meeting = await one(
    `insert into public.meetings (community_id, tipo, fecha) values ($1, 'extraordinaria', '2024-03-20') returning id`,
    [cid],
  );
  const resolution = await one(
    `insert into public.resolutions (community_id, meeting_id, punto, texto_literal, kind, resultado, works_package_id, vendor_party_id, importe_aprobado)
     values ($1, $2, '2', 'Aprovacio de les obres', 'works_approval', 'aprobado', $3, $4, 5000) returning id`,
    [cid, meeting.id, works.id, vendor.id],
  );
  const contract = await one(
    `insert into public.contracts (community_id, kind, vendor_party_id, works_package_id, fecha_firma, precio_con_iva)
     values ($1, 'obra', $2, $3, '2024-03-21', 4800) returning id`,
    [cid, vendor.id, works.id],
  );
  const docA = await one(
    `insert into public.documents (community_id, doc_type, doc_date, works_package_id) values ($1, 'factura', '2024-03-10', $2) returning id`,
    [cid, works.id],
  );
  const docB = await one(
    `insert into public.documents (community_id, doc_type, doc_date) values ($1, 'factura', '2024-05-06') returning id`,
    [cid],
  );
  const invoiceA = await one(
    `insert into public.invoices (community_id, document_id, vendor_party_id, numero, fecha_expedicion, total, works_package_id)
     values ($1, $2, $3, '118', '2024-03-10', 1210.00, $4) returning id`,
    [cid, docA.id, vendor.id, works.id],
  );
  const invoiceB = await one(
    `insert into public.invoices (community_id, document_id, vendor_party_id, numero, fecha_expedicion, total)
     values ($1, $2, $3, '119', '2024-05-06', 500.00) returning id`,
    [cid, docB.id, vendor.id],
  );
  const txA = await one(
    `insert into public.bank_transactions (community_id, bank_account_id, statement_id, fecha_operacion, importe, concepto_text, counterparty_name_norm, counterparty_iban_hmac, tx_kind)
     values ($1, $2, $3, '2024-03-12', -1210.00, 'TRANSF REFORMES EXEMPLE', 'reformes exemple sl', $4, 'transfer_out') returning id`,
    [cid, account.id, statement.id, VENDOR_HMAC],
  );
  const txB = await one(
    `insert into public.bank_transactions (community_id, bank_account_id, statement_id, fecha_operacion, importe, concepto_text, counterparty_name_norm, counterparty_iban_hmac, tx_kind)
     values ($1, $2, $3, '2024-05-10', -500.00, 'TRANSF FRA 119', 'reformes exemple sl', $4, 'transfer_out') returning id`,
    [cid, account.id, statement.id, VENDOR_HMAC],
  );
  const txPerson = await one(
    `insert into public.bank_transactions (community_id, bank_account_id, statement_id, fecha_operacion, importe, concepto_text, tx_kind, flags)
     values ($1, $2, $3, '2024-06-01', -900.00, 'TRANSFERENCIA', 'transfer_out', array['person_beneficiary']) returning id`,
    [cid, account.id, statement.id],
  );
  return {
    cid,
    vendorId: String(vendor.id),
    invoiceA: String(invoiceA.id),
    invoiceB: String(invoiceB.id),
    txA: String(txA.id),
    txB: String(txB.id),
    txPerson: String(txPerson.id),
    resolutionId: String(resolution.id),
    contractId: String(contract.id),
    worksPackageId: String(works.id),
  };
}

suite('matcher and M3 rules on a seeded scenario', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let s: Seeded;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    client = await pool.connect();
    await client.query('begin');
    s = await seed(client);
    await runMatch(client, s.cid);
  }, 60_000);

  afterAll(async () => {
    await client.query('rollback');
    client.release();
    await pool.end();
  });

  const ctx = (): RuleContext => ({
    cid: s.cid,
    client,
    today: '2026-09-04',
    param: async (key, onDate) => {
      const r = await client.query<{ v: string | null }>('select public.param($1, $2, $3)::text as v', [s.cid, key, onDate ?? '2026-09-04']);
      const v = r.rows[0]?.v;
      return v == null ? null : Number(v);
    },
  });

  it('accepts the IBAN-identity payments and proposes the rest', async () => {
    const links = await client.query(
      `select from_id, to_id, link_type::text as link_type, method::text as method, score::float8 as score, status::text as status, engine_version
         from public.recon_links where community_id = $1 order by link_type, score desc`,
      [s.cid],
    );
    const paid = links.rows.filter((r) => r.link_type === 'paid_by');
    expect(paid).toHaveLength(2);
    expect(paid.every((r) => r.method === 'iban' && r.status === 'accepted' && r.score === 1)).toBe(true);
    expect(paid.every((r) => r.engine_version === 'm3.1')).toBe(true);

    const authorised = links.rows.filter((r) => r.link_type === 'authorised_by');
    expect(authorised).toHaveLength(1);
    expect(authorised[0]!.from_id).toBe(s.invoiceA);
    expect(authorised[0]!.status).toBe('proposed');

    const contracts = links.rows.filter((r) => r.link_type === 'under_contract');
    expect(contracts.map((r) => r.from_id).sort()).toEqual([s.invoiceA, s.invoiceB].sort());
  });

  it('never overwrites a decision already recorded by a reviewer', async () => {
    await client.query(
      `update public.recon_links set status = 'rejected' where community_id = $1 and link_type = 'authorised_by'`,
      [s.cid],
    );
    await runMatch(client, s.cid);
    const after = await client.query<{ status: string }>(
      `select status::text as status from public.recon_links where community_id = $1 and link_type = 'authorised_by'`,
      [s.cid],
    );
    expect(after.rows.map((r) => r.status)).toEqual(['rejected']);
    await client.query(
      `update public.recon_links set status = 'proposed' where community_id = $1 and link_type = 'authorised_by'`,
      [s.cid],
    );
  });

  it('leaves the expected residual sets', async () => {
    const r = await loadResidualCounts(client, s.cid);
    expect(r.r1).toBe(0);
    expect(r.r2).toBe(1);
    expect(r.r3).toBe(0);
    expect(r.r4).toBe(1);
  });

  it('materialises the works timeline with the ordering discrepancies', async () => {
    const events = await client.query<{ event_type: string; seq_ok: boolean | null }>(
      `select event_type::text as event_type, seq_ok from public.works_events where community_id = $1 order by event_date`,
      [s.cid],
    );
    expect(events.rows.map((e) => e.event_type).sort()).toEqual(['acta_approval', 'contract_signed', 'invoice', 'payment']);
    expect(events.rows.filter((e) => e.seq_ok === false).length).toBeGreaterThanOrEqual(1);
  });

  it('reports the person-beneficiary debit as not yet matched, at severity 4', async () => {
    const hits = await D1_residuals(ctx());
    const r2 = hits.filter((h) => h.computed.residual_set === 'R2');
    expect(r2).toHaveLength(1);
    expect(r2[0]!.entityId).toBe(s.txPerson);
    expect(r2[0]!.severity).toBe(4);
    expect(r2[0]!.independence).toBe(1); // csv export
    expect(r2[0]!.summaryEn).toContain('not yet matched to an invoice in the corpus');
  });

  it('reports the spend without an accepted resolution once', async () => {
    const hits = await E1_authority(ctx());
    expect(hits.filter((h) => h.entityId === s.invoiceA)).toHaveLength(1);
  });

  it('does not multiply the invoiced total when a package carries several resolutions', async () => {
    await client.query('savepoint e1_check');
    try {
      const pkg = await client.query<{ id: string }>(
        `insert into public.works_packages (community_id, code, label, status) values ($1, 'STAIRCASE', 'Escala', 'in_progress') returning id`,
        [s.cid],
      );
      const w2 = pkg.rows[0]!.id;
      const meeting = await client.query<{ id: string }>(
        `insert into public.meetings (community_id, tipo, fecha) values ($1, 'extraordinaria', '2024-04-10') returning id`,
        [s.cid],
      );
      for (const kind of ['works_approval', 'delegation']) {
        await client.query(
          `insert into public.resolutions (community_id, meeting_id, texto_literal, kind, resultado, works_package_id, importe_aprobado, tolerance_pct)
           values ($1, $2, 'Acord', $3::public.resolution_kind, 'aprobado', $4, 900, 0)`,
          [s.cid, meeting.rows[0]!.id, kind, w2],
        );
      }
      const doc = await client.query<{ id: string }>(
        `insert into public.documents (community_id, doc_type, doc_date, works_package_id) values ($1, 'factura', '2024-05-01', $2) returning id`,
        [s.cid, w2],
      );
      await client.query(
        `insert into public.invoices (community_id, document_id, vendor_party_id, numero, fecha_expedicion, total, works_package_id)
         values ($1, $2, $3, '200', '2024-05-01', 1210.00, $4)`,
        [s.cid, doc.rows[0]!.id, s.vendorId, w2],
      );
      const hits = await E1_authority(ctx());
      const cap = hits.find((h) => h.eventKey === `works_package:${w2}:delegated_cap`);
      expect(cap).toBeDefined();
      expect(cap!.computed.invoiced).toBe(1210);
      expect(cap!.amountAtStake).toBe(310);
    } finally {
      await client.query('rollback to savepoint e1_check');
    }
  });

  it('collapses the correlated D4 and E2 hits to one event each', async () => {
    const d4 = await D4_paymentTiming(ctx());
    const e2 = await E2_worksSequence(ctx());
    const beforeContract = paymentBeforeContractKey(s.contractId, s.txA);
    const beforeResolution = paymentBeforeResolutionKey(s.resolutionId, s.txA);

    const has = (hits: RuleHit[], key: string): boolean => hits.some((h) => h.eventKey === key);
    expect(has(d4, beforeContract)).toBe(true);
    expect(has(e2, beforeContract)).toBe(true);
    expect(has(d4, beforeResolution)).toBe(true);
    expect(has(e2, beforeResolution)).toBe(true);

    const collapsed = collapse([...d4, ...e2]);
    expect(collapsed.filter((h) => h.eventKey === beforeContract)).toHaveLength(1);
    expect(collapsed.filter((h) => h.eventKey === beforeResolution)).toHaveLength(1);
    expect(collapsed.find((h) => h.eventKey === beforeContract)!.severity).toBe(3);
  });
});
