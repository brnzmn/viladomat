/**
 * The auditor pack against a real Postgres with the migrations applied.
 *
 * The scenario is seeded inside one transaction that is always rolled back, so the database is
 * left exactly as it was — including `legal_sources`, whose `archived_at` the test clears to
 * assert the hard gate from a known state. Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { envOptional } from '../lib/env.ts';
import { loadAuditorData, renderAuditor } from './auditor.ts';
import { buildDataRoom } from './dataroom.ts';
import { loadLawyerData, renderLawyer } from './lawyer.ts';
import { computeAnchor } from './anchors.ts';
import { canonicalSha256, sha256 } from './sections.ts';
import { scoreFieldsPresent } from './gates.ts';
import { PARTICULAR, PRESIDENCY_UNIT } from './redact.ts';

const DATABASE_URL = envOptional('DATABASE_URL');
const suite = DATABASE_URL ? describe : describe.skip;

/** Article strings the catalogue would print if the gate were open. */
const ARTICLE_STRINGS = ['CCCat 553-6', 'CCCat 553-21', 'CCCat 553-27', 'RD 1619/2012 art. 6', 'Ley 7/2012 art. 7', 'LIVA art. 91'];

interface Seeded {
  cid: string;
  presidentUnitId: string;
  otherUnitId: string;
  distributedFindingId: string;
  pendingFindingId: string;
}

