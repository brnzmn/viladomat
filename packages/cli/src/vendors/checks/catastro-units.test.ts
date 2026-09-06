/**
 * Parser and route tests for `catastro_units` against the recorded (synthetic) shapes of the
 * OVC callejero JSON service. No test touches the network: `ctx.fetch` answers from fixtures and
 * records the URLs it was asked for, and the rate limiter is stubbed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../lib/env.ts';
import { resetRateLimiters } from '../http.ts';
import type { CheckContext, CheckSubject, HttpResponse } from '../types.ts';
import {
  catastroUnits,
  isRcShape,
  normaliseRc,
  parseCatastroDecimal,
  parseCatastroUnits,
  placeFromAddress,
} from './catastro-units.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

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

/** The community as the check runner builds it: the seeded reference travels in `extra.rc`. */
const COMMUNITY: CheckSubject = {
  subjectType: 'community',
  subjectKey: 'H12345674',
  name: 'Comunitat exemple',
  nif: 'H12345674',
  address: 'Carrer de Mostra 25, 08015 Barcelona',
  extra: { rc: '9999999ZZ9999Z' },
};

beforeEach(() => {
  resetRateLimiters();
});

describe('parseCatastroDecimal', () => {
  it('reads the comma decimals the service writes, and plain integers', () => {
    expect(parseCatastroDecimal('7,320000')).toBeCloseTo(7.32, 9);
    expect(parseCatastroDecimal('9.100000')).toBeCloseTo(9.1, 9);
    expect(parseCatastroDecimal('88')).toBe(88);
    expect(parseCatastroDecimal('0,500000')).toBe(0.5);
    expect(parseCatastroDecimal(12)).toBe(12);
  });

  it('returns null rather than a guess for anything unreadable', () => {
    expect(parseCatastroDecimal('')).toBeNull();
    expect(parseCatastroDecimal('n/a')).toBeNull();
    expect(parseCatastroDecimal(null)).toBeNull();
    expect(parseCatastroDecimal({})).toBeNull();
  });
});

describe('parseCatastroUnits — 14-character (parcel) answer', () => {
  const parsed = parseCatastroUnits(fixture('catastro-dnprc-14.json'));

  it('reads the consulta_dnprcResult root and one unit per rcdnp entry', () => {
    expect(parsed.envelope).toBe('lrcdnp');
    expect(parsed.units).toHaveLength(4);
    expect(parsed.control).toEqual({ cudnp: 4, cucons: 0, cuerr: 0 });
    expect(parsed.errors).toEqual([]);
  });

  it('joins pc1+pc2+car+cc1+cc2 into the 20-character reference', () => {
    expect(parsed.units[0]?.rc).toBe('9999999ZZ9999Z0001AB');
    expect(parsed.units[0]?.rc).toHaveLength(20);
  });

  it('reads floor, door, staircase, use, surface, year and the Spanish-decimal coefficient', () => {
    const ground = parsed.units[0];
    expect(ground?.floor).toBe('BJ');
    expect(ground?.door).toBe('01');
    expect(ground?.staircase).toBe('1');
    expect(ground?.use).toBe('Comercial');
    expect(ground?.surface_m2).toBe(120);
    expect(ground?.coefficient_pct).toBeCloseTo(12.4, 9);
    expect(ground?.year_built).toBe(1928);
    expect(parsed.units[1]?.coefficient_pct).toBeCloseTo(7.32, 9);
    expect(parsed.units[3]?.floor).toBe('01');
    expect(parsed.units[3]?.door).toBe('02');
  });

  it('assembles an address line from the structured pieces when no ldt is printed', () => {
    expect(parsed.units[0]?.address_line).toBe('CL MOSTRA 25 Es:1 Pl:BJ Pt:01 08015 BARCELONA');
  });

  it('accepts a single unit arriving as an object rather than a list', () => {
    const one = parseCatastroUnits({
      consulta_dnprcResult: {
        control: { cudnp: 1 },
        lrcdnp: {
          rcdnp: {
            rc: { pc1: '9999999', pc2: 'ZZ9999Z', car: '0001', cc1: 'A', cc2: 'B' },
            dt: { locs: { lous: { lourb: { loint: { es: '1', pt: '01', pu: '01' } } } } },
            debi: { luso: 'Residencial', sfc: '64', cpt: '6,500000', ant: '1930' },
          },
        },
      },
    });
    expect(one.envelope).toBe('lrcdnp');
    expect(one.units).toHaveLength(1);
    expect(one.units[0]?.coefficient_pct).toBe(6.5);
    expect(one.control.cudnp).toBe(1);
  });
});

