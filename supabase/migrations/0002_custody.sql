-- 0002_custody.sql
-- Community, units, parameters, parties, files (custody), pages, OCR, documents, extraction runs,
-- field values/revisions, validators, jobs.

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nif text,                                   -- community NIF (starts with H)
  address text,
  catastro_rc text,
  fy_start_month int not null default 1 check (fy_start_month between 1 and 12),
  ordinary_budget_default numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_communities_touch before update on public.communities for each row execute function public.touch_updated_at();

create table public.units (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  label text not null,                        -- e.g. "Pral 1a"
  floor text,
  door text,
  use text,                                   -- residential / storage / commercial ...
  quota_pct numeric(7,4),
  catastro_rc20 text,
  surface_m2 numeric(10,2),
  holder_role public.holder_role not null default 'unknown',
  notes text,
  created_at timestamptz not null default now(),
  unique (community_id, label)
);

-- Who held which office when (roles only; source is the resolution that appointed them).
create table public.office_terms (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  office public.office not null,
  unit_id uuid references public.units(id),
  party_id uuid,                              -- set for administrator firms (fk added later)
  valid_from date not null,
  valid_to date,
  source_resolution_id uuid,                  -- fk added in 0003
  created_at timestamptz not null default now()
);

-- Clauses of the statutes / constitutive title that override defaults.
create table public.community_rules (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  topic public.rule_topic not null,
  text_literal text not null,
  source_document_id uuid,                    -- fk added below
  page_no int,
  created_at timestamptz not null default now()
);

-- Versioned parameters (materiality, thresholds). Append-only: a new version supersedes.
create table public.parameters (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  key text not null,
  value_num numeric,
  value_text text,
  unit text,
  basis_text text,
  version int not null default 1,
  valid_from date not null default '1900-01-01',
  created_at timestamptz not null default now(),
  unique (community_id, key, version, valid_from)
);
create trigger t_parameters_append_only before update or delete on public.parameters for each row execute function public.forbid_change();

-- Current parameter value for a community, key and date.
create or replace function public.param(cid uuid, k text, on_date date default current_date)
returns numeric language sql stable as $$
  select value_num from public.parameters
   where community_id = cid and key = k and valid_from <= on_date
   order by version desc, valid_from desc limit 1
$$;

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  kind public.party_kind not null,
  display_name text not null,
  legal_name_norm text,
  nif text,
  nif_valid boolean,
  nif_kind text,                              -- DNI | NIE | CIF | SPECIAL
  entity_letter char(1),
  legal_form text,
  address_norm text,
  postcode text,
  phone_norm text,
  email_norm citext,
  domain text,
  origin_class public.issuer_class not null default 'unknown',
  first_seen_document_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_parties_touch before update on public.parties for each row execute function public.touch_updated_at();
create index parties_nif_idx on public.parties (community_id, nif);
create index parties_name_trgm on public.parties using gin (legal_name_norm gin_trgm_ops);
alter table public.office_terms add constraint office_terms_party_fk foreign key (party_id) references public.parties(id);

create table public.party_ibans (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  party_id uuid not null references public.parties(id) on delete cascade,
  iban_hmac text not null,
  iban_last4 text not null,
  iban_enc text,                              -- AES-GCM ciphertext, vendors/community only
  enc_key_version int,
  bank_code text,
  bank_name text,
  country char(2),
  iban_valid boolean,
  ccc_dc_valid boolean,
  seen_on date,
  first_seen_document_id uuid,
  created_at timestamptz not null default now(),
  unique (party_id, iban_hmac)
);
create index party_ibans_hmac_idx on public.party_ibans (community_id, iban_hmac);

-- ---------------------------------------------------------------------------
-- Custody: files are immutable. Only server-side hash verification may be set once.
-- ---------------------------------------------------------------------------
create table public.files (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  sha256 text not null,
  client_sha256 text,
  server_sha256 text,
  hash_verified boolean,
  storage_path text not null,                 -- originals/<sha2>/<sha256>.<ext>
  original_name text not null,
  mime text,
  bytes bigint,
  source public.file_source not null,
  supplied_by_role text,
  supplied_on date,
  batch_label text,
  transport_note text,
  exif jsonb,
  pdf_meta jsonb,
  email_auth jsonb,
  capture_time timestamptz,
  page_count int,
  parent_file_id uuid references public.files(id),
  status public.file_status not null default 'stored',
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  unique (community_id, sha256)
);
create index files_batch_idx on public.files (community_id, batch_label);

