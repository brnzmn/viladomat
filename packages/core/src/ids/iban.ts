/**
 * IBAN validation (ISO 13616 mod-97) with the Spanish CCC internal control digits and a
 * table of Spanish bank codes. Pure functions except {@link hmacIban}, which uses
 * `node:crypto` to produce a keyed digest for pseudonymised storage.
 */
import { createHmac } from 'node:crypto';

/** Entry of the Spanish bank-code table. */
export interface EsBank {
  /** Four-digit entity code (`entidad`). */
  code: string;
  /** Trading name of the entity at the time of the table. */
  name: string;
  /** Entity code of the bank that absorbed this one, when the code is no longer issued. */
  absorbedInto?: string;
}

/**
 * Spanish bank codes (Registro de Entidades del Banco de España, abridged).
 * Absorbed codes still appear on old statements and invoices; they resolve to the
 * successor through {@link lookupEsBank}.
 */
export const ES_BANKS: Readonly<Record<string, EsBank>> = Object.freeze({
  '0049': { code: '0049', name: 'Banco Santander' },
  '0081': { code: '0081', name: 'Banco Sabadell' },
  '0182': { code: '0182', name: 'BBVA' },
  '2100': { code: '2100', name: 'CaixaBank' },
  '0128': { code: '0128', name: 'Bankinter' },
  '2080': { code: '2080', name: 'Abanca' },
  '2085': { code: '2085', name: 'Ibercaja' },
  '2095': { code: '2095', name: 'Kutxabank' },
  '2103': { code: '2103', name: 'Unicaja' },
  '1465': { code: '1465', name: 'ING' },
  '0073': { code: '0073', name: 'Openbank' },
  '3025': { code: '3025', name: "Caixa d'Enginyers" },
  '0239': { code: '0239', name: 'EVO Banco' },
  '0019': { code: '0019', name: 'Deutsche Bank SAE' },
  '0186': { code: '0186', name: 'Banco Mediolanum' },
  '0216': { code: '0216', name: 'Targobank' },
  '0061': { code: '0061', name: 'Banca March' },
  '0234': { code: '0234', name: 'Banco Caminos' },
  '1491': { code: '1491', name: 'Triodos Bank' },
  '3183': { code: '3183', name: 'Arquia Banca' },
  '2000': { code: '2000', name: 'CECA' },
  // Absorbed entities (code → successor).
  '2038': { code: '2038', name: 'Bankia', absorbedInto: '2100' },
  '0075': { code: '0075', name: 'Banco Popular', absorbedInto: '0049' },
  '2013': { code: '2013', name: 'Catalunya Banc', absorbedInto: '0182' },
  '0065': { code: '0065', name: 'Barclays España', absorbedInto: '0081' },
  '2048': { code: '2048', name: 'Liberbank', absorbedInto: '2103' },
  '0030': { code: '0030', name: 'Banesto', absorbedInto: '0049' },
  '2077': { code: '2077', name: 'Bancaja', absorbedInto: '2038' },
  '2090': { code: '2090', name: 'Caja de Ahorros del Mediterráneo', absorbedInto: '0081' },
  '0237': { code: '0237', name: 'Cajasur', absorbedInto: '2095' },
  '0138': { code: '0138', name: 'Bankoa', absorbedInto: '2080' },
  '0130': { code: '0130', name: 'Banco Caixa Geral', absorbedInto: '2080' },
  '2091': { code: '2091', name: 'Caixa Galicia', absorbedInto: '2080' },
});

/** Result of {@link lookupEsBank}. */
export interface EsBankLookup {
  /** Code as given (four digits). */
  code: string;
  /** Name of the entity for the code, if known. */
  name?: string;
  /** Immediate successor code, if the entity was absorbed. */
  absorbedInto?: string;
  /** Code reached after following the absorption chain to its end. */
  currentCode: string;
  /** Name of the current entity, if known. */
  currentName?: string;
}

/** Resolve a four-digit Spanish entity code, following absorptions to the current entity. */
export function lookupEsBank(code: string): EsBankLookup {
  const entry = ES_BANKS[code];
  const out: EsBankLookup = { code, currentCode: code };
  if (!entry) return out;
  out.name = entry.name;
  if (entry.absorbedInto) out.absorbedInto = entry.absorbedInto;
  let current = entry;
  const seen = new Set<string>([code]);
  while (current.absorbedInto && !seen.has(current.absorbedInto)) {
    seen.add(current.absorbedInto);
    const next = ES_BANKS[current.absorbedInto];
    if (!next) {
      out.currentCode = current.absorbedInto;
      return out;
    }
    current = next;
  }
  out.currentCode = current.code;
  out.currentName = current.name;
  return out;
}

/** Expected IBAN length per country (ISO 13616 registry, common countries only). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
});

/** Result of {@link validateIban}. */
export interface IbanValidation {
  /** True when every applicable check passes (format, mod-97 and, for ES, the CCC DCs). */
  valid: boolean;
  /** Upper-case IBAN without separators. */
  normalised: string;
  /** Two-letter country code (may be empty for garbage input). */
  country: string;
  /** ISO 13616 mod-97 check. */
  checkDigitsOk: boolean;
  /** Spanish CCC internal control digits (only for `ES`). */
  cccDcOk?: boolean;
  /** Four-digit entity code (only for `ES`). */
  bankCode?: string;
  /** Name of the entity, if the code is in {@link ES_BANKS}. */
  bankName?: string;
  /** Successor entity code when the entity was absorbed. */
  absorbedInto?: string;
  /** Four-digit office code (only for `ES`). */
  officeCode?: string;
  /** Last four characters, safe to print. */
  last4: string;
  /** Reason for failure, if any. */
  reason?: 'empty' | 'format' | 'length' | 'check_digits' | 'ccc_dc';
}