describe('parseCatastroUnits — 20-character (unit) answer', () => {
  const parsed = parseCatastroUnits(fixture('catastro-dnprc-20.json'));

  it('reads bico.bi with idbi.rc, the printed ldt and debi', () => {
    expect(parsed.envelope).toBe('bico');
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.rc).toBe('9999999ZZ9999Z0003EF');
    expect(parsed.units[0]?.address_line).toBe(
      'CL MOSTRA 25 Es:1 Pl:PR Pt:01 08015 BARCELONA (BARCELONA)',
    );
    expect(parsed.units[0]?.floor).toBe('PR');
    expect(parsed.units[0]?.surface_m2).toBe(88);
    expect(parsed.units[0]?.coefficient_pct).toBeCloseTo(9.1, 9);
  });

  it('lists the built elements of bico.lcons with their surfaces', () => {
    expect(parsed.control).toEqual({ cudnp: 1, cucons: 2, cuerr: 0 });
    expect(parsed.constructions).toHaveLength(2);
    expect(parsed.constructions[0]).toEqual({
      use: 'VIVIENDA',
      staircase: '1',
      floor: 'PR',
      door: '01',
      surface_m2: 80,
    });
    expect(parsed.constructions[1]?.use).toBe('ELEMENTOS COMUNES');
    expect(parsed.constructions[1]?.surface_m2).toBe(8);
  });
});

describe('parseCatastroUnits — error list', () => {
  it('reports lerr entries instead of units', () => {
    const parsed = parseCatastroUnits(fixture('catastro-lerr.json'));
    expect(parsed.units).toEqual([]);
    expect(parsed.envelope).toBe('unknown');
    expect(parsed.control.cuerr).toBe(1);
    expect(parsed.errors).toEqual([
      { code: '17', description: 'LA REFERENCIA CATASTRAL ES OBLIGATORIA' },
    ]);
  });

  it('also reads the XML-derived nesting lerr.err', () => {
    const parsed = parseCatastroUnits({
      consulta_dnp: { lerr: { err: { cod: '43', des: 'NO EXISTE' } } },
    });
    expect(parsed.errors).toEqual([{ code: '43', description: 'NO EXISTE' }]);
  });
});

describe('reference helpers', () => {
  it('normalises spacing and case and recognises 14 and 20 characters', () => {
    expect(normaliseRc(' 9999999 zz9999z ')).toBe('9999999ZZ9999Z');
    expect(isRcShape('9999999ZZ9999Z')).toBe(true);
    expect(isRcShape('9999999ZZ9999Z0001AB')).toBe(true);
    expect(isRcShape('9999999ZZ9999Z0001')).toBe(false);
    expect(isRcShape('')).toBe(false);
  });
});

describe('placeFromAddress', () => {
  it('reads the municipality after the postcode and the province from its prefix', () => {
    expect(placeFromAddress('Carrer de Mostra 25, 08015 Barcelona')).toEqual({
      municipality: 'BARCELONA',
      province: 'BARCELONA',
    });
    expect(placeFromAddress('Carrer de Mostra 25, 08015 Barcelona (Barcelona)')).toEqual({
      municipality: 'BARCELONA',
      province: 'BARCELONA',
    });
    expect(placeFromAddress('Carrer Exemple 3, 17001 Girona')).toEqual({
      municipality: 'GIRONA',
      province: 'GIRONA',
    });
  });

  it('defaults to BARCELONA when the address carries no postcode or is missing', () => {
    expect(placeFromAddress('Carrer de Mostra 25')).toEqual({
      municipality: 'BARCELONA',
      province: 'BARCELONA',
    });
    expect(placeFromAddress(null)).toEqual({ municipality: 'BARCELONA', province: 'BARCELONA' });
  });
});

