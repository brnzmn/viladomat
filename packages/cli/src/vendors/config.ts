/**
 * Register of the public sources the M5 checks read, with their rate limits and their
 * verification status.
 *
 * The sandbox the code was written in could not reach most Spanish and Catalan government
 * domains, so **every endpoint, dataset id and parameter name below is marked `verified: false`
 * and must be confirmed against the live source before a pack cites it** (same gate as
 * `docs/legal-references.md`). The parsers are deliberately tolerant: they accept several
 * plausible spellings of each field and report what they could not read, so a wrong guess about
 * a key name shows up as "not read" rather than as a wrong figure.
 */

export interface SourceConfig {
  /** Identifier used on `external_checks.check_type` rows and in `docs/vendors.md`. */
  id: string;
  name: string;
  /** Base URL or dataset endpoint. */
  baseUrl: string;
  /** Requests per minute the client keeps to. */
  perMinute: number;
  /** false until the endpoint has been confirmed against the live source. */
  verified: boolean;
  /** What exactly has to be checked before this source can be relied on. */
  toVerify: string;
  /** Manual page a reviewer opens when the automated route fails. */
  fallbackUrl?: string;
  /** Licence under which the source publishes, and what it requires of a reuser (attribution). */
  licenceNote?: string;
}

/** Environment variable carrying the optional OpenMercantil API key (`omk_*`); never logged. */
export const OPENMERCANTIL_API_KEY_VAR = 'VX_OPENMERCANTIL_API_KEY';

