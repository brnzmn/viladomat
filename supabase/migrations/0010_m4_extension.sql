-- 0010_m4_extension.sql
-- M4 extension: quotes, work certifications, permits, subsidy detail, recurring services and
-- insurance, the benchmark register (categories, sources, records, index series), expected
-- prices, calibration and golden set, rule precision, external checks, officers and party links.
--
-- Conventions follow 0001-0009: uuid pks, `community_id` on every community-scoped table,
-- money numeric(14,2), RLS through public.install_policies(tbl, mode), append-only enforced by
-- public.forbid_change(), updated_at by public.touch_updated_at().
--
-- Wording is neutral throughout: these tables hold transcribed figures and computed
-- expectations; a difference between them is a discrepancy to verify, never a conclusion.

-- ---------------------------------------------------------------------------
-- 1. Quotes (presupuestos) and their partidas
-- ---------------------------------------------------------------------------
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  vendor_party_id uuid references public.parties(id),
  works_package_id uuid references public.works_packages(id),
  numero text,
  version int not null default 1,               -- successive versions of the same quote
  fecha date,
  validez_dias int,
  pem numeric(14,2),                            -- presupuesto de ejecución material
  gastos_generales_pct numeric(6,3),
  gastos_generales_importe numeric(14,2),
  beneficio_industrial_pct numeric(6,3),
  beneficio_industrial_importe numeric(14,2),
  presupuesto_contrata_sin_iva numeric(14,2),   -- PEC = PEM + GG + BI
  iva_pct numeric(5,2),
  total_con_iva numeric(14,2),
  condiciones_pago text,
  plazo_ejecucion text,
  exclusiones text[] not null default '{}',
  firmado_por_comunidad boolean,
  accepted boolean not null default false,
  accepted_on date,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_quotes_touch before update on public.quotes for each row execute function public.touch_updated_at();
create index quotes_pkg_idx on public.quotes (community_id, works_package_id, fecha);
create index quotes_vendor_idx on public.quotes (community_id, vendor_party_id, fecha);
create index quotes_document_idx on public.quotes (document_id);
comment on table public.quotes is 'Quotes (presupuestos) as transcribed; the CONTRACT layer of the expected-price engine reads accepted quotes and contracts.';

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  orden int not null,
  chapter text,                                 -- capítulo / capítol
  code text,                                    -- partida code as printed
  descripcion text not null,
  cantidad numeric(14,4),
  unidad text,
  precio_unitario numeric(14,4),
  importe numeric(14,2),
  es_partida_alzada boolean not null default false,
  category_code text,                           -- taxonomy code; see public.benchmark_categories
  category_conf numeric(4,3),
  page_id uuid references public.pages(id),
  created_at timestamptz not null default now(),
  unique (quote_id, orden)
);
create index quote_items_category_idx on public.quote_items (community_id, category_code);
create index quote_items_code_idx on public.quote_items (quote_id, code);
create index quote_items_desc_trgm_idx on public.quote_items using gin (descripcion gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. Work certifications (certificaciones de obra) and their items
-- ---------------------------------------------------------------------------
create table public.work_certifications (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  contract_id uuid references public.contracts(id),
  works_package_id uuid references public.works_packages(id),
  numero_certificacion int,
  periodo_desde date,
  periodo_hasta date,
  fecha date,
  contractor_party_id uuid references public.parties(id),
  direccion_facultativa_present boolean,        -- signature of the site direction on the sheet
  total_a_origen numeric(14,2),
  total_anterior numeric(14,2),
  total_actual numeric(14,2),
  retencion_garantia_pct numeric(5,2),
  retencion_garantia_importe numeric(14,2),
  iva_pct numeric(5,2),
  liquido_a_pagar numeric(14,2),
  firmas jsonb,                                 -- [{role, present, page_id}]
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, numero_certificacion)
);
create trigger t_work_certifications_touch before update on public.work_certifications for each row execute function public.touch_updated_at();
create index work_certifications_pkg_idx on public.work_certifications (community_id, works_package_id, fecha);
create index work_certifications_contract_idx on public.work_certifications (contract_id, numero_certificacion);

create table public.work_certification_items (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  certification_id uuid not null references public.work_certifications(id) on delete cascade,
  orden int not null,
  code text,
  descripcion text not null,
  unidad text,
  cantidad_contrato numeric(14,4),
  precio_unitario numeric(14,4),
  importe_contrato numeric(14,2),
  cantidad_a_origen numeric(14,4),
  importe_a_origen numeric(14,2),
  importe_anterior numeric(14,2),
  importe_actual numeric(14,2),
  pct_ejecutado numeric(7,3),
  quote_item_id uuid references public.quote_items(id),
  category_code text,
  page_id uuid references public.pages(id),
  created_at timestamptz not null default now(),
  unique (certification_id, orden)
);
create index work_cert_items_quote_item_idx on public.work_certification_items (quote_item_id);

