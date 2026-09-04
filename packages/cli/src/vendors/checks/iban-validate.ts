/**
 * `iban_validate` — local IBAN check: ISO 13616 mod-97, the Spanish CCC control digits and the
 * entity behind the four-digit bank code, following absorptions to the current entity.
 *
 * The full IBAN is never written to the check row: only the country, the bank code, the resolved
 * entity name and the last four characters. The keyed digest lives in `party_ibans.iban_hmac`.
 *
 * Two inputs are accepted, because by the time the vendor checks run the corpus normally holds
 * only the pseudonym:
 *
 * - `subject.iban` — the transcribed account number (the path taken at extraction time);
 * - `subject.extra.bank_code` and friends — what `party_ibans` stores. The arithmetic was done
 *   when the number was read, so the check replays the entity resolution (including absorptions,
 *   which is what a mid-relationship change of IBAN usually turns out to be) and reports the
 *   stored verdicts, marked `basis: 'stored_pseudonym'`.
 */
import { hmacIban, lookupEsBank, validateIban } from '@viladomat/core';
import { envOptional } from '../../lib/env.ts';
import type { CheckContext, CheckResult, CheckSubject, VendorCheck } from '../types.ts';

function absorptionNote(
  code: string | null,
  bank: ReturnType<typeof lookupEsBank> | null,
): string | undefined {
  if (!bank?.absorbedInto) return undefined;
  return (
    `Bank code ${code} was absorbed into ${bank.currentCode}` +
    `${bank.currentName ? ` (${bank.currentName})` : ''}; a change of IBAN around the migration date is expected.`
  );
}

/** Result built from what `party_ibans` stores, when the account number itself is not available. */
function fromStoredPseudonym(subject: CheckSubject): CheckResult | null {
  const extra = subject.extra ?? {};
  const bankCode = typeof extra.bank_code === 'string' ? extra.bank_code : null;
  const last4 = typeof extra.last4 === 'string' ? extra.last4 : null;
  if (!bankCode && !last4) return null;
  const bank = bankCode ? lookupEsBank(bankCode) : null;
  const normalised = {
    present: true,
    basis: 'stored_pseudonym',
    valid: typeof extra.iban_valid === 'boolean' ? extra.iban_valid : null,
    country: typeof extra.country === 'string' ? extra.country : null,
    check_digits_ok: typeof extra.iban_valid === 'boolean' ? extra.iban_valid : null,
    ccc_dc_ok: typeof extra.ccc_dc_valid === 'boolean' ? extra.ccc_dc_valid : null,
    bank_code: bankCode,
    bank_name: bank?.name ?? (typeof extra.bank_name === 'string' ? extra.bank_name : null),
    absorbed_into: bank?.absorbedInto ?? null,
    current_bank_code: bank?.currentCode ?? null,
    current_bank_name: bank?.currentName ?? null,
    office_code: null,
    last4,
    iban_hmac: typeof extra.iban_hmac === 'string' ? extra.iban_hmac : null,
    reason: null,
    note: 'Read from the stored pseudonym (bank code and last four); the account number itself is not held in clear.',
  };
  const note = absorptionNote(bankCode, bank);
  return {
    type: 'iban_validate',
    status: 'ok',
    normalised,
    raw: { basis: 'stored_pseudonym', bank_code: bankCode, last4 },
    source_url: null,
    cost_cents: 0,
    request: { basis: 'stored_pseudonym', last4 },
    ...(note ? { note } : {}),
  };
}

export const ibanValidate: VendorCheck = {
  type: 'iban_validate',
  label: 'IBAN mod-97, CCC control digits and bank entity',
  manual: false,
  source: 'local',
  run(subject: CheckSubject, _ctx: CheckContext): Promise<CheckResult> {
    const raw = subject.iban ?? null;
    if (!raw) {
      const stored = fromStoredPseudonym(subject);
      if (stored) return Promise.resolve(stored);
      return Promise.resolve({
        type: 'iban_validate',
        status: 'not_found',
        normalised: {
          present: false,
          note: 'No account number or stored pseudonym for this party.',
        },
        raw: { input: null },
        source_url: null,
        cost_cents: 0,
        request: {},
      });
    }
    const v = validateIban(raw);
    const bank = v.bankCode ? lookupEsBank(v.bankCode) : null;
    const key = envOptional('IBAN_HMAC_KEY');
    let digest: string | null = null;
    if (key) {
      try {
        digest = hmacIban(raw, key);
      } catch {
        digest = null;
      }
    }
    const normalised = {
      present: true,
      basis: 'transcribed_iban',
      valid: v.valid,
      country: v.country,
      check_digits_ok: v.checkDigitsOk,
      ccc_dc_ok: v.cccDcOk ?? null,
      bank_code: v.bankCode ?? null,
      bank_name: v.bankName ?? null,
      absorbed_into: bank?.absorbedInto ?? null,
      current_bank_code: bank?.currentCode ?? null,
      current_bank_name: bank?.currentName ?? null,
      office_code: v.officeCode ?? null,
      last4: v.last4,
      iban_hmac: digest,
      reason: v.reason ?? null,
    };
    // The raw response deliberately excludes the account number itself.
    return Promise.resolve({
      type: 'iban_validate',
      status: 'ok',
      normalised,
      raw: {
        country: v.country,
        bank_code: v.bankCode ?? null,
        last4: v.last4,
        valid: v.valid,
        reason: v.reason ?? null,
      },
      source_url: null,
      cost_cents: 0,
      request: { last4: v.last4 },
      ...(absorptionNote(v.bankCode ?? null, bank)
        ? { note: absorptionNote(v.bankCode ?? null, bank) as string }
        : {}),
    });
  },
};
