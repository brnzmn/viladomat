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
const ARCHITECT = '33333333-3333-3333-3333-333333333333';

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
      {
        id: ARCHITECT,
        kind: 'architect',
        display_name: 'ESTUDI EXEMPLE ARQUITECTES SLP',
        nif: 'B65432106',
        nif_valid: true,
        nif_kind: 'CIF',
        entity_letter: 'B',
        address_norm: null,
        first_invoice: '2022-03-01',
        invoice_count: 2,
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
        id: 'c6',
        check_type: 'aeat_census',
        subject_type: 'party',
        subject_key: VENDOR,
        status: 'ok',
        source_url: 'https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP',
        normalised: {
          census_match: false,
          result: 'NO IDENTIFICADO',
          nif: 'B12345674',
          name_sent: 'OBRES EXEMPLE BARNA SL',
          name_registered: null,
          natural_person: false,
          source_verified: false,
        },
        fetched_at: '2026-09-01T10:09:00Z',
      },
      {
        id: 'c7',
        check_type: 'insolvency',
        subject_type: 'party',
        subject_key: VENDOR,
        status: 'manual_pending',
        source_url: 'https://www.publicidadconcursal.es/consulta-publicidad-concursal-new',
        normalised: { manual: true },
        fetched_at: '2026-09-01T10:10:00Z',
      },
      {
        id: 'c8',
        check_type: 'aeat_census',
        subject_type: 'party',
        subject_key: MAINTAINER,
        status: 'ok',
        source_url: 'https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP',
        normalised: {
          census_match: true,
          result: 'IDENTIFICADO',
          nif: 'B58818501',
          name_sent: 'ASCENSORS EXEMPLE SL',
          name_registered: 'ASCENSORS EXEMPLE SOCIEDAD LIMITADA',
          natural_person: false,
          source_verified: true,
        },
        fetched_at: '2026-09-01T10:11:00Z',
      },
      {
        // A manual completion: the reviewer's PDF is on file, the row carries no census_match.
        id: 'c9',
        check_type: 'aeat_census',
        subject_type: 'party',
        subject_key: ARCHITECT,
        status: 'ok',
        source_url: 'https://sede.agenciatributaria.gob.es/Sede/tramitacion/G321.shtml',
        normalised: {
          manual: true,
          evidence_uploaded: true,
          evidence_bytes: 1024,
          evidence_note: 'response page captured',
          answers_check_id: 'c-pending',
        },
        fetched_at: '2026-09-02T09:00:00Z',
      },
      {
        // An automated answer of the insolvency register in the shape REA and RASIC use.
        id: 'c10',
        check_type: 'insolvency',
        subject_type: 'party',
        subject_key: ARCHITECT,
        status: 'ok',
        source_url: 'https://www.publicidadconcursal.es/consulta-publicidad-concursal-new',
        normalised: { registered: false, source_verified: false },
        fetched_at: '2026-09-02T09:01:00Z',
      },
      {
        // A REA manual completion: evidence on file, no structured outcome.
        id: 'c11',
        check_type: 'rea',
        subject_type: 'party',
        subject_key: ARCHITECT,
        status: 'ok',
        source_url: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
        normalised: { manual: true, evidence_uploaded: true, answers_check_id: 'c-rea-pending' },
        fetched_at: '2026-09-02T09:02:00Z',
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

  it('reports the census and the insolvency register with the same closed vocabulary', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const vendor = sheet.vendors.find((v) => v.party_id === VENDOR);
    const maintainer = sheet.vendors.find((v) => v.party_id === MAINTAINER);
    const architect = sheet.vendors.find((v) => v.party_id === ARCHITECT);
    expect(vendor?.census_status).toBe('not located');
    expect(vendor?.insolvency_status).toBe('pending manual check');
    expect(maintainer?.census_status).toBe('registered');
    expect(maintainer?.insolvency_status).toBe('not checked');
    expect(architect?.insolvency_status).toBe('not located');
    const vocabulary = ['registered', 'not located', 'not checked', 'pending manual check'];
    for (const v of sheet.vendors) {
      expect(vocabulary).toContain(v.census_status);
      expect(vocabulary).toContain(v.insolvency_status);
    }
    // The result string a register answered with stays on the check row.
    expect(JSON.stringify(sheet)).not.toContain('NO IDENTIFICADO');
  });

  it('reads a manual completion as "not checked": the outcome is in the evidence, not in the row', async () => {
    const sheet = await vendorFactSheet(client, CID);
    const architect = sheet.vendors.find((v) => v.party_id === ARCHITECT);
    expect(architect?.census_status).toBe('not checked');
    expect(architect?.rea_status).toBe('not checked');
    expect(architect?.checks.map((c) => c.type).sort()).toEqual([
      'aeat_census',
      'insolvency',
      'rea',
    ]);
  });

  it('lists the grants published for the community and the sources that are still unverified', async () => {
    const sheet = await vendorFactSheet(client, CID);
    expect(sheet.community_grants).toHaveLength(1);
    expect(sheet.community_grants[0]?.amount_granted).toBe(30000);
    expect(sheet.unverified_sources).toEqual(['aeat_census', 'company_profile', 'insolvency']);
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
      'aeat_census',
      'company_profile',
      'insolvency',
      'rea',
      'registro_mercantil_nota',
    ]);
    expect(vendor?.checks.every((c) => c.fetched_at === '2026-09-01')).toBe(true);
  });
});
