-- 0004_findings.sql
-- Rule catalogue, legal sources, finding runs, findings, evidence, reviews, null models,
-- audit log, report exports, chain anchors, notices, restricted reference data.

-- Archived primary sources (laws, ordinances, programme bases, benchmark PDFs). Global.
create table public.legal_sources (
  id text primary key,                         -- e.g. 'cccat-553-6'
  title text not null,
  url text,
  storage_path text,                           -- exports/legal_sources/<id>.pdf
  sha256 text,
  archived_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  excerpt text,
  notes text
);

create table public.rules (
  code text primary key,
  family text not null,
  version int not null default 1,
  name_es text not null,
  name_ca text,
  name_en text not null,
  description text,
  severity_default int not null check (severity_default between 1 and 4),
  specificity_prior numeric(4,3) not null default 0.7,
  legal_basis_kind public.legal_basis_kind not null default 'internal_control',
  attribution public.rule_attribution not null default 'funds',
  article_refs text[] not null default '{}',
  legal_source_ids text[] not null default '{}',
  enabled_in_v1 boolean not null default true,
  worklist_eligible boolean not null default true,
  never_t1t2 boolean not null default false,
  milestone text,
  fp_notes text,
  changelog text,
  updated_at timestamptz not null default now()
);

create table public.finding_runs (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  pipeline_version text not null,
  engine_version text not null,
  parameters_snapshot jsonb not null,
  rules_snapshot jsonb not null,
  inputs_hash text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  rule_code text not null references public.rules(code),
  rule_version int not null,
  fingerprint text not null,                   -- rule + entity + key facts
  event_key text,                              -- shared by hits on the same underlying event
  severity int not null check (severity between 1 and 4),
  extraction_quality numeric(4,3),
  specificity numeric(4,3),
  independence numeric(4,3),
  confidence numeric(4,3),
  hit_score numeric(6,3),
  entity_type text,
  entity_id uuid,
  works_package_id uuid references public.works_packages(id),
  fiscal_year int,
  amount_at_stake numeric(14,2),
  act_date_first date,
  act_date_last date,
  computed jsonb,
  summary_es text,
  summary_en text,
  innocent_explanations jsonb,
  next_check text,
  resolving_document text,
  tier public.finding_tier,
  status public.finding_status not null default 'new',
  explanation_requested_on date,
  explanation_letter_file_id uuid references public.files(id),
  explanation_received_on date,
  four_eyes_ok boolean not null default false,
  first_seen_run_id uuid references public.finding_runs(id),
  last_seen_run_id uuid references public.finding_runs(id),
  superseded_by uuid references public.findings(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, fingerprint)
);
create trigger t_findings_touch before update on public.findings for each row execute function public.touch_updated_at();
create index findings_status_idx on public.findings (community_id, status, tier);
create index findings_entity_idx on public.findings (entity_type, entity_id);
alter table public.document_requests add constraint document_requests_finding_fk foreign key (finding_id) references public.findings(id);

create table public.finding_evidence (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  label text not null,
  document_id uuid references public.documents(id),
  page_id uuid references public.pages(id),
  bbox int[],
  crop_path text,
  crop_status public.crop_status,
  quote text,
  file_sha256 text,
  run_id uuid references public.extraction_runs(id),
  revision_ids uuid[] not null default '{}',
  bank_transaction_id uuid references public.bank_transactions(id),
  resolution_id uuid references public.resolutions(id),
  external_check_id uuid,
  benchmark_record_id uuid,
  parameter_version int,
  computed jsonb,
  created_at timestamptz not null default now()
);

create table public.finding_reviews (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  from_status public.finding_status,
  to_status public.finding_status not null,
  reason text,
  attachment_file_ids uuid[] not null default '{}',
  actor_id uuid,
  created_at timestamptz not null default now()
);
create trigger t_finding_reviews_append_only before update or delete on public.finding_reviews for each row execute function public.forbid_change();

-- A status change is only valid through a review row; the review row updates the finding.
create or replace function public.apply_finding_review()
returns trigger language plpgsql as $$
begin
  if new.to_status = 'explained' and coalesce(new.reason, '') = '' then
    raise exception 'a reason is required to mark a finding as explained' using errcode = '23514';
  end if;
  update public.findings
     set status = new.to_status,
         explanation_requested_on = case when new.to_status = 'sent_for_explanation' then coalesce(explanation_requested_on, current_date) else explanation_requested_on end,
         explanation_received_on = case when new.to_status = 'explained' then coalesce(explanation_received_on, current_date) else explanation_received_on end
   where id = new.finding_id;
  return new;
end $$;
create trigger t_finding_reviews_apply after insert on public.finding_reviews for each row execute function public.apply_finding_review();

create table public.rule_null_models (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  rule_code text not null references public.rules(code),
  rule_version int not null,
  corpus_hash text not null,
  observed numeric,
  null_mean numeric,
  null_p95 numeric,
  p_value numeric,
  permutations int,
  computed_at timestamptz not null default now()
);

create table public.audit_log (
  id bigserial primary key,
  community_id uuid references public.communities(id) on delete cascade,
  actor_id uuid,
  action public.audit_action not null,
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  ip_hash text,
  at timestamptz not null default now()
);
create trigger t_audit_log_append_only before update or delete on public.audit_log for each row execute function public.forbid_change();
create index audit_log_idx on public.audit_log (community_id, at desc);

create table public.report_exports (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  kind public.report_kind not null,
  storage_path text not null,
  sha256 text not null,
  canonical_sha256 text,                       -- hash of the canonical HTML/data-room bundle
  manifest jsonb,
  finding_run_id uuid references public.finding_runs(id),
  reproduced_ok boolean,
  reproduced_at timestamptz,
  approved_by_role text,
  approved_at timestamptz,
  timestamp_token_path text,
  generated_at timestamptz not null default now()
);

-- Weekly Merkle root over append-only tables, to be externally timestamped.
create table public.chain_anchors (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  covers_until timestamptz not null,
  tables text[] not null,
  row_counts jsonb not null,
  merkle_root text not null,
  previous_root text,
  timestamp_token_path text,
  created_at timestamptz not null default now()
);
create trigger t_chain_anchors_append_only before update or delete on public.chain_anchors for each row execute function public.forbid_change();

create table public.notices_sent (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  unit_id uuid references public.units(id),
  kind text not null default 'art13_14_notice',
  channel text,
  sent_on date not null,
  evidence_file_id uuid references public.files(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Restricted schema: identifiers of natural persons used only for equality tests.
-- No direct access; security-definer functions in 0006 expose what the rules need.
-- ---------------------------------------------------------------------------
create table restricted.reference_persons (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  role public.reference_role not null,
  surname1_norm text,
  surname2_norm text,
  given_norm text,                             -- null for president_family rows
  addresses_norm text[] not null default '{}', -- empty for president_family rows
  iban_hmacs text[] not null default '{}',
  nif_hmac text,
  dni_last3 text,
  source_document_ids uuid[] not null default '{}',
  lawful_basis_note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_reference_persons_touch before update on restricted.reference_persons for each row execute function public.touch_updated_at();

create table restricted.unit_payer_keys (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  payer_name_hmac text,
  payer_iban_hmac text,
  mandate_ref_hmac text,
  source_document_id uuid references public.documents(id),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now()
);
create index unit_payer_keys_idx on restricted.unit_payer_keys (community_id, payer_iban_hmac, payer_name_hmac, mandate_ref_hmac);
