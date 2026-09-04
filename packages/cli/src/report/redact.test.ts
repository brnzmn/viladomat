import { describe, expect, it } from 'vitest';
import {
  emptyRedactionContext,
  isNaturalPersonCounterparty,
  looksLikeBusiness,
  maskIban,
  OTHER_OWNER_UNIT,
  PARTICULAR,
  PRESIDENCY_UNIT,
  redactBankRow,
  redactCounterpartyName,
  redactIbansInText,
  redactRecord,
  redactText,
  unitDisplay,
  type RedactionContext,
} from './redact.ts';

function ctx(lang: 'es' | 'en' = 'es'): RedactionContext {
  const c = emptyRedactionContext(lang);
  c.unitLabels.set('u-president', 'Pral 1a');
  c.unitLabels.set('u-other', '3r 2a');
  c.presidentUnitIds.add('u-president');
  c.presidentUnitLabels.add('pral 1a');
  c.businessNames.add('reformes exemple sl');
  return c;
}

describe('counterparty names', () => {
  it('keeps entity names: a vendor on an invoice is business data', () => {
    expect(looksLikeBusiness('Reformes Exemple SL')).toBe(true);
    expect(looksLikeBusiness('Ascensors Barcelona, S.A.')).toBe(true);
    expect(looksLikeBusiness('Endesa Energia XXI')).toBe(true);
    expect(redactCounterpartyName({ name: 'Reformes Exemple SL' }, ctx())).toBe('Reformes Exemple SL');
  });

  it('replaces a natural person by the neutral placeholder in both languages', () => {
    expect(looksLikeBusiness('Joan Puig Ferrer')).toBe(false);
    expect(redactCounterpartyName({ name: 'Joan Puig Ferrer' }, ctx('es'))).toBe(PARTICULAR.es);
    expect(redactCounterpartyName({ name: 'Joan Puig Ferrer' }, ctx('en'))).toBe(PARTICULAR.en);
  });

  it('keeps a name the party table knows to be an entity even without a legal form', () => {
    const c = ctx();
    c.businessNames.add('serralleria del mig');
    expect(redactCounterpartyName({ name: 'Serralleria del Mig' }, c)).toBe('Serralleria del Mig');
  });

  it('errs towards redacting a name that neither the token list nor the party table recognises', () => {
    expect(redactCounterpartyName({ name: 'Ferreteria Nova' }, ctx())).toBe(PARTICULAR.es);
  });

  it('trusts the matcher: a person_beneficiary flag redacts whatever the name looks like', () => {
    expect(isNaturalPersonCounterparty({ name: 'Something SL', flags: ['person_beneficiary'] }, ctx())).toBe(true);
  });

  it('keeps a name that resolved to a business party row', () => {
    expect(isNaturalPersonCounterparty({ name: 'Joan Puig Ferrer', partyKind: 'vendor' }, ctx())).toBe(false);
  });
});

describe('IBANs', () => {
  it('keeps four digits of a full IBAN', () => {
    expect(maskIban('ES9121000418450200051332')).toBe('**** 1332');
    expect(maskIban('1332')).toBe('**** 1332');
    expect(maskIban(null)).toBe('');
  });

  it('sweeps IBANs out of free text, spaced or not', () => {
    expect(redactIbansInText('transferencia a ES91 2100 0418 4502 0005 1332 el 1 de junio')).toBe(
      'transferencia a ES** **** 1332 el 1 de junio',
    );
    expect(redactIbansInText('IBAN ES9121000418450200051332 concepto obras')).toBe('IBAN ES** **** 1332 concepto obras');
  });
});

describe('units', () => {
  it("labels the presidency's units by role and other owners' units by label", () => {
    expect(unitDisplay({ id: 'u-president' }, ctx())).toBe(PRESIDENCY_UNIT.es);
    expect(unitDisplay({ label: 'Pral 1a' }, ctx())).toBe(PRESIDENCY_UNIT.es);
    expect(unitDisplay({ id: 'u-other' }, ctx())).toBe('3r 2a');
    expect(unitDisplay({ id: 'u-unknown' }, ctx())).toBe(OTHER_OWNER_UNIT.es);
    expect(unitDisplay({ id: 'u-president' }, ctx('en'))).toBe(PRESIDENCY_UNIT.en);
  });

  it("rewrites the presidency's unit label where it appears in prose", () => {
    expect(redactText('Recibo de la unidad Pral 1a de junio', ctx())).toBe('Recibo de la unidad unidad del rol de presidencia de junio');
    expect(redactText('Recibo de la unidad 3r 2a de junio', ctx())).toBe('Recibo de la unidad 3r 2a de junio');
  });
});

describe('bank rows', () => {
  it('redacts the person, the IBAN and the unit, and keeps the vendor', () => {
    const row = {
      fecha_operacion: '2024-06-01',
      importe: '-900.00',
      counterparty_name_norm: 'Joan Puig Ferrer',
      counterparty_iban_last4: '1332',
      counterparty_iban_hmac: 'abcdef0123456789abcdef',
      concepto_text: 'transferencia ES9121000418450200051332 obras Pral 1a',
      unit_id: 'u-president',
      flags: [],
    };
    const out = redactBankRow(row, ctx());
    expect(out.counterparty_name_norm).toBe(PARTICULAR.es);
    expect(out.counterparty_iban_last4).toBe('**** 1332');
    expect(out.counterparty_iban_hmac).toBe('abcdef01…');
    expect(out.concepto_text).toBe('transferencia ES** **** 1332 obras unidad del rol de presidencia');
    expect(out.unit_label).toBe(PRESIDENCY_UNIT.es);
    expect(out.unit_id).toBeUndefined();
    expect(out.importe).toBe('-900.00');

    const vendorRow = { ...row, counterparty_name_norm: 'Reformes Exemple SL', unit_id: null };
    expect(redactBankRow(vendorRow, ctx(), 'vendor').counterparty_name_norm).toBe('Reformes Exemple SL');
  });
});

describe('data-room records', () => {
  it('masks hashes and IBAN fragments and names units, leaving business columns alone', () => {
    const out = redactRecord(
      {
        id: 'x',
        vendor: 'Reformes Exemple SL',
        total: '1210.00',
        iban_shown_last4: '1332',
        iban_hmac: 'deadbeefdeadbeefdeadbeef',
        unit_id: 'u-other',
        descripcion: 'transferencia ES9121000418450200051332',
        empty: null,
      },
      ctx(),
    );
    expect(out).toEqual({
      id: 'x',
      vendor: 'Reformes Exemple SL',
      total: '1210.00',
      iban_shown_last4: '**** 1332',
      iban_hmac: 'deadbeef…',
      unit_label: '3r 2a',
      descripcion: 'transferencia ES** **** 1332',
      empty: null,
    });
  });
});
