/**
 * Registry of the vendor due-diligence checks.
 *
 * `CHECKS` is the single list the CLI, the fact sheet and the docs read from, so adding a source
 * means adding one module and one entry here.
 *
 * Modules:
 * - `nif-validate.ts`, `iban-validate.ts` — local arithmetic, no network;
 * - `company-profile.ts`, `grants.ts`, `rasic.ts`, `catastro-units.ts`, `surname-frequency.ts`
 *   — public JSON endpoints through `ctx.fetch`;
 * - `rea.ts` — the REA public lookup form (type `rea`): GET then POST through `ctx.fetch`, the
 *   result table parsed; its manual fallback is `rea_manual` in `manual.ts`;
 * - `aeat-census.ts` — the AEAT VNifV2 identity check (type `aeat_census`), which runs through
 *   the certificate transport `ctx.certFetch` (`vendors/transport/mtls.ts`, `VX_CLIENT_CERT_P12`)
 *   and falls back to the manual web-form placeholder when no certificate is configured;
 * - `manual.ts` — the placeholders that raise a `manual_pending` row for sources with no machine
 *   route (`rea_manual`, `rasic_manual`, `registro_mercantil_nota`, `insolvency`, and the AEAT
 *   fallback); `dgsfp.ts` adds `dgsfp_manual` (insurers and insurance distributors).
 *
 * Every automated source is `verified: false` until probed from the operator's machine; each
 * check reports `normalised.source_verified` accordingly and carries its manual route.
 *
 * Docs: the check table in `docs/vendors.md` lists `aeat_census` under the manual checks; with a
 * certificate configured it is an automated check against `SOURCES.aeat_vnif` (unverified until
 * probed from the operator's machine) and the manual route remains its fallback. `rasic` and
 * `rea` refuse to call out until the register has verified their source (`ctx.sourceVerified`).
 */
import type { VendorCheck } from '../types.ts';
import { nifValidate } from './nif-validate.ts';
import { ibanValidate } from './iban-validate.ts';
import { companyProfile } from './company-profile.ts';
import { bdnsGrants, raiscGrants } from './grants.ts';
import { rasic } from './rasic.ts';
import { rea } from './rea.ts';
import { catastroUnits } from './catastro-units.ts';
import { surnameFrequency } from './surname-frequency.ts';
import { aeatCensus } from './aeat-census.ts';
import { dgsfpManual } from './dgsfp.ts';
import { insolvency, rasicManual, reaManual, registroMercantilNota } from './manual.ts';

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
  reaManual,
  rasicManual,
  aeatCensus,
  registroMercantilNota,
  insolvency,
  dgsfpManual,
]);

export function checkByType(type: string): VendorCheck | undefined {
  return CHECKS.find((c) => c.type === type);
}

/**
 * Checks run for a vendor party by default (`vx vendors check --all`). `rea_manual`,
 * `rasic_manual` and `dgsfp_manual` are left out so `--all` does not raise a manual item for
 * every vendor; ask for them with `--only`. `dgsfp_manual` concerns parties of kind `insurer`
 * and vendors invoicing insurance only. `catastro_units` runs only for parties with an address on
 * record (see {@link plannedVendorChecks}): the Cadastre describes the building at the vendor's
 * address so rule B2 can compare it with the Community's own building by cadastral reference,
 * not only by normalised address string; the free service returns no holder data.
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
  'catastro_units',
]);

/** Checks that need an address on the party record; planned only when one is transcribed. */
export const ADDRESS_CHECKS: ReadonlySet<string> = new Set(['catastro_units']);

/**
 * Parties never looked up in the tax census: owners and the president act as members of the
 * community, not as counterparties, and no identifier of theirs is queried anywhere.
 */
export const CENSUS_EXCLUDED_KINDS: ReadonlySet<string> = new Set(['owner_role', 'president_role']);

/** Checks that query a source through the operator's client certificate. */
export const CERTIFICATE_GATED_CHECKS: ReadonlySet<string> = new Set(['aeat_census']);

/** What the planner needs to know about a party. */
export interface PlannedParty {
  kind: string;
  address_norm: string | null;
}

/**
 * The check types to plan for one party: the requested types (or the default vendor set), less
 * the address checks when the party has no address on record, less the certificate-gated checks
 * for the kinds that are never put to the tax census. Pure, so the planning rule is tested
 * without a database. Unknown type names pass through: the caller validates them against the
 * registry so a typo in `--only` is reported rather than skipped.
 */
export function plannedVendorChecks(
  party: PlannedParty,
  requested: readonly string[] | null,
): string[] {
  const hasAddress = (party.address_norm ?? '').trim().length > 0;
  return (requested ?? VENDOR_DEFAULT_CHECKS).filter((type) => {
    if (ADDRESS_CHECKS.has(type) && !hasAddress) return false;
    if (CERTIFICATE_GATED_CHECKS.has(type) && CENSUS_EXCLUDED_KINDS.has(party.kind)) return false;
    return true;
  });
}

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
  reaManual,
  rasicManual,
  aeatCensus,
  registroMercantilNota,
  insolvency,
  dgsfpManual,
};
