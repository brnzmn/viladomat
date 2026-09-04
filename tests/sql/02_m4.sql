-- M4 extension checks: quotes, certifications, permits, the benchmark register and expected
-- prices. Runs inside a transaction and rolls back. Requires 0010_m4_extension.sql.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'ASSERTION FAILED: %', msg; end if;
end $$;

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
select public.bootstrap_community('M4 test community', 'H00000001', 'Carrer Exemple 25', null) as cid \gset
select gen_random_uuid() as reviewer \gset
select gen_random_uuid() as stranger \gset
insert into public.community_members (user_id, community_id, role) values (:'reviewer', :'cid', 'owner_reviewer');

insert into public.works_packages (community_id, code, label) values (:'cid', 'PAINT_INT', 'Pintura interior') returning id as wp_id \gset
insert into public.parties (community_id, kind, display_name) values (:'cid', 'vendor', 'Contractor A SL') returning id as vendor_id \gset

-- ---------------------------------------------------------------------------
-- taxonomy seed
-- ---------------------------------------------------------------------------
select pg_temp.assert((select count(*) from public.benchmark_categories) >= 40, 'benchmark_categories seeded with at least 40 codes');
select pg_temp.assert((select comparable_default from public.benchmark_categories where code = 'ELEV_INSTALL') = false, 'lift installation is non-benchmarkable in v1');
select pg_temp.assert((select comparable_default from public.benchmark_categories where code = 'STAIR_REHAB') = false, 'staircase rehabilitation is non-benchmarkable in v1');
select pg_temp.assert((select count(*) from public.benchmark_sources where tier = 'official') > 0, 'official-tier sources registered');
select pg_temp.assert((select count(*) from public.benchmark_sources where verified_at is not null) = 0, 'no source is marked verified before its archived copy is checked');

-- ---------------------------------------------------------------------------
-- quotes and quote items
-- ---------------------------------------------------------------------------
insert into public.quotes (community_id, vendor_party_id, works_package_id, numero, fecha, pem,
                           gastos_generales_pct, beneficio_industrial_pct, presupuesto_contrata_sin_iva,
                           iva_pct, total_con_iva, exclusiones, accepted, entry_source)
values (:'cid', :'vendor_id', :'wp_id', 'P-2023-014', '2023-05-10', 10000.00,
        13.000, 6.000, 11900.00, 21.00, 14399.00, array['licencias', 'andamio'], true, 'seed')
returning id as quote_id \gset

insert into public.quote_items (community_id, quote_id, orden, chapter, code, descripcion, cantidad, unidad, precio_unitario, importe, category_code)
values (:'cid', :'quote_id', 1, 'CAP 1', 'PI.01', 'Pintura plastica en paramentos verticales de escalera', 450.00, 'm2', 12.5000, 5625.00, 'PAINT_INT'),
       (:'cid', :'quote_id', 2, 'CAP 1', 'PI.02', 'Partida alzada de imprevistos', 1.00, 'pa', 500.0000, 500.00, 'MISC');
select pg_temp.assert((select count(*) from public.quote_items where quote_id = :'quote_id') = 2, 'quote items inserted');
select pg_temp.expect_error(format('insert into public.quote_items (community_id, quote_id, orden, descripcion) values (%L, %L, 1, ''duplicate order'')', :'cid', :'quote_id'), 'quote item order is unique per quote');

-- ---------------------------------------------------------------------------
-- certifications
-- ---------------------------------------------------------------------------
insert into public.contracts (community_id, kind, vendor_party_id, works_package_id, fecha_firma, precio_sin_iva, es_precio_cerrado, entry_source)
values (:'cid', 'obra', :'vendor_id', :'wp_id', '2023-06-01', 11900.00, true, 'seed') returning id as contract_id \gset

insert into public.work_certifications (community_id, contract_id, works_package_id, numero_certificacion,
                                        periodo_desde, periodo_hasta, fecha, contractor_party_id,
                                        direccion_facultativa_present, total_a_origen, total_anterior,
                                        total_actual, retencion_garantia_pct, iva_pct, liquido_a_pagar, firmas)
values (:'cid', :'contract_id', :'wp_id', 1, '2023-06-01', '2023-06-30', '2023-07-03', :'vendor_id',
        false, 6000.00, 0.00, 6000.00, 5.00, 21.00, 6897.00, '[{"role": "contractor", "present": true}]'::jsonb)
