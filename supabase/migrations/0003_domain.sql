-- 0003_domain.sql
-- Bank, liquidations, meetings/resolutions, derramas, works, contracts, loans, subsidies, invoices,
-- reconciliation links, request clock, document requests.

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  label text not null,
  iban_hmac text,
  iban_last4 text,
  iban_enc text,
  enc_key_version int,
  bank_code text,
  bank_name text,
  holder_as_shown text,
  holder_kind public.holder_kind not null default 'unknown',
  purpose public.account_purpose not null default 'unknown',
  titled_to_community boolean,
  signatory_roles text[],
  holder_certificate_document_id uuid references public.documents(id),
  opened_on date,
  closed_on date,
  created_at timestamptz not null default now(),
  unique (community_id, label)
);

create table public.bank_statements (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  document_id uuid references public.documents(id),
  file_id uuid references public.files(id),
  source public.statement_source not null,
  periodo_desde date,
  periodo_hasta date,
  saldo_inicial numeric(14,2),
  saldo_final numeric(14,2),
  continuity_ok boolean,
  self_check_ok boolean,
  discrepancy_eur numeric(14,2),
  parser_version text,
  created_at timestamptz not null default now()
);
create index bank_statements_acct_idx on public.bank_statements (bank_account_id, periodo_desde);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  statement_id uuid references public.bank_statements(id) on delete cascade,
  fecha_operacion date not null,
  fecha_valor date,
  importe numeric(14,2) not null,             -- signed: negative = debit
  concepto_comun char(2),
  concepto_propio text,
  concepto_text text,
  counterparty_name_norm text,
  counterparty_iban_hmac text,
  counterparty_iban_last4 text,
  counterparty_party_id uuid references public.parties(id),
  ref1 text,
  ref2 text,
  num_documento text,
  saldo_tras numeric(14,2),
  tx_kind public.tx_kind not null default 'other',
  flags text[] not null default '{}',
  unit_id uuid references public.units(id),       -- set only through restricted.set_transaction_unit
  derrama_id uuid,
  page_id uuid references public.pages(id),
  confidence numeric(4,3) not null default 0.7,
  dedupe_key text,
  created_at timestamptz not null default now(),
  unique (bank_account_id, dedupe_key)
);
create index bank_tx_date_idx on public.bank_transactions (community_id, fecha_operacion);
create index bank_tx_amount_idx on public.bank_transactions (community_id, importe);
create index bank_tx_cp_idx on public.bank_transactions (community_id, counterparty_iban_hmac);

-- Administrator's annual accounts: the assertion of the party under review.
create table public.liquidations (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id),
  ejercicio int not null,
  periodo_desde date,
  periodo_hasta date,
  administrator_party_id uuid references public.parties(id),
  basis public.liq_basis not null default 'unknown',
  total_ingresos numeric(14,2),
  total_gastos numeric(14,2),
  resultado numeric(14,2),
  saldo_inicial numeric(14,2),
  saldo_final numeric(14,2),
  fondo_reserva_inicial numeric(14,2),
  fondo_reserva_dotacion numeric(14,2),
  fondo_reserva_disposiciones numeric(14,2),
  fondo_reserva_final numeric(14,2),
  saldo_en_poder_administrador numeric(14,2),
  deudores_total numeric(14,2),
  acreedores_pendientes numeric(14,2),
  facturas_pendientes_pago numeric(14,2),
  retenciones_pendientes numeric(14,2),
  approved_by_resolution_id uuid,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  unique (community_id, ejercicio, document_id)
);

create table public.liquidation_lines (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  liquidation_id uuid not null references public.liquidations(id) on delete cascade,
  side text not null check (side in ('ingreso', 'gasto')),
  concepto text not null,
  proveedor_text text,
  vendor_party_id uuid references public.parties(id),
  importe numeric(14,2) not null,
  presupuestado numeric(14,2),
  capitulo text,
  category_code text,
  page_id uuid references public.pages(id),
  created_at timestamptz not null default now()
);

create table public.liquidation_unit_rows (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  liquidation_id uuid not null references public.liquidations(id) on delete cascade,
  unit_id uuid references public.units(id),
  unit_label_as_shown text,
  coeficiente_pct numeric(7,4),
  cuota_ordinaria numeric(14,2),
  cuota_extraordinaria numeric(14,2),
  deuda_pendiente numeric(14,2),
  page_id uuid references public.pages(id),
  created_at timestamptz not null default now()
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id),
  tipo public.meeting_kind not null,
  fecha date not null,
  convocatoria_fecha date,
  convened_by_role text,
  lugar text,
  quorum_pct numeric(7,4),
  attendees jsonb,                             -- [{unit_label, present|represented, quota_pct}]
  cuentas_aprobadas boolean,
  presupuesto_aprobado numeric(14,2),
  firma_presidente boolean,
  firma_secretario boolean,
  fecha_firma date,
  fecha_notificacion date,
  notice_days int generated always as (case when convocatoria_fecha is not null then fecha - convocatoria_fecha end) stored,
  signed_within_5d boolean generated always as (case when fecha_firma is not null then fecha_firma - fecha <= 5 end) stored,
  sent_within_10d boolean generated always as (case when fecha_notificacion is not null then fecha_notificacion - fecha <= 10 end) stored,
  entry_source public.entry_source not null default 'extraction',
  seed_verified_by uuid,
  seed_verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (community_id, fecha, tipo)
);

