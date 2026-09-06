/**
 * `rasic` — Catalan register of industrial-safety agents (RASIC): lift maintainers and
 * installers, electrical installers, and the other regulated trades, read from the open dataset
 * the research report identified (`RASIC_DATASET_ID` = exxq-fubu on the transparency portal).
 *
 * **Gated.** The dataset was never opened live: its column names are candidates taken from a
 * sibling dataset and, decisively, it is unknown whether it carries an identifier column at all.
 * While `RASIC_COLUMNS_VERIFIED` is false — and the runner has not marked the source verified in
 * the register (`ctx.sourceVerified`, read through `sourceVerifiedIn` in `vendors/types.ts`) —
 * the check refuses to make a request and returns `error` with that reason plus the manual route,
 * so no pack can quote a RASIC answer that came from a guessed schema.
 *
 * **Query shape.** Because the identifier column is unknown, an identifier is searched with the
 * portal's full-text parameter `$q` (column-agnostic) and the rows are then kept only when one
 * of their values is that identifier. A name goes into a `$where` on the candidate name column
 * after the safety rules of `grants.ts` (`soqlSafeName`); an identifier is validated first.
 *
 * **Data protection.** Only identifiers already printed on ingested documents are looked up. For
 * a natural person (a sole-trader installer with a DNI, NIE or K/L/M identifier) the row keeps
 * the verification outcome and the registration facts only — registration number, activities,
 * dates and status: the published name, identifier and address fields are dropped from every
 * entry ({@link withholdRasicPersonal}), the response body is not archived, and the name on file
 * is not copied into the request (it is not a parameter of a search by identifier). In a name
 * search each matched record is judged by the identifier it carries, in whichever column it sits
 * ({@link rasicRecordIsNaturalPerson}: the gate only proves that some identifier column exists,
 * not that it is one of the candidates); when any row was withheld the body is not archived
 * either and the row is flagged `natural_person`, so the data-room export (`report/redact.ts`)
 * treats the whole lookup as a person's.
 *
 * Absence from the register is a discrepancy to verify, not a conclusion: a lawful maintainer may
 * be registered in another autonomous community, may appear under a group company, or the
 * registration may have lapsed after the works were done.
 */