-- files: allow only the one-time server verification update.
create or replace function public.files_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'files is append-only' using errcode = '42501';
  end if;
  if old.server_sha256 is not null then
    raise exception 'file % already verified; rows are immutable', old.id using errcode = '42501';
  end if;
  if row(new.id, new.community_id, new.sha256, new.client_sha256, new.storage_path, new.original_name, new.mime, new.bytes,
         new.source, new.supplied_by_role, new.supplied_on, new.batch_label, new.transport_note, new.exif, new.pdf_meta,
         new.email_auth, new.capture_time, new.parent_file_id, new.uploaded_by, new.uploaded_at)
     is distinct from
     row(old.id, old.community_id, old.sha256, old.client_sha256, old.storage_path, old.original_name, old.mime, old.bytes,
         old.source, old.supplied_by_role, old.supplied_on, old.batch_label, old.transport_note, old.exif, old.pdf_meta,
         old.email_auth, old.capture_time, old.parent_file_id, old.uploaded_by, old.uploaded_at) then
    raise exception 'only server_sha256/hash_verified/status/page_count may change on files' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger t_files_guard before update or delete on public.files for each row execute function public.files_guard();

create table public.custody_manifests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  batch_label text not null,
  manifest_path text not null,
  manifest_sha256 text not null,
  file_count int not null,
  generated_at timestamptz not null default now(),
  generated_on_device text,
  timestamp_token_path text,
  timestamp_provider text,
  timestamped_at timestamptz,
  notary_ref text
);

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  page_no int not null,
  render_path text,                           -- derived/<sha256>/p<n>_<w>x<h>.jpg
  width int,
  height int,
  long_edge int,
  render_params jsonb,
  thumb_path text,
  phash bytea,
  has_text_layer boolean,
  text_layer text,
  legibility numeric(4,3),
  rotation_applied int,
  dedupe_of_page_id uuid references public.pages(id),
  created_at timestamptz not null default now(),
  unique (file_id, page_no)
);

create table public.ocr_words (
  id bigserial primary key,
  page_id uuid not null references public.pages(id) on delete cascade,
  idx int not null,
  text text not null,
  x0 int not null, y0 int not null, x1 int not null, y1 int not null,
  confidence numeric(5,2),
  engine text not null default 'tesseract',
  engine_version text,
  lang text
);
create index ocr_words_page_idx on public.ocr_words (page_id, idx);

create table public.works_packages (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  code public.works_code not null,
  label text,
  status public.works_status not null default 'unknown',
  architect_pem numeric(14,2),
  permit_pem numeric(14,2),
  subsidy_protegible numeric(14,2),
  contract_price numeric(14,2),
  suspension_date date,
  suspension_reason public.suspension_reason,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, code, label)
);
create trigger t_works_packages_touch before update on public.works_packages for each row execute function public.touch_updated_at();

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  doc_type text not null,
  status public.doc_status not null default 'grouped',
  doc_date date,
  fiscal_year int,
  issuer_party_id uuid references public.parties(id),
  recipient_party_id uuid references public.parties(id),
  language text check (language in ('es', 'ca', 'mixed', 'en', 'unknown')),
  issuer_class public.issuer_class not null default 'unknown',
  provenance_chain text[] not null default '{}',
  obtained_directly boolean not null default false,
  grouping_confidence numeric(4,3),
  grouping_reason text,
  grouped_by public.grouped_by not null default 'auto',
  current_run_id uuid,
  works_package_id uuid references public.works_packages(id),
  duplicate_of_document_id uuid references public.documents(id),
  dedupe_key text,
  title text,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_doc_type_check check (doc_type in (
    'factura','factura_simplificada','factura_rectificativa','presupuesto','contrato_obra','contrato_ascensor',
    'contrato_mantenimiento','contrato_prestamo','certificacion_obra','certificat_final_obra','albaran',
    'justificante_pago','justificant_transferencia','certificat_titularitat_bancaria','extracto_bancario',
    'liquidacion_anual','presupuesto_comunidad','acta','convocatoria','aviso_derrama','recibo_comunidad',
    'estatuts_titol_constitutiu','requeriment_burofax','permiso_obras','autoliquidacion_icio','iit','ite',
    'solicitud_subvencion','resolucio_subvencion','declaracio_responsable_ascensor','full_encarrec',
    'poliza_seguro','modelo_111_190_347','email','chat_export','nota_manuscrita','otro','ilegible'))
);
create trigger t_documents_touch before update on public.documents for each row execute function public.touch_updated_at();
create index documents_type_idx on public.documents (community_id, doc_type, fiscal_year);
create index documents_dedupe_idx on public.documents (community_id, dedupe_key);
alter table public.community_rules add constraint community_rules_doc_fk foreign key (source_document_id) references public.documents(id);
alter table public.parties add constraint parties_first_doc_fk foreign key (first_seen_document_id) references public.documents(id);
alter table public.party_ibans add constraint party_ibans_first_doc_fk foreign key (first_seen_document_id) references public.documents(id);

create table public.document_pages (
  document_id uuid not null references public.documents(id) on delete cascade,
  page_id uuid not null references public.pages(id) on delete cascade,
  seq int not null,
  primary key (document_id, page_id),
  unique (page_id)
);

