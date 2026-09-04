/**
 * Parser tests for every check, against recorded (synthetic) fixture responses.
 *
 * No test touches the network: `ctx.fetch` is a fixture player that answers by URL fragment, and
 * the rate limiter is stubbed so the suite does not sleep. The fixtures are shaped like the
 * responses the unverified sources are expected to return; when a field name turns out to be
 * different, these tests are where the change lands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cccToIban } from '@viladomat/core';
import { REPO_ROOT } from '../lib/env.ts';
import { RASIC_DATASET_ID } from './config.ts';
import { resetRateLimiters } from './http.ts';
import { bdnsGrants, parseBdnsGrants, parseRaiscGrants, raiscGrants } from './checks/grants.ts';
import {
  companyProfile,
  parseCompanyProfile,
  parseSearchResults,
  pickCandidate,
} from './checks/company-profile.ts';
import { catastroUnits, parseCatastroUnits, splitStreet } from './checks/catastro-units.ts';
import { parseRasicRows, rasic } from './checks/rasic.ts';
import { parseSurnameFrequency, surnameFrequency } from './checks/surname-frequency.ts';
import { nifValidate } from './checks/nif-validate.ts';
import { ibanValidate } from './checks/iban-validate.ts';
import { aeatCensus, insolvency, rea, registroMercantilNota } from './checks/manual.ts';
import type { CheckContext, CheckSubject, HttpResponse } from './types.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

/** A `fetch` that answers from fixtures and records the URLs it was asked for. */
function fixtureFetch(routes: readonly Route[], seen: string[] = []): CheckContext['fetch'] {
  return (url: string) => {
    seen.push(url);
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

function ctxWith(routes: readonly Route[], seen: string[] = []): CheckContext {
  return {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch: fixtureFetch(routes, seen),
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

  it('prefers an exact identifier match over a name match', () => {
    const candidates = parseSearchResults(fixture('company-profile-search.json'));
    expect(candidates).toHaveLength(2);
    const chosen = pickCandidate(candidates, { nif: 'B58818501', name: 'OBRES EXEMPLE BARNA SL' });
    expect(chosen?.how).toBe('nif');
    expect(chosen?.candidate.id).toBe('exemple-serveis-generals-sl');
  });

  it('returns not_found with the manual fallback when nothing matches', () => {
    const chosen = pickCandidate(parseSearchResults(fixture('company-profile-search.json')), {
      name: 'ALGO COMPLETAMENT DIFERENT',
    });
    expect(chosen).toBeNull();
  });

  it('runs search then detail through ctx.fetch and reports the fallback route', async () => {
    const seen: string[] = [];
    const r = await companyProfile.run(
      VENDOR,
      ctxWith(
        [
          { match: '/companies/search', body: fixture('company-profile-search.json') },
          {
            match: '/companies/obres-exemple-barna-sl',
            body: fixture('company-profile-detail.json'),
          },
        ],
        seen,
      ),
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(r.normalised.matched_by).toBe('nif');
    expect(r.normalised.source_verified).toBe(false);
    expect((r.normalised.fallback as { url: string }).url).toContain('libreborme');
    expect(r.request?.detail_endpoint).toContain('obres-exemple-barna-sl');
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
  it('parses a BDNS response', () => {
    const rows = parseBdnsGrants(fixture('bdns-concesiones.json'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.register).toBe('BDNS');
    expect(rows[0]?.beneficiary_nif).toBe('H12345674');
    expect(rows[1]?.amount_granted).toBe(30000);
    expect(rows[1]?.amount_paid).toBe(12000);
  });

  it('summarises the totals and states that absence is not exculpatory', async () => {
    const r = await bdnsGrants.run(
      {
        subjectType: 'community',
        subjectKey: 'H12345674',
        nif: 'H12345674',
        name: 'Comunitat exemple',
      },
      ctxWith([{ match: 'concesiones/busqueda', body: fixture('bdns-concesiones.json') }]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.count).toBe(2);
    expect(r.normalised.total_granted).toBe(48500);
    expect(r.normalised.years).toEqual(['2023', '2024']);
  });

  it('reports an empty BDNS answer as not_found with the non-exculpatory note', async () => {
    const r = await bdnsGrants.run(
      { subjectType: 'community', subjectKey: 'H12345674', nif: 'H12345674' },
      ctxWith([{ match: 'concesiones/busqueda', body: { content: [] } }]),
    );
    expect(r.status).toBe('not_found');
    expect(String(r.normalised.note)).toMatch(/not exculpatory/);
  });

  it('parses a RAISC (Socrata) response and records the dataset id it queried', async () => {
    expect(parseRaiscGrants(fixture('raisc-grants.json'))[0]?.register).toBe('RAISC');
    const r = await raiscGrants.run(
      { subjectType: 'community', subjectKey: 'H12345674', nif: 'H12345674' },
      ctxWith([{ match: 's9xt-n979', body: fixture('raisc-grants.json') }]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.dataset).toBe('s9xt-n979');
    expect(r.normalised.source_verified).toBe(false);
  });
});

describe('rasic', () => {
  it('parses a register row', () => {
    const rows = parseRasicRows(fixture('rasic.json'));
    expect(rows[0]?.registration_number).toBe('RASIC-EX-00042');
    expect(rows[0]?.activities).toHaveLength(2);
  });

  it('refuses to query while the dataset id is a placeholder, and offers the manual route', async () => {
    expect(RASIC_DATASET_ID.startsWith('TO-VERIFY')).toBe(true);
    const seen: string[] = [];
    const r = await rasic.run(VENDOR, ctxWith([], seen));
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toMatch(/dataset id not verified/);
    expect((r.normalised.manual as { url: string }).url).toContain('canalempresa');
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
    for (const check of [rea, aeatCensus, registroMercantilNota, insolvency]) {
      const r = await check.run(VENDOR, ctxWith([]));
      expect(r.status).toBe('manual_pending');
      expect(r.manual?.url).toMatch(/^https:\/\//);
      expect(r.manual?.evidence.length).toBeGreaterThan(0);
      expect(r.manual?.query).toBeTruthy();
    }
  });

  it('prices the Registro Mercantil note so the reviewer knows it is a purchase', async () => {
    const r = await registroMercantilNota.run(VENDOR, ctxWith([]));
    expect(r.cost_cents).toBeGreaterThan(0);
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
