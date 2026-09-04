/**
 * `nif_validate` — local check digit and entity-letter test of a party's tax identifier.
 *
 * No network: the arithmetic is in `@viladomat/core` (mod-23 for DNI/NIE, the control-character
 * rules per entity letter for a CIF). An invalid result is a discrepancy to verify, most often an
 * OCR misread: the next check is always to re-read the original at full resolution before the
 * identifier is treated as wrong.
 */
import { CIF_ENTITY_LABELS, isNaturalPersonNif, validateNif } from '@viladomat/core';
import type { CheckContext, CheckResult, CheckSubject, VendorCheck } from '../types.ts';

export const nifValidate: VendorCheck = {
  type: 'nif_validate',
  label: 'NIF check digit and entity letter',
  manual: false,
  source: 'local',
  run(subject: CheckSubject, _ctx: CheckContext): Promise<CheckResult> {
    const raw = subject.nif ?? null;
    if (!raw) {
      return Promise.resolve({
        type: 'nif_validate',
        status: 'not_found',
        normalised: { nif: null, present: false, note: 'No identifier transcribed for this party.' },
        raw: { input: null },
        source_url: null,
        cost_cents: 0,
        request: { nif: null },
      });
    }
    const v = validateNif(raw);
    const entityLetter = v.entityLetter ?? (v.kind === 'CIF' ? v.normalised.charAt(0) : null);
    const normalised = {
      nif: v.normalised,
      present: true,
      valid: v.valid,
      kind: v.kind,
      shape: v.shape ?? null,
      entity_letter: entityLetter,
      entity_label: entityLetter ? (CIF_ENTITY_LABELS[entityLetter] ?? v.entityLabel ?? null) : null,
      natural_person: isNaturalPersonNif(v),
      reason: v.reason ?? null,
    };
    return Promise.resolve({
      type: 'nif_validate',
      status: 'ok',
      normalised,
      raw: { input: raw, validation: v },
      source_url: null,
      cost_cents: 0,
      request: { nif: raw },
      ...(v.valid
        ? {}
        : { note: 'Check digit does not match. Re-read the identifier on the original page before treating it as incorrect.' }),
    });
  },
};
