/**
 * `bdns_grants` and `raisc_grants` — public grant registers, searched by the beneficiary's
 * identifier and, for RAISC only, by name when no identifier is known.
 *
 * Two uses. Run on the **community's H-NIF** the checks show which grants were resolved or paid
 * to the community, which is the independent leg rule D8 needs. Run on a **vendor** they show
 * public money the vendor received; that is context, never a finding on its own.
 *
 * BDNS is the national register (Ley 38/2003 art. 20 publicity, itself only "likely" in
 * `docs/legal-references.md`); RAISC is the Catalan register, published on the transparency
 * portal as a Socrata dataset. The paths, parameters and field names below are the ones the
 * research report established from the published specifications; none was exercised live, so
 * both sources stay `verified: false` and the parsers accept several spellings of each field.
 *
 * **Query safety.** Nothing reaches a query string unchecked: an identifier is validated with
 * `validateNif` (a misread identifier is not sent) and a name must fit {@link SAFE_NAME} before
 * it is placed in a SoQL `$where` clause; otherwise the check returns `error` with the reason
 * `unsafe query value`. `rasic.ts` reuses the same helpers.
 *
 * **Data protection.** For a natural-person beneficiary (a sole trader) the rows keep the grant
 * facts (register, reference, date, amounts) and drop the published name; the response body is
 * not archived. BDNS itself masks natural persons ("***3410** NAME"); the masked token is never
 * read as an identifier.
 */
import { isNaturalPersonNif, validateNif } from '@viladomat/core';
import { RAISC_DATASET_ID, SOURCES } from '../config.ts';
import { asArray, asIsoDate, asNumber, asString, fetchJson, firstOf, qs } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Query safety, shared with rasic.ts
// ---------------------------------------------------------------------------

/** Reason string of an `error` result whose input could not be placed in a query safely. */
export const UNSAFE_QUERY_VALUE = 'unsafe query value';

/**
 * Characters a company or person name may contain before it is interpolated into a SoQL clause:
 * letters (any script), digits, space, full stop, comma, apostrophe, ampersand, middle dot and
 * hyphen. Quotes, percent signs, underscores, brackets and semicolons are refused rather than
 * escaped: the first two would change the meaning of a `like`, the others have no place in a name.
 */
