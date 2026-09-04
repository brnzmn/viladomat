-- 0014_advisor_fixes.sql
-- Findings of the Supabase security and performance advisors after the first remote apply.
--   * extension_in_public                     -> pg_trgm and citext move to the extensions schema
--   * function_search_path_mutable            -> every owned function gets a fixed search_path
--   * anon_security_definer_function_executable -> no PUBLIC/anon execute on security-definer functions,
--                                                and functions created from now on start locked down
--   * auth_rls_initplan                       -> auth.uid() evaluated once per statement on community_members
--   * multiple_permissive_policies            -> one permissive policy per command on the three child tables
-- Left as is on purpose: unindexed_foreign_keys and unused_index (INFO). One community and a few
-- thousand rows do not justify 145 extra indexes; revisit when a query plan shows it.

-- ---------------------------------------------------------------------------
-- 1. Extensions out of the API-exposed schema. Existing columns, indexes and operators keep
--    working (they reference the objects by OID). Supabase resolves unqualified names through
--    "$user", public, extensions; the local shim sets the same search_path.
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
do $$ begin
  execute 'grant usage on schema extensions to anon, authenticated, service_role';
exception when insufficient_privilege then
  null; -- the platform owns the schema and has granted usage already
end $$;
do $$
declare e text;
begin
  foreach e in array array['pg_trgm', 'citext'] loop
    if exists (select 1 from pg_extension x join pg_namespace n on n.oid = x.extnamespace
                where x.extname = e and n.nspname = 'public') then
      execute format('alter extension %I set schema extensions', e);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Fixed search_path on every function we own that does not set one yet.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'restricted')
       and p.prokind = 'f'
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Function grants are explicit instead of inherited from PUBLIC or platform defaults.
--    Signed-in members may call the helpers used by policies and the security-definer functions
--    that guard themselves (log_access, member lookups, restricted upserts); bootstrap_community
--    and claim_job stay service-only; nothing is callable anonymously.
-- ---------------------------------------------------------------------------
grant execute on all functions in schema public to authenticated, service_role;
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.prokind = 'f'
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname in ('bootstrap_community', 'claim_job') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Functions created from now on carry no execute for PUBLIC or anon; grants are explicit.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------------
-- 4. community_members: auth.uid() as an init-plan, once per statement.
-- ---------------------------------------------------------------------------
drop policy if exists members_self_select on public.community_members;
create policy members_self_select on public.community_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_owner_reviewer(community_id));
drop policy if exists members_owner_delete on public.community_members;
create policy members_owner_delete on public.community_members for delete to authenticated
  using (public.is_owner_reviewer(community_id) and user_id <> (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. Child tables: the reviewer write policy no longer overlaps the member select policy.
-- ---------------------------------------------------------------------------
drop policy if exists document_pages_write on public.document_pages;
drop policy if exists document_pages_insert on public.document_pages;
drop policy if exists document_pages_update on public.document_pages;
drop policy if exists document_pages_delete on public.document_pages;
create policy document_pages_insert on public.document_pages for insert to authenticated
  with check (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)));
create policy document_pages_update on public.document_pages for update to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)))
  with check (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)));
create policy document_pages_delete on public.document_pages for delete to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)));

drop policy if exists invoice_vat_write on public.invoice_vat_summary;
drop policy if exists invoice_vat_insert on public.invoice_vat_summary;
drop policy if exists invoice_vat_update on public.invoice_vat_summary;
drop policy if exists invoice_vat_delete on public.invoice_vat_summary;
create policy invoice_vat_insert on public.invoice_vat_summary for insert to authenticated
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)));
create policy invoice_vat_update on public.invoice_vat_summary for update to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)));
create policy invoice_vat_delete on public.invoice_vat_summary for delete to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)));

drop policy if exists finding_evidence_write on public.finding_evidence;
drop policy if exists finding_evidence_insert on public.finding_evidence;
drop policy if exists finding_evidence_update on public.finding_evidence;
drop policy if exists finding_evidence_delete on public.finding_evidence;
create policy finding_evidence_insert on public.finding_evidence for insert to authenticated
  with check (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)));
create policy finding_evidence_update on public.finding_evidence for update to authenticated
  using (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)))
  with check (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)));
create policy finding_evidence_delete on public.finding_evidence for delete to authenticated
  using (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)));