async function seed(client: pg.PoolClient): Promise<Seeded> {
  const one = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> => (await client.query(sql, params)).rows[0] as Record<string, unknown>;

  // No source has an archived primary copy: the hard gate is closed for every rule.
  await client.query('update public.legal_sources set archived_at = null');

  const community = await one(
    `insert into public.communities (name, nif, address, fy_start_month, ordinary_budget_default)
     values ('Comunitat M6 de prova', 'H00000006', 'Carrer de prova 25', 1, 6700) returning id`,
  );
  const cid = String(community.id);
  await client.query(
    `insert into public.parameters (community_id, key, value_num, unit, version, valid_from, basis_text) values
       ($1, 'outflow_min', 300, 'EUR', 1, '1900-01-01', 'Minimum outflow considered by payment rules (internal control).'),
       ($1, 'pm_ordinary', 335, 'EUR', 1, '1900-01-01', 'Planning materiality: 5% of the ordinary budget (professional standard).'),
       ($1, 'cash_limit', 1000, 'EUR', 2, '2021-07-11', 'Ley 11/2021 amending Ley 7/2012 art. 7: cash payment limit reduced (statutory).')`,
    [cid],
  );
  const presidentUnit = await one(
    `insert into public.units (community_id, label, quota_pct, holder_role) values ($1, 'Pral 1a', 8.5, 'president') returning id`,
    [cid],
  );
  const otherUnit = await one(
    `insert into public.units (community_id, label, quota_pct, holder_role) values ($1, '3r 2a', 6.5, 'other_owner') returning id`,
    [cid],
  );
  const vendor = await one(
    `insert into public.parties (community_id, kind, display_name, legal_name_norm, nif) values ($1, 'vendor', 'Reformes Exemple SL', 'reformes exemple sl', 'B00000006') returning id`,
    [cid],
  );
  const account = await one(
    `insert into public.bank_accounts (community_id, label, holder_kind, purpose, titled_to_community) values ($1, 'Compte ordinari', 'community', 'ordinary', true) returning id`,
    [cid],
  );
  // one outflow to a natural person, one to the vendor: the redaction rules must differ
  await client.query(
    `insert into public.bank_transactions (community_id, bank_account_id, fecha_operacion, importe, concepto_text, counterparty_name_norm, counterparty_iban_last4, tx_kind, flags, dedupe_key)
     values ($1, $2, '2024-06-01', -900.00, 'transferencia ES9121000418450200051332 obres', 'Joan Puig Ferrer', '1332', 'transfer_out', array['person_beneficiary'], 'm6-a'),
            ($1, $2, '2024-06-15', -1210.00, 'factura obres', 'Reformes Exemple SL', '4321', 'transfer_out', '{}', 'm6-b'),
            ($1, $2, '2024-01-05', 60.00, 'quota extraordinaria', 'quota', '0001', 'quota_in', '{}', 'm6-c')`,
    [cid, account.id],
  );
  const derrama = await one(
    `insert into public.derramas (community_id, objeto, importe_total, criterio, per_unit_amount, starts_on, months, entry_source)
     values ($1, 'Quota extraordinària obres', 10800, 'partes_iguales', 60, '2023-01-01', 12, 'seed') returning id`,
    [cid],
  );
  await client.query(
    `insert into public.derrama_ledger (community_id, derrama_id, unit_id, period, expected, paid, basis, status) values
       ($1, $2, $3, '2023-01-01', 60, 0, 'assertion', 'missing'),
       ($1, $2, $4, '2023-01-01', 60, 60, 'assertion', 'paid')`,
    [cid, derrama.id, presidentUnit.id, otherUnit.id],
  );

  const run = await one(
    `insert into public.finding_runs (community_id, pipeline_version, engine_version, parameters_snapshot, rules_snapshot, inputs_hash)
     values ($1, '1', 'm3.1', '[]'::jsonb, '[]'::jsonb, 'test') returning id`,
    [cid],
  );

  // D6 is statutory and cites CCCat 553-6: its article must stay withheld while unarchived.
  const pending = await one(
    `insert into public.findings (community_id, rule_code, rule_version, fingerprint, event_key, severity, extraction_quality,
        specificity, independence, confidence, hit_score, entity_type, fiscal_year, amount_at_stake, act_date_first, act_date_last,
        computed, summary_es, summary_en, innocent_explanations, next_check, resolving_document, tier, status, first_seen_run_id, last_seen_run_id)
     values ($1, 'D6', 1, 'm6fp-pending', 'reserve', 2, 0.9, 0.8, 0.7, 0.504, 1.008, 'community', 2024, 335.00, '2024-12-31', '2024-12-31',
        '{"reserve": 0}'::jsonb,
        'El fondo de reserva registrado es inferior al 5 % del presupuesto ordinario. Verificar.',
        'The reserve fund on record is below 5% of the ordinary budget. Verify.',
        '["Reserva mantenida como subcuenta."]'::jsonb, 'Solicitar el extracto de la cuenta de reserva.',
        'Extracto de la cuenta del fondo de reserva', 'T2', 'new', $2, $2) returning id`,
    [cid, run.id],
  );

  // D1 has been through the right of reply and carries the counterparty's answer verbatim.
  const distributed = await one(
    `insert into public.findings (community_id, rule_code, rule_version, fingerprint, event_key, severity, extraction_quality,
        specificity, independence, confidence, hit_score, entity_type, fiscal_year, amount_at_stake, act_date_first, act_date_last,
        computed, summary_es, summary_en, innocent_explanations, next_check, resolving_document, tier, status, first_seen_run_id, last_seen_run_id)
     values ($1, 'D1', 1, 'm6fp-distributed', 'tx', 3, 0.9, 0.85, 0.7, 0.535, 1.605, 'bank_transaction', 2024, 900.00, '2024-06-01', '2024-06-01',
        '{"amount": 900}'::jsonb,
        'Cargo de 900,00 € el 2024-06-01: no conciliado con ninguna factura del corpus. Verificar.',
        'Debit of 900.00 € on 2024-06-01: not matched to an invoice in the corpus. Verify.',
        '["Factura pagada desde otra cuenta."]'::jsonb, 'Solicitar la factura o el recibo del movimiento.',
        'Factura o recibo del movimiento', 'T2', 'new', $2, $2) returning id`,
    [cid, run.id],
  );

  // E4 is a base-rate rule (never_t1t2): annex only, whatever tier it was given.
  await client.query(
    `insert into public.findings (community_id, rule_code, rule_version, fingerprint, event_key, severity, extraction_quality,
        specificity, independence, confidence, hit_score, entity_type, fiscal_year, computed, summary_es, summary_en,
        innocent_explanations, next_check, tier, status, first_seen_run_id, last_seen_run_id)
     values ($1, 'E4', 1, 'm6fp-baserate', 'sod', 1, 0.9, 0.6, 0.7, 0.378, 0.378, 'community', 2024, '{}'::jsonb,
        'Las funciones de aprobación, contratación y pago recaen en el mismo rol. Observación.',
        'Approval, contracting and payment sit with the same role. Observation.',
        '[]'::jsonb, 'Contexto para otras comprobaciones.', 'T2', 'confirmed_discrepancy', $2, $2)`,
    [cid, run.id],
  );

  const tx = await one('select id from public.bank_transactions where community_id = $1 and importe = -900.00', [cid]);
  await client.query(
    `insert into public.finding_evidence (finding_id, label, bank_transaction_id, computed) values ($1, 'bank movement', $2, '{}'::jsonb)`,
    [distributed.id, tx.id],
  );

  const letter = await one(
    `insert into public.files (community_id, sha256, storage_path, original_name, source, supplied_by_role, supplied_on, batch_label)
     values ($1, 'a'||repeat('0', 63), 'originals/a0/a.pdf', 'respuesta.pdf', 'admin_delivery', 'administrator', '2026-08-25', 'entrega-1') returning id`,
    [cid],
  );
  await client.query(
    `insert into public.finding_reviews (finding_id, from_status, to_status, reason) values ($1, 'new', 'in_review', 'reviewed')`,
    [distributed.id],
  );
  await client.query(
    `insert into public.finding_reviews (finding_id, from_status, to_status, reason) values ($1, 'in_review', 'sent_for_explanation', 'letter sent; reply requested within ten calendar days')`,
    [distributed.id],
  );
  await client.query(
    `insert into public.finding_reviews (finding_id, from_status, to_status, reason, attachment_file_ids)
     values ($1, 'sent_for_explanation', 'confirmed_discrepancy', 'Respuesta de la administración: el pago corresponde a un anticipo acordado verbalmente.', array[$2::uuid])`,
    [distributed.id, letter.id],
  );

  await client.query(
    `insert into public.custody_manifests (community_id, batch_label, manifest_path, manifest_sha256, file_count, generated_on_device)
     values ($1, 'entrega-1', 'exports/manifests/entrega-1.csv', 'b'||repeat('0', 63), 1, 'laptop')`,
    [cid],
  );
  await client.query(
    `insert into public.party_links (community_id, from_party_id, to_role, signal, points, tier, status, explanation)
     values ($1, $2, 'president', 'S3', 40, 'review', 'open', 'Coincidencia de un apellido; homónimos esperados por confirmar.')`,
    [cid, vendor.id],
  );

  return {
    cid,
    presidentUnitId: String(presidentUnit.id),
    otherUnitId: String(otherUnit.id),
    distributedFindingId: String(distributed.id),
    pendingFindingId: String(pending.id),
  };
}

