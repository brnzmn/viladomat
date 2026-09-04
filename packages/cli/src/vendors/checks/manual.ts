/**
 * Manual checks: `insolvency`, `rea`, `aeat_census` and `registro_mercantil_nota`.
 *
 * These four sources have no usable machine route — the register is a web form, or it sits
 * behind the operator's own Cl@ve or certificate, or the document is bought. The check therefore
 * writes a `manual_pending` row carrying the exact URL to open, the search terms to type and the
 * evidence to capture, and the CLI prints them. When the reviewer has the screenshot or the PDF:
 *
 *     vx vendors evidence --check <id> --file <path>
 *
 * which stores the file under `exports/<community>/checks/<check_id>.<ext>` and appends a
 * completion row with `evidence_storage_path` set and status `ok`.
 *
 * A leg obtained this way is **not** issuer-direct for scoring purposes: a screenshot taken by
 * the reviewer scores 0.7, an archived machine response 1.0.
 */
import { MANUAL_SOURCES, type ManualSourceConfig } from '../config.ts';
import type { CheckContext, CheckResult, CheckSubject, VendorCheck } from '../types.ts';

function manualCheck(type: string, label: string, cfg: ManualSourceConfig, buildQuery: (s: CheckSubject) => string): VendorCheck {
  return {
    type,
    label,
    manual: true,
    source: cfg.id,
    run(subject: CheckSubject, _ctx: CheckContext): Promise<CheckResult> {
      const query = buildQuery(subject);
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
          note:
            'Open the page, run the search with the terms above and capture the evidence listed. ' +
            'Absence of an entry is recorded as such and is not exculpatory.',
        },
        raw: { manual: true, source: cfg.id, url: cfg.url, query },
        source_url: cfg.url,
        cost_cents: cfg.costCents,
        request: { query, source: cfg.id },
        manual: { url: cfg.url, evidence: cfg.evidence, query, costCents: cfg.costCents, note: cfg.toVerify },
      });
    },
  };
}

const nameAndNif = (s: CheckSubject): string =>
  [s.nif, s.name].filter(Boolean).join(' · ') || s.subjectKey;

/** REA: contractors and subcontractors executing construction works (Ley 32/2006; RD 1109/2007). */
export const rea = manualCheck(
  'rea',
  'REA — Registro de Empresas Acreditadas (manual lookup)',
  MANUAL_SOURCES.rea,
  nameAndNif,
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

/** Insolvency publicity: is there a published insolvency proceeding for this entity. */
export const insolvency = manualCheck(
  'insolvency',
  'Registro Público Concursal — insolvency publicity (manual lookup)',
  MANUAL_SOURCES.insolvency,
  nameAndNif,
);

/** RASIC by hand, for when the open dataset cannot be reached or its id is still unverified. */
export const rasicManual = manualCheck(
  'rasic_manual',
  'RASIC — manual lookup (Canal Empresa)',
  MANUAL_SOURCES.rasic_manual,
  nameAndNif,
);

export const MANUAL_CHECKS: readonly VendorCheck[] = [rea, aeatCensus, registroMercantilNota, insolvency, rasicManual];
