-- 0005_rls.sql
-- Row-level security. Members read their community; reviewers write; append-only tables accept
-- inserts only; originals (files, pages, OCR, raw field values, raw bank rows) are visible to
-- reviewers only; restricted.* has no policies at all (security-definer functions only).

-- helper: originals visibility
create or replace function public.can_see_originals(cid uuid)
returns boolean language sql stable as $$
  select public.member_role_of(cid) in ('owner_reviewer', 'second_reviewer', 'viewer')
$$;

-- community_members: a user sees their own memberships; owner_reviewer manages members
alter table public.community_members enable row level security;
create policy members_self_select on public.community_members for select to authenticated using (user_id = auth.uid() or public.is_owner_reviewer(community_id));
create policy members_owner_insert on public.community_members for insert to authenticated with check (public.is_owner_reviewer(community_id));
create policy members_owner_update on public.community_members for update to authenticated using (public.is_owner_reviewer(community_id));
create policy members_owner_delete on public.community_members for delete to authenticated using (public.is_owner_reviewer(community_id) and user_id <> auth.uid());

-- communities
alter table public.communities enable row level security;
create policy communities_select on public.communities for select to authenticated using (public.is_member(id));
create policy communities_update on public.communities for update to authenticated using (public.is_owner_reviewer(id));

-- global catalogues: read for everyone signed in; written by the service role only
alter table public.rules enable row level security;
create policy rules_select on public.rules for select to authenticated using (true);
alter table public.legal_sources enable row level security;
create policy legal_sources_select on public.legal_sources for select to authenticated using (true);

-- Generic policy installer for tables carrying community_id.
--   mode 'mutable'      : select member / insert+update reviewer / delete owner_reviewer
--   mode 'append_only'  : select member / insert reviewer
--   mode 'originals'    : select can_see_originals / insert reviewer / update reviewer
--   mode 'originals_ao' : select can_see_originals / insert reviewer (append-only)
create or replace function public.install_policies(tbl text, mode text)
returns void language plpgsql as $$
declare sel text; ins text; upd text; del text;
begin
  execute format('alter table public.%I enable row level security', tbl);
  sel := case when mode like 'originals%' then 'public.can_see_originals(community_id)' else 'public.is_member(community_id)' end;
  execute format('create policy %I on public.%I for select to authenticated using (%s)', tbl || '_select', tbl, sel);
  execute format('create policy %I on public.%I for insert to authenticated with check (public.is_reviewer(community_id))', tbl || '_insert', tbl);
  if mode in ('mutable', 'originals') then
    execute format('create policy %I on public.%I for update to authenticated using (public.is_reviewer(community_id)) with check (public.is_reviewer(community_id))', tbl || '_update', tbl);
  end if;
  if mode = 'mutable' then
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_owner_reviewer(community_id))', tbl || '_delete', tbl);
  end if;
end $$;

select public.install_policies('units', 'mutable');
select public.install_policies('office_terms', 'mutable');
select public.install_policies('community_rules', 'mutable');
select public.install_policies('parameters', 'append_only');
select public.install_policies('parties', 'mutable');
select public.install_policies('party_ibans', 'mutable');
select public.install_policies('files', 'originals');            -- update limited by trigger
select public.install_policies('custody_manifests', 'mutable');
select public.install_policies('pages', 'originals');
select public.install_policies('works_packages', 'mutable');
select public.install_policies('documents', 'mutable');
select public.install_policies('extraction_runs', 'append_only');
select public.install_policies('field_values', 'originals');
select public.install_policies('field_revisions', 'append_only');
select public.install_policies('validator_results', 'append_only');
select public.install_policies('jobs', 'mutable');
select public.install_policies('bank_accounts', 'mutable');
select public.install_policies('bank_statements', 'mutable');
select public.install_policies('bank_transactions', 'originals');
select public.install_policies('liquidations', 'mutable');
select public.install_policies('liquidation_lines', 'mutable');
select public.install_policies('liquidation_unit_rows', 'originals');
select public.install_policies('meetings', 'mutable');
select public.install_policies('resolutions', 'mutable');
select public.install_policies('derramas', 'mutable');
select public.install_policies('derrama_ledger', 'originals');
select public.install_policies('contracts', 'mutable');
select public.install_policies('contract_milestones', 'mutable');
select public.install_policies('loans', 'mutable');
select public.install_policies('subsidies', 'mutable');
select public.install_policies('invoices', 'mutable');
select public.install_policies('invoice_lines', 'mutable');
select public.install_policies('works_events', 'mutable');
select public.install_policies('recon_links', 'mutable');
select public.install_policies('request_clock', 'mutable');
select public.install_policies('document_requests', 'mutable');
select public.install_policies('finding_runs', 'mutable');
select public.install_policies('findings', 'mutable');
select public.install_policies('rule_null_models', 'mutable');
select public.install_policies('audit_log', 'append_only');
select public.install_policies('report_exports', 'mutable');
select public.install_policies('chain_anchors', 'append_only');
select public.install_policies('notices_sent', 'mutable');

-- tables without community_id: derive through the parent
alter table public.document_pages enable row level security;
create policy document_pages_select on public.document_pages for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.can_see_originals(d.community_id)));
create policy document_pages_write on public.document_pages for all to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)))
  with check (exists (select 1 from public.documents d where d.id = document_id and public.is_reviewer(d.community_id)));

alter table public.ocr_words enable row level security;
create policy ocr_words_select on public.ocr_words for select to authenticated
  using (exists (select 1 from public.pages p where p.id = page_id and public.can_see_originals(p.community_id)));
create policy ocr_words_insert on public.ocr_words for insert to authenticated
  with check (exists (select 1 from public.pages p where p.id = page_id and public.is_reviewer(p.community_id)));

alter table public.invoice_vat_summary enable row level security;
create policy invoice_vat_select on public.invoice_vat_summary for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_member(i.community_id)));
create policy invoice_vat_write on public.invoice_vat_summary for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and public.is_reviewer(i.community_id)));

alter table public.finding_evidence enable row level security;
create policy finding_evidence_select on public.finding_evidence for select to authenticated
  using (exists (select 1 from public.findings f where f.id = finding_id and public.is_member(f.community_id)));
create policy finding_evidence_write on public.finding_evidence for all to authenticated
  using (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)))
  with check (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)));

alter table public.finding_reviews enable row level security;
create policy finding_reviews_select on public.finding_reviews for select to authenticated
  using (exists (select 1 from public.findings f where f.id = finding_id and public.is_member(f.community_id)));
create policy finding_reviews_insert on public.finding_reviews for insert to authenticated
  with check (exists (select 1 from public.findings f where f.id = finding_id and public.is_reviewer(f.community_id)));

-- restricted schema: RLS on, no policies -> only security-definer functions reach it.
alter table restricted.reference_persons enable row level security;
alter table restricted.unit_payer_keys enable row level security;
revoke all on all tables in schema restricted from authenticated, anon;