suite('auditor pack against a migrated database', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let s: Seeded;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    client = await pool.connect();
    await client.query('begin');
    s = await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query('rollback');
      client.release();
    }
    if (pool) await pool.end();
  });

  it('refuses the pack while a tier-1/2 item has not been through the right of reply, and counts it under --allow-pending', async () => {
    const data = await loadAuditorData(client, s.cid, '2026-09-04', 'es');
    // this is exactly the check `vx report --pack auditor` applies before rendering
    expect(data.gates.stats.unreviewed_t1t2).toBe(1);
    expect(data.gates.stats.withheld_pending_reply).toBe(1);
    expect(data.gates.stats.findings_distributed).toBe(1);
    expect(data.gates.stats.annex_only).toBe(1);
    expect(data.gates.pendingReply[0]?.finding.id).toBe(s.pendingFindingId);
    expect(data.gates.distributed[0]?.finding.id).toBe(s.distributedFindingId);
    expect(data.gates.annex[0]?.finding.ruleCode).toBe('E4');
  });

  it('prints no article number while every legal source is unarchived', async () => {
    const data = await loadAuditorData(client, s.cid, '2026-09-04', 'es');
    expect(data.archivedSources.size).toBe(0);
    const html = renderAuditor(data, 'es');
    for (const article of ARTICLE_STRINGS) expect(html).not.toContain(article);
    expect(html).toContain('referencia normativa pendiente de archivo');
    // the parameter's own basis text carries a citation and is withheld the same way
    expect(html).not.toContain('Ley 11/2021');
    // the verification register still names the sources, with "archived: no"
    expect(html).toContain('cccat-553-6');
  });

  it('opens the citation gate for exactly the rule whose source has been archived', async () => {
    await client.query('savepoint archive_one');
    await client.query(
      `insert into public.legal_sources (id, title, storage_path, sha256, archived_at)
       values ('cccat-553-6', 'CCCat 553-6', 'exports/legal_sources/cccat-553-6.pdf', 'c'||repeat('0', 63), now())
       on conflict (id) do update set archived_at = now(), sha256 = excluded.sha256`,
    );
    const html = renderAuditor(await loadAuditorData(client, s.cid, '2026-09-04', 'es'), 'es');
    expect(html).toContain('CCCat 553-6');
    expect(html).not.toContain('CCCat 553-21');
    await client.query('rollback to savepoint archive_one');
  });

  it('leads with the supported-spend headline before any item, and prints no score', async () => {
    const data = await loadAuditorData(client, s.cid, '2026-09-04', 'es');
    const html = renderAuditor(data, 'es');
    const headline = html.indexOf('Porcentaje de salidas de fondos conciliadas');
    const items = html.indexOf('6. Puntos no conciliados');
    expect(headline).toBeGreaterThan(0);
    expect(headline).toBeLessThan(items);
    expect(data.supported.outflowCount).toBe(2);
    expect(data.supported.withInvoiceCount).toBe(0);
    expect(html).toContain('0,0 %');
    expect(scoreFieldsPresent(html)).toEqual([]);
    expect(html).not.toContain('1.605');
  });

  it("prints the counterparty's reply verbatim next to the item, with the attachment hash", async () => {
    const html = renderAuditor(await loadAuditorData(client, s.cid, '2026-09-04', 'es'), 'es');
    expect(html).toContain('Respuesta de la administración: el pago corresponde a un anticipo acordado verbalmente.');
    expect(html).toContain('respuesta.pdf');
    expect(html).toContain('Alcance y límites de la detección');
  });

  it("names the presidency's unit by role and redacts the natural-person counterparty", async () => {
    const data = await loadAuditorData(client, s.cid, '2026-09-04', 'es');
    expect(data.redaction.presidentUnitIds.has(s.presidentUnitId)).toBe(true);
    const html = renderAuditor(data, 'es');
    expect(html).toContain(PRESIDENCY_UNIT.es);
    expect(html).not.toContain('Pral 1a');
    expect(html).toContain('3r 2a');

    const lawyer = renderLawyer(await loadLawyerData(client, s.cid, '2026-09-04', 'es'), 'es');
    expect(lawyer).toContain(PARTICULAR.es);
    expect(lawyer).not.toContain('Joan Puig Ferrer');
    expect(lawyer).not.toContain('ES9121000418450200051332');
    expect(lawyer).toContain('**** 1332');
    // the lawyer annex is the only pack that carries the related-party detail
    expect(lawyer).toContain('Coincidencia de un apellido');
    expect(html).not.toContain('Coincidencia de un apellido');
    expect(lawyer).toContain('Periodos a verificar');
  });

  it('renders the same canonical body twice while the header carries the date', async () => {
    const first = renderAuditor(await loadAuditorData(client, s.cid, '2026-09-04', 'es'), 'es');
    const second = renderAuditor(await loadAuditorData(client, s.cid, '2027-01-31', 'es'), 'es');
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
    expect(first).not.toBe(second);
    expect(first).toContain('2026-09-04');
    expect(second).toContain('2027-01-31');
  });

  it('renders the English twin with the same structure and the English placeholders', async () => {
    const html = renderAuditor(await loadAuditorData(client, s.cid, '2026-09-04', 'en'), 'en');
    expect(html).toContain('legal reference pending archive');
    expect(html).toContain('Scope and limits of detection');
    expect(html).toContain(PRESIDENCY_UNIT.en);
    for (const article of ARTICLE_STRINGS) expect(html).not.toContain(article);
    expect(scoreFieldsPresent(html)).toEqual([]);
  });

  it('builds a data room whose manifest hash matches every file it lists', async () => {
    const bundle = await buildDataRoom(client, s.cid, '2026-09-04', 'es');
    expect(bundle.files.length).toBeGreaterThan(DATA_ROOM_MIN_FILES);
    for (const f of bundle.files) {
      expect(f.sha256).toBe(sha256(f.content));
      expect(bundle.manifest.files.find((m) => m.name === f.name)).toMatchObject({ sha256: f.sha256, bytes: f.bytes });
    }
    expect(bundle.manifest.finding_run_id).not.toBeNull();
    expect(bundle.manifest.rule_versions.D1).toBeGreaterThan(0);
    // the manifest says what the distributed packs built from this data included and withheld
    expect(bundle.manifest.gates).toMatchObject({ findings_distributed: 1, withheld_pending_reply: 1, annex_only: 1 });
    expect(bundle.manifestSha256).toBe(sha256(bundle.manifestJson));

    // the bank ledger is redacted, and the scores live here and only here
    const bank = bundle.files.find((f) => f.name === 'bank_transactions.csv');
    expect(bank?.content.toString()).toContain(PARTICULAR.es);
    expect(bank?.content.toString()).not.toContain('Joan Puig Ferrer');
    expect(bank?.content.toString()).toContain('Reformes Exemple SL');
    const findings = bundle.files.find((f) => f.name === 'findings.csv');
    expect(findings?.content.toString()).toContain('hit_score');

    const again = await buildDataRoom(client, s.cid, '2026-09-04', 'es');
    expect(again.bundleSha256).toBe(bundle.bundleSha256);
  });

  it('anchors the append-only tables and chains to the previous root', async () => {
    const first = await computeAnchor(client, s.cid);
    expect(first.tables).toContain('finding_reviews');
    expect(first.rowCounts.finding_reviews).toBe(3);
    expect(first.rowCounts.files).toBe(1);
    expect(first.previousRoot).toBeNull();
    expect(first.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

    const unchanged = await computeAnchor(client, s.cid);
    expect(unchanged.merkleRoot).toBe(first.merkleRoot);

    await client.query('savepoint anchor_change');
    await client.query(
      `insert into public.finding_reviews (finding_id, from_status, to_status, reason) values ($1, 'confirmed_discrepancy', 'needs_document', 'further document requested')`,
      [s.distributedFindingId],
    );
    const after = await computeAnchor(client, s.cid);
    expect(after.merkleRoot).not.toBe(first.merkleRoot);
    expect(after.rowCounts.finding_reviews).toBe(4);
    await client.query('rollback to savepoint anchor_change');
  });
});

const DATA_ROOM_MIN_FILES = 14;
