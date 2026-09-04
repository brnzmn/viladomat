/**
 * `catastro_units` — the Cadastre's list of the units at an address: cadastral reference, floor,
 * door, staircase, built surface and participation coefficient.
 *
 * This is the independent leg for the unit table: the coefficients transcribed from the minutes
 * can be compared with the ones the Cadastre publishes (rule E3), and the number of units is a
 * fact the community cannot alter.
 *
 * Route: the OVC callejero JSON service (`Consulta_DNPLOC` for an address, `Consulta_DNPRC` for a
 * single reference). Method and parameter spellings are **to verify**; the parser accepts both
 * envelopes the service is documented to return (`lrcdnp` for a list, `bico` for one property).
 * No personal data is requested: the service is queried for property descriptions, never for
 * holders.
 */
import { SOURCES } from '../config.ts';
import { asArray, asNumber, asString, fetchJson, firstOf, pick, qs } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';

export interface CatastroUnit {
  /** 20-character cadastral reference when the pieces could be joined. */
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

function parseOne(node: unknown): CatastroUnit | null {
  const rcNode = firstOf(node, ['rc', 'idbi']) ?? node;
  const rc = joinRc(firstOf(rcNode, ['rc']) ?? rcNode);
  const dt = firstOf(node, ['dt']);
  const loint =
    pick(dt, 'locs', 'lous', 'lourb', 'loint') ??
    pick(node, 'dt', 'lourb', 'loint') ??
    firstOf(node, ['loint']);
  const debi = firstOf(node, ['debi']) ?? pick(node, 'bi', 'debi');
  const unit: CatastroUnit = {
    rc,
    staircase: asString(firstOf(loint, ['es'])),
    floor: asString(firstOf(loint, ['pt'])),
    door: asString(firstOf(loint, ['pu'])),
    use: asString(firstOf(debi, ['luso', 'uso'])),
    surface_m2: asNumber(firstOf(debi, ['sfc', 'superficie'])),
    coefficient_pct: asNumber(firstOf(debi, ['cpt', 'coeficiente'])),
    year_built: asNumber(firstOf(debi, ['ant', 'antiguedad'])),
    address_line: asString(firstOf(node, ['ldt', 'direccion'])),
  };
  if (!unit.rc && !unit.floor && !unit.door && unit.surface_m2 === null) return null;
  return unit;
}

/** Parse either envelope of the OVC callejero service. Exported for fixture tests. */
export function parseCatastroUnits(payload: unknown): { units: CatastroUnit[]; envelope: string } {
  const consulta = firstOf(payload, ['consulta_dnp', 'consulta_dnprc', 'consulta']) ?? payload;
  const list = pick(consulta, 'lrcdnp', 'rcdnp');
  if (list !== undefined) {
    const units = asArray(list)
      .map(parseOne)
      .filter((u): u is CatastroUnit => u !== null);
    return { units, envelope: 'lrcdnp' };
  }
  const bico = firstOf(consulta, ['bico']);
  if (bico !== undefined) {
    const bi = firstOf(bico, ['bi']) ?? bico;
    const one = parseOne(bi);
    return { units: one ? [one] : [], envelope: 'bico' };
  }
  const bi = firstOf(consulta, ['bi']);
  if (bi !== undefined) {
    const one = parseOne(bi);
    return { units: one ? [one] : [], envelope: 'bi' };
  }
  return { units: [], envelope: 'unknown' };
}

const cfg = SOURCES.catastro;

/** Split "Carrer de Viladomat 25" into the pieces the service expects. */
export function splitStreet(address: string): { sigla: string; calle: string; numero: string } {
  const cleaned = address.replace(/\s+/g, ' ').trim();
  const m =
    /^(?:(c\/|carrer|calle|av|avinguda|avenida|pg|passeig|paseo|rda|ronda|pl|plaça|plaza|trav|travessera)\.?\s+)?(?:de\s+la\s+|de\s+l'|dels?\s+|d'|de\s+)?(.+?)[,\s]+(\d+[A-Za-z]?)(?:\s|$)/i.exec(
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
  type: 'catastro_units',
  label: 'Cadastre — units at the address (floor, door, surface, coefficient)',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const address = subject.address ?? null;
    const rc = asString(subject.extra?.rc ?? null);
    const province = subject.province ?? 'BARCELONA';
    const municipality = subject.municipality ?? 'BARCELONA';
    let url: string;
    let request: Record<string, unknown>;
    if (rc) {
      url = `${cfg.baseUrl}/Consulta_DNPRC${qs({ Provincia: '', Municipio: '', RC: rc })}`;
      request = { rc, endpoint: url, source_verified: cfg.verified };
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
        type: 'catastro_units',
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
      const { units, envelope } = parseCatastroUnits(res.json);
      const totalCoefficient = units.reduce((acc, u) => acc + (u.coefficient_pct ?? 0), 0);
      return {
        type: 'catastro_units',
        status: units.length > 0 ? 'ok' : 'not_found',
        normalised: {
          units,
          unit_count: units.length,
          coefficient_sum_pct: Math.round(totalCoefficient * 10000) / 10000,
          envelope,
          searched: request,
          source_verified: cfg.verified,
          note:
            units.length > 0
              ? "Cadastral description of the units at the address as published on the fetch date. Coefficients are the Cadastre's, which may differ from the participation quotas in the constitutive title."
              : 'No unit list returned for the address as written. Try the cadastral reference of the building.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('catastro_units', url, err, request);
    }
  },
};
