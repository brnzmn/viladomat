-- 0015_registry_sources.sql
-- Register of the public sources the vendor checks read (M5), in the database rather than only
-- in code, so a source can be marked verified from the operator's machine by `vx vendors sources
-- probe` and the check runner can read that state at run time.
--
-- A global catalogue like public.benchmark_sources and public.legal_sources: one row per source
-- id (the `source` of each check module, see packages/cli/src/vendors/config.ts), no community
-- column. Every row starts with verified_at null; a probe that parsed the live answer into the
-- expected shape sets verified_at, verified_by and probe_check_id (the external_checks row of the
-- probe). Until then every check of that source reports normalised.source_verified = false and no
-- pack cites it (same gate as docs/legal-references.md).
--
-- Grants are explicit (0014 revoked the defaults for functions; tables keep the 0001 default
-- privileges, which are revoked here so signed-in members read only): authenticated may select,
-- the service role does everything, anon nothing. Row-level security: everyone signed in reads;
-- there is no write policy for authenticated, so writes go through the service role (the CLI).
-- public.install_policies() is not used because it requires a community_id column.

create table public.registry_sources (
  id text primary key,                          -- source id used on check modules and rows
  name text not null,
  base_url text,
  access text not null check (access in ('api', 'dataset', 'form', 'manual', 'local')),
  licence_note text,
  verified_at timestamptz,                      -- null until a probe parsed the live answer
  verified_by uuid,
  probe_check_id uuid references public.external_checks(id),
  notes text,
  updated_at timestamptz not null default now()
);
create trigger t_registry_sources_touch before update on public.registry_sources for each row execute function public.touch_updated_at();
comment on table public.registry_sources is 'Register of the public sources the vendor checks read. verified_at stays null until a probe from the operator''s machine parsed the live answer into the expected shape; the check runner sets normalised.source_verified from this table.';
comment on column public.registry_sources.access is 'api: JSON or SOAP endpoint; dataset: open-data file or Socrata resource; form: HTML form read by the check; manual: a reviewer opens the page and files evidence; local: arithmetic on this machine.';
comment on column public.registry_sources.probe_check_id is 'The external_checks row (check_type source_probe) whose answer verified the source.';

alter table public.registry_sources enable row level security;
create policy registry_sources_select on public.registry_sources for select to authenticated using (true);

revoke all on public.registry_sources from public, anon, authenticated;
grant select on public.registry_sources to authenticated;
grant all on public.registry_sources to service_role;

-- One row per source id in code. Names, URLs and licence notes follow the research report;
-- nothing here is verified: every verified_at is null until the probe has run.
insert into public.registry_sources (id, name, base_url, access, licence_note, notes) values
('openmercantil', 'OpenMercantil (BORME aggregator)', 'https://openmercantil.es/api/v1', 'api',
 'CC BY 4.0 with mandatory attribution (header X-Attribution-Required, _attributions in every search response); underlying BORME data under Ley 37/2007.',
 'GET /search?q={name or NIF}&limit=5 -> {query, count, offset, items, _attributions}; /company/{slug}, /officers, /events. Optional X-API-Key (omk_*). Probe: the community''s administrator by identifier.'),
('bdns', 'BDNS - Base de Datos Nacional de Subvenciones', 'https://www.infosubvenciones.es/bdnstrans/api', 'api',
 'Public register (Ley 38/2003 art. 20, itself "likely" in docs/legal-references.md); reuse terms of the API to verify.',
 'GET concesiones/busqueda?vpd=GE&nifCif={NIF}&page=0&pageSize=50; wrapper content[], totalElements, totalPages; 10 requests per second per IP reported. Probe: the community''s identifier.'),
('raisc', 'RAISC - Registre d''ajuts i subvencions de Catalunya (Socrata s9xt-n979)', 'https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json', 'dataset',
 'Generalitat open data (CC BY reported by an independent source; the portal licence page is to verify).',
 'Columns cif_beneficiari, ra_social_del_beneficiari, data_concessi, import_subvenci_pr_stec_ajut, import_ajuda_equivalent, codi_bdns (to confirm via /api/views/s9xt-n979.json). Probe: the community''s identifier.'),
('rasic', 'RASIC - Registre d''agents de la seguretat industrial de Catalunya (Socrata exxq-fubu)', 'https://analisi.transparenciacatalunya.cat/resource/exxq-fubu.json', 'dataset',
 'Generalitat open data (dataset licence unverified; portal default believed to be an open attribution licence).',
 'Dataset id identified by naming analogy with a sibling dataset; whether it carries an identifier column is the decisive open item. Probe: GET /api/views/exxq-fubu.json and require a NIF-like column.'),
('catastro', 'Sede Electronica del Catastro - OVC callejero (JSON)', 'https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json', 'api',
 'Free non-protected cadastral data (TRLCI art. 52); transformation and redistribution subject to art. 52.2; about 3,600 requests per hour reported before a four-hour denial.',
 'Consulta_DNPRC?RefCat={RC14|RC20}&Provincia=&Municipio= (parameter RefCat, not RC: RC answers lerr code 17); root consulta_dnprcResult; 14 characters -> lrcdnp.rcdnp[], 20 -> bico.bi. Probe: the community''s cadastral reference.'),
('aeat_vnif', 'AEAT - VNifV2 identity check of a NIF and name (SOAP, client certificate)', 'https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP', 'api',
 'AEAT electronic-office service for declarants (data quality of modelo 347 and similar); not reusable data; mutual TLS with the operator''s certificate.',
 'www1 for personal and representative certificates, www10 for seal certificates; Resultado vocabulary IDENTIFICADO, NO IDENTIFICADO, IDENTIFICADO-BAJA, IDENTIFICADO-REVOCADO, NO PROCESADO. Probe: the community''s own identifier and name; skipped without VX_CLIENT_CERT_P12.'),
('idescat', 'Idescat - onomastica (surname frequency)', 'https://api.idescat.cat/onomastica/v1', 'api',
 'Idescat open data (terms to verify).',
 'Endpoint path, table id and whether the figure is a rate or a count are to verify. No automated probe: verified by hand.'),
('rea', 'REA - Registro de Empresas Acreditadas (public lookup form)', 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm', 'form',
 'Public register (Ley 32/2006; RD 1109/2007).',
 'GET then POST fields tipoIdentificacion (1 NIF, 2 NIE, 3 CIF, 6 passport), numIdentificacion, submitButton_mostrar=Mostrar; result table#tabla-consulta with "inscrita"/"acreditada" or "no existe ningun registro"; 2-second pacing. Gated: the check refuses to post to the form until this row is verified. Probe: a vendor or administrator legal-person identifier through the form.'),
('rea_manual', 'REA - manual lookup of the public form', 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm', 'manual',
 'Public register (Ley 32/2006; RD 1109/2007).',
 'Reviewer route: screenshot of the result with the search terms and the date.'),
('rasic_manual', 'RASIC - manual lookup (cercador)', 'https://empresa.gencat.cat/ca/departament/dades-obertes/seguretat-industrial/rasic/', 'manual',
 'Generalitat public register.',
 'Reviewer route while the dataset is unverified.'),
('aeat_census', 'AEAT - census check of a NIF (web form, operator Cl@ve or certificate)', 'https://sede.agenciatributaria.gob.es/Sede/tramitacion/G321.shtml', 'manual',
 'AEAT service for declarants; not reusable data.',
 'Reviewer route and fallback of aeat_vnif; capture only the identifier, the registered name and the date.'),
('registro_mercantil_nota', 'Registro Mercantil - nota informativa', 'https://sede.registradores.org/', 'manual',
 'Registral publicity for the requester''s declared use (RRM art. 12); paid (arancel plus VAT).',
 'Paid document; the PDF as delivered is the evidence.'),
('insolvency', 'Registro Publico Concursal - insolvency publicity', 'https://www.publicidadconcursal.es/consulta-publicidad-concursal-new', 'manual',
 'RD 892/2013 art. 5.a: data of the register for the purposes of the register.',
 'Browser-rendered portlet (#busquedaNif, #busquedaNombre, #btnBuscar; rows .tablaResultados); CSV export columns nif_sujeto, sujeto, tipo_resolucion, fecha_resolucion, numero_procedimiento_expediente, seccion. Automation deferred.'),
('dgsfp', 'DGSFP - registers of insurers and of insurance distributors', 'https://rrpp.dgsfp.mineco.es/', 'manual',
 'Ministerio de Economia legal notice: reuse under Ley 37/2007 and RD 1495/2011 arts. 7-8.',
 'Insurers at / (claves C####, E####, L####), distributors at /Mediador (J####, F####, AV####, OV####); situacion strings to verify. Consulted by hand.')
on conflict (id) do nothing;
-- Not registered: the Banco de Espana register of entities. No check reads it; iban_validate
-- resolves a bank code from the offline table in @viladomat/core (packages/core/src/ids/iban.ts).
-- A live source (REGBANESP_CONESTAB_A.xls, a BIFF8 workbook) is a follow-up and gets its row with
-- its check module.

-- Rule B10 (M5): the identifier and the name printed on the invoices are put to the AEAT census
-- (check aeat_census, VNifV2); a result other than IDENTIFICADO is a discrepancy to verify.
-- Mirrors the B7 row of 0009_rules_catalog.sql (family vendor, statutory basis, vendor
-- compliance); the article references stay "to verify" until the text is archived
-- (docs/legal-references.md). Idempotent: an existing row is left as it is.
insert into public.rules (code, family, version, name_es, name_ca, name_en, description, severity_default, specificity_prior, legal_basis_kind, attribution, article_refs, legal_source_ids, enabled_in_v1, worklist_eligible, never_t1t2, milestone, fp_notes) values
('B10', 'vendor', 1,
 'Identificación censal del NIF y el nombre', 'Identificació censal del NIF i el nom', 'Census identification of the identifier and name',
 'The identifier and the name printed on the invoices of a vendor, administrator, architect or insurer are put to the AEAT census (VNifV2). A result other than IDENTIFICADO is reported as a discrepancy to verify: severity 3, or 2 for IDENTIFICADO-BAJA (de-registered), which may post-date the invoices. Owners and the presidency are never looked up; for a natural person only the outcome is kept. Absence of a match establishes nothing on its own.',
 3, 0.85, 'statutory', 'vendor_compliance', '{RD 1065/2007 arts. 31-33 (to verify)}', '{rd-1065-2007}', true, true, false, 'M5',
 'A trade name printed instead of the registered name; a recent change of name; a transcription error in the name or the identifier (re-read the original first); for a natural person an incomplete name, since the census matches on the full name; the source endpoint is unverified until probed from the operator''s machine.')
on conflict (code) do nothing;
