/**
 * Manual checks: `insolvency`, `rea_manual`, `aeat_census` (fallback), `registro_mercantil_nota`,
 * `rasic_manual` and, in `dgsfp.ts`, `dgsfp_manual`.
 *
 * These sources have no usable machine route today — the register is a browser-rendered form,
 * or it sits behind the operator's own Cl@ve or certificate, or the document is bought — or the
 * automated route exists but is not yet verified and a reviewer wants the entry on the record
 * now. The check therefore writes a `manual_pending` row carrying the exact URL to open, the
 * search terms to type and the evidence to capture, and the CLI prints them. When the reviewer
 * has the screenshot or the PDF:
 *
 *     vx vendors evidence --check <id> --file <path>
 *
 * which stores the file under `exports/<community>/checks/<check_id>.<ext>` and appends a
 * completion row with `evidence_storage_path` set and status `ok`.
 *
 * A leg obtained this way is **not** issuer-direct for scoring purposes: a screenshot taken by
 * the reviewer scores 0.7, an archived machine response 1.0.
 *
 * Insolvency: the Registro Público Concursal search (`MANUAL_SOURCES.insolvency`) is a Liferay
 * portlet that only renders in a browser (selectors and CSV columns are recorded in its
 * `toVerify`), so its automation is deferred and the manual route is the only one.
 */
import { MANUAL_SOURCES, type ManualSourceConfig } from '../config.ts';
import type { CheckContext, CheckResult, CheckSubject, VendorCheck } from '../types.ts';

export interface ManualCheckOptions {
  /** Extra guidance appended to the standard note and printed by the CLI. */
  note?: string;
}

/** Build a manual check for one manual source. Exported so other modules can add their own. */
export function manualCheck(
  type: string,
  label: string,
  cfg: ManualSourceConfig,
  buildQuery: (s: CheckSubject) => string,
  opts: ManualCheckOptions = {},
): VendorCheck {
  return {
    type,
    label,
    manual: true,
    source: cfg.id,
    run(subject: CheckSubject, _ctx: CheckContext): Promise<CheckResult> {
      const query = buildQuery(subject);
      const note =
        'Open the page, run the search with the terms above and capture the evidence listed. ' +
        'Absence of an entry is recorded as such and is not exculpatory.' +
        (opts.note ? ` ${opts.note}` : '');
      return Promise.resolve({
        type,
        status: 'manual_pending',
        normalised: {
          manual: true,
          url: cfg.url,
          query,
          evidence_required: cfg.evidence,
          cost_cents: cfg.costCents,
          to_verify: cfg.toVerify,
          note,
        },
        raw: { manual: true, source: cfg.id, url: cfg.url, query },
        source_url: cfg.url,
        cost_cents: cfg.costCents,
        request: { query, source: cfg.id },
        manual: {
          url: cfg.url,
          evidence: cfg.evidence,
          query,
          costCents: cfg.costCents,
          note: cfg.toVerify,
        },
        ...(opts.note ? { note: opts.note } : {}),
      });
    },
  };
}

/** Search terms for a party: identifier and name when both are known. */
export const nameAndNif = (s: CheckSubject): string =>
  [s.nif, s.name].filter(Boolean).join(' · ') || s.subjectKey;

/**
 * REA by hand (Ley 32/2006; RD 1109/2007): the fallback of the automated `rea` check
 * (`checks/rea.ts`) while the form is unverified or when it fails. Evidence uploaded against the
 * automated check's own row flows to rule B7 and the fact sheet, which read type `rea`; this
 * separate type is for raising the item explicitly (`--only rea_manual`).
 */
export const reaManual = manualCheck(
  'rea_manual',
  'REA — Registro de Empresas Acreditadas (manual lookup of the public form)',
  MANUAL_SOURCES.rea,
  (s) => s.nif ?? s.subjectKey,
  {
    note: 'Choose the identifier type on the form (NIF, NIE or CIF) and type the identifier; the form is not known to search by name.',
  },
);

/** AEAT census: does the identifier exist and is it registered to this name. */
export const aeatCensus = manualCheck(
  'aeat_census',
  'AEAT census check of the identifier (operator Cl@ve required)',
  MANUAL_SOURCES.aeat_census,
  (s) => s.nif ?? s.subjectKey,
);

/** Registro Mercantil nota informativa: the document that confirms identity before any link is asserted. */
export const registroMercantilNota = manualCheck(
  'registro_mercantil_nota',
  'Registro Mercantil — nota informativa (paid)',
  MANUAL_SOURCES.registro_mercantil_nota,
  nameAndNif,
);

/** Insolvency publicity: is there a published insolvency resolution for this entity. */
export const insolvency = manualCheck(
  'insolvency',
  'Registro Público Concursal — insolvency publicity (manual lookup)',
  MANUAL_SOURCES.insolvency,
  nameAndNif,
  {
    note: 'The page renders in the browser only: type the identifier in the identifier field and search; then repeat with the company name, since the two searches can differ.',
  },
);

/** RASIC by hand, for when the open dataset cannot be reached or its columns are still unverified. */
export const rasicManual = manualCheck(
  'rasic_manual',
  'RASIC — manual lookup (cercador)',
  MANUAL_SOURCES.rasic_manual,
  nameAndNif,
);

export const MANUAL_CHECKS: readonly VendorCheck[] = [
  reaManual,
  aeatCensus,
  registroMercantilNota,
  insolvency,
  rasicManual,
];