import { isNaturalPersonNif, normaliseNif, validateNif } from '@viladomat/core';
import { MANUAL_SOURCES, RASIC_COLUMNS_VERIFIED, RASIC_DATASET_ID, SOURCES } from '../config.ts';
import { asArray, asIsoDate, asString, fetchJson, firstOf, qs } from '../http.ts';
import {
  errorResult,
  sourceVerifiedIn,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';
import { naturalPersonShape } from './aeat-census.ts';
import { safeNif, soqlSafeName, UNSAFE_QUERY_VALUE } from './grants.ts';

/**
 * Candidate column names, most likely first. The first six of `number`, `name`, `address`,
 * `municipality`, `postcode` and `province` follow the sibling dataset the report cites; the
 * identifier column is unknown (see `SOURCES.rasic.toVerify`).
 */
export const RASIC_COLUMN_CANDIDATES = Object.freeze({
  number: ['n_mero_de_rasic', 'numero_rasic', 'num_registre', 'numero_registro', 'codi', 'num'],
  name: ['nom_titular_actual', 'titular', 'rao_social', 'razon_social', 'nom', 'nombre', 'empresa'],
  nif: ['nif', 'cif', 'nif_cif', 'nif_titular', 'cif_titular', 'document', 'identificador'],
  address: ['adre_a', 'adreca', 'direccio', 'direccion', 'address'],
  municipality: ['poblaci_', 'poblacio', 'municipi', 'municipio', 'localitat'],
  postcode: ['codi_postal', 'cp', 'codigo_postal', 'postcode'],
  province: ['prov_ncia', 'provincia', 'province'],
  activities: ['activitats', 'actividades', 'activities', 'ambit', 'especialitat', 'categoria'],
  date_from: ['data_alta', 'fecha_alta', 'date_from', 'data_inscripcio', 'data_d_alta'],
  date_to: ['data_baixa', 'fecha_baja', 'date_to', 'data_de_baixa'],
  status: ['situacio', 'estat', 'estado', 'status'],
});

export interface RasicRow {
  registration_number: string | null;
  /** Name as published: business data for a company; dropped by the check for a natural person. */
  name: string | null;
  /** Identifier as published; dropped by the check for a natural person. */
  nif: string | null;
  /** Address as published; dropped, with the three fields below, for a natural person. */
  address: string | null;
  municipality: string | null;
  postcode: string | null;
  province: string | null;
  activities: string[];
  date_from: string | null;
  date_to: string | null;
  status: string | null;
}

/** The list of records inside a Socrata answer (a bare array, or wrapped). */
export function rasicList(payload: unknown): unknown[] {
  return Array.isArray(payload)
    ? payload
    : asArray(firstOf(payload, ['results', 'data', 'items', 'records', 'rows']));
}

export function parseRasicRows(payload: unknown): RasicRow[] {
  const c = RASIC_COLUMN_CANDIDATES;
  return rasicList(payload)
    .map((o): RasicRow => {
      const activities = asArray(firstOf(o, c.activities))
        .map((a) => asString(a) ?? asString(firstOf(a, ['nom', 'name', 'descripcio'])) ?? '')
        .filter(Boolean);
      return {
        registration_number: asString(firstOf(o, c.number)),
        name: asString(firstOf(o, c.name)),
        nif: asString(firstOf(o, c.nif))?.toUpperCase().replace(/[\s-]/g, '') ?? null,
        address: asString(firstOf(o, c.address)),
        municipality: asString(firstOf(o, c.municipality)),
        postcode: asString(firstOf(o, c.postcode)),
        province: asString(firstOf(o, c.province)),
        activities,
        date_from: asIsoDate(firstOf(o, c.date_from)),
        date_to: asIsoDate(firstOf(o, c.date_to)),
        status: asString(firstOf(o, c.status)),
      };
    })
    .filter((r) => r.registration_number !== null || r.name !== null || r.nif !== null);
}

/** True when any value of the record is the identifier (whatever the column is called). */
export function recordMentionsNif(record: unknown, nif: string): boolean {
  if (record === null || typeof record !== 'object') return false;
  const wanted = normaliseNif(nif);
  return Object.values(record as Record<string, unknown>).some(
    (v) => typeof v === 'string' && normaliseNif(v) === wanted,
  );
}

/**
 * True when a record belongs to a natural person, judged by the identifier it carries: the value
 * of a candidate identifier column when it is shaped like a person's (DNI, NIE, K/L/M — valid or
 * not, so a misread one still counts), else any whole-cell value that is a valid person's
 * identifier, whatever its column is called (the probe only proves that some identifier column
 * exists, not that it is one of the candidates). Free text never qualifies: only a cell that is
 * exactly an identifier validates. A record with no identifier at all cannot be told apart — one
 * more reason the dataset stays gated until its columns are confirmed.
 */
export function rasicRecordIsNaturalPerson(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const declared = asString(firstOf(record, RASIC_COLUMN_CANDIDATES.nif));
  if (declared && naturalPersonShape(validateNif(declared))) return true;
  return Object.values(record as Record<string, unknown>).some(
    (v) => typeof v === 'string' && isNaturalPersonNif(validateNif(v)),
  );
}

/**
 * For a natural person only the registration facts are kept — number, activities, dates and
 * status; the published name, identifier and address fields are set to null. Pure; exported so
 * the redaction can be tested on its own.
 */
export function withholdRasicPersonal(row: RasicRow): RasicRow {
  return {
    ...row,
    name: null,
    nif: null,
    address: null,
    municipality: null,
    postcode: null,
    province: null,
  };
}

const cfg = SOURCES.rasic;

/**
 * The query for a subject. Pure, so the safety rules can be tested without a transport: an
 * identifier is validated, a name must fit the safe class. Null when there is nothing to search.
 */
export function buildRasicQuery(
  nif: string | null,
  name: string | null,
): { url: string; by: 'nif' | 'name' } | { error: Error } | null {
  const base = `${cfg.baseUrl}/${RASIC_DATASET_ID}.json`;
  if (nif) {
    const safe = safeNif(nif);
    if (!safe)
      return {
        error: new Error(
          `${UNSAFE_QUERY_VALUE}: identifier ${normaliseNif(nif) || nif} fails its check digit; re-read it on the original page before querying`,
        ),
      };
    return { url: base + qs({ $q: safe, $limit: 100 }), by: 'nif' };
  }
  if (name) {
    const safe = soqlSafeName(name);
    if (!safe)
      return {
        error: new Error(
          `${UNSAFE_QUERY_VALUE}: the name carries characters outside the safe class (letters, digits, space, . , ' & · -) and was not sent`,
        ),
      };
    const column = RASIC_COLUMN_CANDIDATES.name[0] as string;
    return {
      url: base + qs({ $where: `upper(${column}) like '%${safe}%'`, $limit: 100 }),
      by: 'name',
    };
  }
  return null;
}

function manualRoute(subject: CheckSubject): Record<string, unknown> {
  return {
    url: MANUAL_SOURCES.rasic_manual.url,
    query: subject.nif ?? subject.name ?? subject.subjectKey,
    evidence: MANUAL_SOURCES.rasic_manual.evidence,
  };
}

export const rasic: VendorCheck = {
  type: 'rasic',
  label: 'RASIC — industrial-safety agents register (lift, electrical, gas, thermal)',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const nif = subject.nif ?? null;
    const name = subject.name ?? null;
    const verified = RASIC_COLUMNS_VERIFIED || sourceVerifiedIn(ctx, cfg.id);
    // A person-shaped identifier marks a natural-person subject (once it has passed `safeNif`
    // this is exactly `isNaturalPersonNif`). The name on file is then left off the request: it
    // is not a parameter of a search by identifier, and the row keeps the outcome only.
    const natural = nif !== null && naturalPersonShape(validateNif(nif));
    const request: Record<string, unknown> = {
      nif,
      ...(natural ? {} : { name }),
      dataset: RASIC_DATASET_ID,
      natural_person: natural,
      source_verified: verified,
    };

    if (!verified) {
      return {
        type: 'rasic',
        status: 'error',
        normalised: {
          error: 'RASIC dataset columns not verified',
          note:
            'The columns of the RASIC open dataset (and whether it carries an identifier column) have not been confirmed against the live source. ' +
            'The automated lookup is disabled until they are; use the manual route and upload the evidence.',
          manual: manualRoute(subject),
          dataset: RASIC_DATASET_ID,
          natural_person: natural,
          source_verified: false,
        },
        raw: { skipped: true, reason: 'columns_unverified', dataset: RASIC_DATASET_ID },
        source_url: cfg.fallbackUrl ?? cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }

    const query = buildRasicQuery(nif, name);
    if (!query) {
      return {
        type: 'rasic',
        status: 'not_found',
        normalised: {
          note: 'No identifier or name to search with.',
          manual: manualRoute(subject),
          natural_person: natural,
          source_verified: verified,
        },
        raw: null,
        source_url: cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    if ('error' in query) {
      const out = errorResult('rasic', cfg.baseUrl, query.error, request);
      out.normalised = { ...out.normalised, manual: manualRoute(subject) };
      return out;
    }
    request.endpoint = query.url;
    request.searched_by = query.by;
    try {
      const res = await fetchJson(ctx, query.url, { source: cfg.id, allowStatus: [404] });
      // A full-text search can match the identifier inside any column; keep the records that
      // carry it as a value, so a stray substring match is not read as a registration.
      const records =
        query.by === 'nif' && nif
          ? rasicList(res.json).filter((r) => recordMentionsNif(r, nif))
          : rasicList(res.json);
      // A natural person's entries keep the registration facts only. In a name search each
      // record is judged by the identifier it carries; the body is archived only when nothing
      // was withheld.
      const rows: RasicRow[] = [];
      let withheld = 0;
      for (const record of records) {
        const [row] = parseRasicRows([record]);
        if (!row) continue;
        if (natural || rasicRecordIsNaturalPerson(record)) {
          rows.push(withholdRasicPersonal(row));
          withheld += 1;
        } else {
          rows.push(row);
        }
      }
      const personal = natural || withheld > 0;
      return {
        type: 'rasic',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          registered: rows.length > 0,
          entries: rows,
          // Entries reduced to their registration facts because they belong to a natural person.
          entries_withheld: withheld,
          searched: { nif: nif ? safeNif(nif) : null, name: query.by === 'name' ? name : null },
          dataset: RASIC_DATASET_ID,
          // True for a person's identifier or, in a name search, when a matched row carried one:
          // the export then treats the whole lookup as a person's (it errs towards redacting).
          natural_person: personal,
          source_verified: verified,
          manual: manualRoute(subject),
          note:
            (rows.length > 0
              ? 'Registered in RASIC as of the fetch date.'
              : 'No RASIC entry located. Not exculpatory and not conclusive: registration in another autonomous community, a group company holding the registration, a lapse after the works, or a dataset without an identifier column are all possible.') +
            (personal
              ? ' Only the outcome and the registration facts are stored for a natural person; the response was not archived.'
              : ''),
        },
        raw: personal
          ? {
              redacted: 'natural person: only the registration facts are kept',
              http_status: res.status,
            }
          : (res.json ?? res.text),
        source_url: query.url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      const out = errorResult('rasic', query.url, err, request);
      out.normalised = { ...out.normalised, manual: manualRoute(subject) };
      return out;
    }
  },
};