export const SAFE_NAME = /^[\p{L}\p{N} .,'&·-]{1,120}$/u;

/**
 * A name fit for a SoQL `like` clause — upper case, single spaces, apostrophes doubled — or null
 * when it carries anything outside {@link SAFE_NAME}.
 */
export function soqlSafeName(name: string | null | undefined): string | null {
  const s = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!s || !SAFE_NAME.test(s)) return null;
  return s.toUpperCase().replace(/'/g, "''");
}

/** The identifier in its canonical 9-character form when it passes its check digit, else null. */
export function safeNif(nif: string | null | undefined): string | null {
  if (!nif) return null;
  const v = validateNif(nif);
  return v.valid ? v.normalised : null;
}

function unsafeNifError(nif: string): Error {
  const v = validateNif(nif);
  return new Error(
    `${UNSAFE_QUERY_VALUE}: identifier ${v.normalised || nif} fails its check digit (${v.reason ?? 'format'}); re-read it on the original page before querying`,
  );
}

function unsafeNameError(): Error {
  return new Error(
    `${UNSAFE_QUERY_VALUE}: the name carries characters outside the safe class (letters, digits, space, . , ' & · -) and was not sent`,
  );
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** One grant as published, in a shape both registers can be mapped onto. */
export interface GrantRow {
  register: 'BDNS' | 'RAISC';
  reference: string | null;
  /** Number of the call (convocatoria) the grant was awarded under, when published. */
  call_number: string | null;
  beneficiary: string | null;
  beneficiary_nif: string | null;
  grantor: string | null;
  /** Administration level (LOCAL, AUTONOMICA, ESTATAL) when the register publishes it. */
  level: string | null;
  programme: string | null;
  instrument: string | null;
  date: string | null;
  amount_granted: number | null;
  /** Aid-equivalent amount (loans, guarantees), when published. */
  aid_equivalent: number | null;
  amount_paid: number | null;
  url: string | null;
}

const RESULT_KEYS = ['content', 'results', 'data', 'items', 'concesiones', 'records', 'rows'];

/**
 * BDNS prints the beneficiary as "NIF Razón social" for a legal person and as a masked token
 * followed by the name for a natural person ("***3410** NAME"). The leading token is read as an
 * identifier only when it passes its check digit; a masked token is dropped.
 */
export function splitBeneficiario(
  value: string | null,
): { nif: string | null; name: string | null; masked: boolean } {
  const s = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { nif: null, name: null, masked: false };
  const m = /^(\S{9})(?:\s+(.*))?$/.exec(s);
  if (m) {
    const token = m[1] ?? '';
    const rest = (m[2] ?? '').trim() || null;
    if (token.includes('*')) return { nif: null, name: rest, masked: true };
    const v = validateNif(token);
    if (v.valid) return { nif: v.normalised, name: rest, masked: false };
  }
  return { nif: null, name: s, masked: false };
}

export function parseBdnsGrants(payload: unknown): GrantRow[] {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, RESULT_KEYS));
  return list
    .map((o): GrantRow => {
      const printed = splitBeneficiario(
        asString(firstOf(o, ['beneficiario', 'nombreBeneficiario', 'beneficiary', 'denominacion'])),
      );
      const explicitNif = asString(firstOf(o, ['nifBeneficiario', 'nifCif', 'nif', 'idBeneficiario']));
      const nif = printed.nif ?? (explicitNif ? safeNif(explicitNif) : null);
      const grantor = asString(
        firstOf(o, ['nivel3', 'nivel2', 'organo', 'organoConcedente', 'administracion', 'grantor']),
      );
      return {
        register: 'BDNS',
        reference: asString(firstOf(o, ['id', 'idConcesion', 'codigoBDNS', 'referencia'])),
        call_number: asString(firstOf(o, ['numeroConvocatoria', 'codigoConvocatoria', 'idConvocatoria'])),
        beneficiary: printed.name,
        beneficiary_nif: nif,
        grantor,
        level: asString(firstOf(o, ['nivel1', 'nivel', 'ambito'])),
        programme: asString(firstOf(o, ['convocatoria', 'tituloConvocatoria', 'programa', 'descripcion'])),
        instrument: asString(firstOf(o, ['instrumento', 'tipoInstrumento'])),
        date: asIsoDate(firstOf(o, ['fechaConcesion', 'fecha', 'fechaPago', 'date'])),
        amount_granted: asNumber(firstOf(o, ['importe', 'importeConcedido', 'amount'])),
        aid_equivalent: asNumber(firstOf(o, ['ayudaEquivalente', 'importeAyudaEquivalente'])),
        amount_paid: asNumber(firstOf(o, ['importePagado', 'pagado', 'amount_paid'])),
        url: asString(firstOf(o, ['urlBR', 'url', 'enlace'])),
      };
    })
    .filter((g) => g.reference !== null || g.beneficiary !== null || g.amount_granted !== null);
}

