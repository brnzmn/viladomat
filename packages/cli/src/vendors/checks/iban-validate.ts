/**
 * `iban_validate` — local IBAN check: ISO 13616 mod-97, the Spanish CCC control digits and the
 * entity behind the four-digit bank code, following absorptions to the current entity.
 *
 * The full IBAN is never written to the check row: only the country, the bank code, the resolved
 * entity name and the last four characters. The keyed digest lives in `party_ibans.iban_hmac`.
 */
import { hmacIban, lookupEsBank, validateIban } from '@viladomat/core';
import { envOptional } from '../../lib/env.ts';
import type { CheckContext, CheckResult, CheckSubject, VendorCheck } from '../types.ts';

export const ibanValidate: VendorCheck = {
  type: 'iban_validate',
  label: 'IBAN mod-97, CCC control digits and bank entity',
  manual: false,
  source: 'local',
  run(subject: CheckSubject, _ctx: CheckContext): Promise<CheckResult> {
    const raw = subject.iban ?? null;
    if (!raw) {
      return Promise.resolve({
        type: 'iban_validate',
        status: 'not_found',
        normalised: { present: false, note: 'No account number transcribed for this party.' },
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
      ...(bank?.absorbedInto
        ? {
            note: `Bank code ${v.bankCode} was absorbed into ${bank.currentCode}${bank.currentName ? ` (${bank.currentName})` : ''}; a change of IBAN around the migration date is expected.`,
          }
        : {}),
    });
  },
};
