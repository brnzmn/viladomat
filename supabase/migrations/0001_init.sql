-- 0001_init.sql
-- Extensions, schemas, enums, helper functions, grants.
-- Applies on Supabase (auth/storage schemas present) and on the supabase/postgres image locally.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists citext;

create schema if not exists restricted;

comment on schema restricted is 'Identifiers of natural persons needed for equality tests; reachable only through security-definer functions.';

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner_reviewer', 'second_reviewer', 'viewer', 'auditor_readonly');
create type public.holder_role as enum ('president', 'requesting_owner', 'other_owner', 'unknown');
create type public.office as enum ('president', 'vice_president', 'secretary', 'administrator');
create type public.rule_topic as enum ('quota_criterion', 'works_threshold', 'delegation_limit', 'reserve_fund', 'meeting', 'other');
create type public.party_kind as enum ('vendor', 'administrator', 'architect', 'president_role', 'owner_role', 'bank', 'public_body', 'insurer', 'other');
create type public.issuer_class as enum ('bank', 'public_registry', 'vendor_direct', 'administrator', 'president', 'requesting_owner', 'unknown');
create type public.file_source as enum ('web_upload', 'local', 'drive', 'gmail', 'admin_delivery', 'bank_export', 'phone_transfer', 'onsite');
create type public.file_status as enum ('stored', 'quarantined', 'duplicate');
create type public.doc_status as enum ('grouped', 'classified', 'extracted', 'verified', 'reviewed', 'rejected');
create type public.grouped_by as enum ('auto', 'human', 'seed');
create type public.run_stage as enum ('classify', 'extract', 'verify', 'crosscheck', 'narrative', 'translate');
create type public.run_status as enum ('queued', 'submitted', 'succeeded', 'errored', 'expired', 'refused', 'parse_failed');
create type public.field_status as enum ('auto_accepted', 'needs_review', 'human_confirmed', 'corrected', 'rejected', 'unreadable', 'seed');
create type public.crop_status as enum ('anchored', 'anchored_redacted', 'approximate', 'page_only');
create type public.revision_source as enum ('model', 'ocr', 'verify', 'validator', 'human', 'seed');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead');
create type public.holder_kind as enum ('community', 'administrator_pooled', 'other', 'unknown');
create type public.account_purpose as enum ('ordinary', 'reserve', 'works', 'unknown');
create type public.statement_source as enum ('norma43', 'camt053', 'csv', 'pdf_native', 'pdf_scan', 'photo', 'seed');
create type public.tx_kind as enum ('transfer_out', 'transfer_in', 'direct_debit', 'direct_debit_recurring', 'fee', 'tax', 'card', 'cash', 'cheque', 'bizum', 'internal', 'interest', 'loan', 'subsidy', 'quota_in', 'refund', 'returned', 'other');
create type public.liq_basis as enum ('cash', 'accrual', 'mixed', 'unknown');
create type public.meeting_kind as enum ('ordinaria', 'extraordinaria');
create type public.entry_source as enum ('seed', 'extraction');
create type public.resolution_kind as enum ('works_approval', 'contractor_choice', 'budget', 'accounts', 'derrama', 'delegation', 'election', 'loan', 'subsidy', 'audit', 'info', 'other');
create type public.resolution_result as enum ('aprobado', 'rechazado', 'informado', 'pendiente');
create type public.derrama_criterio as enum ('coeficiente', 'partes_iguales', 'otro');
create type public.ledger_basis as enum ('bank', 'assertion');
create type public.ledger_status as enum ('expected', 'paid', 'partial', 'missing', 'excess');
create type public.works_code as enum ('ELEVATOR', 'STAIRCASE', 'ENTRANCE_DOOR', 'INTERCOM', 'WINDOWS', 'PAINT_INT', 'REAR_FACADE', 'SEWER', 'DRAIN', 'OTHER');
create type public.works_status as enum ('planned', 'approved', 'contracted', 'in_progress', 'suspended', 'completed', 'unknown');
create type public.works_event_type as enum ('acta_approval', 'quote_received', 'quote_accepted', 'contract_signed', 'permit_filed', 'permit_granted', 'icio_paid', 'start_of_works', 'certification', 'invoice', 'payment', 'final_certification', 'retention_release', 'suspension', 'resumption', 'subsidy_application', 'subsidy_resolution', 'subsidy_payment', 'loan_disbursement', 'site_photo');
create type public.suspension_reason as enum ('seasonal', 'contractual', 'dispute', 'permit', 'unknown');
create type public.contract_kind as enum ('obra', 'ascensor_instalacion', 'mantenimiento_ascensor', 'servicio', 'prestamo', 'otro');
create type public.milestone_status as enum ('pending', 'invoiced', 'paid', 'paid_without_invoice', 'overpaid');
create type public.link_type as enum ('paid_by', 'reported_as', 'authorised_by', 'under_contract', 'certifies', 'quotes_for', 'funds', 'declares_pem_for', 'subsidises', 'same_scope_as', 'refunds', 'returns');
create type public.link_method as enum ('exact', 'amount_date', 'amount_date_name', 'partial_sum', 'iban', 'reference', 'trigram', 'human', 'seed');
create type public.link_status as enum ('proposed', 'accepted', 'rejected');
create type public.request_class as enum ('accounts', 'budget', 'derrama_statement', 'invoices', 'bank_statements', 'bank_statements_norma43', 'bank_holder_certificate', 'contracts', 'elevator_contract', 'certifications', 'permit', 'subsidy', 'modelo_347', 'insurance_policy', 'related_party_declaration', 'statutes', 'other');
create type public.request_status as enum ('planned', 'requested', 'partial', 'received', 'inspected_only', 'refused');
create type public.legal_basis_kind as enum ('statutory', 'subsidy_bases', 'professional_standard', 'internal_control');
create type public.rule_attribution as enum ('vendor_compliance', 'administrator_process', 'governance', 'funds');
create type public.finding_status as enum ('new', 'in_review', 'sent_for_explanation', 'explained', 'confirmed_discrepancy', 'needs_document', 'dismissed_fp');
create type public.finding_tier as enum ('T1', 'T2', 'T3');
create type public.report_kind as enum ('pre_junta_es', 'auditor_es', 'lawyer_es', 'en_twin', 'ca_twin', 'data_room', 'manifest', 'explanation_letter');
create type public.audit_action as enum ('view', 'download', 'edit', 'status_change', 'export', 'login', 'rule_run', 'external_check', 'seed', 'ingest');
create type public.reference_role as enum ('president', 'president_family', 'administrator_principal');
create type public.subsidy_status as enum ('unknown', 'not_applied', 'applied', 'granted', 'paid', 'denied');

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Fiscal year of a date given the month the community's exercise starts (1 = January).
create or replace function public.fiscal_year(d date, start_month int default 1)
returns int language sql immutable as $$
  select case
    when start_month is null or start_month <= 1 then extract(year from d)::int
    when extract(month from d)::int >= start_month then extract(year from d)::int + 1
    else extract(year from d)::int
  end
