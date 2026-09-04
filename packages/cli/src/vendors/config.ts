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
}

export const SOURCES = {
  /** Company registry aggregator: officers, address, incorporation, capital, CNAE, BORME events. */
  openmercantil: {
    id: 'openmercantil',
    name: 'OpenMercantil (BORME aggregator)',
    baseUrl: 'https://api.openmercantil.com/api/v1',
    perMinute: 60,
    verified: false,
    toVerify:
      'Base URL, authentication, the search and detail paths and every field name; also whether the licence allows storing the response. Confirm against the provider before use.',
    fallbackUrl: 'https://libreborme.net/',
  },
  /** National subsidy database (Base de Datos Nacional de Subvenciones). */
  bdns: {
    id: 'bdns',
    name: 'BDNS — Base de Datos Nacional de Subvenciones',
    baseUrl: 'https://www.infosubvenciones.es/bdnstrans/api',
    perMinute: 30,
    verified: false,
    toVerify:
      'Path `concesiones/busqueda`, the query parameter names (page/pageSize/beneficiario/nifCif/order/direccion) and the response envelope. Ley 38/2003 art. 20 publicity is itself only "likely" in docs/legal-references.md.',
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
      'Dataset id `s9xt-n979`, the host, and the column names used in the $where clause. The id was noted during research and never opened.',
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
      'The dataset id is a placeholder (see RASIC_DATASET_ID): the open dataset was never opened during research. Column names and whether the register is published as open data at all are unconfirmed.',
    fallbackUrl: 'https://canalempresa.gencat.cat/',
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
 * Placeholder dataset id for RASIC. **To verify**: the real id was never obtained. While it
 * still starts with `TO-VERIFY`, the check refuses to call out and returns `error` with that
 * reason, so no pack can quote a RASIC result that came from a guessed dataset.
 */
export const RASIC_DATASET_ID = 'TO-VERIFY-rasic-dataset-id';

/** RAISC grants dataset id, noted during research and never opened. To verify. */
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
  rea: {
    id: 'rea',
    name: 'REA — Registro de Empresas Acreditadas (construction contractors)',
    url: 'https://expinterweb.mites.gob.es/rea/pub/consultaEmpresas.htm',
    evidence: [
      'Screenshot or PDF of the result page showing the search terms (NIF and company name) and the date',
      'If registered: the registration number, the issuing autonomous community and the validity dates',
      'If not found: the empty result page, captured with the search terms visible',
    ],
    costCents: 0,
    toVerify:
      'Public-lookup URL and whether the lookup is by NIF, by name or both. Ley 32/2006 / RD 1109/2007 are recorded as "verified" in content but the register URL was not reachable during research.',
  },
  rasic_manual: {
    id: 'rasic_manual',
    name: 'RASIC — manual lookup (Canal Empresa)',
    url: 'https://canalempresa.gencat.cat/',
    evidence: [
      'Screenshot of the register entry (or of the empty result) with the search terms and the date visible',
      'The registration number and activity codes when present',
    ],
    costCents: 0,
    toVerify: 'The public consultation route for RASIC was not confirmed during research.',
  },
  aeat_census: {
    id: 'aeat_census',
    name: 'AEAT — census check of a NIF (requires the operator’s Cl@ve or certificate)',
    url: 'https://sede.agenciatributaria.gob.es/Sede/procedimientoini/G313.shtml',
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
    name: 'Registro Público Concursal — insolvency publicity',
    url: 'https://www.publicidadconcursal.es/',
    evidence: [
      'Screenshot or PDF of the search result for the NIF and the company name, with the date visible',
      'If an entry exists: the publication, its date and the procedure reference',
    ],
    costCents: 0,
    toVerify: 'Search URL and whether the lookup accepts a NIF.',
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