returning id as cert_id \gset
select pg_temp.expect_error(format('insert into public.work_certifications (community_id, contract_id, numero_certificacion) values (%L, %L, 1)', :'cid', :'contract_id'), 'certification number is unique per contract');

insert into public.work_certification_items (community_id, certification_id, orden, code, descripcion, unidad,
                                             cantidad_contrato, precio_unitario, importe_contrato,
                                             cantidad_a_origen, importe_a_origen, importe_anterior, importe_actual,
                                             pct_ejecutado, quote_item_id)
select :'cid', :'cert_id', 1, 'PI.01', 'Pintura plastica en paramentos verticales de escalera', 'm2',
       450.00, 12.5000, 5625.00, 240.00, 3000.00, 0.00, 3000.00, 53.333, qi.id
  from public.quote_items qi where qi.quote_id = :'quote_id' and qi.orden = 1;
select pg_temp.assert((select count(*) from public.work_certification_items where certification_id = :'cert_id') = 1, 'certification item linked to the quote partida');

-- ---------------------------------------------------------------------------
-- permits
-- ---------------------------------------------------------------------------
insert into public.permits (community_id, works_package_id, expedient_no, tipus, data_presentacio,
                            pem_declarat, icio_base, icio_pct, icio_quota, taxa, entry_source)
values (:'cid', :'wp_id', '06-2023-0001', 'comunicat_diferit', '2023-05-20', 10000.00, 10000.00, 4.000, 400.00, 385.00, 'seed')
returning id as permit_id \gset
select pg_temp.expect_error(format('insert into public.permits (community_id, tipus) values (%L, ''not_a_type'')', :'cid'), 'permit type check');
select pg_temp.expect_error(format('insert into public.permits (community_id, expedient_no, tipus) values (%L, ''06-2023-0001'', ''llicencia'')', :'cid'), 'expedient number is unique per community');

-- subsidy detail columns added by this migration
insert into public.subsidies (community_id, programa, expedient, estat, pressupost_protegible, pct,
                              programa_bases_source_id, justificacio_presentada, three_quotes_source, entry_source)
values (:'cid', 'Consorci - elements comuns', 'EXP-1', 'applied', 11900.00, 35.000, 'BS-04', false, 'subsidy_bases', 'seed');
select pg_temp.assert((select three_quotes_source from public.subsidies where community_id = :'cid') = 'subsidy_bases', 'subsidy detail columns present');

-- recurring services and insurance
insert into public.recurring_services (community_id, category_code, vendor_party_id, label, started_on, monthly_amount_first, permanencia_meses)
values (:'cid', 'ELEV_MAINT', :'vendor_id', 'Manteniment ascensor', '2023-09-01', 95.00, 60);
insert into public.insurance_policies (community_id, insurer_party_id, policy_number, premium_annual, valid_from, valid_to)
values (:'cid', :'vendor_id', 'POL-1', 1200.00, '2023-01-01', '2023-12-31');
select pg_temp.expect_error(format('insert into public.insurance_policies (community_id, policy_number, valid_from) values (%L, ''POL-1'', ''2023-01-01'')', :'cid'), 'one policy row per number and start date');

-- ---------------------------------------------------------------------------
-- benchmark records: append-only, with a one-way supersede pointer
-- ---------------------------------------------------------------------------
insert into public.benchmark_records (category_code, source_id, source_ref, unit, region, valid_from,
                                      price_low, price_median, price_high, vat_included, index_basis,
                                      index_ref_date, scope, comparable, hash)
values ('PAINT_INT', 'BS-22', 'test capture 2023', 'm2', 'BCN', '2023-01-01',
        8.0000, 11.0000, 15.0000, false, 'IPC_CAT', '2023-01-01',
        '{"building_age_class": "pre_1965", "protected": true}'::jsonb, true, repeat('b', 64))
returning id as bm_id \gset

