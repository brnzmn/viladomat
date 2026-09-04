-- Advisor regressions (0014): fixed search_path on every owned function, no anonymous execute
-- on security-definer functions, extensions outside public, one permissive select policy on the
-- child tables. Runs inside a transaction and rolls back.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'ASSERTION FAILED: %', msg; end if;
end $$;
-- 0014 locks down default execute for PUBLIC; the test helpers run as authenticated too.
grant execute on function pg_temp.assert(boolean, text) to public;

select pg_temp.assert(
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'restricted') and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) = 0,
  'every owned function sets a search_path');

select pg_temp.assert(
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'execute')) = 0,
  'no security-definer function is executable by anon');

select pg_temp.assert(
  (select count(*) from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where n.nspname = 'public' and e.extname in ('pg_trgm', 'citext')) = 0,
  'pg_trgm and citext live outside public');

select pg_temp.assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('document_pages', 'invoice_vat_summary', 'finding_evidence')
      and cmd = 'ALL') = 0,
  'no FOR ALL policy overlaps the select policy on the child tables');

select pg_temp.assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('document_pages', 'invoice_vat_summary', 'finding_evidence')
      and cmd = 'SELECT' and 'authenticated' = any(roles)) = 3,
  'each child table keeps exactly one select policy for members');

-- members still resolve their own row and the reviewer helpers still work with the new search_path
select public.bootstrap_community('Advisor test community', 'H00000014', 'Carrer Exemple 25', null) as cid \gset
select gen_random_uuid() as reviewer \gset
insert into public.community_members (user_id, community_id, role) values (:'reviewer', :'cid', 'owner_reviewer');
set role authenticated;
select set_config('request.jwt.claim.sub', :'reviewer', true);
select pg_temp.assert((select count(*) from public.community_members where community_id = :'cid') = 1, 'reviewer sees own membership row');
select pg_temp.assert(public.is_reviewer(:'cid'), 'is_reviewer resolves with fixed search_path');
select pg_temp.assert(public.member_role_of(:'cid') = 'owner_reviewer', 'member_role_of resolves for the caller');
reset role;

rollback;