create table public.resolutions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  punto text,
  texto_literal text not null,
  kind public.resolution_kind not null default 'other',
  resultado public.resolution_result not null default 'aprobado',
  votos jsonb,                                 -- {favor, contra, abstencion, quotas_favor_pct, quotas_total_pct, voters}
  quotas_favor_pct numeric(7,4),
  voters_favor int,
  voters_total int,
  importe_aprobado numeric(14,2),
  tolerance_pct numeric(6,3),
  vendor_party_id uuid references public.parties(id),
  works_package_id uuid references public.works_packages(id),
  delegation_to_role text,
  delegation_scope text,
  delegation_cap numeric(14,2),
  cap_explicit boolean,
  challenge_3m_until date,
  challenge_12m_until date,
  page_id uuid references public.pages(id),
  page_no int,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now()
);
alter table public.office_terms add constraint office_terms_resolution_fk foreign key (source_resolution_id) references public.resolutions(id);
alter table public.liquidations add constraint liquidations_resolution_fk foreign key (approved_by_resolution_id) references public.resolutions(id);

-- challenge windows follow the notification date (or the meeting date when unknown, flagged)
create or replace function public.resolutions_windows()
returns trigger language plpgsql as $$
declare base date;
begin
  select coalesce(m.fecha_notificacion, m.fecha) into base from public.meetings m where m.id = new.meeting_id;
  new.challenge_3m_until := base + interval '3 months';
  new.challenge_12m_until := base + interval '12 months';
  return new;
end $$;
create trigger t_resolutions_windows before insert or update on public.resolutions for each row execute function public.resolutions_windows();

create table public.derramas (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  resolution_id uuid references public.resolutions(id),
  objeto text not null,
  works_package_id uuid references public.works_packages(id),
  importe_total numeric(14,2),
  criterio public.derrama_criterio not null default 'coeficiente',
  per_unit_amount numeric(14,2),
  starts_on date,
  ends_on date,
  months int,
  target_account_id uuid references public.bank_accounts(id),
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now()
);
alter table public.bank_transactions add constraint bank_tx_derrama_fk foreign key (derrama_id) references public.derramas(id);

create table public.derrama_ledger (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  derrama_id uuid not null references public.derramas(id) on delete cascade,
  unit_id uuid not null references public.units(id),
  period date not null,                        -- first day of month
  expected numeric(14,2) not null,
  paid numeric(14,2) not null default 0,
  bank_transaction_id uuid references public.bank_transactions(id),
  liquidation_unit_row_id uuid references public.liquidation_unit_rows(id),
  basis public.ledger_basis not null default 'assertion',
  status public.ledger_status not null default 'expected',
  created_at timestamptz not null default now(),
  unique (derrama_id, unit_id, period)
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id),
  kind public.contract_kind not null,
  vendor_party_id uuid references public.parties(id),
  works_package_id uuid references public.works_packages(id),
  fecha_firma date,
  community_signer_role text,
  precio_sin_iva numeric(14,2),
  iva_pct numeric(5,2),
  precio_con_iva numeric(14,2),
  es_precio_cerrado boolean,
  inicio date,
  duracion text,
  fin_previsto date,
  penalizaciones jsonb,
  retencion_pct numeric(5,2),
  garantia_meses int,
  permanencia_meses int,
  revision_precios text,
  licencia_a_cargo_de text,
  prl_cae_mencion boolean,
  counterparty_matches_invoicing_entity boolean,
  quote_document_id uuid references public.documents(id),
  authorised_by_resolution_id uuid references public.resolutions(id),
  upfront_max_pct numeric(5,2),
  elevator_spec jsonb,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now()
);

create table public.contract_milestones (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  seq int not null,
  hito text not null,
  pct numeric(6,3),
  importe numeric(14,2),
  condicion text,
  fecha_prevista date,
  is_advance boolean not null default false,
  matched_invoice_id uuid,
  matched_tx_id uuid references public.bank_transactions(id),
  status public.milestone_status not null default 'pending',
  unique (contract_id, seq)
);

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id),
  resolution_id uuid references public.resolutions(id),
  lender_party_id uuid references public.parties(id),
  principal numeric(14,2),
  disbursed_on date,
  disbursement_tx_id uuid references public.bank_transactions(id),
  destination_iban_hmac text,
  paid_to_is_community boolean,
  amortisation jsonb,                          -- [{date, amount}]
  works_package_id uuid references public.works_packages(id),
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now()
);

