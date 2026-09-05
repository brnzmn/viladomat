-- Register of public sources (0015): table shape, seed rows all unverified, read-only for
-- signed-in members, writable by the service role only, probe provenance through external_checks.
-- Runs inside a transaction and rolls back.
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
-- table and seed
-- ---------------------------------------------------------------------------
select pg_temp.assert(to_regclass('public.registry_sources') is not null, 'registry_sources exists');
select pg_temp.assert(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'registry_sources'
      and column_name in ('id', 'name', 'base_url', 'access', 'licence_note', 'verified_at', 'verified_by', 'probe_check_id', 'notes', 'updated_at')) = 10,
  'registry_sources carries the ten register columns');

select pg_temp.assert((select count(*) from public.registry_sources) = 14, 'fourteen source rows are seeded');
select pg_temp.assert((select count(*) from public.registry_sources where verified_at is not null) = 0, 'no seeded source is marked verified');
select pg_temp.assert((select count(*) from public.registry_sources where probe_check_id is not null) = 0, 'no seeded source carries a probe');
select pg_temp.assert(
  (select count(*) from public.registry_sources
    where id in ('openmercantil', 'bdns', 'raisc', 'rasic', 'catastro', 'aeat_vnif', 'idescat', 'rea', 'rea_manual',
                 'rasic_manual', 'aeat_census', 'registro_mercantil_nota', 'insolvency', 'dgsfp')) = 14,
  'every source id used by the check modules is registered');
-- No row without a check module: the Banco de Espana register is resolved offline (@viladomat/core).
select pg_temp.assert((select count(*) from public.registry_sources where id = 'bde_bank') = 0, 'no orphan bde_bank row');
select pg_temp.assert((select access from public.registry_sources where id = 'catastro') = 'api', 'catastro is an api source');
select pg_temp.assert((select access from public.registry_sources where id = 'rasic') = 'dataset', 'rasic is a dataset source');
select pg_temp.assert((select access from public.registry_sources where id = 'rea') = 'form', 'rea is a form source');
select pg_temp.assert((select access from public.registry_sources where id = 'insolvency') = 'manual', 'insolvency is a manual source');
select pg_temp.expect_error(
  'insert into public.registry_sources (id, name, access) values (''x_test'', ''bad access'', ''telepathy'')',
  'access is restricted to api, dataset, form, manual, local');

-- ---------------------------------------------------------------------------
-- policies and grants
-- ---------------------------------------------------------------------------
select pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.registry_sources'::regclass), 'row-level security is enabled');
select pg_temp.assert(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'registry_sources'
     and policyname = 'registry_sources_select' and cmd = 'SELECT' and 'authenticated' = any(roles)) = 1,
  'registry_sources_select lets signed-in members read the register');
select pg_temp.assert(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'registry_sources' and cmd <> 'SELECT') = 0,
  'no write policy for authenticated: writes go through the service role');
select pg_temp.assert(has_table_privilege('authenticated', 'public.registry_sources', 'select'), 'authenticated may select');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.registry_sources', 'insert'), 'authenticated may not insert');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.registry_sources', 'update'), 'authenticated may not update');
select pg_temp.assert(not has_table_privilege('anon', 'public.registry_sources', 'select'), 'anon may not read the register');
select pg_temp.assert(has_table_privilege('service_role', 'public.registry_sources', 'insert, update, delete'), 'service role writes the register');

-- ---------------------------------------------------------------------------
-- probe provenance: verified_at points at an external_checks row of type source_probe
-- ---------------------------------------------------------------------------
select public.bootstrap_community('Registry test community', 'H00000015', 'Carrer Exemple 25', null) as cid \gset
select gen_random_uuid() as reviewer \gset
insert into public.community_members (user_id, community_id, role) values (:'reviewer', :'cid', 'owner_reviewer');
insert into public.external_checks (community_id, check_type, subject_type, subject_key, source_url, request, raw_response, normalised, status)
values (:'cid', 'source_probe', 'source', 'catastro', 'https://example.test/probe', '{}'::jsonb, '{}'::jsonb,
        '{"source": "catastro", "verified": true}'::jsonb, 'ok')
returning id as probe_id \gset

select pg_temp.expect_error(
  format('update public.registry_sources set probe_check_id = %L where id = ''catastro''', gen_random_uuid()),
  'probe_check_id must reference an existing external_checks row');

-- the seed row was written by the migration, in an earlier transaction, so the trigger's stamp
-- (transaction now()) is strictly later than the seeded updated_at
select updated_at as before_update from public.registry_sources where id = 'catastro' \gset
update public.registry_sources set verified_at = now(), verified_by = :'reviewer', probe_check_id = :'probe_id' where id = 'catastro';
select pg_temp.assert((select verified_at is not null from public.registry_sources where id = 'catastro'), 'catastro marked verified by the probe');
select pg_temp.assert((select probe_check_id = :'probe_id' from public.registry_sources where id = 'catastro'), 'the probe row is referenced');
select pg_temp.assert((select updated_at > :'before_update'::timestamptz from public.registry_sources where id = 'catastro'), 'updated_at is touched on update');
select pg_temp.assert((select count(*) from public.registry_sources where verified_at is not null) = 1, 'only the probed source is verified');

-- a signed-in member reads the whole register but cannot write it
set role authenticated;
select set_config('request.jwt.claim.sub', :'reviewer', true);
select pg_temp.assert((select count(*) from public.registry_sources) = 14, 'signed-in member sees every source row');
select pg_temp.assert((select verified_at is not null from public.registry_sources where id = 'catastro'), 'signed-in member sees the verification state');
select pg_temp.expect_error('update public.registry_sources set notes = ''edited'' where id = ''bdns''', 'signed-in member cannot update the register');
select pg_temp.expect_error('insert into public.registry_sources (id, name, access) values (''x_member'', ''member insert'', ''api'')', 'signed-in member cannot insert a source');
select pg_temp.expect_error('delete from public.registry_sources where id = ''bdns''', 'signed-in member cannot delete a source');
reset role;

rollback;
