/**
 * Static, invented fixtures shared by every document model: the community, its units, and
 * the vendors/roles that issue or receive money. Every name, address, NIF and IBAN here is
 * fabricated for this test corpus (see docs/neutrality.md) — none refers to a real person,
 * company or bank. NIFs/IBANs are constructed with `@viladomat/core`'s own checksum math
 * (see lib/core-ids.ts) so they validate exactly as a real one would.
 */
import { makeCifDigitControl, makeDni, makeIban, validateIban, validateNif } from './core-ids.ts';

export const COMMUNITY_BANK = { entidad: '9010', oficina: '0001', cuenta: '0000000001' } as const;

export const COMMUNITY = {
  name: 'Comunitat de Propietaris Carrer Exemple 1',
  nif: 'H00000000',
  address: 'Carrer Exemple 1, 08015 Barcelona',
  bankName: 'Banc Exemple',
  iban: makeIban(COMMUNITY_BANK.entidad, COMMUNITY_BANK.oficina, COMMUNITY_BANK.cuenta),
} as const;

export interface Unit {
  label: string;
  quotaPct: number;
  use?: 'storage' | 'commercial' | 'dwelling';
}

/** 13 units, quotas summing to exactly 100.00. "Pral 1a" is used by the planted C11 line. */
export const UNITS: readonly Unit[] = [
  { label: 'Sot 1', quotaPct: 3.5, use: 'storage' },
  { label: 'Sot 2', quotaPct: 3.5, use: 'storage' },
  { label: 'Bxs 1a', quotaPct: 6.5, use: 'commercial' },
  { label: 'Bxs 2a', quotaPct: 6.5, use: 'commercial' },
  { label: 'Entl 1a', quotaPct: 8.0 },
  { label: 'Entl 2a', quotaPct: 8.0 },
  { label: 'Pral 1a', quotaPct: 8.5 },
  { label: 'Pral 2a', quotaPct: 8.5 },
  { label: '1r 1a', quotaPct: 9.25 },
  { label: '1r 2a', quotaPct: 9.25 },
  { label: '2n 1a', quotaPct: 9.25 },
  { label: '2n 2a', quotaPct: 9.25 },
  { label: '3r 1a', quotaPct: 10.0 },
];

const quotaSum = UNITS.reduce((a, u) => a + u.quotaPct, 0);
if (Math.abs(quotaSum - 100) > 1e-9) {
  throw new RangeError(`UNITS quotas must sum to 100.00, got ${quotaSum}`);
}

/** Role holding the presidency (roles only — never a person's name; see docs/neutrality.md). */
export const PRESIDENT_UNIT = 'Entl 1a';
export const DERRAMA_MONTHLY = 60.0;

export interface Vendor {
  key: string;
  name: string;
  nif: string;
  address: string;
  iban: string;
  bankLabel: string;
  isNaturalPerson?: boolean;
}

function bankIban(entidad: string, oficina: string, cuenta: string): string {
  return makeIban(entidad, oficina, cuenta);
}

export const VENDORS: Record<string, Vendor> = {
  ascensors: {
    key: 'ascensors',
    name: 'Ascensors Exemple S.A.',
    nif: makeCifDigitControl('A', '1112223'),
    address: 'Polígon Industrial Exemple, Carrer B 12, 08210 Barberà del Vallès',
    iban: bankIban('9011', '0001', '0000000101'),
    bankLabel: 'Caixa Model',
  },
  installacions: {
    key: 'installacions',
    name: 'Instal·lacions Exemple S.L.',
    nif: makeCifDigitControl('B', '2223334'),
    address: 'Carrer del Taller 8, 08014 Barcelona',
    iban: bankIban('9012', '0001', '0000000102'),
    bankLabel: 'Banc de Mostra',
  },
  construccions: {
    key: 'construccions',
    name: 'Construccions Model S.L.',
    nif: makeCifDigitControl('B', '3334445'),
    address: 'Carrer de la Construcció 22, 08020 Barcelona',
    iban: bankIban('9013', '0001', '0000000103'),
    bankLabel: 'Caixa Referència',
  },
  pintures: {
    key: 'pintures',
    name: 'Pintures Mostra S.L.',
    nif: makeCifDigitControl('B', '4445556'),
    address: 'Carrer de la Pintura 5, 08016 Barcelona',
    iban: bankIban('9014', '0001', '0000000104'),
    bankLabel: 'Banc Model',
  },
  fusteria: {
    key: 'fusteria',
    name: 'Fusteria Referència S.L.',
    nif: makeCifDigitControl('B', '5556667'),
    address: 'Carrer de la Fusteria 3, 08030 Barcelona',
    // Printed on the invoice — deliberately different from the IBAN the bank transfer
    // actually reached (see planted item "iban-mismatch"). Both bank codes are fictitious.
    iban: bankIban('9015', '0001', '0000000105'),
    bankLabel: 'Banc de Mostra',
  },
  arquitecte: {
    key: 'arquitecte',
    name: 'Arquitecte Tècnic Exemple',
    nif: makeDni('12345678'),
    address: "Carrer de l'Arquitectura 2, 08015 Barcelona",
    iban: bankIban('9017', '0001', '0000000107'),
    bankLabel: 'Caixa Model',
    isNaturalPerson: true,
  },
  neteges: {
    key: 'neteges',
    name: 'Neteges Exemple S.L.',
    nif: makeCifDigitControl('B', '6667778'),
    address: 'Carrer de la Neteja 9, 08018 Barcelona',
    iban: bankIban('9018', '0001', '0000000108'),
    bankLabel: 'Banc Model',
  },
  administracio: {
    key: 'administracio',
    name: 'Administracions Exemple S.L.',
    nif: makeCifDigitControl('B', '7778889'),
    address: "Carrer de l'Administració 14, 08013 Barcelona",
    iban: bankIban('9019', '0001', '0000000109'),
    bankLabel: 'Banc Exemple',
  },
};

/** The IBAN the bank transfer to Fusteria Referència actually reached — differs from
 * `VENDORS.fusteria.iban` (printed on the invoice). Both validate; only the account differs
 * in its final digits, which is exactly the shape of a payee-IBAN-mismatch finding (B4/B5). */
export const FUSTERIA_IBAN_ACTUAL = bankIban('9015', '0001', '0000000205');

// Self-check every fixture identifier at module load: a bug here must fail loudly, not
// silently ship an invalid NIF/IBAN inside a "clean" synthetic document.
for (const v of Object.values(VENDORS)) {
  const n = validateNif(v.nif);
  if (!n.valid) throw new RangeError(`fixture vendor ${v.key} has an invalid NIF: ${v.nif}`);
  const i = validateIban(v.iban);
  if (!i.valid) throw new RangeError(`fixture vendor ${v.key} has an invalid IBAN: ${v.iban}`);
}
{
  const i = validateIban(FUSTERIA_IBAN_ACTUAL);
  if (!i.valid) throw new RangeError('FUSTERIA_IBAN_ACTUAL is invalid');
  const cn = validateNif(COMMUNITY.nif);
  if (!cn.valid) throw new RangeError('COMMUNITY.nif is invalid');
  const ci = validateIban(COMMUNITY.iban);
  if (!ci.valid) throw new RangeError('COMMUNITY.iban is invalid');
}
