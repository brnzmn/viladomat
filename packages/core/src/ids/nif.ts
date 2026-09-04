/**
 * Spanish tax identifiers: DNI, NIE, CIF (entity numbers) and the special
 * personal numbers starting with K, L or M.
 *
 * Everything here is pure string arithmetic; no I/O. The functions accept the
 * raw text as it may come out of OCR or extraction (lower case, dots, hyphens,
 * spaces, an `ES` VAT prefix) and produce a canonical 9-character form.
 */

/** Control letters for personal numbers (DNI/NIE/special), indexed by `n mod 23`. */
export const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Control letters for entity numbers (CIF), indexed by the computed control digit. */
export const CIF_CONTROL_LETTERS = 'JABCDEFGHI';

/** Shape of the identifier. `INVALID` is returned when the checksum or format fails. */
export type NifKind = 'DNI' | 'NIE' | 'CIF' | 'SPECIAL' | 'INVALID';

/** Reason codes attached to an invalid identifier. */
export type NifInvalidReason = 'empty' | 'format' | 'checksum' | 'control_type';

/** Result of {@link validateNif}. */
export interface NifValidation {
  /** True when the format and the control character are both correct. */
  valid: boolean;
  /** Kind of identifier when valid, `INVALID` otherwise. */
  kind: NifKind;
  /** Canonical 9-character form (see {@link normaliseNif}). */
  normalised: string;
  /** For CIFs: the entity letter (first character). */
  entityLetter?: string;
  /** For CIFs: human-readable legal form implied by the entity letter. */
  entityLabel?: string;
  /** Why the identifier is invalid. */
  reason?: NifInvalidReason;
  /** Shape the identifier was recognised as, even when invalid (helps error messages). */
  shape?: Exclude<NifKind, 'INVALID'>;
}

/**
 * Legal form implied by the first letter of a CIF.
 * Source: Orden EHA/451/2008 (composición del NIF de personas jurídicas).
 */
export const CIF_ENTITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  A: 'Sociedad anónima',
  B: 'Sociedad de responsabilidad limitada',
  C: 'Sociedad colectiva',
  D: 'Sociedad comanditaria',
  E: 'Comunidad de bienes / herencia yacente',
  F: 'Sociedad cooperativa',
  G: 'Asociación / fundación',
  H: 'Comunidad de propietarios (propiedad horizontal)',
  J: 'Sociedad civil',
  N: 'Entidad extranjera',
  P: 'Corporación local',
  Q: 'Organismo público',
  R: 'Congregación o institución religiosa',
  S: 'Órgano de la Administración del Estado o autonómica',
  U: 'Unión temporal de empresas (UTE)',
  V: 'Otro tipo no definido',
  W: 'Establecimiento permanente de entidad no residente',
});

/** Entity letters whose control character must be a digit. */
const CIF_DIGIT_CONTROL: ReadonlySet<string> = new Set(['A', 'B', 'E', 'H']);
/** Entity letters whose control character must be a letter. */
const CIF_LETTER_CONTROL: ReadonlySet<string> = new Set(['K', 'P', 'Q', 'S', 'N', 'R', 'W']);
/** Entity letters that accept either a digit or a letter. */
const CIF_EITHER_CONTROL: ReadonlySet<string> = new Set(['C', 'D', 'F', 'G', 'J', 'U', 'V']);

/**
 * Control letter for a personal number.
 * @param n the numeric part (DNI: 8 digits; NIE: prefix letter mapped to 0/1/2 followed by 7 digits)
 */
export function dniLetter(n: number): string {
  return DNI_LETTERS.charAt(((n % 23) + 23) % 23);
}

/**
 * CIF control digit for the 7-digit central block.
 *
 * A = sum of the digits in even positions (2nd, 4th, 6th);
 * B = sum of the digit sums of 2× each odd-position digit (1st, 3rd, 5th, 7th);
 * C = (10 − ((A + B) mod 10)) mod 10.
 */
export function cifControlDigit(digits7: string): number {
  if (!/^\d{7}$/.test(digits7)) {
    throw new RangeError('cifControlDigit expects exactly 7 digits');
  }
  let a = 0;
  let b = 0;
  for (let i = 0; i < 7; i++) {
    const d = digits7.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      a += d; // 2nd, 4th, 6th position (0-based index 1, 3, 5)
    } else {
      const twice = d * 2;
      b += twice > 9 ? twice - 9 : twice;
    }
  }
  return (10 - ((a + b) % 10)) % 10;
}

/**
 * Canonical form of a NIF-like string.
 *
 * - upper case, NFKC;
 * - spaces, dots, hyphens, underscores and slashes removed;
 * - an `ES` VAT-number prefix removed when it precedes a 9-character identifier;
 * - personal numbers padded with leading zeros (`1234567L` → `01234567L`,
 *   `X123456L` → `X0123456L`).
 *
 * The result is not validated; use {@link validateNif} for that.
 */