create table public.subsidies (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id),
  resolution_id uuid references public.resolutions(id),
  programa text,
  expedient text,
  estat public.subsidy_status not null default 'unknown',
  pressupost_protegible numeric(14,2),
  pct numeric(6,3),
  import_atorgat numeric(14,2),
  import_pagat numeric(14,2),
  compte_desti_hmac text,
  paid_to_is_community boolean,
  bdns_id text,
  shown_in_liquidation_line_id uuid references public.liquidation_lines(id),
  received_bank_tx_id uuid references public.bank_transactions(id),
  works_package_id uuid references public.works_packages(id),
  three_quotes_present boolean,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  vendor_party_id uuid references public.parties(id),
  serie text,
  numero text,
  numero_int bigint,
  fecha_expedicion date,
  fecha_operacion date,
  recipient_name text,
  recipient_nif text,
  recipient_matches_community boolean,
  base_imponible numeric(14,2),
  iva_total numeric(14,2),
  retencion_irpf_pct numeric(5,2),
  retencion_irpf_importe numeric(14,2),
  suplidos numeric(14,2),
  total numeric(14,2),
  forma_pago text,
  iban_shown_hmac text,
  iban_shown_last4 text,
  vencimiento date,
  es_simplificada boolean not null default false,
  es_rectificativa boolean not null default false,
  rectifica_invoice_id uuid references public.invoices(id),
  mencion_isp boolean,
  mencion_materiales_40 boolean,
  verifactu_qr boolean,
  referencia_presupuesto text,
  referencia_obra text,
  works_package_id uuid references public.works_packages(id),
  category_code text,
  arithmetic_ok boolean,
  is_extra boolean not null default false,
  created_at timestamptz not null default now(),
  unique (document_id)
);
create index invoices_vendor_idx on public.invoices (community_id, vendor_party_id, fecha_expedicion);
create index invoices_total_idx on public.invoices (community_id, total);
alter table public.contract_milestones add constraint contract_milestones_invoice_fk foreign key (matched_invoice_id) references public.invoices(id);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  orden int not null,
  codigo text,
  descripcion text not null,
  cantidad numeric(14,4),
  unidad text,
  precio_unitario numeric(14,4),
  descuento_pct numeric(6,3),
  base numeric(14,2),
  tipo_iva_pct numeric(5,2),
  cuota_iva numeric(14,2),
  total_linea numeric(14,2),
  es_manuscrito boolean not null default false,
  es_partida_alzada boolean not null default false,
  is_extra boolean not null default false,
  element_scope text check (element_scope in ('common', 'private_unit', 'unknown')) default 'unknown',
  unit_hint text,
  category_code text,
  category_conf numeric(4,3),
  category_override text,
  page_id uuid references public.pages(id),
  unique (invoice_id, orden)
);

create table public.invoice_vat_summary (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  base numeric(14,2) not null,
  tipo_pct numeric(5,2) not null,
  cuota numeric(14,2) not null
);

-- Timeline of a works package (materialised by the rules engine).
create table public.works_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  works_package_id uuid not null references public.works_packages(id) on delete cascade,
  event_type public.works_event_type not null,
  event_date date,
  ref_type text,
  ref_id uuid,
  amount numeric(14,2),
  seq_ok boolean,
  violation_text text,
  suspension_reason public.suspension_reason,
  engine_version text,
  created_at timestamptz not null default now()
);
create index works_events_pkg_idx on public.works_events (works_package_id, event_date);

-- Generic reconciliation links.
create table public.recon_links (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  from_type text not null,
  from_id uuid not null,
  to_type text not null,
  to_id uuid not null,
  link_type public.link_type not null,
  method public.link_method not null,
  score numeric(4,3) not null default 0,
  amount_matched numeric(14,2),
  status public.link_status not null default 'proposed',
  decided_by uuid,
  decided_at timestamptz,
  engine_version text,
  created_at timestamptz not null default now(),
  unique (from_type, from_id, to_type, to_id, link_type)
);
create index recon_links_from_idx on public.recon_links (from_type, from_id);
create index recon_links_to_idx on public.recon_links (to_type, to_id);

-- Statutory clock of the owners' request for an extraordinary meeting.
create table public.request_clock (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  request_date date,
  request_evidence_document_id uuid references public.documents(id),
  quotas_pct_requesting numeric(7,4),
  units_requesting int,
  convocation_date date,
  junta_date date,
  notice_days int generated always as (case when convocation_date is not null and junta_date is not null then junta_date - convocation_date end) stored,
  docs_available_from date,
  status text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_request_clock_touch before update on public.request_clock for each row execute function public.touch_updated_at();

create table public.document_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  class public.request_class not null,
  fiscal_year int,
  description text,
  requested_on date,
  requested_via text,
  request_evidence_file_id uuid references public.files(id),
  received_on date,
  received_file_ids uuid[] not null default '{}',
  response_evidence_file_id uuid references public.files(id),
  status public.request_status not null default 'planned',
  legal_basis text,
  finding_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_document_requests_touch before update on public.document_requests for each row execute function public.touch_updated_at();
create index document_requests_idx on public.document_requests (community_id, class, fiscal_year);