export function parseRaiscGrants(payload: unknown): GrantRow[] {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, RESULT_KEYS));
  return list
    .map((o): GrantRow => {
      const explicitNif = asString(
        firstOf(o, ['cif_beneficiari', 'nif_beneficiari', 'nif', 'cif', 'document']),
      );
      return {
        register: 'RAISC',
        reference: asString(firstOf(o, ['codi_raisc', 'identificador', 'id', 'expedient', 'codi'])),
        call_number: asString(firstOf(o, ['codi_bdns', 'numero_convocatoria'])),
        beneficiary: asString(
          firstOf(o, [
            'ra_social_del_beneficiari',
            'rao_social_beneficiari',
            'beneficiari',
            'beneficiario',
            'nom_beneficiari',
            'denominacio',
          ]),
        ),
        beneficiary_nif: explicitNif
          ? (safeNif(explicitNif) ?? explicitNif.toUpperCase().replace(/[\s-]/g, ''))
          : null,
        grantor: asString(
          firstOf(o, [
            'administraci_',
            'administracio',
            'entitat_oo_aa_o_departament',
            'organ',
            'departament',
            'organisme',
            'entitat',
          ]),
        ),
        level: asString(firstOf(o, ['tipus_administracio', 'nivell'])),
        programme: asString(
          firstOf(o, [
            'objecte_de_la_convocat_ria',
            'objecte_convocatoria',
            'linia',
            'convocatoria',
            'programa',
            'objecte',
          ]),
        ),
        instrument: asString(firstOf(o, ['tipus_d_ajut', 'instrument', 'tipus_ajut'])),
        date: asIsoDate(
          firstOf(o, ['data_concessi', 'data_concessio', 'data', 'data_atorgament', 'data_resolucio']),
        ),
        amount_granted: asNumber(
          firstOf(o, [
            'import_subvenci_pr_stec_ajut',
            'import_subvencio',
            'import',
            'import_atorgat',
            'import_concedit',
          ]),
        ),
        aid_equivalent: asNumber(firstOf(o, ['import_ajuda_equivalent', 'ajuda_equivalent'])),
        amount_paid: asNumber(firstOf(o, ['import_pagat', 'pagat'])),
        url: asString(firstOf(o, ['url', 'enllac'])),
      };
    })
    .filter((g) => g.reference !== null || g.beneficiary !== null || g.amount_granted !== null);
}

function summarise(rows: readonly GrantRow[]): Record<string, unknown> {
  const total = rows.reduce((acc, r) => acc + (r.amount_granted ?? 0), 0);
  const paid = rows.reduce((acc, r) => acc + (r.amount_paid ?? 0), 0);
  const years = [
    ...new Set(rows.map((r) => (r.date ? r.date.slice(0, 4) : null)).filter(Boolean)),
  ].sort();
  return {
    count: rows.length,
    total_granted: Math.round(total * 100) / 100,
    total_paid: Math.round(paid * 100) / 100,
    years,
  };
}

/** For a natural-person subject only the grant facts are kept: names out, body not archived. */
function withholdPersonal(rows: readonly GrantRow[]): GrantRow[] {
  return rows.map((r) => ({ ...r, beneficiary: null }));
}

// ---------------------------------------------------------------------------
// BDNS
// ---------------------------------------------------------------------------

const bdnsCfg = SOURCES.bdns;

/** The BDNS search URL for a validated identifier; BDNS is not searched by name. */
export function bdnsSearchUrl(nif: string): string {
  return (
    `${bdnsCfg.baseUrl}/concesiones/busqueda` +
    qs({
      vpd: 'GE',
      nifCif: nif,
      page: 0,
      pageSize: 50,
      order: 'fechaConcesion',
      direccion: 'desc',
    })
  );
}

