/**
 * Registry of the vendor due-diligence checks.
 *
 * `CHECKS` is the single list the CLI, the fact sheet and the docs read from, so adding a source
 * means adding one module and one entry here.
 */
import type { VendorCheck } from '../types.ts';
import { nifValidate } from './nif-validate.ts';
import { ibanValidate } from './iban-validate.ts';
import { companyProfile } from './company-profile.ts';
import { bdnsGrants, raiscGrants } from './grants.ts';
import { rasic } from './rasic.ts';
import { catastroUnits } from './catastro-units.ts';
import { surnameFrequency } from './surname-frequency.ts';
import { aeatCensus, insolvency, rasicManual, rea, registroMercantilNota } from './manual.ts';

export const CHECKS: readonly VendorCheck[] = Object.freeze([
  nifValidate,
  ibanValidate,
  companyProfile,
  bdnsGrants,
  raiscGrants,
  rasic,
  catastroUnits,
  surnameFrequency,
  rea,
  rasicManual,
  aeatCensus,
  registroMercantilNota,
  insolvency,
]);

export function checkByType(type: string): VendorCheck | undefined {
  return CHECKS.find((c) => c.type === type);
}

/**
 * Checks run for a vendor party by default (`vx vendors check --all`). `rasic_manual` is left
 * out so `--all` does not raise a manual item for every vendor; ask for it with `--only`.
 */
export const VENDOR_DEFAULT_CHECKS: readonly string[] = Object.freeze([
  'nif_validate',
  'iban_validate',
  'company_profile',
  'bdns_grants',
  'rasic',
  'rea',
  'aeat_census',
  'insolvency',
]);

/** Checks run for the community itself. */
export const COMMUNITY_DEFAULT_CHECKS: readonly string[] = Object.freeze([
  'nif_validate',
  'bdns_grants',
  'raisc_grants',
  'catastro_units',
]);

export {
  nifValidate,
  ibanValidate,
  companyProfile,
  bdnsGrants,
  raiscGrants,
  rasic,
  catastroUnits,
  surnameFrequency,
  rea,
  rasicManual,
  aeatCensus,
  registroMercantilNota,
  insolvency,
};
