-- Smoke and integrity checks for the schema. Runs inside a transaction and rolls back.
-- Requires the migrations (and, locally, the shim) to be applied.
\set ON_ERROR_STOP on
begin;

-- helper: assert
create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'ASSERTION FAILED: %', msg; end if;
end $$;

-- helper: expect an error
create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    return;
  end;
  raise exception 'EXPECTED ERROR DID NOT HAPPEN: %', msg;
end $$;
-- 0014 locks down default execute for PUBLIC; the test helpers run as authenticated too.
grant execute on function pg_temp.assert(boolean, text) to public;
grant execute on function pg_temp.expect_error(text, text) to public;

-- ---------------------------------------------------------------------------
-- bootstrap
-- ---------------------------------------------------------------------------
select public.bootstrap_community('Test community', 'H00000000', 'Carrer Exemple 1', null) as cid \gset
select gen_random_uuid() as reviewer \gset
select gen_random_uuid() as stranger \gset
insert into public.community_members (user_id, community_id, role) values (:'reviewer', :'cid', 'owner_reviewer');

insert into public.units (community_id, label, quota_pct, holder_role) values
  (:'cid', 'Pral 1a', 6.56, 'other_owner'),
  (:'cid', '1r 2a', 6.07, 'requesting_owner');

-- parameters: date-dependent cash limit
insert into public.parameters (community_id, key, value_num, unit, basis_text, version, valid_from) values
  (:'cid', 'cash_limit', 2500, 'EUR', 'Ley 7/2012 art. 7 before 2021-07-11', 1, '1900-01-01'),
  (:'cid', 'cash_limit', 1000, 'EUR', 'Ley 7/2012 art. 7 as amended by Ley 11/2021', 1, '2021-07-11'),
  (:'cid', 'outflow_min', 300, 'EUR', 'petty jobs', 1, '1900-01-01'),
  (:'cid', 'authority_threshold', 1000, 'EUR', 'community has no rule; stated', 1, '1900-01-01'),
  (:'cid', 'pm_ordinary', 335, 'EUR', '5% of ordinary budget', 1, '1900-01-01');
select pg_temp.assert(public.param(:'cid', 'cash_limit', '2021-01-01') = 2500, 'cash limit before change');
select pg_temp.assert(public.param(:'cid', 'cash_limit', '2022-01-01') = 1000, 'cash limit after change');
select pg_temp.expect_error(format('update public.parameters set value_num = 1 where community_id = %L', :'cid'), 'parameters are append-only');

-- ---------------------------------------------------------------------------
-- custody: files guard
-- ---------------------------------------------------------------------------
insert into public.files (community_id, sha256, client_sha256, storage_path, original_name, mime, bytes, source, supplied_by_role, supplied_on, batch_label)
values (:'cid', repeat('a', 64), repeat('a', 64), :'cid' || '/aa/' || repeat('a', 64) || '.jpg', 'IMG_0001.jpg', 'image/jpeg', 1234, 'web_upload', 'requesting_owner', current_date, 'entrega-1')
returning id as file_id \gset
update public.files set server_sha256 = repeat('a', 64), hash_verified = true where id = :'file_id';
select pg_temp.expect_error(format('update public.files set original_name = ''x'' where id = %L', :'file_id'), 'files immutable after verification');
select pg_temp.expect_error(format('delete from public.files where id = %L', :'file_id'), 'files cannot be deleted');

-- pages and documents
insert into public.pages (community_id, file_id, page_no) values (:'cid', :'file_id', 1) returning id as page_id \gset
insert into public.documents (community_id, doc_type, issuer_class, provenance_chain, obtained_directly)
values (:'cid', 'acta', 'administrator', array['administrator', 'requesting_owner'], false) returning id as doc_id \gset
insert into public.document_pages (document_id, page_id, seq) values (:'doc_id', :'page_id', 1);
select pg_temp.expect_error(format('insert into public.documents (community_id, doc_type) values (%L, ''not_a_type'')', :'cid'), 'doc_type check');