select pg_temp.expect_error(format('update public.benchmark_records set price_median = 99 where id = %L', :'bm_id'), 'benchmark records are append-only');
select pg_temp.expect_error(format('update public.benchmark_records set notes = ''edited'' where id = %L', :'bm_id'), 'benchmark records are append-only for every field');
select pg_temp.expect_error(format('delete from public.benchmark_records where id = %L', :'bm_id'), 'benchmark records cannot be deleted');
select pg_temp.expect_error('insert into public.benchmark_records (category_code, source_id, region, hash) values (''PAINT_INT'', ''BS-22'', ''BCN'', ' || quote_literal(repeat('b', 64)) || ')', 'benchmark record hash is unique');
select pg_temp.expect_error('insert into public.benchmark_records (category_code, source_id, region, hash) values (''NOT_A_CODE'', ''BS-22'', ''BCN'', ''h2'')', 'benchmark record category must exist');
select pg_temp.expect_error('insert into public.benchmark_records (category_code, source_id, region, hash) values (''PAINT_INT'', ''BS-22'', ''EU'', ''h3'')', 'benchmark record region check');

-- a re-sync inserts the replacement and points the old row at it, once
insert into public.benchmark_records (category_code, source_id, source_ref, unit, region, valid_from,
                                      price_low, price_median, price_high, index_basis, hash)
values ('PAINT_INT', 'BS-22', 'test capture 2024', 'm2', 'BCN', '2024-01-01',
        9.0000, 12.0000, 16.0000, 'IPC_CAT', repeat('c', 64))
returning id as bm2_id \gset
update public.benchmark_records set superseded_by = :'bm2_id' where id = :'bm_id';
select pg_temp.assert((select superseded_by from public.benchmark_records where id = :'bm_id') = :'bm2_id'::uuid, 'supersede pointer set');
select pg_temp.expect_error(format('update public.benchmark_records set superseded_by = %L where id = %L', :'bm_id', :'bm_id'), 'supersede pointer is set only once');
select pg_temp.assert((select count(*) from public.benchmark_records where superseded_by is null) = 1, 'one current record per capture');

-- index series
insert into public.index_series (source, series_code, base_period, period, value) values
  ('INE', 'IPC_CAT', '2021=100', '2023-01-01', 110.5000),
  ('INE', 'IPC_CAT', '2021=100', '2024-01-01', 114.2000);
select pg_temp.expect_error('insert into public.index_series (source, series_code, period, value) values (''INE'', ''IPC_CAT'', ''2023-01-01'', 1)', 'one value per source, series and period');

-- ---------------------------------------------------------------------------
-- expected prices
-- ---------------------------------------------------------------------------
insert into public.invoices (community_id, document_id, vendor_party_id, total)
select :'cid', d.id, :'vendor_id', 7000.00
  from public.documents d where d.community_id = :'cid' limit 1;
insert into public.expected_prices (community_id, target_type, target_id, e_value, band_low, band_high,
                                    confidence, severity, sources, method_version, parameters_version)
values (:'cid', 'invoice_line', :'quote_id', 5625.0000, 5343.7500, 5906.2500, 'high', 'REVIEW',
        '[{"layer": "CONTRACT", "point": 5625, "weight": 0.45, "ref": "quote P-2023-014 partida PI.01"}]'::jsonb,
        'p1-1.0.0', 'par-v1')
returning id as ep_id \gset
select pg_temp.assert((select severity from public.expected_prices where id = :'ep_id') = 'REVIEW', 'expected price stored');
select pg_temp.expect_error(format('insert into public.expected_prices (community_id, target_type, target_id, severity, method_version) values (%L, ''invoice_line'', %L, ''INFO'', ''p1-1.0.0'')', :'cid', :'quote_id'), 'one expected price per target and method version');
select pg_temp.expect_error(format('insert into public.expected_prices (community_id, target_type, target_id, severity, method_version) values (%L, ''invoice_line'', %L, ''HUGE'', ''p1-1.0.1'')', :'cid', :'quote_id'), 'severity check');

-- calibration, golden set, rule precision
insert into public.calibration (community_id, engine, field_type, conf_bucket, n, correct, accuracy, wilson_low, sample_kind)
values (:'cid', 'extract', 'amount', '0.9-1.0', 100, 96, 0.9600, 0.9016, 'random_audit');
insert into public.golden_set (community_id, label, labelled_fields, planted_discrepancies)
values (:'cid', 'synthetic invoice 01', '{"total": "1234.56"}'::jsonb, '["duplicate_number"]'::jsonb);
insert into public.rule_precision_log (community_id, rule_code, rule_version, hits, reviewed, true_positive, fp_rate)
values (:'cid', 'P1a', 1, 12, 8, 6, 0.2500);
select pg_temp.expect_error(format('insert into public.rule_precision_log (community_id, rule_code, rule_version) values (%L, ''ZZ9'', 1)', :'cid'), 'rule precision log references the rule catalogue');

