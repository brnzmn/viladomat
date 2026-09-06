import { describe, expect, it } from 'vitest';
import {
  CHECK_PARTY_NIF_KIND,
  emptyRedactionContext,
  isNaturalPersonCheckRow,
  isNaturalPersonCounterparty,
  looksLikeBusiness,
  maskIban,
  OTHER_OWNER_UNIT,
  PARTICULAR,
  PRESIDENCY_UNIT,
  redactBankRow,
  redactCounterpartyName,
  redactExternalCheckRow,
  redactIbansInText,
  redactRecord,
  redactText,
  stripPersonNames,
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

describe('registry lookups made for a natural person', () => {
  // A sole trader's lookups as the checks write them: the name as printed on the invoice sits in
  // the request of several checks, in the search terms of a manual route and, for a legal person
  // only, in the census result. The placeholder stands for a person's name; no real name is used.
  const NAME = 'SOLE TRADER NAME PLACEHOLDER';
  const censusRow = {
    id: 'c-1',
    party_id: 'p-1',
    check_type: 'aeat_census',
    status: 'ok',
    request: JSON.stringify({ nif: '12345678Z', name_sent: NAME, natural_person: true, endpoint: 'https://example.test/vnif' }),
    normalised: JSON.stringify({
      census_match: true,
      result: 'IDENTIFICADO',
      nif: '12345678Z',
      name_sent: NAME,
      name_registered: null,
      natural_person: true,
      source_verified: false,
      manual: { url: 'https://example.test/G321', query: '12345678Z' },
    }),
    [CHECK_PARTY_NIF_KIND]: 'DNI',
  };

  it('recognises the row by the party identifier kind or by the check’s own flag', () => {
    expect(isNaturalPersonCheckRow(censusRow)).toBe(true);
    expect(isNaturalPersonCheckRow({ ...censusRow, [CHECK_PARTY_NIF_KIND]: null })).toBe(true);
    expect(
      isNaturalPersonCheckRow({
        request: JSON.stringify({ nif: 'B12345674', name: 'OBRES EXEMPLE SL' }),
        normalised: JSON.stringify({ registered: true }),
        [CHECK_PARTY_NIF_KIND]: 'CIF',
      }),
    ).toBe(false);
    expect(isNaturalPersonCheckRow({ request: null, normalised: null, [CHECK_PARTY_NIF_KIND]: 'NIE' })).toBe(true);
    expect(isNaturalPersonCheckRow({ request: null, normalised: null })).toBe(false);
  });

  it('drops the names at every depth of the request and the result and keeps the outcome', () => {
    const out = redactExternalCheckRow(censusRow);
    expect(CHECK_PARTY_NIF_KIND in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('PLACEHOLDER');
    expect(JSON.parse(String(out.request))).toEqual({
      nif: '12345678Z',
      natural_person: true,
      endpoint: 'https://example.test/vnif',
    });
    expect(JSON.parse(String(out.normalised))).toEqual({
      census_match: true,
      result: 'IDENTIFICADO',
      nif: '12345678Z',
      natural_person: true,
      source_verified: false,
      manual: { url: 'https://example.test/G321' },
    });
    // The other shapes the checks write: a search term equal to the name, nested search terms,
    // entries and grant rows naming the beneficiary, manual search terms of "identifier · name".
    const stripped = stripPersonNames({
      term: NAME,
      name: NAME,
      nif: '12345678Z',
      searched: { nif: '12345678Z', name: NAME },
      entries: [{ registration_number: '09/08/0004567', name: NAME, nif: null }],
      grants: [{ reference: 'r1', beneficiary: `***5678** ${NAME}`, amount: 100 }],
      query: `12345678Z · ${NAME}`,
      evidence_required: ['the result page with the search terms and the date'],
    });
    expect(JSON.stringify(stripped)).not.toContain('PLACEHOLDER');
    expect(stripped).toEqual({
      nif: '12345678Z',
      searched: { nif: '12345678Z' },
      entries: [{ registration_number: '09/08/0004567', nif: null }],
      grants: [{ reference: 'r1', amount: 100 }],
      evidence_required: ['the result page with the search terms and the date'],
    });
  });

  it('applies to a row flagged only by the party identifier kind, whatever the check wrote', () => {
    const out = redactExternalCheckRow({
      check_type: 'company_profile',
      request: JSON.stringify({ term: NAME, nif: null, name: NAME, endpoint: 'https://example.test/search' }),
      normalised: JSON.stringify({ note: 'No profile matched.', searched: { name: NAME } }),
      [CHECK_PARTY_NIF_KIND]: 'nie',
    });
    expect(JSON.stringify(out)).not.toContain('PLACEHOLDER');
    expect(JSON.parse(String(out.request))).toEqual({ nif: null, endpoint: 'https://example.test/search' });
    expect(JSON.parse(String(out.normalised))).toEqual({ note: 'No profile matched.', searched: {} });
  });

  it('leaves a legal person’s row as read, apart from the helper column', () => {
    const row = {
      check_type: 'aeat_census',
      request: JSON.stringify({ nif: 'B12345674', name_sent: 'OBRES EXEMPLE BARNA SL', natural_person: false }),
      normalised: JSON.stringify({ census_match: true, name_registered: 'OBRES EXEMPLE BARNA SL', natural_person: false }),
      [CHECK_PARTY_NIF_KIND]: 'CIF',
    };
    const out = redactExternalCheckRow(row);
    expect(out.request).toBe(row.request);
    expect(out.normalised).toBe(row.normalised);
    expect(CHECK_PARTY_NIF_KIND in out).toBe(false);
  });

  it('tolerates parsed payloads, null payloads and text that is not JSON', () => {
    const parsed = redactExternalCheckRow({
      request: { nif: '12345678Z', name: NAME, natural_person: true },
      normalised: null,
      [CHECK_PARTY_NIF_KIND]: 'DNI',
    });
    expect(parsed.request).toEqual({ nif: '12345678Z', natural_person: true });
    expect(parsed.normalised).toBeNull();
    const unreadable = redactExternalCheckRow({
      request: `not json ${NAME}`,
      normalised: '{}',
      [CHECK_PARTY_NIF_KIND]: 'DNI',
    });
    expect(String(unreadable.request)).not.toContain('PLACEHOLDER');
    expect(JSON.parse(String(unreadable.request))).toHaveProperty('redacted');
  });
});