describe('catastro_units.run', () => {
  it('queries Consulta_DNPRC with RefCat (never RC) plus Provincia and Municipio for a seeded reference', async () => {
    const seen: string[] = [];
    const r = await catastroUnits.run(
      COMMUNITY,
      ctxWith([{ match: 'Consulta_DNPRC', body: fixture('catastro-dnprc-14.json') }], seen),
    );
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0] ?? '');
    expect(url.pathname.endsWith('/Consulta_DNPRC')).toBe(true);
    expect(url.searchParams.get('RefCat')).toBe('9999999ZZ9999Z');
    expect(url.searchParams.has('RC')).toBe(false);
    expect(url.searchParams.get('Provincia')).toBe('BARCELONA');
    expect(url.searchParams.get('Municipio')).toBe('BARCELONA');
    expect(r.status).toBe('ok');
    expect(r.normalised.unit_count).toBe(4);
    expect(r.normalised.envelope).toBe('lrcdnp');
    expect(r.normalised.coefficient_sum_pct).toBeCloseTo(36.67, 4);
    expect(r.normalised.control).toEqual({ cudnp: 4, cucons: 0, cuerr: 0 });
    expect(r.normalised.source_verified).toBe(false);
    expect(r.request?.rc).toBe('9999999ZZ9999Z');
    expect(String(r.normalised.note)).toMatch(/discrepancy to verify/);
  });

  it('prefers the reference over the address when both are known', async () => {
    const seen: string[] = [];
    await catastroUnits.run(
      COMMUNITY,
      ctxWith([{ match: 'Consulta_DNPRC', body: fixture('catastro-dnprc-14.json') }], seen),
    );
    expect(seen[0]).toContain('Consulta_DNPRC');
    expect(seen[0]).not.toContain('Consulta_DNPLOC');
  });

  it('refuses to send a reference that is not 14 or 20 characters', async () => {
    const seen: string[] = [];
    const r = await catastroUnits.run({ ...COMMUNITY, extra: { rc: '123' } }, ctxWith([], seen));
    expect(seen).toHaveLength(0);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/not 14 or 20 characters/);
    expect(r.source_url).toBeNull();
  });

  it('turns a lerr answer into an error result carrying the code', async () => {
    const r = await catastroUnits.run(
      COMMUNITY,
      ctxWith([{ match: 'Consulta_DNPRC', body: fixture('catastro-lerr.json') }]),
    );
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toContain('17');
    expect(r.normalised.errors).toEqual([
      { code: '17', description: 'LA REFERENCIA CATASTRAL ES OBLIGATORIA' },
    ]);
  });

  it('reads a 20-character answer as one unit with its built elements', async () => {
    const r = await catastroUnits.run(
      { ...COMMUNITY, extra: { rc: '9999999ZZ9999Z0003EF' } },
      ctxWith([{ match: 'RefCat=9999999ZZ9999Z0003EF', body: fixture('catastro-dnprc-20.json') }]),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.unit_count).toBe(1);
    expect(r.normalised.envelope).toBe('bico');
    expect((r.normalised.constructions as unknown[]).length).toBe(2);
  });

  it('falls back to Consulta_DNPLOC with the place derived from the address', async () => {
    const seen: string[] = [];
    const r = await catastroUnits.run(
      { ...COMMUNITY, address: 'Carrer Exemple 3, 17001 Girona', extra: {} },
      ctxWith([{ match: 'Consulta_DNPLOC', body: fixture('catastro-dnploc.json') }], seen),
    );
    const url = new URL(seen[0] ?? '');
    expect(url.searchParams.get('Provincia')).toBe('GIRONA');
    expect(url.searchParams.get('Municipio')).toBe('GIRONA');
    expect(url.searchParams.get('Calle')).toBe('EXEMPLE');
    expect(r.status).toBe('ok');
  });

  it('records not_found when neither a reference nor an address is known', async () => {
    const seen: string[] = [];
    const r = await catastroUnits.run(
      { subjectType: 'community', subjectKey: 'x', address: null },
      ctxWith([], seen),
    );
    expect(seen).toHaveLength(0);
    expect(r.status).toBe('not_found');
  });

  it('turns a transport failure into an error result rather than throwing', async () => {
    const r = await catastroUnits.run(COMMUNITY, {
      ...ctxWith([]),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toContain('ECONNREFUSED');
  });
});
