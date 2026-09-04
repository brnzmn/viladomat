/**
 * Fact sheet rendering.
 *
 * The fact sheet is the only vendor output that may reach the assembly, so the assertions here
 * are as much about what it must NOT contain — scores, tiers, links, names of natural persons —
 * as about what it must.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { vendorFactSheet } from './factsheet.ts';

const CID = '00000000-0000-0000-0000-0000000000c1';
const VENDOR = '11111111-1111-1111-1111-111111111111';
const MAINTAINER = '22222222-2222-2222-2222-222222222222';

function fakeClient(
  canned: Array<{ match: string; rows: Array<Record<string, unknown>> }>,
): pg.PoolClient {
  return {
    query: async (text: string) => {
      const hit = canned.find((c) => text.includes(c.match));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    },
  } as unknown as pg.PoolClient;
}

const client = fakeClient([
  {
    match: 'from public.parties p',
    rows: [
      {
        id: VENDOR,
        kind: 'vendor',
        display_name: 'OBRES EXEMPLE BARNA SL',
        nif: 'B12345674',
        nif_valid: true,
        nif_kind: 'CIF',
        entity_letter: 'B',
        address_norm: 'carrer de mostra 100',
        first_invoice: '2022-02-10',
        invoice_count: 6,
        first_document: '2022-01-20',
      },
      {
        id: MAINTAINER,
        kind: 'vendor',
        display_name: 'ASCENSORS EXEMPLE SL',
        nif: 'B58818501',
        nif_valid: true,
        nif_kind: 'CIF',
        entity_letter: 'B',
        address_norm: null,
        first_invoice: null,
        invoice_count: 0,
        first_document: null,
      },
    ],
  },
  {
    match: 'from public.entity_officers',
    rows: [
      {
        id: 'o1',
        party_id: VENDOR,
        person_name_norm: 'JOSEP MARIA EXEMPLE ROCA',
        surname1_norm: 'EXEMPLE',
        surname2_norm: 'ROCA',
        given_norm: 'JOSEP MARIA',
        cargo: 'Administrador único',
        date_from: '2021-11-08',
        date_to: null,
        borme_ref: { seccion: 'A' },
      },
    ],
  },
  {
    match: 'from public.external_checks',
    rows: [
      {
        id: 'c1',
        check_type: 'company_profile',
        subject_type: 'party',
        subject_key: VENDOR,
        status: 'ok',
        source_url: 'https://example.test/companies/1',
        normalised: {
          incorporation_date: '2021-11-08',
          capital_eur: 3000,
          cnae: '4399',
          address: 'CARRER DE MOSTRA 100',
          source_verified: false,
        },
        fetched_at: '2026-09-01T10:00:00Z',
      },
      {
        id: 'c2',
        check_type: 'rea',
        subject_type: 'party',
        subject_key: VENDOR,
        status: 'not_found',
        source_url: null,
        normalised: {},
        fetched_at: '2026-09-01T10:05:00Z',
      },
      {
        id: 'c3',
        check_type: 'rasic',
        subject_type: 'party',
        subject_key: MAINTAINER,
        status: 'ok',
        source_url: null,
        normalised: { registered: true },
        fetched_at: '2026-09-01T10:06:00Z',
      },
      {
        id: 'c4',
        check_type: 'registro_mercantil_nota',
        subject_type: 'party',
        subject_key: VENDOR,
        status: 'manual_pending',
        source_url: 'https://www.registradores.org/',
        normalised: {},
        fetched_at: '2026-09-01T10:07:00Z',
      },
      {
        id: 'c5',
        check_type: 'bdns_grants',
        subject_type: 'community',
        subject_key: 'H12345674',
        status: 'ok',
        source_url: null,
        normalised: {
          grants: [
            {
              register: 'BDNS',
              programme: 'Ajuts 2024',
              date: '2024-06-14',
              amount_granted: 30000,
              amount_paid: 12000,
            },
          ],
        },
        fetched_at: '2026-09-01T10:08:00Z',
      },
    ],
  },
  { match: 'from public.communities', rows: [{ nif: 'H12345674' }] },
]);

describe('vendorFactSheet', () => {
  it('prints registry facts, officers as initials and the entity kind of the identifier', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const vendor = sheet.vendors.find((v) => v.party_id === VENDOR);
    expect(vendor?.entity_kind).toBe('Sociedad de responsabilidad limitada');
    expect(vendor?.nif_valid).toBe(true);
    expect(vendor?.incorporation_date).toBe('2021-11-08');
    expect(vendor?.officers).toEqual([
      {
        initials: 'J.M. E. R.',
        cargo: 'Administrador único',
        date_from: '2021-11-08',
        date_to: null,
      },
    ]);
    expect(vendor?.first_document_date).toBe('2022-01-20');
    expect(vendor?.invoice_count).toBe(6);
  });

  it('names no natural person anywhere in the structure', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const text = JSON.stringify(sheet);
    expect(text).not.toContain('JOSEP');
    expect(text).not.toContain('ROCA');
    expect(text).not.toMatch(/person_name_norm/);
  });

  it('carries no score, tier, link or severity', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const text = JSON.stringify(sheet);
    for (const forbidden of ['points', 'tier', 'severity', 'party_link', 'hit_score', 'rarity']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('distinguishes "not located" from "not checked" and from "pending manual check"', async () => {
    const sheet = await vendorFactSheet(client, CID);
    expect(sheet.vendors.find((v) => v.party_id === VENDOR)?.rea_status).toBe('not located');
    expect(sheet.vendors.find((v) => v.party_id === VENDOR)?.rasic_status).toBe('not checked');
    expect(sheet.vendors.find((v) => v.party_id === MAINTAINER)?.rasic_status).toBe('registered');
    expect(sheet.vendors.find((v) => v.party_id === MAINTAINER)?.rea_status).toBe('not checked');
  });

  it('lists the grants published for the community and the sources that are still unverified', async () => {
    const sheet = await vendorFactSheet(client, CID);
    expect(sheet.community_grants).toHaveLength(1);
    expect(sheet.community_grants[0]?.amount_granted).toBe(30000);
    expect(sheet.unverified_sources).toEqual(['company_profile']);
  });

  it('states in both languages that absence of an entry establishes nothing', async () => {
    const sheet = await vendorFactSheet(client, CID);
    expect(sheet.note_es).toMatch(/no acredita incumplimiento alguno/);
    expect(sheet.note_en).toMatch(/does not establish any/);
  });

  it('shows the checks run for each vendor with their dates', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const vendor = sheet.vendors.find((v) => v.party_id === VENDOR);
    expect(vendor?.checks.map((c) => c.type).sort()).toEqual([
      'company_profile',
      'rea',
      'registro_mercantil_nota',
    ]);
    expect(vendor?.checks.every((c) => c.fetched_at === '2026-09-01')).toBe(true);
  });
});
