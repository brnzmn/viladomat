import { describe, expect, it } from 'vitest';
import {
  ES_BANKS,
  cccToIban,
  computeCccDc,
  computeIbanCheckDigits,
  hmacIban,
  ibanLast4,
  ibanMod97,
  lookupEsBank,
  normaliseIban,
  validateIban,
} from './iban.ts';

// --- independent helpers written in the test, so the module is not checking itself ---

function testCccDigit(block: string): string {
  const weights = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(block[i]) * (weights[i] ?? 0);
  let r = 11 - (sum % 11);
  if (r === 11) r = 0;
  if (r === 10) r = 1;
  return String(r);
}

function testIbanCheck(country: string, bban: string): string {
  const s = `${bban}${country}00`;
  let digits = '';
  for (const ch of s) digits += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  // iterative mod 97 without BigInt, to stay independent of the implementation
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return String(98 - rem).padStart(2, '0');
}

function buildEsIban(entidad: string, oficina: string, cuenta: string): string {
  const dc = testCccDigit(`00${entidad}${oficina}`) + testCccDigit(cuenta);
  const bban = `${entidad}${oficina}${dc}${cuenta}`;
  return `ES${testIbanCheck('ES', bban)}${bban}`;
}

const ES_SYNTHETIC = buildEsIban('0081', '0123', '0001234567');
const DE_SYNTHETIC = `DE${testIbanCheck('DE', '370400440532013000')}370400440532013000`;

describe('normaliseIban / ibanLast4', () => {
  it('uppercases and strips spaces, dots and hyphens', () => {
    expect(normaliseIban(' es91 2100-0418.4502 0005 1332 ')).toBe('ES9121000418450200051332');
    expect(normaliseIban(null)).toBe('');
  });
  it('returns the last four characters', () => {
    expect(ibanLast4('ES91 2100 0418 4502 0005 1332')).toBe('1332');
    expect(ibanLast4('ES1')).toBe('');
  });
});

describe('check digit helpers', () => {
  it('computes CCC control digits matching the independent helper', () => {
    expect(computeCccDc('2100', '0418', '0200051332')).toBe('45');
    expect(computeCccDc('0081', '0123', '0001234567')).toBe(
      testCccDigit('0000810123') + testCccDigit('0001234567'),
    );
  });
  it('computes ISO 13616 check digits with BigInt matching the iterative helper', () => {
    expect(computeIbanCheckDigits('ES', '21000418450200051332')).toBe('91');
    expect(computeIbanCheckDigits('DE', '370400440532013000')).toBe(testIbanCheck('DE', '370400440532013000'));
  });
  it('builds a Spanish IBAN from CCC parts', () => {
    expect(cccToIban('0081', '0123', '0001234567')).toBe(ES_SYNTHETIC);
    expect(cccToIban('2100', '0418', '0200051332')).toBe('ES9121000418450200051332');
    expect(() => cccToIban('81', '0123', '0001234567')).toThrow(RangeError);
  });
  it('ibanMod97 returns 1 for valid IBANs and -1 for garbage', () => {
    expect(ibanMod97(ES_SYNTHETIC)).toBe(1);
    expect(ibanMod97('ES!!')).toBe(-1);
  });
});