export const SOURCES = {
  /** Company registry aggregator: officers, address, incorporation, capital, CNAE, BORME events. */
  openmercantil: {
    id: 'openmercantil',
    name: 'OpenMercantil (BORME aggregator)',
    baseUrl: 'https://openmercantil.es/api/v1',
    perMinute: 30,
    verified: false,
    toVerify:
      'Established by the research report from the provider’s published OpenAPI (mirrored, not read live): base URL https://openmercantil.es/api/v1; ' +
      'GET /search?q={name or NIF}&limit=5 answering { query, count, offset, items, _attributions }; GET /company/{slug}, /company/{slug}/officers and /company/{slug}/events; ' +
      'no credential for reads, optional X-API-Key (omk_*) from VX_OPENMERCANTIL_API_KEY for a higher quota; response header x-ratelimit-limit: 200 (per day and IP without a key, reported). ' +
      'Still to confirm live from the operator’s machine: the field names inside items and the detail objects (the parser accepts several spellings and lists what it could not read), the slug key, the 200-per-day quota, and the CC BY 4.0 attribution wording.',
    fallbackUrl: 'https://openmercantil.es/',
    licenceNote:
      'CC BY 4.0 with mandatory attribution (response header X-Attribution-Required and `_attributions` in every search response); underlying BORME data under Ley 37/2007. Keep `_attributions` with the archived response and print the attribution wherever a figure from this source is cited.',
  },
  /** National subsidy database (Base de Datos Nacional de Subvenciones). */
  bdns: {
    id: 'bdns',
    name: 'BDNS — Base de Datos Nacional de Subvenciones',
    baseUrl: 'https://www.infosubvenciones.es/bdnstrans/api',
    perMinute: 30,
    verified: false,
    toVerify:
      'Established by the research report from the published API specification (mirrors, not read live): GET concesiones/busqueda?vpd=GE&nifCif={NIF}&page=0&pageSize=50&order=fechaConcesion&direccion=desc; ' +
      'wrapper { content[], totalElements, totalPages, size, number }; Concesion { id, idConvocatoria, numeroConvocatoria, convocatoria, nivel1 (LOCAL|AUTONOMICA|ESTATAL), nivel2, nivel3, fechaConcesion, beneficiario ("NIF Razón social", masked for natural persons), instrumento, importe, ayudaEquivalente, urlBR }. ' +
      'The `beneficiario` query parameter is an integer id, so no name search is sent. Still to confirm live: that nifCif is accepted as a filter, that vpd is mandatory, the pageSize maximum, and whether the community’s H-NIF is returned unmasked. Ley 38/2003 art. 20 publicity is itself only "likely" in docs/legal-references.md.',
    fallbackUrl: 'https://www.infosubvenciones.es/bdnstrans/GE/es/concesiones',
  },
  /** Catalan open-data portal (Socrata). Grants register. */
  raisc: {
    id: 'raisc',
    name: 'RAISC — Registre d’ajuts i subvencions de Catalunya (Socrata)',
    baseUrl: 'https://analisi.transparenciacatalunya.cat/resource',
    perMinute: 60,
    verified: false,
    toVerify:
      'Established by the research report (dataset page read through mirrors, not live): dataset s9xt-n979 queried as ?cif_beneficiari={NIF}&$order=data_concessi DESC&$limit=5000; ' +
      'columns codi_raisc, codi_bdns, any_de_la_convocat_ria, objecte_de_la_convocat_ria, cif_beneficiari, ra_social_del_beneficiari ("Persona física" or "Benef. no publicable" for natural persons), data_concessi, import_subvenci_pr_stec_ajut, import_ajuda_equivalent, administraci_. ' +
      'Still to confirm live: GET /api/views/s9xt-n979.json for the exact column list and types, and whether the name column can be searched with a $where clause.',
    fallbackUrl: 'https://analisi.transparenciacatalunya.cat/',
  },
  /** Catalan industrial-safety agents register (lift maintainers, electrical installers). */
  rasic: {
    id: 'rasic',
    name: 'RASIC — Registre d’agents de la seguretat industrial de Catalunya',
    baseUrl: 'https://analisi.transparenciacatalunya.cat/resource',
    perMinute: 60,
    verified: false,
    toVerify:
      'The research report identifies dataset exxq-fubu as the RASIC installers register on the Catalan open-data portal (RASIC_DATASET_ID), by naming analogy with a sibling dataset (ebyt-8dme, RASIC-TRA workshops) whose columns are n_mero_de_rasic, nom_titular_actual, adre_a, poblaci_, codi_postal, prov_ncia. ' +
      'Nothing of it was opened live: the column names and, decisively, whether the dataset carries an identifier (NIF) column at all are unconfirmed, so the check refuses to run while RASIC_COLUMNS_VERIFIED is false. ' +
      'To confirm from the operator’s machine: GET https://analisi.transparenciacatalunya.cat/api/views/exxq-fubu.json (metadata, columns), then one query by a known registration number.',
    fallbackUrl: 'https://empresa.gencat.cat/ca/departament/dades-obertes/seguretat-industrial/rasic/',
  },
  /**
   * REA, the national register of accredited construction companies (Ley 32/2006; RD 1109/2007),
   * public lookup form of the Ministry of Labour. An HTML form, not an API: the check GETs the
   * page (cookies, hidden fields) and POSTs the identifier, then reads the result table.
   */
  rea: {
    id: 'rea',
    name: 'REA — Registro de Empresas Acreditadas (public lookup form)',
    baseUrl: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
    perMinute: 30,
    verified: false,
    toVerify:
      'Established by the research report (page structure reported by clients, not read live): GET then POST https://expinterweb.mites.gob.es/rea/pub/consulta.htm with form fields tipoIdentificacion (1 NIF, 2 NIE, 3 CIF, 6 passport), numIdentificacion and submitButton_mostrar=Mostrar; ' +
      'the result is a <table id="tabla-consulta"> whose text contains "inscrita" or "acreditada" for a registered company and "no existe ningún registro" when nothing is found; 2-second pacing. ' +
      'Still to confirm live from the operator’s machine: that the form answers without a session, a token or a captcha; the column headings of the result table (registration number in the AA/PP/SSSSSSS format, autonomous community, validity dates); and the certificate check at /rea/pub/vericert.htm.',
    fallbackUrl: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
  },
  /** Cadastre street/property web service (units, floor, door, surface, coefficient). */
  catastro: {
    id: 'catastro',
    name: 'Sede Electrónica del Catastro — OVC callejero (JSON)',
    baseUrl: 'https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json',
    perMinute: 20,
    verified: false,
    toVerify:
      'Method names (Consulta_DNPLOC / Consulta_DNPRC), the parameter spelling and the JSON envelope. Free service with an unstated rate limit; 20/min is a conservative self-imposed cap.',
    fallbackUrl: 'https://www1.sedecatastro.gob.es/',
  },
  /**
   * AEAT identity check of an identifier and the name printed with it ("Calidad de datos
   * identificativos", web service VNifV2). Mutual TLS: the request only goes out through the
   * certificate transport (`ctx.certFetch`), never through the plain `fetch`.
   */
  aeat_vnif: {
    id: 'aeat_vnif',
    name: 'AEAT — VNifV2 identity check of a NIF and name (SOAP, client certificate)',
    baseUrl: 'https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP',
    perMinute: 30,
    verified: false,
    toVerify:
      'Live handshake with the operator’s PKCS#12 from the operator’s machine: www1 host for personal and representative certificates (www10 for seal certificates); WSDL https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/burt/jdit/ws/VNifV2.wsdl with VNifV2Ent.xsd / VNifV2Sal.xsd (namespace URIs of the envelope built here); SOAP 1.1 document/literal with an empty SOAPAction; the Resultado vocabulary IDENTIFICADO, NO IDENTIFICADO, IDENTIFICADO-BAJA, IDENTIFICADO-REVOCADO, NO PROCESADO, NO IDENTIFICABLE, NO IDENTIFICADO-SIMILAR and whether the web service emits the -SIMILAR value; several rows for one NIF; HTTP 401 on a rejected certificate; whether a legacy (RC2/3DES) PKCS#12 needs re-export for OpenSSL 3. Manual v1.7 (Manual_Tecnico_WS_Masivo_Calidad_Datos_Identificativos.pdf) on sede.agenciatributaria.gob.es.',
    fallbackUrl: 'https://sede.agenciatributaria.gob.es/Sede/tramitacion/G321.shtml',
  },
  /** Catalan statistical institute: surname frequency (onomàstica). */
  idescat: {
    id: 'idescat',
    name: 'Idescat — onomàstica (surname frequency)',
    baseUrl: 'https://api.idescat.cat/onomastica/v1',
    perMinute: 30,
    verified: false,
    toVerify:
      'Endpoint path, the `id` of the surname table, the query parameter and whether the figure returned is per mille of the population or an absolute count. docs/benchmark-sources.md already records the Idescat API endpoint as unverified.',
    fallbackUrl: 'https://www.idescat.cat/onomastica/',
  },
} as const satisfies Record<string, SourceConfig>;

