/**
 * Thin bridge to `@viladomat/core`'s identifier math, imported by relative path (this
 * directory is not a workspace package) so every invented NIF/CIF/IBAN in the synthetic
 * corpus is constructed with, and re-verified by, the exact same checksum code the real
 * system uses. Nothing here talks to a database.
 */
import {
  cifControlDigit,
  CIF_CONTROL_LETTERS,
  dniLetter,
  validateNif,
  type NifValidation,
} from '../../../packages/core/src/ids/nif.ts';
import { cccToIban, computeCccDc, validateIban } from '../../../packages/core/src/ids/iban.ts';

export { validateNif, validateIban };
export type { NifValidation };

/** Build a valid CIF for an entity letter with a digit control character (A, B, E, H, ...). */
export function makeCifDigitControl(entityLetter: string, digits7: string): string {
  if (!/^\d{7}$/.test(digits7)) throw new RangeError('digits7 must be 7 digits');
  const control = String(cifControlDigit(digits7));
  const cif = `${entityLetter}${digits7}${control}`;
  const v = validateNif(cif);
  if (!v.valid) throw new RangeError(`generated CIF failed self-check: ${cif}`);
  return cif;
}

/** Build a valid CIF for an entity letter with a letter control character (K, P, Q, S, ...). */
export function makeCifLetterControl(entityLetter: string, digits7: string): string {
  if (!/^\d{7}$/.test(digits7)) throw new RangeError('digits7 must be 7 digits');
  const control = CIF_CONTROL_LETTERS.charAt(cifControlDigit(digits7));
  const cif = `${entityLetter}${digits7}${control}`;
  const v = validateNif(cif);
  if (!v.valid) throw new RangeError(`generated CIF failed self-check: ${cif}`);
  return cif;
}

/** Build a valid DNI (natural person) from an 8-digit number. */
export function makeDni(digits8: string): string {
  if (!/^\d{8}$/.test(digits8)) throw new RangeError('digits8 must be 8 digits');
  const dni = `${digits8}${dniLetter(Number(digits8))}`;
  const v = validateNif(dni);
  if (!v.valid) throw new RangeError(`generated DNI failed self-check: ${dni}`);
  return dni;
}

/** Build a valid Spanish IBAN from a fictitious 4-digit entity code, office and account. */
export function makeIban(entidad: string, oficina: string, cuenta: string): string {
  const iban = cccToIban(entidad, oficina, cuenta);
  const v = validateIban(iban);
  if (!v.valid) throw new RangeError(`generated IBAN failed self-check: ${iban}`);
  return iban;
}

/** Pretty-print an IBAN in 4-character groups, as printed on real documents. */
export function formatIbanPrinted(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

/** Compute just the CCC control digits (used by the Norma 43 writer, not by invoices). */
export function cccControlDigits(entidad: string, oficina: string, cuenta: string): string {
  return computeCccDc(entidad, oficina, cuenta);
}