/** Upper-case the IBAN and strip spaces, dots and hyphens. Not validated. */
export function normaliseIban(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s.\-]/g, '');
}

/** Convert letters to their ISO 13616 numeric values (A=10 … Z=35). */
function toNumericString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) out += s.charAt(i);
    else if (c >= 65 && c <= 90) out += String(c - 55);
    else return '';
  }
  return out;
}

/** mod-97 of an IBAN-shaped string using BigInt arithmetic. Returns -1 for malformed input. */
export function ibanMod97(iban: string): number {
  if (iban.length < 5) return -1;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = toNumericString(rearranged);
  if (!numeric) return -1;
  return Number(BigInt(numeric) % 97n);
}

/** Compute the two ISO 13616 check digits for a country and BBAN. */
export function computeIbanCheckDigits(country: string, bban: string): string {
  const cc = country.toUpperCase();
  const probe = `${cc}00${bban.toUpperCase()}`;
  const remainder = ibanMod97(probe);
  if (remainder < 0) throw new RangeError('computeIbanCheckDigits: malformed BBAN');
  return String(98 - remainder).padStart(2, '0');
}

const CCC_WEIGHTS: readonly number[] = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];

/**
 * Spanish CCC control digit over a 10-digit block.
 * r = 11 − (Σ digit×weight mod 11); r=11 → 0; r=10 → 1.
 */
export function cccControlDigit(tenDigits: string): number {
  if (!/^\d{10}$/.test(tenDigits)) {
    throw new RangeError('cccControlDigit expects exactly 10 digits');
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += (tenDigits.charCodeAt(i) - 48) * (CCC_WEIGHTS[i] ?? 0);
  }
  const r = 11 - (sum % 11);
  if (r === 11) return 0;
  if (r === 10) return 1;
  return r;
}

/**
 * Compute the two CCC control digits: DC1 over `00` + entidad + oficina, DC2 over the
 * 10-digit account number.
 */
export function computeCccDc(entidad: string, oficina: string, cuenta: string): string {
  const dc1 = cccControlDigit(`00${entidad}${oficina}`);
  const dc2 = cccControlDigit(cuenta);
  return `${dc1}${dc2}`;
}

/** Build a Spanish IBAN from entity, office and 10-digit account (control digits computed). */
export function cccToIban(entidad: string, oficina: string, cuenta: string): string {
  if (!/^\d{4}$/.test(entidad) || !/^\d{4}$/.test(oficina) || !/^\d{10}$/.test(cuenta)) {
    throw new RangeError('cccToIban expects 4 + 4 + 10 digits');
  }
  const bban = `${entidad}${oficina}${computeCccDc(entidad, oficina, cuenta)}${cuenta}`;
  return `ES${computeIbanCheckDigits('ES', bban)}${bban}`;
}

/** Last four characters of the normalised IBAN (empty when shorter). */
export function ibanLast4(raw: string | null | undefined): string {
  const n = normaliseIban(raw);
  return n.length >= 4 ? n.slice(-4) : '';
}

/**
 * Validate an IBAN. Country lengths are enforced for the countries in {@link IBAN_LENGTHS};
 * other countries only need a syntactically valid 15–34 character IBAN with a correct mod-97.
 * Spanish IBANs additionally verify the CCC control digits and resolve the entity.
 */
export function validateIban(raw: string | null | undefined): IbanValidation {
  const n = normaliseIban(raw);
  const base: IbanValidation = {
    valid: false,
    normalised: n,
    country: n.slice(0, 2),
    checkDigitsOk: false,
    last4: ibanLast4(n),
  };
  if (!n) return { ...base, reason: 'empty' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(n)) return { ...base, reason: 'format' };

  const expectedLength = IBAN_LENGTHS[base.country];
  if (expectedLength !== undefined && n.length !== expectedLength) {
    return { ...base, reason: 'length' };
  }

  base.checkDigitsOk = ibanMod97(n) === 1;
  if (!base.checkDigitsOk) return { ...base, reason: 'check_digits' };

  if (base.country !== 'ES') {
    return { ...base, valid: true };
  }

  const entidad = n.slice(4, 8);
  const oficina = n.slice(8, 12);
  const dc = n.slice(12, 14);
  const cuenta = n.slice(14, 24);
  base.bankCode = entidad;
  base.officeCode = oficina;
  const bank = lookupEsBank(entidad);
  if (bank.name) base.bankName = bank.name;
  if (bank.absorbedInto) base.absorbedInto = bank.absorbedInto;
  base.cccDcOk = /^\d{20}$/.test(n.slice(4)) && computeCccDc(entidad, oficina, cuenta) === dc;
  if (!base.cccDcOk) return { ...base, reason: 'ccc_dc' };
  return { ...base, valid: true };
}

/**
 * Keyed pseudonym of an IBAN: HMAC-SHA256 over the normalised IBAN, hex encoded.
 * The key is supplied base64-encoded and never stored next to the digest.
 */
export function hmacIban(iban: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length === 0) throw new RangeError('hmacIban: empty key');
  return createHmac('sha256', key).update(normaliseIban(iban)).digest('hex');
}