describe('validateIban — Spanish', () => {
  it('validates the published example IBAN and resolves the bank', () => {
    const v = validateIban('ES91 2100 0418 4502 0005 1332');
    expect(v).toMatchObject({
      valid: true,
      country: 'ES',
      checkDigitsOk: true,
      cccDcOk: true,
      bankCode: '2100',
      bankName: 'CaixaBank',
      officeCode: '0418',
      last4: '1332',
    });
    expect(v.absorbedInto).toBeUndefined();
  });
  it('validates a synthetic IBAN built in the test', () => {
    const v = validateIban(ES_SYNTHETIC);
    expect(v.valid).toBe(true);
    expect(v.bankName).toBe('Banco Sabadell');
    expect(v.officeCode).toBe('0123');
  });
  it('reports the successor of an absorbed entity', () => {
    const v = validateIban(buildEsIban('2038', '0001', '0000000001'));
    expect(v).toMatchObject({ valid: true, bankCode: '2038', bankName: 'Bankia', absorbedInto: '2100' });
  });
  it('flags wrong CCC control digits even when the IBAN check digits are right', () => {
    const dc = testCccDigit('0000810123') + testCccDigit('0001234567');
    const wrongDc = String((Number(dc) + 1) % 100).padStart(2, '0');
    const bban = `00810123${wrongDc}0001234567`;
    const iban = `ES${testIbanCheck('ES', bban)}${bban}`;
    const v = validateIban(iban);
    expect(v).toMatchObject({ valid: false, checkDigitsOk: true, cccDcOk: false, reason: 'ccc_dc' });
  });
  it('flags a wrong IBAN check', () => {
    const wrong = `ES00${ES_SYNTHETIC.slice(4)}`;
    const alt = wrong === ES_SYNTHETIC ? `ES01${ES_SYNTHETIC.slice(4)}` : wrong;
    expect(validateIban(alt)).toMatchObject({ valid: false, checkDigitsOk: false, reason: 'check_digits' });
  });
  it('flags a wrong length and malformed input', () => {
    expect(validateIban(ES_SYNTHETIC.slice(0, 23))).toMatchObject({ valid: false, reason: 'length' });
    expect(validateIban('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateIban('1234')).toMatchObject({ valid: false, reason: 'format' });
  });
  it('leaves the bank name undefined for unknown entity codes', () => {
    const v = validateIban(buildEsIban('9999', '0001', '0000000001'));
    expect(v.valid).toBe(true);
    expect(v.bankName).toBeUndefined();
  });
});

describe('validateIban — foreign', () => {
  it('accepts a syntactically valid DE IBAN without CCC checks', () => {
    const v = validateIban(DE_SYNTHETIC);
    expect(v).toMatchObject({ valid: true, country: 'DE', checkDigitsOk: true, last4: '3000' });
    expect(v.cccDcOk).toBeUndefined();
    expect(v.bankCode).toBeUndefined();
  });
  it('rejects a DE IBAN with an altered digit', () => {
    const altered = `${DE_SYNTHETIC.slice(0, 10)}${DE_SYNTHETIC[10] === '0' ? '1' : '0'}${DE_SYNTHETIC.slice(11)}`;
    expect(validateIban(altered).valid).toBe(false);
  });
});

describe('ES_BANKS / lookupEsBank', () => {
  it('contains the required entities', () => {
    for (const [code, name] of [
      ['0049', 'Banco Santander'],
      ['0081', 'Banco Sabadell'],
      ['0182', 'BBVA'],
      ['2100', 'CaixaBank'],
      ['0128', 'Bankinter'],
      ['2080', 'Abanca'],
      ['2085', 'Ibercaja'],
      ['2095', 'Kutxabank'],
      ['2103', 'Unicaja'],
      ['1465', 'ING'],
      ['0073', 'Openbank'],
      ['3025', "Caixa d'Enginyers"],
      ['0239', 'EVO Banco'],
      ['0019', 'Deutsche Bank SAE'],
      ['0186', 'Banco Mediolanum'],
      ['0216', 'Targobank'],
    ] as const) {
      expect(ES_BANKS[code]?.name).toBe(name);
    }
  });
  it('records absorptions', () => {
    expect(ES_BANKS['2038']?.absorbedInto).toBe('2100');
    expect(ES_BANKS['0075']?.absorbedInto).toBe('0049');
    expect(ES_BANKS['2013']?.absorbedInto).toBe('0182');
    expect(ES_BANKS['0065']?.absorbedInto).toBe('0081');
    expect(ES_BANKS['2048']?.absorbedInto).toBe('2103');
  });
  it('follows absorption chains to the current entity', () => {
    expect(lookupEsBank('2077')).toMatchObject({ name: 'Bancaja', absorbedInto: '2038', currentCode: '2100', currentName: 'CaixaBank' });
    expect(lookupEsBank('2100')).toMatchObject({ currentCode: '2100', currentName: 'CaixaBank' });
    expect(lookupEsBank('9999')).toEqual({ code: '9999', currentCode: '9999' });
  });
});

describe('hmacIban', () => {
  const key = Buffer.from('a-test-key-that-is-long-enough-000').toString('base64');
  it('is deterministic and independent of formatting', () => {
    const a = hmacIban('ES91 2100 0418 4502 0005 1332', key);
    const b = hmacIban('es9121000418450200051332', key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes with the key and with the IBAN', () => {
    const other = Buffer.from('another-key-000000000000000000000').toString('base64');
    expect(hmacIban(ES_SYNTHETIC, key)).not.toBe(hmacIban(ES_SYNTHETIC, other));
    expect(hmacIban(ES_SYNTHETIC, key)).not.toBe(hmacIban(DE_SYNTHETIC, key));
  });
  it('refuses an empty key', () => {
    expect(() => hmacIban(ES_SYNTHETIC, '')).toThrow(RangeError);
  });
});