export const bdnsGrants: VendorCheck = {
  type: 'bdns_grants',
  label: 'BDNS — grants published for this beneficiary',
  manual: false,
  source: bdnsCfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const rawNif = subject.nif ?? null;
    const request: Record<string, unknown> = {
      nif: rawNif,
      name: subject.name ?? null,
      source_verified: bdnsCfg.verified,
    };
    if (!rawNif) {
      return {
        type: 'bdns_grants',
        status: 'not_found',
        normalised: {
          note: 'No identifier to search with. BDNS is queried by identifier only: its `beneficiario` parameter is a numeric id, not a name.',
          source_verified: bdnsCfg.verified,
        },
        raw: null,
        source_url: bdnsCfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    const nif = safeNif(rawNif);
    if (!nif) return errorResult('bdns_grants', bdnsCfg.baseUrl, unsafeNifError(rawNif), request);
    const natural = isNaturalPersonNif(validateNif(nif));
    const url = bdnsSearchUrl(nif);
    request.nif = nif;
    request.endpoint = url;
    request.natural_person = natural;
    try {
      const res = await fetchJson(ctx, url, { source: bdnsCfg.id, allowStatus: [404] });
      const parsed = parseBdnsGrants(res.json);
      const rows = natural ? withholdPersonal(parsed) : parsed;
      const totalElements = asNumber(firstOf(res.json, ['totalElements', 'total']));
      return {
        type: 'bdns_grants',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          grants: rows,
          ...summarise(rows),
          total_elements: totalElements,
          searched: { nif },
          natural_person: natural,
          source_verified: bdnsCfg.verified,
          note:
            rows.length > 0
              ? 'Published grants for this beneficiary as of the fetch date (first page of 50, newest first).'
              : 'No published grant found. Absence is not exculpatory: publicity gaps and a different beneficiary identifier are both possible.',
        },
        raw: natural
          ? { redacted: 'natural person: only the grant facts are kept', http_status: res.status }
          : (res.json ?? res.text),
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('bdns_grants', url, err, request);
    }
  },
};

// ---------------------------------------------------------------------------
// RAISC
// ---------------------------------------------------------------------------

const raiscCfg = SOURCES.raisc;

/** Column the name search runs on (to verify; see `SOURCES.raisc.toVerify`). */
export const RAISC_NAME_COLUMN = 'ra_social_del_beneficiari';

/**
 * The RAISC query for a subject: an exact filter on the identifier column when an identifier is
 * known, else a `$where` on the name column. Pure, so the safety rules can be tested without a
 * transport. Returns null when there is nothing to search with.
 */
export function buildRaiscQuery(
  nif: string | null,
  name: string | null,
): { url: string; by: 'nif' | 'name' } | { error: Error } | null {
  const base = `${raiscCfg.baseUrl}/${RAISC_DATASET_ID}.json`;
  if (nif) {
    const safe = safeNif(nif);
    if (!safe) return { error: unsafeNifError(nif) };
    return {
      url: base + qs({ cif_beneficiari: safe, $order: 'data_concessi DESC', $limit: 5000 }),
      by: 'nif',
    };
  }
  if (name) {
    const safe = soqlSafeName(name);
    if (!safe) return { error: unsafeNameError() };
    return {
      url:
        base +
        qs({
          $where: `upper(${RAISC_NAME_COLUMN}) like '%${safe}%'`,
          $order: 'data_concessi DESC',
          $limit: 5000,
        }),
      by: 'name',
    };
  }
  return null;
}

export const raiscGrants: VendorCheck = {
  type: 'raisc_grants',
  label: 'RAISC (Catalonia) — grants published for this beneficiary',
  manual: false,
  source: raiscCfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const nif = subject.nif ?? null;
    const name = subject.name ?? null;
    const request: Record<string, unknown> = {
      nif,
      name,
      dataset: RAISC_DATASET_ID,
      source_verified: raiscCfg.verified,
    };
    const query = buildRaiscQuery(nif, name);
    if (!query) {
      return {
        type: 'raisc_grants',
        status: 'not_found',
        normalised: { note: 'No identifier or name to search with.', source_verified: raiscCfg.verified },
        raw: null,
        source_url: raiscCfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    if ('error' in query) return errorResult('raisc_grants', raiscCfg.baseUrl, query.error, request);
    const natural = nif ? isNaturalPersonNif(validateNif(nif)) : false;
    request.endpoint = query.url;
    request.searched_by = query.by;
    request.natural_person = natural;
    try {
      const res = await fetchJson(ctx, query.url, { source: raiscCfg.id, allowStatus: [404] });
      const parsed = parseRaiscGrants(res.json);
      const rows = natural ? withholdPersonal(parsed) : parsed;
      return {
        type: 'raisc_grants',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          grants: rows,
          ...summarise(rows),
          searched: { nif: nif ? safeNif(nif) : null, name: query.by === 'name' ? name : null },
          dataset: RAISC_DATASET_ID,
          natural_person: natural,
          source_verified: raiscCfg.verified,
          note:
            rows.length > 0
              ? 'Published grants for this beneficiary as of the fetch date.'
              : 'No published grant found in the dataset queried. The dataset id and its column names are still to verify.',
        },
        raw: natural
          ? { redacted: 'natural person: only the grant facts are kept', http_status: res.status }
          : (res.json ?? res.text),
        source_url: query.url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('raisc_grants', query.url, err, request);
    }
  },
};
