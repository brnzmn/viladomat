/**
 * Officer normalisation and the upsert that keeps `entity_officers` from growing a duplicate on
 * every re-run of the same check.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { officerInitials, officersFromProfile, upsertOfficers } from './officers.ts';
import { parseCompanyProfile } from './checks/company-profile.ts';

interface Call {
  text: string;
  params: unknown[];
}

function fakeClient(
  canned: Array<{ match: string; rows: Array<Record<string, unknown>> }>,
  calls: Call[] = [],
): pg.PoolClient {
  return {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const hit = canned.find((c) => text.includes(c.match));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    },
  } as unknown as pg.PoolClient;
}

const PROFILE = parseCompanyProfile({
  company: {
    name: 'OBRES EXEMPLE BARNA SL',
    cargos: [
      {
        nombre: 'EXEMPLE ROCA, JOSEP MARIA',
        cargo: 'Administrador único',
        fecha_nombramiento: '2021-11-08',
        seccion: 'A',
        num_borme: '224',
      },
      { nombre: 'MOSTRA VIVES, LAIA', cargo: 'Apoderada', fecha_nombramiento: '2022-03-14' },
      { nombre: 'EXEMPLE ROCA, JOSEP MARIA', cargo: 'Administrador único' },
    ],
  },
});

describe('officersFromProfile', () => {
  it('splits a gazette name into given name and both surnames', () => {
    const officers = officersFromProfile(PROFILE);
    expect(officers).toHaveLength(2);
    expect(officers[0]).toMatchObject({
      surname1: 'EXEMPLE',
      surname2: 'ROCA',
      given: 'JOSEP MARIA',
      cargo: 'Administrador único',
      dateFrom: '2021-11-08',
    });
    expect(officers[0]?.bormeRef).toMatchObject({ seccion: 'A', num: '224' });
    expect(officers[1]?.surname1).toBe('MOSTRA');
  });

  it('drops a repeat of the same person in the same office', () => {
    expect(officersFromProfile(PROFILE).filter((o) => o.surname1 === 'EXEMPLE')).toHaveLength(1);
  });

  it('renders initials for every output outside the reviewer screen', () => {
    const officers = officersFromProfile(PROFILE);
    expect(
      officerInitials(officers[0] as { given: string; surname1: string; surname2: string }),
    ).toBe('J.M. E. R.');
    expect(officerInitials({ given: '', surname1: 'MOSTRA', surname2: '' })).toBe('M.');
  });
});

describe('upsertOfficers', () => {
  const cid = '00000000-0000-0000-0000-0000000000c1';
  const partyId = '11111111-1111-1111-1111-111111111111';

  it('inserts when the person and office are new', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [{ match: 'select id from public.entity_officers', rows: [] }],
      calls,
    );
    const res = await upsertOfficers(client, cid, partyId, officersFromProfile(PROFILE), 'check-1');
    expect(res).toEqual({ inserted: 2, updated: 0 });
    const inserts = calls.filter((c) => c.text.includes('insert into public.entity_officers'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params).toContain('check-1');
  });

  it('updates instead of duplicating when the same person and office already exist', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [{ match: 'select id from public.entity_officers', rows: [{ id: 'officer-1' }] }],
      calls,
    );
    const res = await upsertOfficers(client, cid, partyId, officersFromProfile(PROFILE), 'check-2');
    expect(res).toEqual({ inserted: 0, updated: 2 });
    expect(calls.filter((c) => c.text.includes('insert into public.entity_officers'))).toHaveLength(
      0,
    );
    expect(calls.filter((c) => c.text.includes('update public.entity_officers'))).toHaveLength(2);
  });
});
