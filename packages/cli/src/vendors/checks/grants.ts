/**
 * `bdns_grants` and `raisc_grants` — public grant registers, searched by the beneficiary's
 * identifier and, failing that, by name.
 *
 * Two uses. Run on the **community's H-NIF** the checks show which grants were resolved or paid
 * to the community, which is the independent leg rule D8 needs. Run on a **vendor** they show
 * public money the vendor received; that is context, never a finding on its own.
 *
 * BDNS is the national register (Ley 38/2003 art. 20 publicity, itself only "likely" in
 * `docs/legal-references.md`); RAISC is the Catalan register, published on the transparency
 * portal as a Socrata dataset. Both endpoints and every parameter name are **to verify**.
 */
import { RAISC_DATASET_ID, SOURCES } from '../config.ts';
import { asArray, asIsoDate, asNumber, asString, fetchJson, firstOf, qs } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';

/** One grant as published, in a shape both registers can be mapped onto. */
export interface GrantRow {
  register: 'BDNS' | 'RAISC';
  reference: string | null;
  beneficiary: string | null;
  beneficiary_nif: string | null;
  grantor: string | null;
  programme: string | null;
  date: string | null;
  amount_granted: number | null;
  amount_paid: number | null;
}

const RESULT_KEYS = ['content', 'results', 'data', 'items', 'concesiones', 'records', 'rows'];

export function parseBdnsGrants(payload: unknown): GrantRow[] {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, RESULT_KEYS));
  return list
    .map((o): GrantRow => ({
      register: 'BDNS',
      reference: asString(
        firstOf(o, ['idConcesion', 'id', 'numeroConvocatoria', 'codigoBDNS', 'referencia']),
      ),
      beneficiary: asString(
        firstOf(o, ['beneficiario', 'nombreBeneficiario', 'beneficiary', 'denominacion']),
      ),
      beneficiary_nif:
        asString(firstOf(o, ['nifBeneficiario', 'nifCif', 'nif', 'idBeneficiario']))
          ?.toUpperCase()
          .replace(/[\s-]/g, '') ?? null,
      grantor: asString(firstOf(o, ['organo', 'administracion', 'organoConcedente', 'grantor'])),
      programme: asString(
        firstOf(o, ['convocatoria', 'tituloConvocatoria', 'programa', 'instrumento']),
      ),
      date: asIsoDate(firstOf(o, ['fechaConcesion', 'fecha', 'fechaPago', 'date'])),
      amount_granted: asNumber(
        firstOf(o, ['importe', 'importeConcedido', 'ayudaEquivalente', 'amount']),
      ),
      amount_paid: asNumber(firstOf(o, ['importePagado', 'pagado', 'amount_paid'])),
    }))
    .filter((g) => g.reference !== null || g.beneficiary !== null || g.amount_granted !== null);
}

export function parseRaiscGrants(payload: unknown): GrantRow[] {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, RESULT_KEYS));
  return list
    .map((o): GrantRow => ({
      register: 'RAISC',
      reference: asString(firstOf(o, ['identificador', 'id', 'expedient', 'codi'])),
      beneficiary: asString(
        firstOf(o, ['beneficiari', 'beneficiario', 'nom_beneficiari', 'denominacio']),
      ),
      beneficiary_nif:
        asString(firstOf(o, ['nif', 'nif_beneficiari', 'cif', 'document']))
          ?.toUpperCase()
          .replace(/[\s-]/g, '') ?? null,
      grantor: asString(firstOf(o, ['organ', 'departament', 'organisme', 'entitat'])),
      programme: asString(firstOf(o, ['linia', 'convocatoria', 'programa', 'objecte'])),
      date: asIsoDate(firstOf(o, ['data', 'data_concessio', 'data_atorgament', 'any'])),
      amount_granted: asNumber(firstOf(o, ['import', 'import_atorgat', 'import_concedit'])),
      amount_paid: asNumber(firstOf(o, ['import_pagat', 'pagat'])),
    }))
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

const bdnsCfg = SOURCES.bdns;

export const bdnsGrants: VendorCheck = {
  type: 'bdns_grants',
  label: 'BDNS — grants published for this beneficiary',
  manual: false,
  source: bdnsCfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const nif = subject.nif ?? null;
    const url =
      `${bdnsCfg.baseUrl}/concesiones/busqueda` +
      qs({
        page: 0,
        pageSize: 100,
        order: 'fechaConcesion',
        direccion: 'desc',
        nifCif: nif,
        beneficiario: nif ? null : (subject.name ?? null),
      });
    const request = {
      nif,
      name: subject.name ?? null,
      endpoint: url,
      source_verified: bdnsCfg.verified,
    };
    if (!nif && !subject.name) {
      return {
        type: 'bdns_grants',
        status: 'not_found',
        normalised: { note: 'No identifier or name to search with.' },
        raw: null,
        source_url: bdnsCfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    try {
      const res = await fetchJson(ctx, url, { source: bdnsCfg.id, allowStatus: [404] });
      const rows = parseBdnsGrants(res.json);
      return {
        type: 'bdns_grants',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          grants: rows,
          ...summarise(rows),
          searched: { nif, name: subject.name ?? null },
          source_verified: bdnsCfg.verified,
          note:
            rows.length > 0
              ? 'Published grants for this beneficiary as of the fetch date.'
              : 'No published grant found. Absence is not exculpatory: publicity gaps and a different beneficiary identifier are both possible.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('bdns_grants', url, err, request);
    }
  },
};

const raiscCfg = SOURCES.raisc;

export const raiscGrants: VendorCheck = {
  type: 'raisc_grants',
  label: 'RAISC (Catalonia) — grants published for this beneficiary',
  manual: false,
  source: raiscCfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const nif = subject.nif ?? null;
    const name = subject.name ?? null;
    // Socrata SoQL: an equality on the identifier when there is one, else a case-insensitive
    // name search. Column names are unverified; the parser reports what it could not read.
    const where = nif
      ? `upper(nif) = '${nif.toUpperCase().replace(/'/g, "''")}'`
      : name
        ? `upper(beneficiari) like '%${name.toUpperCase().replace(/'/g, "''")}%'`
        : null;
    const url = `${raiscCfg.baseUrl}/${RAISC_DATASET_ID}.json${qs({ $where: where, $limit: 200 })}`;
    const request = {
      nif,
      name,
      dataset: RAISC_DATASET_ID,
      endpoint: url,
      source_verified: raiscCfg.verified,
    };
    if (!where) {
      return {
        type: 'raisc_grants',
        status: 'not_found',
        normalised: { note: 'No identifier or name to search with.' },
        raw: null,
        source_url: raiscCfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    try {
      const res = await fetchJson(ctx, url, { source: raiscCfg.id, allowStatus: [404] });
      const rows = parseRaiscGrants(res.json);
      return {
        type: 'raisc_grants',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          grants: rows,
          ...summarise(rows),
          searched: { nif, name },
          dataset: RAISC_DATASET_ID,
          source_verified: raiscCfg.verified,
          note:
            rows.length > 0
              ? 'Published grants for this beneficiary as of the fetch date.'
              : 'No published grant found in the dataset queried. The dataset id and its column names are still to verify.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('raisc_grants', url, err, request);
    }
  },
};
