import { describe, expect, it } from 'vitest';
import {
  CIF_ENTITY_LABELS,
  cifControlDigit,
  dniLetter,
  isNaturalPersonNif,
  normaliseNif,
  validateNif,
} from './nif.ts';

/** Independent re-implementation of the personal-number control letter, for cross-checking. */
function expectedPersonLetter(n: number): string {
  return 'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23] ?? '';
}

/** Independent re-implementation of the CIF control, returning both representations. */
function expectedCifControl(digits: string): { digit: string; letter: string } {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(digits[i]);
    if ((i + 1) % 2 === 0) a += d;
    else {
      const twice = 2 * d;
      b += twice > 9 ? twice - 9 : twice;
    }
  }
  const c = (10 - ((a + b) % 10)) % 10;
  return { digit: String(c), letter: 'JABCDEFGHI'[c] ?? '' };
}

describe('normaliseNif', () => {
  it('uppercases and strips spaces, dots, hyphens and slashes', () => {
    expect(normaliseNif(' b-12.345.674 ')).toBe('B12345674');
    expect(normaliseNif('x 1234567 l')).toBe('X1234567L');
    expect(normaliseNif('12.345.678/Z')).toBe('12345678Z');
  });
  it('pads DNI numbers to 8 digits and NIE numbers to 7 digits', () => {
    expect(normaliseNif('1234567L')).toBe('01234567L');
    expect(normaliseNif('123L')).toBe('00000123L');
    expect(normaliseNif('X123456L')).toBe('X0123456L');
  });
  it('drops an ES VAT prefix in front of a 9-character identifier', () => {
    expect(normaliseNif('ES B12345674')).toBe('B12345674');
    expect(normaliseNif('ESB12345674')).toBe('B12345674');
  });
  it('returns an empty string for empty input', () => {
    expect(normaliseNif('')).toBe('');
    expect(normaliseNif(null)).toBe('');
    expect(normaliseNif(undefined)).toBe('');
  });
});

describe('dniLetter / cifControlDigit', () => {
  it('matches the mod-23 table for a range of numbers', () => {
    for (const n of [0, 1, 22, 23, 12345678, 99999999, 1234567]) {
      expect(dniLetter(n)).toBe(expectedPersonLetter(n));
    }
  });
  it('computes the CIF control digit with the digit-sum rule', () => {
    expect(cifControlDigit('1234567')).toBe(Number(expectedCifControl('1234567').digit));
    expect(cifControlDigit('9876543')).toBe(Number(expectedCifControl('9876543').digit));
    expect(cifControlDigit('0000000')).toBe(0);
    expect(() => cifControlDigit('123')).toThrow(RangeError);
  });
});

describe('validateNif — DNI', () => {
  it('accepts a DNI with the correct letter', () => {
    const letter = expectedPersonLetter(12345678);
    const v = validateNif(`12345678${letter}`);
    expect(v).toMatchObject({ valid: true, kind: 'DNI', normalised: `12345678${letter}` });
    expect(isNaturalPersonNif(v)).toBe(true);
  });
  it('rejects a DNI with a wrong letter and reports the checksum', () => {
    const wrong = expectedPersonLetter(12345678) === 'A' ? 'B' : 'A';
    const v = validateNif(`12345678${wrong}`);
    expect(v).toMatchObject({ valid: false, kind: 'INVALID', reason: 'checksum', shape: 'DNI' });
    expect(isNaturalPersonNif(v)).toBe(false);
  });
  it('accepts a DNI given without leading zeros', () => {
    const letter = expectedPersonLetter(1234567);
    expect(validateNif(`1234567${letter}`)).toMatchObject({
      valid: true,
      kind: 'DNI',
      normalised: `01234567${letter}`,
    });
  });
});

describe('validateNif — NIE', () => {
  it('maps X/Y/Z to 0/1/2 before the modulo', () => {
    const x = expectedPersonLetter(1234567);
    const y = expectedPersonLetter(11234567);
    const z = expectedPersonLetter(21234567);
    expect(validateNif(`X1234567${x}`)).toMatchObject({ valid: true, kind: 'NIE' });
    expect(validateNif(`Y1234567${y}`)).toMatchObject({ valid: true, kind: 'NIE' });
    expect(validateNif(`Z1234567${z}`)).toMatchObject({ valid: true, kind: 'NIE' });
    // The X letter applied to a Y number fails unless the two coincide.
    if (x !== y)
      expect(validateNif(`Y1234567${x}`)).toMatchObject({
        valid: false,
        reason: 'checksum',
        shape: 'NIE',
      });
  });
});

