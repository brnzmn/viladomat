/**
 * Parser tests for every check, against recorded (synthetic) fixture responses.
 *
 * No test touches the network: `ctx.fetch` is a fixture player that answers by URL fragment, and
 * the rate limiter is stubbed so the suite does not sleep. The fixtures are shaped like the
 * responses the unverified sources are expected to return (as the research report established
 * them); when a field name turns out to be different, these tests are where the change lands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cccToIban } from '@viladomat/core';
import { REPO_ROOT } from '../lib/env.ts';
import { OPENMERCANTIL_API_KEY_VAR, RASIC_COLUMNS_VERIFIED, RASIC_DATASET_ID } from './config.ts';
import { resetRateLimiters } from './http.ts';
import {
  bdnsGrants,
  buildRaiscQuery,
  parseBdnsGrants,
  parseRaiscGrants,
  raiscGrants,
  soqlSafeName,
  splitBeneficiario,
  UNSAFE_QUERY_VALUE,
} from './checks/grants.ts';
import {
  companyProfile,
  parseCompanyProfile,
  parseEventsList,
  parseOfficersList,
  parseSearchResults,
  pickCandidate,
} from './checks/company-profile.ts';
import { catastroUnits, parseCatastroUnits, splitStreet } from './checks/catastro-units.ts';
import {
  buildRasicQuery,
  parseRasicRows,
  rasic,
  rasicRecordIsNaturalPerson,
  recordMentionsNif,
  withholdRasicPersonal,
  type RasicRow,
} from './checks/rasic.ts';
import { parseSurnameFrequency, surnameFrequency } from './checks/surname-frequency.ts';
import { nifValidate } from './checks/nif-validate.ts';
import { ibanValidate } from './checks/iban-validate.ts';
import { aeatCensus, insolvency, reaManual, registroMercantilNota } from './checks/manual.ts';
import { dgsfpManual } from './checks/dgsfp.ts';
import { CHECKS, checkByType, plannedVendorChecks, VENDOR_DEFAULT_CHECKS } from './checks/index.ts';
import type { CheckContext, CheckSubject, HttpRequestInit, HttpResponse } from './types.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** Undo the form encoding of a query string (`URLSearchParams` writes spaces as `+`). */
function decodedQuery(url: string): string {
  return decodeURIComponent(url.replace(/\+/g, ' '));
}

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

/** A `fetch` that answers from fixtures and records the URLs (and request inits) it was asked for. */
function fixtureFetch(
  routes: readonly Route[],
  seen: string[] = [],
  inits: Array<HttpRequestInit | undefined> = [],
): CheckContext['fetch'] {
  return (url: string, init?: HttpRequestInit) => {
    seen.push(url);
    inits.push(init);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    const body = route ? JSON.stringify(route.body) : '';
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(res);
  };
}

function ctxWith(
  routes: readonly Route[],
  seen: string[] = [],
  inits: Array<HttpRequestInit | undefined> = [],
): CheckContext {
  return {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch: fixtureFetch(routes, seen, inits),
    rateLimit: () => Promise.resolve(),
    timeoutMs: 10_000,
  };
}

const VENDOR: CheckSubject = {
  subjectType: 'party',
  subjectKey: '11111111-1111-1111-1111-111111111111',
  partyId: '11111111-1111-1111-1111-111111111111',
  name: 'OBRES EXEMPLE BARNA, S.L.',
  nif: 'B12345674',
  address: 'Carrer de Mostra 100, 08011 Barcelona',
};

const COMMUNITY: CheckSubject = {
  subjectType: 'community',
  subjectKey: 'H12345674',
  nif: 'H12345674',
  name: 'Comunitat exemple',
};

beforeEach(() => {
  resetRateLimiters();
});

describe('nif_validate', () => {
  it('reports the entity letter and its legal form for a CIF', async () => {
    const r = await nifValidate.run(VENDOR, ctxWith([]));
    expect(r.status).toBe('ok');
    expect(r.normalised.valid).toBe(true);
    expect(r.normalised.entity_letter).toBe('B');
    expect(r.normalised.entity_label).toBe('Sociedad de responsabilidad limitada');
    expect(r.normalised.natural_person).toBe(false);
    expect(r.source_url).toBeNull();
    expect(r.cost_cents).toBe(0);
  });

  it('records a wrong check digit without calling it incorrect', async () => {
    const r = await nifValidate.run({ ...VENDOR, nif: 'B12345670' }, ctxWith([]));
    expect(r.normalised.valid).toBe(false);
    expect(r.normalised.reason).toBe('checksum');
    expect(String(r.note)).toMatch(/Re-read the identifier/);
  });

  it('records the absence of an identifier as not_found, not as an error', async () => {
    const r = await nifValidate.run({ ...VENDOR, nif: null }, ctxWith([]));
    expect(r.status).toBe('not_found');
    expect(r.normalised.present).toBe(false);
  });
});