-- ---------------------------------------------------------------------------
-- 3. Permits, municipal taxes and building-inspection filings
-- ---------------------------------------------------------------------------
create table public.permits (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  works_package_id uuid references public.works_packages(id),
  expedient_no text,
  tipus text not null check (tipus in (
    'assabentat', 'comunicat_immediat', 'comunicat_diferit', 'llicencia',
    'autoliquidacio_icio', 'iit', 'ite', 'altre')),
  data_presentacio date,
  data_resolucio date,
  pem_declarat numeric(14,2),
  icio_base numeric(14,2),
  icio_pct numeric(6,3),
  icio_quota numeric(14,2),
  icio_bonificacio_pct numeric(6,3),
  taxa numeric(14,2),
  icio_bank_tx_id uuid references public.bank_transactions(id),
  condicions_patrimoni text,                    -- heritage conditions stated in the resolution
  tecnic_collegi text,                          -- professional body reference of the signing technician
  iit_referencia text,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_permits_touch before update on public.permits for each row execute function public.touch_updated_at();
create index permits_pkg_idx on public.permits (community_id, works_package_id, data_presentacio);
create index permits_tipus_idx on public.permits (community_id, tipus);
create unique index permits_expedient_idx on public.permits (community_id, expedient_no) where expedient_no is not null;

-- ---------------------------------------------------------------------------
-- 4. Subsidy detail columns (the header table exists since 0003)
-- ---------------------------------------------------------------------------
alter table public.subsidies add column if not exists programa_bases_source_id text;
alter table public.subsidies add column if not exists justificacio_presentada boolean;
alter table public.subsidies add column if not exists three_quotes_source text;
comment on column public.subsidies.programa_bases_source_id is 'Id in public.legal_sources or public.benchmark_sources of the archived call bases the thresholds were read from.';
comment on column public.subsidies.three_quotes_source is 'Where the three-quotes requirement comes from (call bases article, internal control, or unknown).';

-- ---------------------------------------------------------------------------
-- 5. Recurring services and insurance policies
-- ---------------------------------------------------------------------------
create table public.recurring_services (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  category_code text,
  vendor_party_id uuid references public.parties(id),
  label text not null,
  started_on date,
  ended_on date,
  monthly_amount_first numeric(14,2),
  monthly_amount_last numeric(14,2),
  contract_document_id uuid references public.documents(id),
  permanencia_meses int,
  notes text,
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_recurring_services_touch before update on public.recurring_services for each row execute function public.touch_updated_at();
create index recurring_services_idx on public.recurring_services (community_id, category_code, vendor_party_id);
comment on table public.recurring_services is 'Recurring service relationships; the HISTORY layer of the expected-price engine weights these more when no contract is on file.';

create table public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  insurer_party_id uuid references public.parties(id),
  policy_number text,
  coverage_summary text,
  premium_annual numeric(14,2),
  valid_from date,
  valid_to date,
  document_id uuid references public.documents(id),
  entry_source public.entry_source not null default 'extraction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_insurance_policies_touch before update on public.insurance_policies for each row execute function public.touch_updated_at();
create unique index insurance_policies_number_idx on public.insurance_policies (community_id, policy_number, valid_from) where policy_number is not null;

-- ---------------------------------------------------------------------------
-- 6. Benchmark register (global reference data, no community_id)
-- ---------------------------------------------------------------------------
create table public.benchmark_categories (
  code text primary key,
  label_es text not null,
  label_ca text,
  label_en text not null,
  keywords_es text[] not null default '{}',
  keywords_ca text[] not null default '{}',
  unit text,
  layers text[] not null default '{}',          -- C contract, B budget, K benchmark, H history
  comparable_default boolean not null default true,
  notes text
);
comment on table public.benchmark_categories is 'Line taxonomy of docs/taxonomy.md: the code decides which expected-price layers apply and which unit a quantity is converted to.';
comment on column public.benchmark_categories.comparable_default is 'false marks a category as non-benchmarkable in v1: the BENCHMARK layer is skipped and the report prints "no comparable benchmark".';

-- Seed: the 43 categories of docs/taxonomy.md (kept identical to packages/core/src/taxonomy/categories.ts).
insert into public.benchmark_categories
  (code, label_es, label_ca, label_en, keywords_es, keywords_ca, unit, layers, comparable_default, notes)
values
  ('ELEV_INSTALL', 'Instalación de ascensor (equipo)', 'Instal·lació d''ascensor (equip)', 'Lift installation (equipment)',
   array['instalación ascensor', 'elevador', 'montaje', 'cabina', 'maquinaria', 'paradas'],
   array['instal·lació ascensor', 'muntatge', 'cabina', 'parades'],
   'ud', array['C', 'B'], false, 'No comparable reference in v1 for a lift inserted into a protected pre-1965 stairwell; CONTRACT and BUDGET layers only.'),
  ('ELEV_CIVIL', 'Obra civil de ascensor', 'Obra civil d''ascensor', 'Lift civil works',
   array['obra civil ascensor', 'hueco', 'foso', 'estructura metálica', 'cerramiento', 'recorte forjado'],
   array['forat', 'fossat', 'estructura metàl·lica', 'tancament', 'retall forjat'],
   'ud', array['C', 'B'], false, 'Non-benchmarkable in v1 (see ELEV_INSTALL).'),
  ('ELEV_MAINT', 'Mantenimiento de ascensor', 'Manteniment d''ascensor', 'Lift maintenance',
   array['mantenimiento ascensor', 'conservación', 'todo riesgo', 'semi integral', 'cuota mensual'],
   array['manteniment', 'conservació', 'tot risc'],
   'mes', array['C', 'K', 'H'], true, 'Visit periodicity from RD 355/2024 (ITC AEM 1) drives the expected number of invoices per year.'),
  ('ELEV_INSPECT', 'Inspección periódica de ascensor', 'Inspecció periòdica d''ascensor', 'Lift periodic inspection',
   array['inspección periódica', 'OCA', 'organismo de control', 'revisión reglamentaria'],
   array['inspecció periòdica', 'organisme de control'],
   'ud', array['K', 'H'], true, 'Paid to the inspection body, not to the maintainer.'),
  ('ELEV_TELECOM', 'Línea telefónica de ascensor', 'Línia telefònica d''ascensor', 'Lift phone / GSM line',
   array['línea telefónica ascensor', 'GSM', 'telealarma', 'rescate'],
   array['línia telefònica', 'telealarma', 'rescat'],
   'mes', array['C', 'H'], true, null),
  ('FACADE_REHAB', 'Rehabilitación de fachada', 'Rehabilitació de façana', 'Façade rehabilitation',
   array['fachada', 'revoco', 'estuco', 'grietas', 'hidrofugante', 'pintura exterior'],
   array['façana', 'arrebossat', 'estuc', 'esquerdes', 'hidrofugant'],
   'm2', array['C', 'B', 'K'], true, 'Heritage conditions and rear-façade access widen the band.'),
  ('BALCONY', 'Balcones: losa y barandilla', 'Balcons: llosa i barana', 'Balcony slab and railing',
   array['balcón', 'losa', 'canto forjado', 'voladizo', 'barandilla', 'armadura'],
   array['balcó', 'cantell', 'volada', 'barana', 'armadura'],
   'ml', array['C', 'B', 'K'], true, null),
  ('SCAFFOLD', 'Andamios', 'Bastides', 'Scaffolding',
   array['andamio', 'montaje y desmontaje', 'alquiler mensual', 'ocupación vía pública', 'lona'],
   array['bastida', 'muntatge', 'lloguer', 'lona'],
   'm2·mes', array['C', 'K'], true, null),
  ('ROOF', 'Cubierta o terrado', 'Coberta o terrat', 'Roof / terrace',
   array['cubierta', 'terrado', 'azotea', 'impermeabilización', 'tela asfáltica', 'claraboya', 'lucernario'],
   array['coberta', 'terrat', 'impermeabilització', 'claraboia'],
   'm2', array['C', 'B', 'K'], true, null),
  ('STAIR_REHAB', 'Rehabilitación de escalera', 'Rehabilitació d''escala', 'Staircase rehabilitation',
   array['escalera', 'peldaños', 'huella', 'pasamanos', 'barandilla', 'mármol', 'terrazo'],
   array['escala', 'graons', 'passamà', 'barana', 'marbre', 'terratzo'],
   'ud', array['C', 'B'], false, 'Non-benchmarkable in v1 for a protected pre-1965 stairwell.'),
  ('PAINT_INT', 'Pintura interior de zonas comunes', 'Pintura interior de zones comunes', 'Interior painting (common areas)',
   array['pintura', 'pintar', 'plástica', 'esmalte', 'vestíbulo', 'rellano', 'techos'],
   array['pintura', 'pintar', 'vestíbul', 'replà', 'sostres'],
   'm2', array['C', 'B', 'K'], true, null),
  ('ENTRANCE_DOOR', 'Puerta de entrada', 'Porta d''entrada', 'Entrance door',
   array['puerta entrada', 'portal', 'puerta acceso', 'cierrapuertas', 'muelle', 'cerradura'],
   array['porta d''entrada', 'portal', 'tancaportes', 'pany'],
   'ud', array['C', 'B', 'K'], true, 'A protected ensemble may require restoration instead of replacement.'),
  ('INTERCOM', 'Videoportero o portero automático', 'Videoporter o porter electrònic', 'Video-entry / intercom',
   array['videoportero', 'portero automático', 'placa de calle', 'monitor', 'telefonillo'],
   array['videoporter', 'porter electrònic', 'placa de carrer', 'monitor'],
   'ud', array['C', 'B', 'K'], true, 'Check element_scope: the same words describe private-unit works.'),
  ('WINDOWS', 'Ventanas de elementos comunes', 'Finestres d''elements comuns', 'Windows (common elements)',
   array['ventana', 'carpintería aluminio', 'RPT', 'vidrio', 'climalit', 'persiana'],
   array['finestra', 'fusteria d''alumini', 'vidre', 'persiana'],
   'ud', array['C', 'B', 'K'], true, 'Check element_scope (rule C11).'),
  ('LOCKSMITH', 'Cerrajería', 'Serralleria', 'Locksmith',
   array['cerrajería', 'llaves', 'amaestramiento', 'copias', 'bombín'],
   array['serralleria', 'claus', 'còpies', 'bombí'],
   'ud', array['K', 'H'], true, null),
  ('ELECTRICAL', 'Instalación eléctrica e iluminación menor', 'Instal·lació elèctrica i enllumenat menor', 'Electrical installation and minor lighting',
   array['instalación eléctrica', 'cuadro', 'luminaria', 'LED', 'detector', 'emergencia', 'boletín', 'bombilla', 'fluorescente', 'temporizador'],
   array['instal·lació elèctrica', 'quadre', 'lluminària', 'detector', 'emergència', 'butlletí', 'bombeta', 'fluorescent', 'temporitzador'],
   'ud', array['C', 'H', 'K'], true, null),
  ('PLUMB_SEWER', 'Saneamiento, bajantes y desagües', 'Sanejament, baixants i desguassos', 'Sewer, downpipes, drains',
   array['colector', 'bajante', 'albañal', 'desatasco', 'arqueta', 'saneamiento', 'alcantarillado', 'cámara'],
   array['col·lector', 'baixant', 'clavegueró', 'desembús', 'arqueta', 'sanejament', 'càmera'],
   'ml', array['C', 'B', 'K'], true, null),
  ('WATER_SUPPLY', 'Instalación de agua', 'Instal·lació d''aigua', 'Water supply installation',
   array['tubería agua', 'batería contadores', 'grupo presión', 'montante', 'fuga'],
   array['canonada d''aigua', 'bateria de comptadors', 'grup de pressió', 'muntant', 'fuita'],
   'ud', array['C', 'H'], true, null),
  ('MASONRY', 'Albañilería y obra menor', 'Paleteria i obra menor', 'Masonry and minor works',
   array['albañilería', 'obra menor', 'reparación', 'humedades', 'yeso', 'tabique'],
   array['paleteria', 'obra menor', 'reparació', 'humitats', 'guix', 'envà'],
   'm2', array['C', 'K'], true, null),
  ('ARCH_PROJECT', 'Proyecto de arquitectura', 'Projecte d''arquitectura', 'Architect project',
   array['proyecto básico y ejecución', 'memoria', 'planos', 'visado', 'arquitecto'],
   array['projecte bàsic i d''execució', 'memòria', 'plànols', 'visat', 'arquitecte'],
   '% PEM', array['C', 'K'], true, 'Reference fee scales were abolished; the trade ratio supports severity 1 only.'),
  ('ARCH_DO', 'Dirección de obra', 'Direcció d''obra', 'Site direction',
   array['dirección de obra', 'dirección de ejecución', 'aparejador', 'certificación', 'visita de obra'],
   array['direcció d''obra', 'direcció d''execució', 'aparellador', 'certificació', 'visita d''obra'],
   '% PEM', array['C', 'K'], true, null),
  ('HS_COORD', 'Coordinación de seguridad y salud', 'Coordinació de seguretat i salut', 'Health and safety coordination',
   array['coordinación seguridad y salud', 'estudio básico', 'plan de seguridad'],
   array['coordinació de seguretat i salut', 'estudi bàsic', 'pla de seguretat'],
   '% PEM', array['C', 'K'], true, null),
  ('ITE', 'Inspección técnica del edificio', 'Inspecció tècnica de l''edifici', 'Technical building inspection',
   array['inspección técnica edificio', 'ITE', 'IITE', 'certificado aptitud'],
   array['inspecció tècnica de l''edifici', 'ITE', 'IITE', 'certificat aptitud'],
   'ud', array['K'], true, null),
  ('PERMITS', 'Licencias y tasas municipales', 'Llicències i taxes municipals', 'Municipal permits and taxes',
   array['licencia', 'comunicado', 'ICIO', 'tasa', 'autoliquidación', 'Ajuntament', 'ocupación vía pública'],
   array['llicència', 'comunicat', 'ICIO', 'taxa', 'autoliquidació', 'Ajuntament', 'ocupació via pública'],
   '% PEM', array['K'], true, 'Official tier: municipal fiscal ordinances 2.1 and 3.3, edition by year.'),
  ('SUBSIDY', 'Subvenciones: gestión e ingresos', 'Subvencions: gestió i ingressos', 'Subsidy processing and income',
   array['subvención', 'Consorci', 'ayudas', 'gestión expediente', 'informe'],
   array['subvenció', 'Consorci', 'ajuts', 'gestió d''expedient'],
   '% eligible', array['B', 'K'], true, 'Official tier: the call caps are absolute amounts, not unit prices.'),
  ('ADMIN_FEE', 'Honorarios de administración', 'Honoraris d''administració', 'Administrator fees',
   array['honorarios administración', 'cuota administración', 'gestión'],
   array['honoraris d''administració', 'quota d''administració', 'gestió'],
   '€/unit·mes', array['C', 'H', 'K'], true, 'Research packs disagree on the Barcelona range; severity capped at 2 (rule D9).'),
  ('ADMIN_EXTRA', 'Extras de administración', 'Extres d''administració', 'Administrator extras',
   array['junta extraordinaria', 'certificado deuda', 'convocatoria', 'burofax', 'fotocopias', 'correo'],
   array['junta extraordinària', 'certificat de deute', 'convocatòria', 'burofax', 'fotocòpies', 'correu'],
   'ud', array['C', 'H', 'K'], true, null),
  ('INSURANCE', 'Seguro de la comunidad', 'Assegurança de la comunitat', 'Community insurance',
   array['seguro', 'póliza', 'prima', 'recibo', 'siniestro', 'franquicia'],
   array['assegurança', 'pòlissa', 'prima', 'rebut', 'sinistre', 'franquícia'],
   'any', array['C', 'H', 'K'], true, null),
  ('CLEANING', 'Limpieza', 'Neteja', 'Cleaning',
   array['limpieza', 'escalera', 'portal', 'cristales'],
   array['neteja', 'escala', 'portal', 'vidres'],
   'mes', array['C', 'H', 'K'], true, null),
  ('ELECTRICITY', 'Suministro eléctrico', 'Subministrament elèctric', 'Electricity utility',
   array['electricidad', 'luz', 'kWh', 'potencia', 'término fijo'],
   array['electricitat', 'llum', 'kWh', 'potència', 'terme fix'],
   'mes', array['H'], true, 'Benchmark on kWh and tariff, not on an indexed euro amount.'),
  ('WATER_UTIL', 'Suministro de agua', 'Subministrament d''aigua', 'Water utility',
   array['agua', 'm3', 'canon', 'consumo'],
   array['aigua', 'm3', 'cànon', 'consum'],
   'm3', array['H'], true, null),
  ('CAE_PRL', 'Coordinación de actividades empresariales y PRL', 'Coordinació d''activitats empresarials i PRL', 'Contractor coordination / risk prevention',
   array['coordinación actividades empresariales', 'CAE', 'PRL', 'prevención riesgos', 'plataforma'],
   array['coordinació d''activitats empresarials', 'CAE', 'PRL', 'prevenció de riscos'],
   'any', array['C', 'H', 'K'], true, null),
  ('LEGAL', 'Servicios jurídicos y notariales', 'Serveis jurídics i notarials', 'Legal and notarial',
   array['abogado', 'procurador', 'demanda', 'reclamación', 'morosos', 'notaría', 'registro'],
   array['advocat', 'procurador', 'demanda', 'reclamació', 'morosos', 'notaria', 'registre'],
   'h', array['C', 'H'], true, null),
  ('BANK', 'Comisiones bancarias y servicio de préstamo', 'Comissions bancàries i servei de préstec', 'Bank fees and loan service',
   array['comisión', 'mantenimiento cuenta', 'transferencia', 'préstamo', 'interés', 'amortización', 'aval'],
   array['comissió', 'manteniment de compte', 'transferència', 'préstec', 'interès', 'amortització', 'aval'],
   'mes', array['C', 'H'], true, null),
  ('WASTE', 'Residuos y contenedores', 'Residus i contenidors', 'Waste and containers',
   array['contenedor', 'escombros', 'saca', 'gestión residuos', 'vertedero'],
   array['contenidor', 'runa', 'saca', 'gestió de residus', 'abocador'],
   'ud', array['C', 'K'], true, null),
  ('PEST', 'Control de plagas', 'Control de plagues', 'Pest control',
   array['desinsectación', 'desratización', 'plagas'],
   array['desinsectació', 'desratització', 'plagues'],
   'ud', array['C', 'H'], true, null),
  ('FIRE', 'Protección contra incendios', 'Protecció contra incendis', 'Fire safety',
   array['extintor', 'retimbrado', 'BIE', 'señalización'],
   array['extintor', 'retimbrat', 'BIE', 'senyalització'],
   'ud', array['C', 'H'], true, null),
  ('TELECOM', 'Antena y telecomunicaciones', 'Antena i telecomunicacions', 'Aerial and telecoms',
   array['antena', 'TDT', 'amplificador', 'fibra', 'ICT'],
   array['antena', 'TDT', 'amplificador', 'fibra', 'ICT'],
   'ud', array['C', 'H'], true, null),
  ('GAS', 'Instalación de gas', 'Instal·lació de gas', 'Gas installation',
   array['gas', 'revisión', 'instalación receptora'],
   array['gas', 'revisió', 'instal·lació receptora'],
   'ud', array['C', 'H'], true, null),
  ('FUND_RESERVE', 'Fondo de reserva', 'Fons de reserva', 'Reserve fund',
   array['fondo de reserva', 'dotación'],
   array['fons de reserva', 'dotació'],
   'any', array['B'], true, 'Budget layer only: at least 5% of the ordinary budget (CCCat 553-6, to verify).'),
  ('DERRAMA', 'Derrama o cuota extraordinaria', 'Derrama o quota extraordinària', 'Extraordinary contribution',
   array['derrama', 'cuota extraordinaria', 'aportación obras'],
   array['derrama', 'quota extraordinària', 'aportació obres'],
   'unit·mes', array['B'], true, 'Expectation computed by D5/D5b, not by a price benchmark.'),
  ('MISC', 'Sin clasificar', 'Sense classificar', 'Unclassified',
   array['varios', 'otros', 'imprevistos', 'material', 'ferretería'],
   array['altres', 'imprevistos', 'material', 'ferreteria'],
   null, '{}', false, 'Goes to the review queue; no layer applies until reclassified.'),
  ('ASBESTOS', 'Retirada de amianto', 'Retirada d''amiant', 'Asbestos removal',
   array['amianto', 'uralita', 'fibrocemento', 'desamiantado', 'plan de trabajo'],
   array['amiant', 'uralita', 'fibrociment', 'desamiantat', 'pla de treball'],
   'ml', array['C', 'K'], true, 'Registry check under rules G5/G6.');

create table public.benchmark_sources (
  id text primary key,                          -- BS-01 … as in docs/benchmark-sources.md
  name text not null,
  tier text not null check (tier in ('official', 'semi_official', 'trade', 'own_history')),
  url text,
  access_method text,                           -- manual | api | purchase | internal
  licence_note text,
  evidence_file_id uuid references public.files(id),
  verified_at timestamptz,                      -- null until the archived copy has been checked
  notes text
);
comment on table public.benchmark_sources is 'Register of benchmark sources. Tier sets the weight in the expected-price engine and the ceiling on severity: a trade-tier source alone never yields MATERIAL. verified_at stays null until the archived PDF/JSON is in Storage.';

-- Register rows only: identifiers, names, tier and access. No prices are seeded here; every
-- figure enters through public.benchmark_records with an archived evidence file.
insert into public.benchmark_sources (id, name, tier, url, access_method, licence_note, notes) values
('BS-01', 'Ajuntament de Barcelona, Ordenança fiscal 2.1 (ICIO), editions 2021-2026', 'official', 'ajuntament.barcelona.cat/hisenda', 'manual', 'official publication; reuse with attribution', 'Rate on the PEM and bonuses by year; research packs disagree on the rate, so it is stored per year and flagged to verify.'),
('BS-02', 'Ajuntament de Barcelona, Ordenança fiscal 3.3 (taxa de serveis urbanistics)', 'official', 'ajuntament.barcelona.cat/hisenda', 'manual', 'official publication', 'Fee for major-works licences and comunicats; amounts to read from the edition in force.'),
('BS-03', 'Consorci de l''Habitatge de Barcelona, accessibility call 2024-2026', 'official', 'consorcihabitatge.barcelona', 'manual', 'official publication', 'Percentage and caps of the call; packs disagree, and the composition of the eligible budget is unconfirmed.'),
('BS-04', 'Consorci de l''Habitatge de Barcelona, common-elements call 2025', 'official', 'consorcihabitatge.barcelona', 'manual', 'official publication', 'Percentage, caps and documentary requirements of the call.'),
('BS-05', 'RD 853/2021 Programa 3, Barcelona call (DOGC 2022)', 'official', 'portaldogc.gencat.cat', 'manual', 'official publication', 'Closed at the end of 2023; relevant only if an application exists.'),
('BS-06', 'RD 355/2024 (ITC AEM 1)', 'official', 'boe.es', 'manual', 'official publication', 'Not a price: maintenance-visit and inspection periodicity, which drives the expected count of maintenance invoices per year.'),
('BS-07', 'CYPE Generador de Precios (rehabilitacion)', 'semi_official', 'generadordeprecios.info', 'manual', 'free after registration; terms of reuse to verify', 'National prices; a Barcelona factor applies. Lift partidas are not comparable to a lift in a protected pre-1965 stairwell.'),
('BS-08', 'ITeC BEDEC (Banc Estructurat de Dades d''Elements Constructius)', 'official', 'itec.cat', 'purchase', 'commercial licence; citation terms to verify', 'Barcelona labour basis, annual editions with an edition-to-edition variation table. Captured in M8.'),
('BS-09', 'INE Tempus3 API - IPC (Spain and Catalonia)', 'official', 'servicios.ine.es/wstempus/js/ES/DATOS_SERIE', 'api', 'INE open data', 'Base changed with the January 2026 release; store the base and rebase when chaining.'),
('BS-10', 'Idescat IPC and API', 'official', 'idescat.cat/pub/?id=ipc', 'api', 'open data', 'Endpoint and licence to verify before wiring.'),
('BS-11', 'INE materials and labour indices; IPCO; BOE price-revision Orders', 'official', 'ine.es', 'manual', 'open data', 'IPCO replaces the previous series from January 2026.'),
('BS-12', 'MITMA construction cost index', 'semi_official', 'transportes.gob.es', 'manual', 'open data', 'Entered manually with a stale-after date.'),
('BS-13', 'COAC Modul Basic', 'semi_official', 'arquitectes.cat', 'manual', 'professional body publication', 'Annual reference module; the current value was not obtained during research.'),
('BS-14', 'Architect fee ratios (firm publications)', 'trade', 'arch.cat', 'manual', 'firm blogs', 'Reference fee scales were abolished; supports rule A11 at severity 1 only.'),
('BS-15', 'Administrator fees, Barcelona (firm publications)', 'trade', '-', 'manual', 'firm blogs', 'Research packs disagree on the range; rule D9 is capped at severity 2.'),
('BS-16', 'Lift maintenance contracts (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'Cover level drives the figure; new lifts often include an initial period.'),
('BS-17', 'Lift periodic inspection by a control body (firm pages)', 'trade', '-', 'manual', 'firm pages', 'Paid to the inspection body, not to the maintainer.'),
('BS-18', 'Lift installation in an old Barcelona building (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'Non-benchmarkable in v1; order-of-magnitude input for the funding-gap envelope only.'),
('BS-19', 'Facade rehabilitation (guides)', 'trade', '-', 'manual', 'guides', 'Heritage conditions and access add cost.'),
('BS-20', 'Balcony slab-edge repair (Q&A and firm pages)', 'trade', '-', 'manual', 'Q&A and firm pages', 'Ranges are estimates and are flagged as such.'),
('BS-21', 'Scaffolding, Barcelona (firm pages)', 'trade', '-', 'manual', 'firm pages', 'A rear facade needs no public-way occupation fee but may need access agreements.'),
('BS-22', 'Interior painting of common areas (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'Eixample stairwell ceiling heights raise the surface per storey.'),
('BS-23', 'Staircase rehabilitation, Barcelona (firm pages)', 'trade', '-', 'manual', 'firm pages', 'Non-benchmarkable in v1 for a protected pre-1965 stairwell.'),
('BS-24', 'Entrance door (firm pages)', 'trade', '-', 'manual', 'firm pages', 'A protected ensemble may require restoration instead of replacement.'),
('BS-25', 'Video-entry system, 10-15 units (firm pages)', 'trade', '-', 'manual', 'firm pages', 'Rewiring roughly doubles the figure.'),
('BS-26', 'Aluminium RPT windows (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'Heritage-compatible profiles and large openings cost more; check element scope.'),
('BS-27', 'ITE / IITE report (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'No administratively fixed price; the certificate fee is separate.'),
('BS-28', 'Community insurance (comparison sites)', 'trade', '-', 'manual', 'comparison sites', 'Premium depends on cover and claims history.'),
('BS-29', 'Cleaning, Barcelona (firm pages)', 'trade', '-', 'manual', 'firm pages', 'Frequency drives the total.'),
('BS-30', 'CAE / PRL coordination (firm pages)', 'trade', '-', 'manual', 'firm pages', 'Platform-only and managed services are different products.'),
('BS-31', 'Electricity and water for common use (comparison sites)', 'trade', '-', 'manual', 'comparison sites', 'Benchmark on kWh and tariff, not on an indexed euro amount.'),
('BS-32', 'Sewer, collector and downpipe works (marketplaces)', 'trade', '-', 'manual', 'marketplaces', 'Camera inspection usually precedes the work.'),
('BS-33', 'Own history', 'own_history', null, 'internal', null, 'The community''s own prior-period price for the same vendor and category, IPC-indexed; needs at least two periods.');

-- Append-only benchmark records. Re-syncs insert a new row and point the old one at it through
-- superseded_by, so every finding can cite the exact record version it used.
create table public.benchmark_records (
  id uuid primary key default gen_random_uuid(),
  category_code text not null references public.benchmark_categories(code),
  source_id text not null references public.benchmark_sources(id),
  source_ref text,                              -- e.g. 'OF 2.1 art. 7 (2025)', 'BEDEC 2025 partida K…'
  unit text,
  region text not null default 'BCN' check (region in ('BCN', 'CAT', 'ES')),
  valid_from date,
  valid_to date,
  price_low numeric(14,4),
  price_median numeric(14,4),
  price_high numeric(14,4),
  vat_included boolean not null default false,
  index_basis text not null default 'NONE' check (index_basis in ('IPC_CAT', 'IPC_ES', 'BEDEC', 'INE_MAT', 'NONE')),
  index_ref_date date,
  scope jsonb not null default '{}'::jsonb,     -- {building_age_class, protected, stops, pit_or_structural, new_vs_replacement, …}
  comparable boolean not null default true,
  evidence_file_id uuid references public.files(id),
  captured_by uuid,
  captured_at timestamptz not null default now(),
  superseded_by uuid references public.benchmark_records(id),
  hash text not null unique,                    -- canonical hash of the record content
  notes text,
  check (superseded_by is null or superseded_by <> id)
);
create index benchmark_records_category_idx on public.benchmark_records (category_code, region, valid_from);
create index benchmark_records_source_idx on public.benchmark_records (source_id);
create index benchmark_records_current_idx on public.benchmark_records (category_code) where superseded_by is null;
comment on table public.benchmark_records is 'Append-only benchmark observations. Facts are immutable; the only permitted change is setting superseded_by once, when a re-sync inserts the replacement row.';

-- Append-only guard: no deletes, and no update other than the one-way supersede pointer.
create or replace function public.benchmark_records_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'table % is append-only', tg_table_name using errcode = '42501';
  end if;
  if old.superseded_by is not null or new.superseded_by is null then
    raise exception 'table % is append-only (only superseded_by may be set, once)', tg_table_name using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'superseded_by') <> (to_jsonb(old) - 'superseded_by') then
    raise exception 'table % is append-only (only superseded_by may change)', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;
create trigger t_benchmark_records_append_only before update or delete on public.benchmark_records
  for each row execute function public.benchmark_records_guard();

-- Index series used to bring a benchmark or a prior-period price to the date of the line.
create table public.index_series (
  id uuid primary key default gen_random_uuid(),
  source text not null,                         -- INE | IDESCAT | ITEC | MITMA
  series_code text not null,
  base_period text,                             -- e.g. '2021=100'; a change of base starts a new segment
  period date not null,                         -- first day of the period
  value numeric(14,4) not null,
  fetched_at timestamptz not null default now(),
  stale_after date,
  unique (source, series_code, period)
);
create index index_series_lookup_idx on public.index_series (source, series_code, period desc);

-- ---------------------------------------------------------------------------
-- 7. Expected prices
-- ---------------------------------------------------------------------------
create table public.expected_prices (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  target_type text not null check (target_type in ('invoice_line', 'invoice', 'contract', 'liquidation_line')),
  target_id uuid not null,
  computed_at timestamptz not null default now(),
  e_value numeric(14,4),
  band_low numeric(14,4),
  band_high numeric(14,4),
  confidence text not null default 'low' check (confidence in ('high', 'medium', 'low')),
  severity text not null check (severity in ('INFO', 'REVIEW', 'MATERIAL', 'NON_BENCHMARKABLE')),
  sources jsonb not null default '[]'::jsonb,   -- one entry per layer: {layer, point, low, high, weight, ref, tier, included, reason}
  method_version text not null,
  parameters_version text,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  unique (target_type, target_id, method_version)
);
create index expected_prices_target_idx on public.expected_prices (target_type, target_id);
create index expected_prices_current_idx on public.expected_prices (community_id, severity) where is_current;
comment on table public.expected_prices is 'Output of the layered expected-price engine. The link to the priced row lives here (target_type + target_id); invoices and invoice_lines carry no pointer back.';

-- ---------------------------------------------------------------------------
-- 8. Calibration, golden set and rule precision
-- ---------------------------------------------------------------------------
create table public.calibration (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  engine text not null,                         -- extraction model / classifier / matcher
  field_type text,
  conf_bucket text,
  n int not null default 0,
  correct int not null default 0,
  accuracy numeric(6,4),
  wilson_low numeric(6,4),
  sample_kind text not null check (sample_kind in ('queue', 'random_audit')),
  computed_at timestamptz not null default now()
);
create index calibration_idx on public.calibration (community_id, engine, field_type, computed_at desc);
comment on column public.calibration.wilson_low is 'Lower bound of the Wilson interval; used as extraction_quality in the confidence of a finding.';

create table public.golden_set (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  label text,
  labelled_fields jsonb not null default '{}'::jsonb,
  planted_discrepancies jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index golden_set_document_idx on public.golden_set (community_id, document_id);

create table public.rule_precision_log (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  rule_code text not null references public.rules(code),
  rule_version int not null default 1,
  hits int not null default 0,
  reviewed int not null default 0,
  true_positive int not null default 0,
  fp_rate numeric(6,4),
  at timestamptz not null default now()
);
create index rule_precision_log_idx on public.rule_precision_log (community_id, rule_code, at desc);

-- ---------------------------------------------------------------------------
-- 9. External checks, officers and party links (M5 tables, created here)
-- ---------------------------------------------------------------------------
create table public.external_checks (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  check_type text not null,                     -- nif_validate | company_profile | borme | bdns | catastro | …
  subject_type text,                            -- party | community | unit | works_package
  subject_key text,
  source_url text,
  request jsonb,
  raw_response jsonb,
  evidence_storage_path text,                   -- archived copy in the exports bucket
  normalised jsonb,
  status text not null check (status in ('ok', 'not_found', 'error', 'manual_pending')),
  fetched_at timestamptz not null default now(),
  cost_cents int not null default 0,
  checked_by uuid
);
create trigger t_external_checks_append_only before update or delete on public.external_checks for each row execute function public.forbid_change();
create index external_checks_subject_idx on public.external_checks (community_id, check_type, subject_key);
comment on table public.external_checks is 'Append-only log of registry and public-source lookups: the request, the raw response and the archived copy, so a check can be reproduced and dated.';

create table public.entity_officers (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  party_id uuid not null references public.parties(id) on delete cascade,
  person_name_norm text,
  surname1_norm text,
  surname2_norm text,
  given_norm text,
  cargo text,
  date_from date,
  date_to date,
  source_check_id uuid references public.external_checks(id),
  borme_ref jsonb,                              -- {seccion, fecha, num, pagina, anuncio}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger t_entity_officers_touch before update on public.entity_officers for each row execute function public.touch_updated_at();
create index entity_officers_party_idx on public.entity_officers (community_id, party_id);
create index entity_officers_surname_idx on public.entity_officers (community_id, surname1_norm, surname2_norm);
comment on table public.entity_officers is 'Officers of vendor entities as published in the official gazette; names are normalised for equality tests and are never exported outside the lawyer/auditor pack.';

create table public.party_links (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  from_party_id uuid not null references public.parties(id) on delete cascade,
  to_role text not null check (to_role in ('president', 'president_family', 'administrator')),
  signal text not null check (signal in ('S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11')),
  points numeric(6,2) not null default 0,
  rarity_weight numeric(8,4),
  expected_collisions numeric(10,4),
  evidence_ids uuid[] not null default '{}',
  tier text not null check (tier in ('priority', 'review', 'note')),
  status text not null default 'open' check (status in ('open', 'verified', 'dismissed')),
  explanation text,
  engine_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, from_party_id, to_role, signal)
);
create trigger t_party_links_touch before update on public.party_links for each row execute function public.touch_updated_at();
create index party_links_party_idx on public.party_links (community_id, from_party_id);
create index party_links_tier_idx on public.party_links (community_id, tier, status);
comment on table public.party_links is 'Possible links to verify between a vendor and an office-holder role, with the rarity weight and the expected number of homonyms. A link is a question for the register, never a statement of fact.';

-- ---------------------------------------------------------------------------
-- 10. Row-level security
-- ---------------------------------------------------------------------------
select public.install_policies('quotes', 'mutable');
select public.install_policies('quote_items', 'mutable');
select public.install_policies('work_certifications', 'mutable');
select public.install_policies('work_certification_items', 'mutable');
select public.install_policies('permits', 'mutable');
select public.install_policies('recurring_services', 'mutable');
select public.install_policies('insurance_policies', 'mutable');
select public.install_policies('expected_prices', 'mutable');
select public.install_policies('calibration', 'mutable');
select public.install_policies('golden_set', 'mutable');
select public.install_policies('rule_precision_log', 'mutable');
select public.install_policies('external_checks', 'append_only');
select public.install_policies('entity_officers', 'mutable');
select public.install_policies('party_links', 'mutable');

-- Global reference tables: readable by every signed-in user, written by the service role.
alter table public.benchmark_categories enable row level security;
create policy benchmark_categories_select on public.benchmark_categories for select to authenticated using (true);

alter table public.benchmark_sources enable row level security;
create policy benchmark_sources_select on public.benchmark_sources for select to authenticated using (true);

alter table public.index_series enable row level security;
create policy index_series_select on public.index_series for select to authenticated using (true);

-- benchmark_records: read and insert for signed-in users; no update or delete policy, so the
-- supersede pointer is set by the service role only and the guard trigger blocks everything else.
alter table public.benchmark_records enable row level security;
create policy benchmark_records_select on public.benchmark_records for select to authenticated using (true);
create policy benchmark_records_insert on public.benchmark_records for insert to authenticated with check (true);