export type SourceId = keyof typeof SOURCES;

/**
 * RASIC installers dataset on the Catalan open-data portal, as identified by the research report
 * (see `SOURCES.rasic.toVerify`). The id was never opened live.
 */
export const RASIC_DATASET_ID = 'exxq-fubu';

/**
 * Sentinel for the RASIC column names. **To verify**: neither the columns nor the presence of an
 * identifier column has been confirmed. While this is false, the check refuses to call out and
 * returns `error` with that reason plus the manual route, so no pack can quote a RASIC result
 * that came from a guessed schema. Flip it (or verify the source in the register, which the
 * runner passes to the check) once `GET /api/views/exxq-fubu.json` has been read from the
 * operator's machine and the parser's candidate columns confirmed.
 */
export const RASIC_COLUMNS_VERIFIED = false;

/** RAISC grants dataset id, established by the research report and never opened live. To verify. */
export const RAISC_DATASET_ID = 's9xt-n979';

/** Manual sources: no API, or an API behind a personal certificate. */
export interface ManualSourceConfig {
  id: string;
  name: string;
  url: string;
  /** What the reviewer must capture and upload. */
  evidence: string[];
  /** Typical cost in cents (0 when free). */
  costCents: number;
  toVerify: string;
}

export const MANUAL_SOURCES = {
  /**
   * Manual fallback of the automated `rea` check (`checks/rea.ts`): the same public form, opened
   * by the reviewer when the automated route fails or is not yet verified.
   */
  rea: {
    id: 'rea_manual',
    name: 'REA — Registro de Empresas Acreditadas (manual lookup of the public form)',
    url: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
    evidence: [
      'Screenshot or PDF of the result page showing the search terms (identifier type and number) and the date',
      'If registered: the registration number, the issuing autonomous community and the validity dates',
      'If not found: the empty result page ("no existe ningún registro"), captured with the search terms visible',
    ],
    costCents: 0,
    toVerify:
      'The form searches by identifier (NIF, NIE, CIF or passport), per the research report; whether it also accepts a company name or a REA number is unconfirmed. Ley 32/2006 / RD 1109/2007 are recorded as "verified" in content but the register page was not reachable during research.',
  },
  rasic_manual: {
    id: 'rasic_manual',
    name: 'RASIC — manual lookup (cercador on empresa.gencat.cat)',
    url: 'https://empresa.gencat.cat/ca/departament/dades-obertes/seguretat-industrial/rasic/',
    evidence: [
      'Screenshot of the register entry (or of the empty result) with the search terms and the date visible',
      'The registration number and activity codes when present',
    ],
    costCents: 0,
    toVerify:
      'The public cercador URL comes from the research report and was not opened live; whether it searches by identifier or only by name and registration number is unconfirmed.',
  },
  aeat_census: {
    id: 'aeat_census',
    name: 'AEAT — census check of a NIF (requires the operator’s Cl@ve or certificate)',
    url: 'https://sede.agenciatributaria.gob.es/Sede/tramitacion/G321.shtml',
    evidence: [
      'PDF of the AEAT response showing the NIF, the name it is registered under and the date of the check',
      'Never capture any other taxpayer data shown on the same screen',
    ],
    costCents: 0,
    toVerify: 'Procedure code and URL of the "consulta de NIF de terceros" service.',
  },
  registro_mercantil_nota: {
    id: 'registro_mercantil_nota',
    name: 'Registro Mercantil — nota informativa',
    url: 'https://www.registradores.org/',
    evidence: [
      'The nota informativa PDF as delivered by the registry (do not re-export or edit it)',
      'The purchase receipt showing the date and the company searched',
    ],
    costCents: 1500,
    toVerify:
      'Current price and the exact product name (nota informativa vs nota simple mercantil).',
  },
  insolvency: {
    id: 'insolvency',
    name: 'Registro Público Concursal — insolvency publicity (section 1 search)',
    url: 'https://www.publicidadconcursal.es/consulta-publicidad-concursal-new',
    evidence: [
      'Screenshot or PDF of the search result for the identifier (and, separately, for the company name), with the date visible',
      'If an entry exists: the resolution type, its date, the court and the procedure reference; the "Exportar" CSV when offered',
    ],
    costCents: 0,
    toVerify:
      'Established by the research report (not opened live): the search page is a Liferay portlet that renders in the browser; identifier field #busquedaNif, name field #busquedaNombre, button #btnBuscar, result rows in table .tablaResultados (name, identifier, court, procedure, state, date); CSV export columns nif_sujeto, sujeto, tipo_resolucion, fecha_resolucion, numero_procedimiento_expediente, seccion. ' +
      'Automation is deferred: it needs a browser (no plain HTTP form), and captcha or anti-bot measures are unconfirmed. Ley 22/2003 art. 198 publicity is recorded as "likely" until archived.',
  },
  /**
   * DGSFP public registers of insurers and of insurance distributors (agents, brokers). Two
   * portals on one host; no API and no identifier-keyed search confirmed, so the reviewer opens
   * the register that matches the party and captures the entry.
   */
  dgsfp: {
    id: 'dgsfp',
    name: 'DGSFP — registers of insurers and of insurance distributors (manual lookup)',
    url: 'https://rrpp.dgsfp.mineco.es/',
    evidence: [
      'Insurers: screenshot of the entry on https://rrpp.dgsfp.mineco.es/ showing the clave administrativa, the situación (Inscrita, Revocada, En liquidación, Disuelta) and the date',
      'Distributors (agents, brokers): screenshot of the entry on https://rrpp.dgsfp.mineco.es/Mediador showing the clave, the situación (Inscrito, Cancelado) and the date',
      'If not found: the empty result page, captured with the search terms visible',
    ],
    costCents: 0,
    toVerify:
      'Established by the research report (not opened live): insurers at https://rrpp.dgsfp.mineco.es/?culture=es-ES (claves C####, E####, L####), distributors at https://rrpp.dgsfp.mineco.es/Mediador (claves J####, F####, AV####, OV####; exclusive agents carry the insurer clave, "A" and the agent identifier). ' +
      'Still to confirm: whether the portals search by identifier, the exact situación strings, the detail URLs and any captcha. Not an automated check: the register is consulted by hand.',
  },
} as const satisfies Record<string, ManualSourceConfig>;

export type ManualSourceId = keyof typeof MANUAL_SOURCES;

/**
 * Population used for the expected-homonym arithmetic: residents of Barcelona (order of
 * magnitude, ≈1.6 million). The figure is printed next to every count so a reader can redo the
 * calculation with a different population. **To verify** against the current padró.
 */
export const HOMONYM_POPULATION = 1_600_000;

/** Number of companies at one address from which it is treated as a domiciliation address. */
export const DOMICILIATION_MIN_COMPANIES = 5;

/** Surname frequency (per mille) above which a single-surname coincidence carries no weight. */
export const COMMON_SURNAME_PER_MILLE = 5;

/** How long a surname-frequency response may be reused from `external_checks`. */
export const SURNAME_CACHE_DAYS = 365;

/** Raw payloads above this size are archived in Storage instead of being stored inline. */
export const LARGE_RAW_BYTES = 256 * 1024;
