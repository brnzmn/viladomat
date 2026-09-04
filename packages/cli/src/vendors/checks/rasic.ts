/**
 * `rasic` — Catalan register of industrial-safety agents (RASIC): lift maintainers and
 * installers, electrical installers, and the other regulated trades.
 *
 * The dataset id is a **placeholder** (`RASIC_DATASET_ID`): the open dataset was never opened
 * during research, so while the constant still starts with `TO-VERIFY` the check refuses to make
 * a request and returns `error` with that reason plus the manual route. No pack can therefore
 * quote a RASIC answer that came from a guessed dataset.
 *
 * Absence from the register is a discrepancy to verify, not a conclusion: a lawful maintainer may
 * be registered in another autonomous community, may appear under a group company, or the
 * registration may have lapsed after the works were done.
 */
import { RASIC_DATASET_ID, MANUAL_SOURCES, SOURCES } from '../config.ts';
import { asArray, asIsoDate, asString, fetchJson, firstOf, qs } from '../http.ts';
import { errorResult, type CheckContext, type CheckResult, type CheckSubject, type VendorCheck } from '../types.ts';

export interface RasicRow {
  registration_number: string | null;
  name: string | null;
  nif: string | null;
  activities: string[];
  date_from: string | null;
  date_to: string | null;
  status: string | null;
}

export function parseRasicRows(payload: unknown): RasicRow[] {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, ['results', 'data', 'items', 'records']));
  return list
    .map((o): RasicRow => {
      const activities = asArray(firstOf(o, ['activitats', 'actividades', 'activities', 'ambit', 'especialitat']))
        .map((a) => asString(a) ?? (asString(firstOf(a, ['nom', 'name', 'descripcio'])) ?? ''))
        .filter(Boolean);
      return {
        registration_number: asString(firstOf(o, ['num_registre', 'numero_registro', 'registration_number', 'codi', 'num'])),
        name: asString(firstOf(o, ['rao_social', 'razon_social', 'nom', 'nombre', 'name', 'empresa'])),
        nif: asString(firstOf(o, ['nif', 'cif', 'document']))?.toUpperCase().replace(/[\s-]/g, '') ?? null,
        activities,
        date_from: asIsoDate(firstOf(o, ['data_alta', 'fecha_alta', 'date_from', 'data_inscripcio'])),
        date_to: asIsoDate(firstOf(o, ['data_baixa', 'fecha_baja', 'date_to'])),
        status: asString(firstOf(o, ['situacio', 'estat', 'estado', 'status'])),
      };
    })
    .filter((r) => r.registration_number !== null || r.name !== null || r.nif !== null);
}

const cfg = SOURCES.rasic;

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
    const request = { nif, name, dataset: RASIC_DATASET_ID, source_verified: cfg.verified };

    if (RASIC_DATASET_ID.startsWith('TO-VERIFY')) {
      return {
        type: 'rasic',
        status: 'error',
        normalised: {
          error: 'RASIC dataset id not verified',
          note:
            'The open-data identifier of the RASIC register has not been confirmed. The automated lookup is disabled until it is; ' +
            'use the manual route and upload the evidence.',
          manual: manualRoute(subject),
          source_verified: false,
        },
        raw: { skipped: true, reason: 'dataset_id_placeholder', dataset: RASIC_DATASET_ID },
        source_url: cfg.fallbackUrl ?? cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }

    const where = nif
      ? `upper(nif) = '${nif.toUpperCase().replace(/'/g, "''")}'`
      : name
        ? `upper(rao_social) like '%${name.toUpperCase().replace(/'/g, "''")}%'`
        : null;
    const url = `${cfg.baseUrl}/${RASIC_DATASET_ID}.json${qs({ $where: where, $limit: 100 })}`;
    if (!where) {
      return {
        type: 'rasic',
        status: 'not_found',
        normalised: { note: 'No identifier or name to search with.', manual: manualRoute(subject) },
        raw: null,
        source_url: cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    try {
      const res = await fetchJson(ctx, url, { source: cfg.id, allowStatus: [404] });
      const rows = parseRasicRows(res.json);
      return {
        type: 'rasic',
        status: rows.length > 0 ? 'ok' : 'not_found',
        normalised: {
          registered: rows.length > 0,
          entries: rows,
          searched: { nif, name },
          dataset: RASIC_DATASET_ID,
          source_verified: cfg.verified,
          manual: manualRoute(subject),
          note:
            rows.length > 0
              ? 'Registered in RASIC as of the fetch date.'
              : 'No RASIC entry located. Not exculpatory and not conclusive: registration in another autonomous community, a group company holding the registration, or a lapse after the works are all possible.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request: { ...request, endpoint: url },
      };
    } catch (err) {
      const out = errorResult('rasic', url, err, { ...request, endpoint: url });
      out.normalised = { ...out.normalised, manual: manualRoute(subject) };
      return out;
    }
  },
};