export function normaliseNif(raw: string | null | undefined): string {
  if (raw == null) return '';
  let s = String(raw)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
  if (s.length === 11 && s.startsWith('ES')) s = s.slice(2);
  const dni = /^(\d{1,8})([A-Z])$/.exec(s);
  if (dni) return (dni[1] ?? '').padStart(8, '0') + (dni[2] ?? '');
  const nie = /^([XYZ])(\d{1,7})([A-Z])$/.exec(s);
  if (nie) return (nie[1] ?? '') + (nie[2] ?? '').padStart(7, '0') + (nie[3] ?? '');
  return s;
}

function invalid(
  normalised: string,
  reason: NifInvalidReason,
  shape?: Exclude<NifKind, 'INVALID'>,
  entityLetter?: string,
): NifValidation {
  const out: NifValidation = { valid: false, kind: 'INVALID', normalised, reason };
  if (shape) out.shape = shape;
  if (entityLetter) {
    out.entityLetter = entityLetter;
    const label = CIF_ENTITY_LABELS[entityLetter];
    if (label) out.entityLabel = label;
  }
  return out;
}

function validateCif(n: string, entity: string, digits: string, control: string): NifValidation {
  const c = cifControlDigit(digits);
  const expectedDigit = String(c);
  const expectedLetter = CIF_CONTROL_LETTERS.charAt(c);
  const isDigit = /\d/.test(control);
  const acceptsDigit = CIF_DIGIT_CONTROL.has(entity) || CIF_EITHER_CONTROL.has(entity);
  const acceptsLetter = CIF_LETTER_CONTROL.has(entity) || CIF_EITHER_CONTROL.has(entity);

  const matches = isDigit ? control === expectedDigit : control === expectedLetter;
  if (!matches) {
    // A control that matches the other representation is a type error, not a checksum error.
    const otherMatches = isDigit ? control === expectedLetter : control === expectedDigit;
    return invalid(n, otherMatches ? 'control_type' : 'checksum', 'CIF', entity);
  }
  if ((isDigit && !acceptsDigit) || (!isDigit && !acceptsLetter)) {
    return invalid(n, 'control_type', 'CIF', entity);
  }
  const out: NifValidation = {
    valid: true,
    kind: 'CIF',
    normalised: n,
    entityLetter: entity,
    shape: 'CIF',
  };
  const label = CIF_ENTITY_LABELS[entity];
  if (label) out.entityLabel = label;
  return out;
}

/**
 * Validate a Spanish tax identifier.
 *
 * - DNI: 8 digits + control letter `DNI_LETTERS[n mod 23]`.
 * - NIE: X/Y/Z + 7 digits + control letter, with X→0, Y→1, Z→2 prefixed before the modulo.
 * - CIF: entity letter + 7 digits + control (digit or letter depending on the entity letter).
 * - Special personal numbers K/L/M: letter + 7 digits + control letter computed like a DNI
 *   over the 7 digits. A `K` number that fails as a personal number is retried as a legacy
 *   CIF with letter control.
 */
export function validateNif(raw: string | null | undefined): NifValidation {
  const n = normaliseNif(raw);
  if (!n) return invalid(n, 'empty');

  const dni = /^(\d{8})([A-Z])$/.exec(n);
  if (dni) {
    const ok = dniLetter(Number(dni[1])) === dni[2];
    return ok
      ? { valid: true, kind: 'DNI', normalised: n, shape: 'DNI' }
      : invalid(n, 'checksum', 'DNI');
  }

  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(n);
  if (nie) {
    const prefix = { X: 0, Y: 1, Z: 2 }[nie[1] ?? 'X'] ?? 0;
    const ok = dniLetter(Number(`${prefix}${nie[2] ?? ''}`)) === nie[3];
    return ok
      ? { valid: true, kind: 'NIE', normalised: n, shape: 'NIE' }
      : invalid(n, 'checksum', 'NIE');
  }

  const special = /^([KLM])(\d{7})([A-Z])$/.exec(n);
  if (special) {
    const ok = dniLetter(Number(special[2])) === special[3];
    if (ok) return { valid: true, kind: 'SPECIAL', normalised: n, shape: 'SPECIAL' };
    if (special[1] === 'K') {
      const asCif = validateCif(n, 'K', special[2] ?? '', special[3] ?? '');
      if (asCif.valid) return asCif;
    }
    return invalid(n, 'checksum', 'SPECIAL');
  }

  const cif = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(n);
  if (cif) {
    return validateCif(n, cif[1] ?? '', cif[2] ?? '', cif[3] ?? '');
  }

  // Recognisable but unusable shapes: give a hint of what was attempted.
  if (/^[A-Z]\d{7}[A-Z0-9]$/.test(n)) return invalid(n, 'format', 'CIF', n.charAt(0));
  return invalid(n, 'format');
}

/** True when the identifier belongs to a natural person (DNI, NIE or special K/L/M). */
export function isNaturalPersonNif(v: NifValidation): boolean {
  return v.valid && (v.kind === 'DNI' || v.kind === 'NIE' || v.kind === 'SPECIAL');
}