$$;

-- Normalise free text for matching: NFD-less fallback using unaccent-like translate, lower, collapse spaces.
create or replace function public.norm_text(t text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(translate(coalesce(t, ''),
    'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇáéíóúàèìòùäëïöüâêîôûñç·',
    'AEIOUAEIOUAEIOUAEIOUNCaeiouaeiouaeiouaeiounc ')),
    '\s+', ' ', 'g'), '')
$$;

-- Spanish amount text "1.234,56" -> numeric
create or replace function public.parse_amount_es(t text)
returns numeric language plpgsql immutable as $$
declare s text;
begin
  if t is null then return null; end if;
  s := regexp_replace(t, '[^0-9,.\-]', '', 'g');
  if s = '' then return null; end if;
  -- if both separators present, the last one is the decimal separator
  if position(',' in s) > 0 and position('.' in s) > 0 then
    if length(s) - position(',' in reverse(s)) > length(s) - position('.' in reverse(s)) then
      s := replace(s, '.', ''); s := replace(s, ',', '.');
    else
      s := replace(s, ',', '');
    end if;
  elsif position(',' in s) > 0 then
    s := replace(s, '.', ''); s := replace(s, ',', '.');
  end if;
  return s::numeric;
exception when others then
  return null;
end $$;

-- Membership lookup used by RLS policies.
create table public.community_members (
  user_id uuid not null,
  community_id uuid not null,
  role public.member_role not null default 'viewer',
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, community_id)
);

create or replace function public.member_role_of(cid uuid)
returns public.member_role language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.community_members
   where user_id = auth.uid() and community_id = cid
     and (valid_until is null or valid_until > now())
$$;

create or replace function public.is_member(cid uuid)
returns boolean language sql stable as $$
  select public.member_role_of(cid) is not null
$$;

create or replace function public.is_reviewer(cid uuid)
returns boolean language sql stable as $$
  select public.member_role_of(cid) in ('owner_reviewer', 'second_reviewer')
$$;

create or replace function public.is_owner_reviewer(cid uuid)
returns boolean language sql stable as $$
  select public.member_role_of(cid) = 'owner_reviewer'
$$;

-- Trigger function: forbid UPDATE/DELETE on append-only tables (the service role is not exempt).
create or replace function public.forbid_change()
returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = '42501';
end $$;

-- Trigger function: maintain updated_at.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated users reach public tables through RLS; restricted only via RPC.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
grant select, insert, update, delete on public.community_members to authenticated, service_role;

grant usage on schema restricted to service_role;
revoke all on schema restricted from authenticated, anon;
