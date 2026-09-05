/**
 * `catastro_units` — the Cadastre's list of the units of a building: cadastral reference, floor,
 * door, staircase, use, built surface, year built and participation coefficient.
 *
 * This is the independent leg for the unit table: the coefficients transcribed from the minutes
 * can be compared with the ones the Cadastre publishes (`vx vendors catastro`), and the number of
 * units is a fact the community cannot alter. No personal data is requested: the service is
 * queried for property descriptions, never for holders.
 *
 * Route, as established by the research report (section 8, "Building/property") and **still to
 * verify from the operator's machine** — the service was unreachable from the sandbox this was
 * written in, so `SOURCES.catastro.verified` stays false until `vx vendors sources probe` has
 * confirmed it and the check runner sets `normalised.source_verified` from the register:
 *
 *   GET https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/Consulta_DNPRC
 *       ?RefCat=<14 or 20 characters>&Provincia=<name>&Municipio=<name>
 *
 * - The reference parameter is `RefCat`. `RC` (the parameter of the legacy .asmx service) makes
 *   the JSON service answer `lerr[].cod = 17`, "LA REFERENCIA CATASTRAL ES OBLIGATORIA".
 * - Root element `consulta_dnprcResult`.
 * - A 14-character reference (the parcel) returns `lrcdnp.rcdnp[]`, one entry per unit:
 *   `rc{pc1, pc2, car, cc1, cc2}` (7 + 7 + 4 + 1 + 1 characters, joined into the 20-character
 *   reference), `dt{loine{cp, cm}, cmc, np, nm, locs.lous.lourb{dir{tv, nv, pnp}, loint{es, pt,
 *   pu}, dp}}` and `debi{luso, sfc, cpt, ant}`; `cpt` is a Spanish decimal such as `7,320000`.
 * - A 20-character reference (one unit) returns `bico.bi{idbi{cn, rc}, dt, ldt, debi}` and the
 *   built elements in `bico.lcons[]{lcd, dt.lourb.loint, dfcons.stl}`.
 * - A single result is an object, several are an array; `control{cudnp, cucons, cuerr}` counts
 *   the entries and the errors.
 * - `Consulta_DNPLOC?Provincia=&Municipio=&Sigla=&Calle=&Numero=&Bloque=&Escalera=&Planta=&Puerta=`
 *   answers for an address (parameter spelling still to test).
 * - Reported rate: about 3,600 requests per hour before a four-hour denial; the self-imposed cap
 *   in `SOURCES.catastro` is 20 per minute.
 *
 * The parser stays tolerant: it accepts the JSON root and the XML-derived one (`consulta_dnp`),
 * an object or an array in every list position, and reports `lerr` entries instead of guessing.
 */
import { parseAmountEs, stripDiacritics } from '@viladomat/core';
import { SOURCES } from '../config.ts';
import { asArray, asString, fetchJson, firstOf, pick, qs } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';

const TYPE = 'catastro_units';

export interface CatastroUnit {
  /** 20-character cadastral reference when the pieces could be joined (14 for a bare parcel). */
  rc: string | null;
  staircase: string | null;
  floor: string | null;
  door: string | null;
  use: string | null;
  surface_m2: number | null;
  coefficient_pct: number | null;
  year_built: number | null;
  address_line: string | null;
}

/** One built element of a unit (`bico.lcons[]`), returned for a 20-character reference. */
export interface CatastroConstruction {
  use: string | null;
  staircase: string | null;
  floor: string | null;
  door: string | null;
  surface_m2: number | null;
}

/** One entry of the service's error list (`lerr[]{cod, des}`). */
export interface CatastroError {
  code: string | null;
  description: string | null;
}

export interface CatastroParse {
  units: CatastroUnit[];
  constructions: CatastroConstruction[];
  envelope: 'lrcdnp' | 'bico' | 'bi' | 'unknown';
  control: { cudnp: number | null; cucons: number | null; cuerr: number | null };
  errors: CatastroError[];
}

/**
 * A Cadastre figure: the service writes decimals with a comma (`7,320000`) and never groups
 * thousands, so a single comma or dot is always the decimal separator here. Anything else goes
 * through the general Spanish amount parser.
 */
export function parseCatastroDecimal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^(-?\d+)(?:[.,](\d+))?$/.exec(s);
  if (m) {
    const n = Number(`${m[1]}.${m[2] ?? '0'}`);
    return Number.isFinite(n) ? n : null;
  }
  return parseAmountEs(s);
}