-- ---------------------------------------------------------------------------
-- field revisions materialise field values; human amount changes need a reason
-- ---------------------------------------------------------------------------
insert into public.field_revisions (community_id, document_id, field_path, old_value, new_value, source)
values (:'cid', :'doc_id', 'total', null, '1234.56'::jsonb, 'model');
select pg_temp.assert((select status from public.field_values where document_id = :'doc_id' and field_path = 'total') = 'needs_review', 'model revision -> needs_review');
select pg_temp.expect_error(format('insert into public.field_revisions (community_id, document_id, field_path, old_value, new_value, source) values (%L, %L, ''total'', ''1234.56''::jsonb, ''1300''::jsonb, ''human'')', :'cid', :'doc_id'), 'human amount change without reason');
insert into public.field_revisions (community_id, document_id, field_path, old_value, new_value, source, reason)
values (:'cid', :'doc_id', 'total', '1234.56'::jsonb, '1300'::jsonb, 'human', 'misread 4 as 7 on the photo');
select pg_temp.assert((select value #>> '{}' from public.field_values where document_id = :'doc_id' and field_path = 'total') = '1300', 'human revision materialised');
select pg_temp.assert((select status from public.field_values where document_id = :'doc_id' and field_path = 'total') = 'human_confirmed', 'human revision -> human_confirmed');
select pg_temp.expect_error(format('delete from public.field_revisions where document_id = %L', :'doc_id'), 'field_revisions append-only');

-- ---------------------------------------------------------------------------
-- meetings, resolutions, challenge windows
-- ---------------------------------------------------------------------------
insert into public.meetings (community_id, document_id, tipo, fecha, convocatoria_fecha, fecha_firma, fecha_notificacion, entry_source)
values (:'cid', :'doc_id', 'ordinaria', '2023-03-23', '2023-03-10', '2023-03-27', '2023-04-01', 'seed') returning id as meeting_id \gset
select pg_temp.assert((select notice_days from public.meetings where id = :'meeting_id') = 13, 'notice days computed');
select pg_temp.assert((select signed_within_5d from public.meetings where id = :'meeting_id') = true, 'signed within 5 days');
select pg_temp.assert((select sent_within_10d from public.meetings where id = :'meeting_id') = true, 'sent within 10 days');
insert into public.works_packages (community_id, code, label) values (:'cid', 'ELEVATOR', 'Ascensor') returning id as wp_id \gset
insert into public.resolutions (community_id, meeting_id, punto, texto_literal, kind, importe_aprobado, works_package_id, delegation_to_role, delegation_scope, cap_explicit, entry_source)
values (:'cid', :'meeting_id', '8', 'Approved by majority: the president is delegated to launch the project.', 'delegation', null, :'wp_id', 'president', 'launch project', false, 'seed') returning id as res_id \gset
select pg_temp.assert((select challenge_3m_until from public.resolutions where id = :'res_id') = date '2023-07-01', 'challenge window 3m from notification');
select pg_temp.assert((select challenge_12m_until from public.resolutions where id = :'res_id') = date '2024-04-01', 'challenge window 12m from notification');

-- derramas and ledger
insert into public.derramas (community_id, resolution_id, objeto, works_package_id, criterio, per_unit_amount, starts_on, months, entry_source)
values (:'cid', :'res_id', 'Obres', :'wp_id', 'partes_iguales', 60, '2023-04-01', 12, 'seed') returning id as derrama_id \gset
insert into public.derrama_ledger (community_id, derrama_id, unit_id, period, expected, paid, basis, status)
select :'cid', :'derrama_id', u.id, '2023-04-01', 60, 0, 'assertion', 'missing' from public.units u where u.community_id = :'cid';
select pg_temp.assert((select count(*) from public.v_r6_derrama_residual where community_id = :'cid') = 2, 'R6 residual rows');

-- bank
insert into public.bank_accounts (community_id, label, holder_kind, purpose) values (:'cid', 'Ordinary', 'community', 'ordinary') returning id as acct_id \gset
insert into public.bank_statements (community_id, bank_account_id, source, periodo_desde, periodo_hasta, saldo_inicial, saldo_final)
values (:'cid', :'acct_id', 'photo', '2023-01-01', '2023-01-31', 1000, 800),
       (:'cid', :'acct_id', 'photo', '2023-03-01', '2023-03-31', 800, 700);
select pg_temp.assert((select count(*) from public.v_r7_statement_months_missing where bank_account_id = :'acct_id') = 1, 'R7 detects the missing month');
insert into public.bank_transactions (community_id, bank_account_id, fecha_operacion, importe, tx_kind, flags, dedupe_key)
values (:'cid', :'acct_id', '2023-01-15', -450.00, 'transfer_out', array['person_beneficiary'], 'k1'),
       (:'cid', :'acct_id', '2023-01-16', -50.00, 'fee', '{}', 'k2'),
       (:'cid', :'acct_id', '2023-01-20', 120.00, 'quota_in', '{}', 'k3');
select pg_temp.assert((select count(*) from public.v_r2_debits_without_invoice where community_id = :'cid') = 1, 'R2 lists the unmatched debit above outflow_min only');

-- ---------------------------------------------------------------------------
-- findings and reviews
-- ---------------------------------------------------------------------------
insert into public.finding_runs (community_id, pipeline_version, engine_version, parameters_snapshot, rules_snapshot)
values (:'cid', '1', 'test', '{}'::jsonb, '{}'::jsonb) returning id as run_id \gset
insert into public.findings (community_id, rule_code, rule_version, fingerprint, event_key, severity, entity_type, entity_id, first_seen_run_id, last_seen_run_id)
values (:'cid', 'D0', 1, 'D0:wp:' || :'wp_id', 'wp:' || :'wp_id' || ':funding', 3, 'works_package', :'wp_id', :'run_id', :'run_id') returning id as finding_id \gset
select pg_temp.expect_error(format('insert into public.finding_reviews (finding_id, from_status, to_status) values (%L, ''new'', ''explained'')', :'finding_id'), 'explained needs a reason');
insert into public.finding_reviews (finding_id, from_status, to_status, reason) values (:'finding_id', 'new', 'sent_for_explanation', 'letter sent');
select pg_temp.assert((select status from public.findings where id = :'finding_id') = 'sent_for_explanation', 'review updates finding status');
select pg_temp.assert((select explanation_requested_on from public.findings where id = :'finding_id') = current_date, 'explanation date stamped');
select pg_temp.expect_error(format('delete from public.finding_reviews where finding_id = %L', :'finding_id'), 'finding_reviews append-only');

-- audit log via RPC (no auth context -> allowed)
select public.log_access(:'cid', 'seed', 'community', :'cid', null, null, 'smoke test') as log_id \gset
select pg_temp.expect_error(format('delete from public.audit_log where id = %s', :'log_id'), 'audit_log append-only');

-- restricted RPCs
select public.upsert_reference_person(:'cid', 'president_family', 'García', 'Pérez', 'Ignored', array['should be dropped'], '{}', null, null, '{}', 'surnames only, public source') as rp_id \gset
select pg_temp.assert((select count(*) from public.reference_match_keys(:'cid') where given_norm is null and addresses_norm = '{}') = 1, 'family rows carry surnames only');

-- ---------------------------------------------------------------------------
-- views execute
-- ---------------------------------------------------------------------------
select count(*) from public.v_control_totals;
select count(*) from public.v_year_balance_continuity;
select count(*) from public.v_works_funding;
select count(*) from public.v_challengeable_resolutions;
select count(*) from public.v_limitation_clocks;
select count(*) from public.v_document_matrix;
select count(*) from public.v_statement_coverage;
select count(*) from public.v_suspension_status;
select count(*) from public.v_r1_invoices_without_payment;
select count(*) from public.v_r3_liquidation_lines_unsupported;
select count(*) from public.v_r4_spend_without_resolution;
select count(*) from public.v_r5_milestones_paid_without_invoice;

-- ---------------------------------------------------------------------------
-- RLS: the reviewer sees the community; a stranger sees nothing; restricted is unreachable
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', :'reviewer', true);
select pg_temp.assert((select count(*) from public.units) = 2, 'reviewer sees units');
select pg_temp.assert((select count(*) from public.files) = 1, 'reviewer sees originals');
select pg_temp.assert((select count(*) from public.v_works_funding) = 1, 'reviewer sees funding view');
select pg_temp.expect_error('select count(*) from restricted.reference_persons', 'restricted schema unreachable for authenticated');
insert into public.units (community_id, label, quota_pct) values (:'cid', '2n 1a', 6.07);
select pg_temp.assert((select count(*) from public.units) = 3, 'reviewer can insert a unit');
select set_config('request.jwt.claim.sub', :'stranger', true);
select pg_temp.expect_error(format('insert into public.units (community_id, label, quota_pct) values (%L, ''3r 1a'', 2.79)', :'cid'), 'stranger cannot insert a unit');
select pg_temp.assert((select count(*) from public.units) = 0, 'stranger sees no units');
select pg_temp.assert((select count(*) from public.findings) = 0, 'stranger sees no findings');
select pg_temp.assert((select count(*) from public.rules) > 40, 'rules catalogue readable');
reset role;

rollback;