create table public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  page_id uuid references public.pages(id) on delete cascade,
  stage public.run_stage not null,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  effort text,
  request_json jsonb,
  response_json jsonb,
  batch_id text,
  custom_id text,
  status public.run_status not null default 'queued',
  stop_reason text,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  cost_usd numeric(10,4),
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create trigger t_extraction_runs_append_only before update or delete on public.extraction_runs for each row execute function public.forbid_change();
create index extraction_runs_doc_idx on public.extraction_runs (document_id, created_at desc);
alter table public.documents add constraint documents_current_run_fk foreign key (current_run_id) references public.extraction_runs(id);

create table public.field_values (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  field_path text not null,
  value jsonb,
  value_norm text,
  page_id uuid references public.pages(id),
  bbox int[] check (bbox is null or array_length(bbox, 1) = 4),
  quote text,
  crop_status public.crop_status not null default 'page_only',
  model_conf numeric(4,3),
  ocr_value_norm text,
  ocr_agrees boolean,
  sonnet_value_norm text,
  sonnet_agrees boolean,
  validator_ok boolean,
  status public.field_status not null default 'needs_review',
  last_revision_id uuid,
  second_confirmation_actor_id uuid,
  second_confirmation_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (document_id, field_path)
);
create trigger t_field_values_touch before update on public.field_values for each row execute function public.touch_updated_at();

create table public.field_revisions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  run_id uuid references public.extraction_runs(id),
  field_path text not null,
  old_value jsonb,
  new_value jsonb,
  new_status public.field_status,
  source public.revision_source not null,
  actor_id uuid,
  reason text,
  created_at timestamptz not null default now()
);
create trigger t_field_revisions_append_only before update or delete on public.field_revisions for each row execute function public.forbid_change();
create index field_revisions_doc_idx on public.field_revisions (document_id, field_path, created_at desc);
alter table public.field_values add constraint field_values_last_revision_fk foreign key (last_revision_id) references public.field_revisions(id);

-- Every revision materialises the current value. A human change of an amount > 1 EUR needs a reason.
create or replace function public.apply_field_revision()
returns trigger language plpgsql as $$
declare old_num numeric; new_num numeric;
begin
  if new.source = 'human' then
    old_num := case when jsonb_typeof(new.old_value) = 'number' then (new.old_value)::text::numeric else public.parse_amount_es(new.old_value #>> '{}') end;
    new_num := case when jsonb_typeof(new.new_value) = 'number' then (new.new_value)::text::numeric else public.parse_amount_es(new.new_value #>> '{}') end;
    if old_num is not null and new_num is not null and abs(old_num - new_num) > 1 and coalesce(new.reason, '') = '' then
      raise exception 'a reason is required when a human changes an amount by more than 1 EUR' using errcode = '23514';
    end if;
  end if;
  insert into public.field_values (community_id, document_id, field_path, value, value_norm, status, last_revision_id)
  values (new.community_id, new.document_id, new.field_path, new.new_value,
          case when jsonb_typeof(new.new_value) = 'string' then public.norm_text(new.new_value #>> '{}') else new.new_value #>> '{}' end,
          coalesce(new.new_status, (case when new.source = 'human' then 'human_confirmed' when new.source = 'seed' then 'seed' else 'needs_review' end)::public.field_status),
          new.id)
  on conflict (document_id, field_path) do update
    set value = excluded.value,
        value_norm = excluded.value_norm,
        status = excluded.status,
        last_revision_id = excluded.last_revision_id;
  return new;
end $$;
create trigger t_field_revisions_apply after insert on public.field_revisions for each row execute function public.apply_field_revision();

create table public.validator_results (
  id bigserial primary key,
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  validator_code text not null,
  validator_version int not null,
  passed boolean not null,
  details jsonb,
  run_at timestamptz not null default now()
);
create trigger t_validator_results_append_only before update or delete on public.validator_results for each row execute function public.forbid_change();
create index validator_results_doc_idx on public.validator_results (document_id, run_at desc);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  idempotency_key text not null unique,        -- <sha256|doc_id>:<step>:<pipeline_version>
  step text not null,
  status public.job_status not null default 'queued',
  priority int not null default 100,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  payload jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();
create index jobs_queue_idx on public.jobs (status, run_after, priority, created_at);

-- Claim the next queued job (worker side, service role).
create or replace function public.claim_job(worker text, steps text[] default null)
returns public.jobs language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.jobs;
begin
  update public.jobs set status = 'running', locked_by = worker, locked_at = now(), attempts = attempts + 1
   where id = (
     select id from public.jobs
      where status = 'queued' and run_after <= now() and (steps is null or step = any(steps))
      order by priority, created_at
      for update skip locked limit 1)
  returning * into j;
  return j;
end $$;
revoke execute on function public.claim_job(text, text[]) from authenticated, anon;