const ROOT_KEYS = [
  'consulta_dnprcResult',
  'consulta_dnplocResult',
  'consulta_dnppResult',
  'consulta_dnp',
  'consulta_dnprc',
  'consulta_dnploc',
  'consulta',
];

function joinRc(rc: unknown): string | null {
  const pc1 = asString(firstOf(rc, ['pc1']));
  const pc2 = asString(firstOf(rc, ['pc2']));
  const car = asString(firstOf(rc, ['car']));
  const cc1 = asString(firstOf(rc, ['cc1']));
  const cc2 = asString(firstOf(rc, ['cc2']));
  const joined = [pc1, pc2, car, cc1, cc2].filter(Boolean).join('');
  if (joined) return joined;
  return asString(firstOf(rc, ['rc', 'refcat', 'referencia_catastral']));
}

/** The interior location (`loint{es, pt, pu}`) wherever the envelope puts it. */
function interior(node: unknown): unknown {
  const dt = firstOf(node, ['dt']);
  return (
    pick(dt, 'locs', 'lous', 'lourb', 'loint') ??
    pick(dt, 'lourb', 'loint') ??
    pick(dt, 'loint') ??
    firstOf(node, ['loint'])
  );
}

/** The address as printed (`ldt`) or assembled from the structured pieces. */
function addressLine(node: unknown): string | null {
  const printed = asString(firstOf(node, ['ldt', 'direccion']));
  if (printed) return printed;
  const dt = firstOf(node, ['dt']);
  const lourb = pick(dt, 'locs', 'lous', 'lourb') ?? pick(dt, 'lourb');
  const dir = firstOf(lourb, ['dir']);
  const li = firstOf(lourb, ['loint']);
  const street = [
    asString(firstOf(dir, ['tv'])),
    asString(firstOf(dir, ['nv'])),
    asString(firstOf(dir, ['pnp'])),
  ]
    .filter(Boolean)
    .join(' ');
  const inside = (
    [
      ['Es', asString(firstOf(li, ['es']))],
      ['Pl', asString(firstOf(li, ['pt']))],
      ['Pt', asString(firstOf(li, ['pu']))],
    ] as Array<[string, string | null]>
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const place = [asString(firstOf(lourb, ['dp'])), asString(firstOf(dt, ['nm']))]
    .filter(Boolean)
    .join(' ');
  const line = [street, inside, place].filter(Boolean).join(' ');
  return line || null;
}

function parseOne(node: unknown): CatastroUnit | null {
  const rcNode = firstOf(node, ['rc', 'idbi']) ?? node;
  const rc = joinRc(firstOf(rcNode, ['rc']) ?? rcNode);
  const loint = interior(node);
  const debi = firstOf(node, ['debi']) ?? pick(node, 'bi', 'debi');
  const unit: CatastroUnit = {
    rc,
    staircase: asString(firstOf(loint, ['es'])),
    floor: asString(firstOf(loint, ['pt'])),
    door: asString(firstOf(loint, ['pu'])),
    use: asString(firstOf(debi, ['luso', 'uso'])),
    surface_m2: parseCatastroDecimal(firstOf(debi, ['sfc', 'superficie'])),
    coefficient_pct: parseCatastroDecimal(firstOf(debi, ['cpt', 'coeficiente'])),
    year_built: parseCatastroDecimal(firstOf(debi, ['ant', 'antiguedad'])),
    address_line: addressLine(node),
  };
  if (!unit.rc && !unit.floor && !unit.door && unit.surface_m2 === null) return null;
  return unit;
}

function parseConstruction(node: unknown): CatastroConstruction | null {
  const li = pick(node, 'dt', 'lourb', 'loint') ?? interior(node);
  const measures = firstOf(node, ['dfcons']) ?? node;
  const c: CatastroConstruction = {
    use: asString(firstOf(node, ['lcd', 'uso'])),
    staircase: asString(firstOf(li, ['es'])),
    floor: asString(firstOf(li, ['pt'])),
    door: asString(firstOf(li, ['pu'])),
    surface_m2: parseCatastroDecimal(firstOf(measures, ['stl', 'sfc'])),
  };
  if (!c.use && c.surface_m2 === null) return null;
  return c;
}

function parseErrors(consulta: unknown): CatastroError[] {
  const lerr = firstOf(consulta, ['lerr']);
  if (lerr === undefined) return [];
  const items = Array.isArray(lerr) ? lerr : asArray(firstOf(lerr, ['err']) ?? lerr);
  return items
    .map((e): CatastroError => ({
      code: asString(firstOf(e, ['cod', 'code'])),
      description: asString(firstOf(e, ['des', 'description'])),
    }))
    .filter((e) => e.code !== null || e.description !== null);
}

function parseControl(consulta: unknown): CatastroParse['control'] {
  const c = firstOf(consulta, ['control']);
  return {
    cudnp: parseCatastroDecimal(firstOf(c, ['cudnp'])),
    cucons: parseCatastroDecimal(firstOf(c, ['cucons'])),
    cuerr: parseCatastroDecimal(firstOf(c, ['cuerr'])),
  };
}

/** Parse either envelope of the OVC callejero service. Exported for fixture tests. */
export function parseCatastroUnits(payload: unknown): CatastroParse {
  const consulta = firstOf(payload, ROOT_KEYS) ?? payload;
  const control = parseControl(consulta);
  const errors = parseErrors(consulta);
  const list = pick(consulta, 'lrcdnp', 'rcdnp');
  if (list !== undefined) {
    const units = asArray(list)
      .map(parseOne)
      .filter((u): u is CatastroUnit => u !== null);
    return { units, constructions: [], envelope: 'lrcdnp', control, errors };
  }
  const bico = firstOf(consulta, ['bico']);
  if (bico !== undefined) {
    const bi = firstOf(bico, ['bi']) ?? bico;
    const one = parseOne(bi);
    const constructions = asArray(firstOf(bico, ['lcons']))
      .map(parseConstruction)
      .filter((c): c is CatastroConstruction => c !== null);
    return { units: one ? [one] : [], constructions, envelope: 'bico', control, errors };
  }
  const bi = firstOf(consulta, ['bi']);
  if (bi !== undefined) {
    const one = parseOne(bi);
    return { units: one ? [one] : [], constructions: [], envelope: 'bi', control, errors };
  }
  return { units: [], constructions: [], envelope: 'unknown', control, errors };
}

/** Upper case, no spaces or hyphens: the form the service expects a reference in. */
export function normaliseRc(raw: string): string {
  return stripDiacritics(raw).toUpperCase().replace(/[\s-]/g, '');
}

/** A parcel (14 characters) or a unit (20 characters) reference. */
export function isRcShape(rc: string): boolean {
  return /^[0-9A-Z]{14}(?:[0-9A-Z]{6})?$/.test(rc);
}

const PROVINCE_BY_POSTCODE: Readonly<Record<string, string>> = {
  '08': 'BARCELONA',
  '17': 'GIRONA',
  '25': 'LLEIDA',
  '43': 'TARRAGONA',
};

/**
 * Province and municipality for the service, read from a postal address: the province from the
 * postcode prefix, the municipality from the words that follow the postcode. Both default to
 * BARCELONA. The Cadastre spells municipalities in its own way (upper case, articles moved to
 * the end), so a municipality other than Barcelona is a guess to verify against `Consulta_DNPLOC`.
 */
export function placeFromAddress(address: string | null | undefined): {
  municipality: string;
  province: string;
} {
  const out = { municipality: 'BARCELONA', province: 'BARCELONA' };
  if (!address) return out;
  const text = stripDiacritics(address).toUpperCase().replace(/\s+/g, ' ');
  const m = /\b(\d{5})\b[\s,.-]*([A-Z' -]+?)(?=\s*\(|,|$)/.exec(text);
  if (m) {
    out.province = PROVINCE_BY_POSTCODE[(m[1] ?? '').slice(0, 2)] ?? out.province;
    const city = (m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (city && !/^ESPANA$|^SPAIN$|^CATALUNYA$|^CATALUNA$/.test(city)) out.municipality = city;
  }
  return out;
}

const cfg = SOURCES.catastro;

/**
 * Split "Carrer de Viladomat 25" into the pieces the service expects. The number may be followed
 * by a comma and the rest of a postal address ("…, 08015 Barcelona"), which is left out.
 */
export function splitStreet(address: string): { sigla: string; calle: string; numero: string } {
  const cleaned = address.replace(/\s+/g, ' ').trim();
  const m =
    /^(?:(c\/|carrer|calle|av|avinguda|avenida|pg|passeig|paseo|rda|ronda|pl|plaça|plaza|trav|travessera)\.?\s+)?(?:de\s+la\s+|de\s+l'|dels?\s+|d'|de\s+)?(.+?)[,\s]+(\d+[A-Za-z]?)(?=[\s,]|$)/i.exec(
      cleaned,
    );
  const siglaMap: Record<string, string> = {
    'c/': 'CL',
    carrer: 'CL',
    calle: 'CL',
    av: 'AV',
    avinguda: 'AV',
    avenida: 'AV',
    pg: 'PS',
    passeig: 'PS',
    paseo: 'PS',
    rda: 'RD',
    ronda: 'RD',
    pl: 'PZ',
    plaça: 'PZ',
    plaza: 'PZ',
    trav: 'TR',
    travessera: 'TR',
  };
  if (!m) return { sigla: 'CL', calle: cleaned, numero: '' };
  const key = (m[1] ?? '').toLowerCase().replace(/\.$/, '');
  return {
    sigla: siglaMap[key] ?? 'CL',
    calle: (m[2] ?? '').trim().toUpperCase(),
    numero: m[3] ?? '',
  };
}

export const catastroUnits: VendorCheck = {
  type: TYPE,
  label: 'Cadastre — units at the address (floor, door, surface, coefficient)',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const address = subject.address ?? null;
    const rcRaw = asString(subject.extra?.rc ?? null);
    const place = placeFromAddress(address);
    const province = subject.province ?? place.province;
    const municipality = subject.municipality ?? place.municipality;
    let url: string;
    let request: Record<string, unknown>;
    if (rcRaw) {
      const rc = normaliseRc(rcRaw);
      request = { rc, province, municipality, source_verified: cfg.verified };
      if (!isRcShape(rc)) {
        // Nothing leaves the machine for a reference that cannot be one.
        return errorResult(
          TYPE,
          null,
          new Error(
            `cadastral reference "${rcRaw}" is not 14 or 20 characters once spaces and hyphens are removed; nothing was sent`,
          ),
          request,
        );
      }
      // `RefCat`, not `RC`: the latter is answered with lerr code 17 (see the module header).
      url = `${cfg.baseUrl}/Consulta_DNPRC${qs({
        Provincia: province,
        Municipio: municipality,
        RefCat: rc,
      })}`;
      request.endpoint = url;
    } else if (address) {
      const parts = splitStreet(address);
      url = `${cfg.baseUrl}/Consulta_DNPLOC${qs({
        Provincia: province,
        Municipio: municipality,
        Sigla: parts.sigla,
        Calle: parts.calle,
        Numero: parts.numero,
        Bloque: '',
        Escalera: '',
        Planta: '',
        Puerta: '',
      })}`;
      request = {
        address,
        parsed: parts,
        province,
        municipality,
        endpoint: url,
        source_verified: cfg.verified,
      };
    } else {
      return {
        type: TYPE,
        status: 'not_found',
        normalised: { note: 'No address or cadastral reference to search with.' },
        raw: null,
        source_url: cfg.baseUrl,
        cost_cents: 0,
        request: {},
      };
    }
    try {
      const res = await fetchJson(ctx, url, { source: cfg.id, allowStatus: [404] });
      const parsed = parseCatastroUnits(res.json);
      if (parsed.units.length === 0 && parsed.errors.length > 0) {
        const first = parsed.errors[0];
        const out = errorResult(
          TYPE,
          url,
          new Error(
            `Catastro answered with error ${first?.code ?? '?'}: ${first?.description ?? 'no description'}`,
          ),
          request,
        );
        out.raw = res.json ?? res.text;
        out.normalised = {
          ...out.normalised,
          errors: parsed.errors,
          control: parsed.control,
          source_verified: cfg.verified,
        };
        return out;
      }
      const { units, envelope } = parsed;
      const totalCoefficient = units.reduce((acc, u) => acc + (u.coefficient_pct ?? 0), 0);
      return {
        type: TYPE,
        status: units.length > 0 ? 'ok' : 'not_found',
        normalised: {
          units,
          unit_count: units.length,
          coefficient_sum_pct: Math.round(totalCoefficient * 10000) / 10000,
          envelope,
          control: parsed.control,
          ...(parsed.constructions.length > 0 ? { constructions: parsed.constructions } : {}),
          ...(parsed.errors.length > 0 ? { errors: parsed.errors } : {}),
          searched: request,
          source_verified: cfg.verified,
          note:
            units.length > 0
              ? "Cadastral description of the units as published on the fetch date. Coefficients are the Cadastre's and may differ from the participation quotas in the constitutive title, which remains the authority; a difference is a discrepancy to verify."
              : 'No unit list returned for the reference or address as written. Try the 14-character cadastral reference of the building.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult(TYPE, url, err, request);
    }
  },
};