describe('validateNif — CIF', () => {
  it('accepts a B (sociedad limitada) CIF with the computed digit control', () => {
    const { digit } = expectedCifControl('1234567');
    const v = validateNif(`B1234567${digit}`);
    expect(v).toMatchObject({
      valid: true,
      kind: 'CIF',
      entityLetter: 'B',
      entityLabel: 'Sociedad de responsabilidad limitada',
    });
    expect(isNaturalPersonNif(v)).toBe(false);
  });
  it('accepts an H (comunidad de propietarios) CIF and labels it', () => {
    const { digit } = expectedCifControl('4567890');
    expect(validateNif(`H4567890${digit}`)).toMatchObject({
      valid: true,
      kind: 'CIF',
      entityLetter: 'H',
      entityLabel: CIF_ENTITY_LABELS['H'],
    });
  });
  it('rejects a B CIF whose control is the (correct) letter instead of a digit', () => {
    const { letter } = expectedCifControl('1234567');
    expect(validateNif(`B1234567${letter}`)).toMatchObject({
      valid: false,
      reason: 'control_type',
      entityLetter: 'B',
    });
  });
  it('requires a letter control for N, P, Q, S, R, W', () => {
    const { digit, letter } = expectedCifControl('7654321');
    for (const e of ['N', 'P', 'Q', 'S', 'R', 'W']) {
      expect(validateNif(`${e}7654321${letter}`)).toMatchObject({
        valid: true,
        kind: 'CIF',
        entityLetter: e,
      });
      expect(validateNif(`${e}7654321${digit}`)).toMatchObject({
        valid: false,
        reason: 'control_type',
      });
    }
  });
  it('accepts either control for C, D, F, G, J, U, V', () => {
    const { digit, letter } = expectedCifControl('2468013');
    for (const e of ['C', 'D', 'F', 'G', 'J', 'U', 'V']) {
      expect(validateNif(`${e}2468013${digit}`)).toMatchObject({ valid: true, kind: 'CIF' });
      expect(validateNif(`${e}2468013${letter}`)).toMatchObject({ valid: true, kind: 'CIF' });
    }
  });
  it('rejects a wrong checksum', () => {
    const { digit } = expectedCifControl('1234567');
    const wrongDigit = String((Number(digit) + 1) % 10);
    expect(validateNif(`B1234567${wrongDigit}`)).toMatchObject({
      valid: false,
      reason: 'checksum',
      shape: 'CIF',
    });
    const { letter } = expectedCifControl('1234567');
    const wrongLetter = letter === 'A' ? 'B' : 'A';
    expect(validateNif(`N1234567${wrongLetter}`)).toMatchObject({
      valid: false,
      reason: 'checksum',
    });
  });
  it('handles the digit-sum carry (2×digit > 9) correctly', () => {
    const { digit } = expectedCifControl('9876543');
    expect(validateNif(`A9876543${digit}`)).toMatchObject({
      valid: true,
      entityLabel: 'Sociedad anónima',
    });
  });
  it('labels U as UTE and J as sociedad civil', () => {
    const { digit } = expectedCifControl('1111111');
    expect(validateNif(`U1111111${digit}`).entityLabel).toMatch(/UTE/);
    expect(validateNif(`J1111111${digit}`).entityLabel).toBe('Sociedad civil');
  });
});

describe('validateNif — special personal numbers K/L/M', () => {
  it('validates letter + 7 digits + letter like a personal number', () => {
    const letter = expectedPersonLetter(1234567);
    for (const p of ['K', 'L', 'M']) {
      const v = validateNif(`${p}1234567${letter}`);
      expect(v).toMatchObject({ valid: true, kind: 'SPECIAL' });
      expect(isNaturalPersonNif(v)).toBe(true);
    }
  });
  it('rejects a wrong letter', () => {
    const letter = expectedPersonLetter(1234567);
    const wrong = letter === 'A' ? 'B' : 'A';
    expect(validateNif(`M1234567${wrong}`)).toMatchObject({
      valid: false,
      reason: 'checksum',
      shape: 'SPECIAL',
    });
  });
  it('falls back to a legacy K CIF with letter control', () => {
    const { letter } = expectedCifControl('7654321');
    const person = expectedPersonLetter(7654321);
    if (letter !== person) {
      expect(validateNif(`K7654321${letter}`)).toMatchObject({
        valid: true,
        kind: 'CIF',
        entityLetter: 'K',
      });
    }
  });
});

describe('validateNif — malformed input', () => {
  it('reports empty and format errors', () => {
    expect(validateNif('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateNif('ABC')).toMatchObject({ valid: false, reason: 'format' });
    expect(validateNif('123456789')).toMatchObject({ valid: false, reason: 'format' });
    expect(validateNif('I1234567A')).toMatchObject({ valid: false, reason: 'format' });
  });
});