-- external checks, officers and links
insert into public.external_checks (community_id, check_type, subject_type, subject_key, source_url, status)
values (:'cid', 'nif_validate', 'party', :'vendor_id', null, 'ok') returning id as check_id \gset
select pg_temp.expect_error(format('update public.external_checks set status = ''error'' where id = %L', :'check_id'), 'external_checks append-only');
select pg_temp.expect_error(format('delete from public.external_checks where id = %L', :'check_id'), 'external_checks cannot be deleted');
insert into public.entity_officers (community_id, party_id, surname1_norm, surname2_norm, cargo, date_from, source_check_id)
values (:'cid', :'vendor_id', 'garcia', 'perez', 'administrador unico', '2019-04-01', :'check_id');
insert into public.party_links (community_id, from_party_id, to_role, signal, points, rarity_weight, expected_collisions, tier, explanation, engine_version)
values (:'cid', :'vendor_id', 'president', 'S3', 25.00, 0.0031, 0.4200, 'review', 'Surname coincidence to verify against a register extract.', 'v1');
select pg_temp.expect_error(format('insert into public.party_links (community_id, from_party_id, to_role, signal, tier) values (%L, %L, ''president'', ''S3'', ''review'')', :'cid', :'vendor_id'), 'one row per party, role and signal');
select pg_temp.expect_error(format('insert into public.party_links (community_id, from_party_id, to_role, signal, tier) values (%L, %L, ''president'', ''S99'', ''review'')', :'cid', :'vendor_id'), 'signal check');

-- ---------------------------------------------------------------------------
-- RLS: the reviewer sees the community's rows; a stranger sees none
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', :'reviewer', true);
select pg_temp.assert((select count(*) from public.quotes) = 1, 'reviewer sees quotes');
select pg_temp.assert((select count(*) from public.quote_items) = 2, 'reviewer sees quote items');
select pg_temp.assert((select count(*) from public.permits) = 1, 'reviewer sees permits');
select pg_temp.assert((select count(*) from public.work_certifications) = 1, 'reviewer sees certifications');
select pg_temp.assert((select count(*) from public.expected_prices) = 1, 'reviewer sees expected prices');
select pg_temp.assert((select count(*) from public.external_checks) = 1, 'reviewer sees external checks');
select pg_temp.assert((select count(*) from public.benchmark_categories) >= 40, 'reviewer reads the category catalogue');
insert into public.permits (community_id, works_package_id, tipus, data_presentacio)
values (:'cid', :'wp_id', 'autoliquidacio_icio', '2023-05-21');
select pg_temp.assert((select count(*) from public.permits) = 2, 'reviewer can insert a permit');

select set_config('request.jwt.claim.sub', :'stranger', true);
select pg_temp.assert((select count(*) from public.quotes) = 0, 'stranger sees no quotes');
select pg_temp.assert((select count(*) from public.quote_items) = 0, 'stranger sees no quote items');
select pg_temp.assert((select count(*) from public.permits) = 0, 'stranger sees no permits');
select pg_temp.assert((select count(*) from public.work_certifications) = 0, 'stranger sees no certifications');
select pg_temp.assert((select count(*) from public.expected_prices) = 0, 'stranger sees no expected prices');
select pg_temp.assert((select count(*) from public.party_links) = 0, 'stranger sees no party links');
select pg_temp.expect_error(format('insert into public.quotes (community_id, numero) values (%L, ''P-X'')', :'cid'), 'stranger cannot insert a quote');
select pg_temp.expect_error(format('insert into public.permits (community_id, tipus) values (%L, ''llicencia'')', :'cid'), 'stranger cannot insert a permit');
select pg_temp.assert((select count(*) from public.benchmark_categories) >= 40, 'the category catalogue is global');
select pg_temp.expect_error('insert into public.benchmark_categories (code, label_es, label_en) values (''X'', ''x'', ''x'')', 'category catalogue is written by the service role only');
-- no update or delete policy exists, so these statements reach no row at all
update public.benchmark_records set superseded_by = null where id = :'bm_id';
delete from public.benchmark_records where id = :'bm_id';
select pg_temp.assert((select superseded_by from public.benchmark_records where id = :'bm_id') is not null, 'the app role cannot clear the supersede pointer');
select pg_temp.assert((select count(*) from public.benchmark_records) = 2, 'the app role cannot delete a benchmark record');
reset role;

rollback;