describe('iban_validate', () => {
  it('resolves the bank and follows an absorption chain, and never stores the account number', async () => {
    // Synthetic ES IBAN built from an absorbed entity code (0075 -> 0049).
    const iban = cccToIban('0075', '0001', '0000000001');
    const r = await ibanValidate.run({ ...VENDOR, iban }, ctxWith([]));
    expect(r.normalised.valid).toBe(true);
    expect(r.normalised.bank_code).toBe('0075');
    expect(r.normalised.current_bank_code).toBe('0049');
    expect(r.normalised.absorbed_into).toBe('0049');
    expect(String(r.note)).toMatch(/absorbed/);
    expect(JSON.stringify(r.raw)).not.toContain(iban.slice(4, 20));
    expect(r.normalised.last4).toBe('0001');
  });

  it('flags an invalid check digit', async () => {
    const r = await ibanValidate.run({ ...VENDOR, iban: 'ES0000000000000000000000' }, ctxWith([]));
    expect(r.normalised.valid).toBe(false);
  });
});

describe('company_profile', () => {
  const SEARCH = { match: '/search', body: fixture('company-profile-search.json') };

  it('parses the recorded detail response into officers, address, capital and the gazette timeline', () => {
    const profile = parseCompanyProfile(fixture('company-profile-detail.json'));
    expect(profile.nif).toBe('B12345674');
    expect(profile.incorporation_date).toBe('2021-11-08');
    expect(profile.capital_eur).toBe(3000);
    expect(profile.cnae).toBe('4399');
    expect(profile.officers).toHaveLength(2);
    expect(profile.officers[0]?.cargo).toBe('Administrador único');
    expect(profile.officers[0]?.borme_ref).toMatchObject({
      seccion: 'A',
      num: '224',
      pagina: '51234',
    });
    expect(profile.events.map((e) => e.date)).toEqual(['2021-11-22', '2022-03-28', '2023-07-11']);
    expect(profile.unread).toEqual([]);
  });

  it('lists what it could not read instead of guessing', () => {
    const profile = parseCompanyProfile({ company: { name: 'EXEMPLE SL' } });
    expect(profile.unread).toContain('incorporation_date');
    expect(profile.unread).toContain('capital_eur');
    expect(profile.unread).toContain('officers');
    expect(profile.incorporation_date).toBeNull();
  });

  it('reads the search items and prefers an exact identifier match over a name match', () => {
    const candidates = parseSearchResults(fixture('company-profile-search.json'));
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.id).toBe('obres-exemple-barna-sl');
    const chosen = pickCandidate(candidates, { nif: 'B58818501', name: 'OBRES EXEMPLE BARNA SL' });
    expect(chosen?.how).toBe('nif');
    expect(chosen?.candidate.id).toBe('exemple-serveis-generals-sl');
  });

  it('returns nothing when neither the identifier nor the name matches', () => {
    const chosen = pickCandidate(parseSearchResults(fixture('company-profile-search.json')), {
      name: 'ALGO COMPLETAMENT DIFERENT',
    });
    expect(chosen).toBeNull();
  });

  it('parses the officers and events sub-resources, events oldest first', () => {
    const officers = parseOfficersList(fixture('company-profile-officers.json'));
    expect(officers).toHaveLength(2);
    expect(officers[1]?.cargo).toBe('Apoderada');
    const events = parseEventsList(fixture('company-profile-events.json'));
    expect(events.map((e) => e.date)).toEqual(['2021-11-22', '2022-03-28', '2023-07-11']);
  });

  it('runs /search then /company/{slug} through ctx.fetch, keeps the attribution and reports the fallback route', async () => {
    const seen: string[] = [];
    const r = await companyProfile.run(
      VENDOR,
      ctxWith(
        [
          SEARCH,
          {
            match: '/company/obres-exemple-barna-sl',
            body: fixture('company-profile-detail.json'),
          },
        ],
        seen,
      ),
    );
    expect(r.status).toBe('ok');
    // The detail carried officers and events inline, so the two sub-resources were not fetched.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('/api/v1/search?q=B12345674&limit=5');
    expect(seen[1]).toContain('/api/v1/company/obres-exemple-barna-sl');
    expect(r.normalised.matched_by).toBe('nif');
    expect(r.normalised.source_verified).toBe(false);
    expect(Array.isArray(r.normalised.attributions)).toBe(true);
    expect((r.normalised.fallback as { url: string }).url).toContain('openmercantil.es');
    expect(r.request?.detail_endpoint).toContain('obres-exemple-barna-sl');
    expect(r.request?.api_key_used).toBe(false);
  });

  it('reads officers and events from their own paths when the detail does not carry them', async () => {
    const seen: string[] = [];
    const r = await companyProfile.run(
      VENDOR,
      ctxWith(
        [
          SEARCH,
          // The sub-resource routes come first: the bare detail fragment is a prefix of theirs.
          {
            match: '/company/obres-exemple-barna-sl/officers',
            body: fixture('company-profile-officers.json'),
          },
          {
            match: '/company/obres-exemple-barna-sl/events',
            body: fixture('company-profile-events.json'),
          },
          {
            match: '/company/obres-exemple-barna-sl',
            body: fixture('company-profile-detail-bare.json'),
          },
        ],
        seen,
      ),
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(4);
    expect(seen[2]).toMatch(/\/officers$/);
    expect(seen[3]).toMatch(/\/events$/);
    expect((r.normalised.officers as unknown[]).length).toBe(2);
    expect((r.normalised.events as Array<{ date: string }>).map((e) => e.date)).toEqual([
      '2021-11-22',
      '2022-03-28',
      '2023-07-11',
    ]);
    expect(r.normalised.unread).toEqual([]);
    expect(r.request?.officers_endpoint).toMatch(/\/officers$/);
  });

  describe('with an API key configured', () => {
    const saved = process.env[OPENMERCANTIL_API_KEY_VAR];
    beforeEach(() => {
      process.env[OPENMERCANTIL_API_KEY_VAR] = 'omk_fixture_key';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env[OPENMERCANTIL_API_KEY_VAR];
      else process.env[OPENMERCANTIL_API_KEY_VAR] = saved;
    });

    it('sends it as X-API-Key on every request and never in the stored request', async () => {
      const inits: Array<HttpRequestInit | undefined> = [];
      const r = await companyProfile.run(
        VENDOR,
        ctxWith(
          [
            SEARCH,
            {
              match: '/company/obres-exemple-barna-sl',
              body: fixture('company-profile-detail.json'),
            },
          ],
          [],
          inits,
        ),
      );
      expect(r.status).toBe('ok');
      expect(inits).toHaveLength(2);
      for (const init of inits) expect(init?.headers?.['X-API-Key']).toBe('omk_fixture_key');
      expect(r.request?.api_key_used).toBe(true);
      expect(JSON.stringify(r)).not.toContain('omk_fixture_key');
    });
  });

  it('turns a transport failure into an error result rather than throwing', async () => {
    const r = await companyProfile.run(VENDOR, {
      ...ctxWith([]),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toContain('ECONNREFUSED');
    expect(r.normalised.fallback).toBeDefined();
  });
});

describe('grants', () => {
  it('parses a BDNS response, splitting "NIF Razón social" into identifier and name', () => {
    const rows = parseBdnsGrants(fixture('bdns-concesiones.json'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.register).toBe('BDNS');
    expect(rows[0]?.beneficiary_nif).toBe('H12345674');
    expect(rows[0]?.beneficiary).toBe('COMUNITAT DE PROPIETARIS EXEMPLE 25');
    expect(rows[0]?.grantor).toBe("CONSORCI DE L'HABITATGE DE BARCELONA");
    expect(rows[0]?.level).toBe('LOCAL');
    expect(rows[0]?.call_number).toBe('700123');
    expect(rows[0]?.reference).toBe('9990001');
    expect(rows[1]?.amount_granted).toBe(30000);
    expect(rows[1]?.aid_equivalent).toBe(30000);
    expect(rows[1]?.amount_paid).toBeNull();
    expect(rows[1]?.url).toContain('700456');
  });

  it('never reads a masked beneficiary token as an identifier', () => {
    expect(splitBeneficiario('***3410** PERSONA FISICA EXEMPLE')).toEqual({
      nif: null,
      name: 'PERSONA FISICA EXEMPLE',
      masked: true,
    });
    expect(splitBeneficiario('H12345674 COMUNITAT EXEMPLE')).toEqual({
      nif: 'H12345674',
      name: 'COMUNITAT EXEMPLE',
      masked: false,
    });
    // A leading token that fails its check digit is part of the name, not an identifier.
    expect(splitBeneficiario('B12345670 EXEMPLE').nif).toBeNull();
    expect(splitBeneficiario('B12345670 EXEMPLE').name).toBe('B12345670 EXEMPLE');
  });

  it('queries BDNS by identifier with the established parameters and summarises the totals', async () => {
    const seen: string[] = [];
    const r = await bdnsGrants.run(
      COMMUNITY,
      ctxWith([{ match: 'concesiones/busqueda', body: fixture('bdns-concesiones.json') }], seen),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.count).toBe(2);
    expect(r.normalised.total_granted).toBe(48500);
    expect(r.normalised.total_elements).toBe(2);
    expect(r.normalised.years).toEqual(['2023', '2024']);
    expect(seen).toHaveLength(1);
    const url = seen[0] ?? '';
    for (const part of [
      'vpd=GE',
      'nifCif=H12345674',
      'page=0',
      'pageSize=50',
      'order=fechaConcesion',
      'direccion=desc',
    ])
      expect(url).toContain(part);
    expect(url).not.toContain('beneficiario=');
  });

  it('reports an empty BDNS answer as not_found with the non-exculpatory note', async () => {
    const r = await bdnsGrants.run(
      { subjectType: 'community', subjectKey: 'H12345674', nif: 'H12345674' },
      ctxWith([{ match: 'concesiones/busqueda', body: { content: [], totalElements: 0 } }]),
    );
    expect(r.status).toBe('not_found');
    expect(String(r.normalised.note)).toMatch(/not exculpatory/);
    expect(r.normalised.total_elements).toBe(0);
  });

  it('does not search BDNS by name and says why', async () => {
    const seen: string[] = [];
    const r = await bdnsGrants.run(
      { subjectType: 'party', subjectKey: 'k', name: 'OBRES EXEMPLE BARNA, S.L.' },
      ctxWith([], seen),
    );
    expect(r.status).toBe('not_found');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.note)).toMatch(/identifier only/);
  });

  it('refuses an identifier that fails its check digit before anything is sent', async () => {
    const seen: string[] = [];
    const r = await bdnsGrants.run({ ...COMMUNITY, nif: 'H12345670' }, ctxWith([], seen));
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toContain(UNSAFE_QUERY_VALUE);
  });

  it('keeps only the grant facts for a natural-person beneficiary', async () => {
    const r = await bdnsGrants.run(
      { subjectType: 'party', subjectKey: 'p', nif: '12345678Z' },
      ctxWith([
        {
          match: 'concesiones/busqueda',
          body: {
            content: [
              {
                id: 1,
                beneficiario: '***5678** PERSONA FISICA EXEMPLE',
                importe: 500,
                fechaConcesion: '2024-01-10',
              },
            ],
            totalElements: 1,
          },
        },
      ]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.natural_person).toBe(true);
    expect(
      (r.normalised.grants as Array<{ beneficiary: unknown; amount_granted: number }>)[0],
    ).toMatchObject({
      beneficiary: null,
      amount_granted: 500,
    });
    expect((r.raw as { redacted?: string }).redacted).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('PERSONA FISICA');
  });

  it('parses a RAISC (Socrata) response with the established columns and records the dataset id', async () => {
    const parsed = parseRaiscGrants(fixture('raisc-grants.json'));
    expect(parsed[0]).toMatchObject({
      register: 'RAISC',
      reference: 'RAISC-2024-000123',
      call_number: '700456',
      beneficiary_nif: 'H12345674',
      grantor: 'Generalitat de Catalunya',
      date: '2024-06-14',
      amount_granted: 30000,
      aid_equivalent: 30000,
    });
    const seen: string[] = [];
    const r = await raiscGrants.run(
      { subjectType: 'community', subjectKey: 'H12345674', nif: 'H12345674' },
      ctxWith([{ match: 's9xt-n979', body: fixture('raisc-grants.json') }], seen),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.dataset).toBe('s9xt-n979');
    expect(r.normalised.source_verified).toBe(false);
    expect(seen[0]).toContain('cif_beneficiari=H12345674');
    expect(seen[0]).toContain('limit=5000');
    expect(r.request?.searched_by).toBe('nif');
  });

  it('places a name in the RAISC $where clause only when it fits the safe class', async () => {
    const byName = buildRaiscQuery(null, "L'Espai Exemple, S.L.");
    expect(byName && 'url' in byName ? decodedQuery(byName.url) : '').toContain(
      "upper(ra_social_del_beneficiari) like '%L''ESPAI EXEMPLE, S.L.%'",
    );
    for (const unsafe of [
      'EXEMPLE; DROP',
      '100% EXEMPLE',
      'EXEMPLE_SL',
      'EXEMPLE (2)',
      'EXEMPLE "SL"',
    ]) {
      const q = buildRaiscQuery(null, unsafe);
      expect(q && 'error' in q ? q.error.message : '').toContain(UNSAFE_QUERY_VALUE);
    }
    expect(soqlSafeName('  Obres   Exemple ')).toBe('OBRES EXEMPLE');
    expect(soqlSafeName('Obres % Exemple')).toBeNull();
    expect(buildRaiscQuery(null, null)).toBeNull();

    const seen: string[] = [];
    const r = await raiscGrants.run(
      { subjectType: 'party', subjectKey: 'k', name: 'EXEMPLE; DROP' },
      ctxWith([], seen),
    );
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toContain(UNSAFE_QUERY_VALUE);
  });
});

describe('rasic', () => {
  /** A sole-trader row on the candidate columns; identifier, name and address are invented. */
  const PERSON_ROW = {
    n_mero_de_rasic: 'RASIC-EX-00077',
    nom_titular_actual: 'PERSONA FISICA EXEMPLE',
    nif: '12345678Z',
    adre_a: 'CARRER DE PROVA, 7',
    poblaci_: 'BARCELONA',
    codi_postal: '08012',
    prov_ncia: 'BARCELONA',
    activitats: ['Instal.lacions electriques - baixa tensio'],
    data_alta: '2019-06-01',
    situacio: 'alta',
  };
  /** What the check may keep of that row: the registration facts, nothing about the person. */
  const PERSON_FACTS: RasicRow = {
    registration_number: 'RASIC-EX-00077',
    name: null,
    nif: null,
    address: null,
    municipality: null,
    postcode: null,
    province: null,
    activities: ['Instal.lacions electriques - baixa tensio'],
    date_from: '2019-06-01',
    date_to: null,
    status: 'alta',
  };
  /** Strings of the person's row that must not survive anywhere in a result. */
  const PERSON_STRINGS = ['PERSONA FISICA', 'CARRER DE PROVA', '08012'];

  it('parses a register row on the candidate columns', () => {
    const rows = parseRasicRows(fixture('rasic.json'));
    expect(rows[0]).toMatchObject({
      registration_number: 'RASIC-EX-00042',
      name: 'ASCENSORS EXEMPLE, S.L.',
      nif: 'B58818501',
      municipality: 'BARCELONA',
      postcode: '08011',
      province: 'BARCELONA',
      date_from: '2015-04-01',
      status: 'alta',
    });
    expect(rows[0]?.activities).toHaveLength(2);
  });

  it('refuses to query while the dataset columns are unverified, and offers the manual route', async () => {
    expect(RASIC_COLUMNS_VERIFIED).toBe(false);
    expect(RASIC_DATASET_ID).toBe('exxq-fubu');
    const seen: string[] = [];
    const r = await rasic.run(VENDOR, ctxWith([], seen));
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toMatch(/columns not verified/);
    expect(r.normalised.source_verified).toBe(false);
    expect((r.normalised.manual as { url: string }).url).toContain('gencat');
  });

  it('runs once the register marks the source verified: full-text on the identifier, rows kept only when they carry it as a value', async () => {
    const seen: string[] = [];
    const ctx = {
      ...ctxWith([{ match: 'exxq-fubu', body: fixture('rasic.json') }], seen),
      sourceVerified: (id: string) => id === 'rasic',
    } as CheckContext;
    const r = await rasic.run(
      { ...VENDOR, nif: 'B58818501', name: 'ASCENSORS EXEMPLE, S.L.' },
      ctx,
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(decodedQuery(seen[0] ?? '')).toContain('$q=B58818501');
    expect(r.normalised.registered).toBe(true);
    expect(r.normalised.source_verified).toBe(true);
    const entries = r.normalised.entries as Array<{
      registration_number: string;
      name: string | null;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.registration_number).toBe('RASIC-EX-00042');
    // A company's row is business data: its name stays and the body is archived.
    expect(entries[0]?.name).toBe('ASCENSORS EXEMPLE, S.L.');
    expect(r.normalised.natural_person).toBe(false);
    expect(r.normalised.entries_withheld).toBe(0);
    expect(Array.isArray(r.raw)).toBe(true);
  });

  it('validates the identifier and the name before building a query', () => {
    const badNif = buildRasicQuery('B12345670', null);
    expect(badNif && 'error' in badNif ? badNif.error.message : '').toContain(UNSAFE_QUERY_VALUE);
    const badName = buildRasicQuery(null, 'OBRES; DROP');
    expect(badName && 'error' in badName ? badName.error.message : '').toContain(
      UNSAFE_QUERY_VALUE,
    );
    const byName = buildRasicQuery(null, 'OBRES EXEMPLE');
    expect(byName && 'url' in byName ? decodedQuery(byName.url) : '').toContain(
      "upper(nom_titular_actual) like '%OBRES EXEMPLE%'",
    );
    expect(buildRasicQuery(null, null)).toBeNull();
    expect(recordMentionsNif({ a: 'b58818501' }, 'B58818501')).toBe(true);
    expect(recordMentionsNif({ a: 'ref B58818501-2' }, 'B58818501')).toBe(false);
  });

  it('judges a record a natural person by the identifier it carries and withholds the personal fields', () => {
    expect(rasicRecordIsNaturalPerson({ nif: '12345678Z' })).toBe(true);
    expect(rasicRecordIsNaturalPerson({ cif_titular: 'X1234567L' })).toBe(true);
    // In a candidate column a misread check letter still leaves a person-shaped identifier.
    expect(rasicRecordIsNaturalPerson({ nif: '12345678A' })).toBe(true);
    expect(rasicRecordIsNaturalPerson({ nif: 'B58818501' })).toBe(false);
    // Whatever the column is called, a whole-cell valid person's identifier counts …
    expect(rasicRecordIsNaturalPerson({ nif_cif_titular: '12345678Z' })).toBe(true);
    // … but outside the candidate columns only a valid one does, and free text never does.
    expect(rasicRecordIsNaturalPerson({ nif_cif_titular: '12345678A' })).toBe(false);
    expect(rasicRecordIsNaturalPerson({ observacions: 'Vegeu expedient 12345678Z-2' })).toBe(false);
    expect(rasicRecordIsNaturalPerson({ nom_titular_actual: 'ASCENSORS EXEMPLE, S.L.' })).toBe(
      false,
    );
    expect(rasicRecordIsNaturalPerson(null)).toBe(false);
    const [row] = parseRasicRows([PERSON_ROW]);
    expect(row).toMatchObject({
      name: 'PERSONA FISICA EXEMPLE',
      nif: '12345678Z',
      postcode: '08012',
    });
    expect(withholdRasicPersonal(row as RasicRow)).toEqual(PERSON_FACTS);
  });

  it('keeps only the registration facts for a natural-person subject searched by identifier', async () => {
    const seen: string[] = [];
    const ctx = {
      ...ctxWith(
        [
          {
            match: 'exxq-fubu',
            body: [
              PERSON_ROW,
              {
                n_mero_de_rasic: 'RASIC-EX-00099',
                nom_titular_actual: 'INSTAL·LACIONS MOSTRA, S.L.',
                nif: 'B12345674',
                observacions: 'Vegeu expedient 12345678Z-2 (referencia interna)',
                situacio: 'alta',
              },
            ],
          },
        ],
        seen,
      ),
      sourceVerified: (id: string) => id === 'rasic',
    } as CheckContext;
    const r = await rasic.run(
      { subjectType: 'party', subjectKey: 'p', nif: '12345678Z', name: 'PERSONA FISICA EXEMPLE' },
      ctx,
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(decodedQuery(seen[0] ?? '')).toContain('$q=12345678Z');
    expect(r.normalised.registered).toBe(true);
    expect(r.normalised.natural_person).toBe(true);
    expect(r.normalised.entries_withheld).toBe(1);
    expect(r.normalised.entries).toEqual([PERSON_FACTS]);
    // The name on file is not a parameter of a search by identifier and is not copied in.
    expect(r.request?.natural_person).toBe(true);
    expect(r.request).not.toHaveProperty('name');
    expect(r.request?.nif).toBe('12345678Z');
    expect(r.raw).toEqual({
      redacted: 'natural person: only the registration facts are kept',
      http_status: 200,
    });
    const text = JSON.stringify(r);
    for (const leaked of PERSON_STRINGS) expect(text).not.toContain(leaked);
  });

  it('archives nothing for a natural-person subject the register does not list either', async () => {
    const r = await rasic.run(
      { subjectType: 'party', subjectKey: 'p', nif: '12345678Z', name: 'PERSONA FISICA EXEMPLE' },
      {
        ...ctxWith([{ match: 'exxq-fubu', body: [] }]),
        sourceVerified: (id: string) => id === 'rasic',
      } as CheckContext,
    );
    expect(r.status).toBe('not_found');
    expect(r.normalised.natural_person).toBe(true);
    expect(r.normalised.entries).toEqual([]);
    expect((r.raw as { redacted?: string }).redacted).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('PERSONA FISICA');
  });

  it('in a name search, judges each matched record by the identifier it carries: a person keeps the registration facts only and the body is not archived', async () => {
    const seen: string[] = [];
    const companyRow = (fixture('rasic.json') as unknown[])[0];
    // A person whose identifier sits under a column name the parser does not know.
    const personUnderOtherColumn = {
      n_mero_de_rasic: 'RASIC-EX-00078',
      nom_titular_actual: 'PERSONA FISICA EXEMPLE 2',
      nif_cif_titular: '12345678Z',
      poblaci_: 'GIRONA',
      situacio: 'alta',
    };
    const ctx = {
      ...ctxWith(
        [{ match: 'exxq-fubu', body: [companyRow, PERSON_ROW, personUnderOtherColumn] }],
        seen,
      ),
      sourceVerified: (id: string) => id === 'rasic',
    } as CheckContext;
    const r = await rasic.run({ subjectType: 'party', subjectKey: 'p', name: 'EXEMPLE' }, ctx);
    expect(r.status).toBe('ok');
    expect(decodedQuery(seen[0] ?? '')).toContain("like '%EXEMPLE%'");
    // The search term stays on the request so the lookup can be repeated; the subject itself
    // carried no identifier, so it is not flagged there.
    expect(r.request?.name).toBe('EXEMPLE');
    expect(r.request?.natural_person).toBe(false);
    // ... but a person's row matched: the result is flagged so the export redacts it as a whole.
    expect(r.normalised.natural_person).toBe(true);
    expect(r.normalised.entries_withheld).toBe(2);
    const entries = r.normalised.entries as RasicRow[];
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      registration_number: 'RASIC-EX-00042',
      name: 'ASCENSORS EXEMPLE, S.L.',
      nif: 'B58818501',
      municipality: 'BARCELONA',
    });
    expect(entries[1]).toEqual(PERSON_FACTS);
    expect(entries[2]).toEqual({
      ...PERSON_FACTS,
      registration_number: 'RASIC-EX-00078',
      activities: [],
      date_from: null,
    });
    expect((r.raw as { redacted?: string }).redacted).toBeDefined();
    const text = JSON.stringify(r);
    // The person's identifier was never on file: it must not enter the row through the register.
    for (const leaked of [...PERSON_STRINGS, '12345678Z', 'GIRONA'])
      expect(text).not.toContain(leaked);
  });
});

describe('catastro_units', () => {
  it('parses the building envelope into units with floor, door, surface and coefficient', () => {
    const { units, envelope } = parseCatastroUnits(fixture('catastro-dnploc.json'));
    expect(envelope).toBe('lrcdnp');
    expect(units).toHaveLength(3);
    expect(units[0]?.rc).toBe('9999XX9999XX0001AB');
    expect(units[0]?.floor).toBe('01');
    expect(units[0]?.door).toBe('01');
    expect(units[0]?.surface_m2).toBe(88);
    expect(units[0]?.coefficient_pct).toBeCloseTo(9.1, 5);
    expect(units[2]?.use).toBe('Comercial');
  });

  it('parses a single-property envelope too', () => {
    const { units, envelope } = parseCatastroUnits({
      consulta_dnp: {
        bico: {
          bi: {
            idbi: { rc: { pc1: 'AAAA11', pc2: 'BBBB22', car: '0007', cc1: 'X', cc2: 'Y' } },
            debi: { sfc: '64', cpt: '6.5' },
          },
        },
      },
    });
    expect(envelope).toBe('bico');
    expect(units).toHaveLength(1);
    expect(units[0]?.surface_m2).toBe(64);
  });

  it('splits a street line into the pieces the service expects', () => {
    expect(splitStreet('Carrer de Mostra 25')).toEqual({
      sigla: 'CL',
      calle: 'MOSTRA',
      numero: '25',
    });
    expect(splitStreet('Avinguda de la Prova, 100')).toEqual({
      sigla: 'AV',
      calle: 'PROVA',
      numero: '100',
    });
  });

  it('adds up the coefficients so the unit table can be compared with the title', async () => {
    const r = await catastroUnits.run(
      {
        subjectType: 'community',
        subjectKey: 'building',
        address: 'Carrer de Mostra 25',
        municipality: 'BARCELONA',
        province: 'BARCELONA',
      },
      ctxWith([{ match: 'Consulta_DNPLOC', body: fixture('catastro-dnploc.json') }]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.unit_count).toBe(3);
    expect(r.normalised.coefficient_sum_pct).toBeCloseTo(29.35, 4);
  });
});

describe('surname_frequency', () => {
  it('reads a published rate', () => {
    const f = parseSurnameFrequency(fixture('idescat-surname.json'), 'Exemple');
    expect(f.surname).toBe('EXEMPLE');
    expect(f.per_mille).toBe(0.07);
    expect(f.basis).toBe('published_rate');
  });

  it('derives a rate from a count when no rate is published', () => {
    const f = parseSurnameFrequency(fixture('idescat-surname-count-only.json'), 'Mostra');
    expect(f.basis).toBe('count_over_population');
    expect(f.per_mille).toBeCloseTo(10, 3);
  });

  it('says so rather than guessing when nothing is readable', () => {
    const f = parseSurnameFrequency({ onomastica: { ff: [{ cognom: 'MOSTRA' }] } }, 'Mostra');
    expect(f.basis).toBe('not_read');
    expect(f.per_mille).toBeNull();
  });

  it('reuses a cached response instead of querying again', async () => {
    const seen: string[] = [];
    const r = await surnameFrequency.run(
      { subjectType: 'surname', subjectKey: 'MOSTRA', extra: { surname: 'Mostra' } },
      {
        ...ctxWith([{ match: 'onomastica', body: fixture('idescat-surname.json') }], seen),
        cacheLookup: () =>
          Promise.resolve({ surname: 'MOSTRA', per_mille: 2.4, basis: 'published_rate' }),
      },
    );
    expect(seen).toHaveLength(0);
    expect(r.normalised.from_cache).toBe(true);
    expect(r.normalised.per_mille).toBe(2.4);
  });
});

describe('manual checks', () => {
  it('raise a manual_pending row carrying the page, the search terms and the evidence to capture', async () => {
    for (const check of [reaManual, aeatCensus, registroMercantilNota, insolvency, dgsfpManual]) {
      const r = await check.run(VENDOR, ctxWith([]));
      expect(r.status).toBe('manual_pending');
      expect(r.manual?.url).toMatch(/^https:\/\//);
      expect(r.manual?.evidence.length).toBeGreaterThan(0);
      expect(r.manual?.query).toBeTruthy();
      expect(String(r.normalised.note)).toMatch(/not exculpatory/);
    }
  });

  it('points the REA fallback and the insolvency search at the pages the research report established', async () => {
    expect(reaManual.type).toBe('rea_manual');
    const rea = await reaManual.run(VENDOR, ctxWith([]));
    expect(rea.manual?.url).toBe('https://expinterweb.mites.gob.es/rea/pub/consulta.htm');
    expect(rea.manual?.query).toBe('B12345674');
    const ins = await insolvency.run(VENDOR, ctxWith([]));
    expect(ins.manual?.url).toContain('consulta-publicidad-concursal-new');
    expect(String(ins.manual?.note)).toContain('#busquedaNif');
  });

  it('names both DGSFP registers for the insurance check', async () => {
    const r = await dgsfpManual.run(VENDOR, ctxWith([]));
    expect(r.type).toBe('dgsfp_manual');
    expect(r.manual?.url).toBe('https://rrpp.dgsfp.mineco.es/');
    expect(String(r.note)).toContain('https://rrpp.dgsfp.mineco.es/Mediador');
    expect(String(r.normalised.note)).toMatch(/Inscrita|Inscrito/);
  });

  it('prices the Registro Mercantil note so the reviewer knows it is a purchase', async () => {
    const r = await registroMercantilNota.run(VENDOR, ctxWith([]));
    expect(r.cost_cents).toBeGreaterThan(0);
  });
});

describe('check registry', () => {
  it('lists every type once, with the automated REA check under `rea` and the manual routes beside it', () => {
    const types = CHECKS.map((c) => c.type);
    expect(new Set(types).size).toBe(types.length);
    expect(checkByType('rea')?.manual).toBe(false);
    expect(checkByType('rea_manual')?.manual).toBe(true);
    expect(checkByType('dgsfp_manual')?.manual).toBe(true);
    expect(checkByType('rea')?.source).toBe('rea');
    expect(checkByType('rea_manual')?.source).toBe('rea_manual');
  });

  it('keeps the manual insurance and registry routes out of the default vendor set', () => {
    expect(VENDOR_DEFAULT_CHECKS).toContain('rea');
    expect(VENDOR_DEFAULT_CHECKS).toContain('catastro_units');
    for (const type of ['rea_manual', 'rasic_manual', 'dgsfp_manual'])
      expect(VENDOR_DEFAULT_CHECKS).not.toContain(type);
  });
});

describe('check planning per party', () => {
  it('plans the Cadastre lookup only for a party with an address on record', () => {
    const withAddress = plannedVendorChecks(
      { kind: 'vendor', address_norm: 'carrer de mostra 100, 08011 barcelona' },
      null,
    );
    expect(withAddress).toEqual([...VENDOR_DEFAULT_CHECKS]);
    expect(withAddress).toContain('catastro_units');
    for (const address of [null, '', '   ']) {
      const without = plannedVendorChecks({ kind: 'vendor', address_norm: address }, null);
      expect(without).not.toContain('catastro_units');
      expect(without).toEqual(VENDOR_DEFAULT_CHECKS.filter((t) => t !== 'catastro_units'));
    }
    // Asked for explicitly, it is still dropped for a party without an address: nothing to send.
    expect(plannedVendorChecks({ kind: 'vendor', address_norm: null }, ['catastro_units'])).toEqual(
      [],
    );
  });

  it('never puts an owner or the president to the tax census, whatever was asked for', () => {
    for (const kind of ['owner_role', 'president_role']) {
      expect(plannedVendorChecks({ kind, address_norm: null }, null)).not.toContain('aeat_census');
      expect(
        plannedVendorChecks({ kind, address_norm: null }, ['aeat_census', 'nif_validate']),
      ).toEqual(['nif_validate']);
    }
    expect(plannedVendorChecks({ kind: 'administrator', address_norm: null }, null)).toContain(
      'aeat_census',
    );
  });

  it('passes requested types through in order, unknown names included, so the caller can report a typo', () => {
    expect(
      plannedVendorChecks({ kind: 'vendor', address_norm: 'x 1' }, [
        'rea',
        'no_such_check',
        'catastro_units',
      ]),
    ).toEqual(['rea', 'no_such_check', 'catastro_units']);
  });
});

describe('iban_validate from the stored pseudonym', () => {
  it('resolves the entity from the bank code when the account number is not held in clear', async () => {
    const r = await ibanValidate.run(
      {
        ...VENDOR,
        iban: null,
        extra: {
          bank_code: '0075',
          last4: '0001',
          iban_valid: true,
          ccc_dc_valid: true,
          country: 'ES',
        },
      },
      ctxWith([]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.basis).toBe('stored_pseudonym');
    expect(r.normalised.current_bank_code).toBe('0049');
    expect(r.normalised.valid).toBe(true);
    expect(String(r.note)).toMatch(/absorbed/);
    expect(JSON.stringify(r)).not.toMatch(/ES\d{22}/);
  });

  it('still reports not_found when there is neither a number nor a pseudonym', async () => {
    const r = await ibanValidate.run({ ...VENDOR, iban: null }, ctxWith([]));
    expect(r.status).toBe('not_found');
  });
});
