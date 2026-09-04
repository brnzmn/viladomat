/**
 * M5 rules against a fake `client.query`.
 *
 * Each rule is exercised on a canned result set and on the clean case, so a rule that fires on a
 * planted discrepancy is also shown not to fire when there is nothing to report. The wording
 * assertions are part of the contract: no natural person is named, an absent registry entry is
 * reported as "not located", and every hit carries an innocent explanation and a next check.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { collapse, type RuleContext, type RuleHit } from './engine.ts';
import {
  A10_quoteAuthenticity,
  B1_companyAge,
  B2_addressCoincidence,
  B3_surnameCoincidence,
  B7_registryRegistration,
  B8_vendorConcentration,
  B9_impliedVolume,
  G2_taxFilings,
  G5_liftCompliance,
  G6_healthAndSafety,
  G7_ite,
  M5_RULES,
  checkIndependence,
  surnameSeverity,
} from './m5.ts';

type Rows = Array<Record<string, unknown>>;
interface Canned {
  match: string;
  rows: Rows;
}

const CID = '00000000-0000-0000-0000-0000000000c1';
const VENDOR = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';

function ctxWith(canned: Canned[], params: Record<string, number> = {}): RuleContext {
  const client = {
    query: async (text: string) => {
      const hit = canned.find((c) => text.includes(c.match));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    },
  } as unknown as pg.PoolClient;
  return {
    cid: CID,
    client,
    today: '2026-09-04',
    param: (key) => Promise.resolve(params[key] ?? null),
  };
}

/** Every hit must carry the material that keeps it a question rather than an assertion. */
function expectWellFormed(hits: readonly RuleHit[]): void {
  for (const h of hits) {
    expect(h.summaryEs.length).toBeGreaterThan(20);
    expect(h.summaryEn.length).toBeGreaterThan(20);
    expect(h.innocentExplanations.length).toBeGreaterThan(0);
    expect(h.nextCheck.length).toBeGreaterThan(10);
    expect(h.eventKey).toMatch(/^(party|community|works_package):/);
    expect(h.independence).toBeGreaterThan(0);
    expect(h.independence).toBeLessThanOrEqual(1);
  }
}

describe('B1 — company age and form', () => {
  const profileRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: VENDOR,
    display_name: 'OBRES EXEMPLE BARNA SL',
    kind: 'vendor',
    profile: { incorporation_date: '2021-11-08', capital_eur: 3000, cnae: '4399' },
    profile_date: '2026-09-01',
    archived: true,
    manual_evidence: false,
    first_invoice: '2021-12-20',
    works_total: '45000.00',
    invoice_total: '45000.00',
    categories: ['MASONRY'],
    ...over,
  });

  it('fires at severity 3 when the first invoice is under six months after incorporation', async () => {
    const hits = await B1_companyAge(
      ctxWith([{ match: "check_type = 'company_profile'", rows: [profileRow()] }]),
    );
    const age = hits.filter((h) => h.eventKey.endsWith(':company_age'));
    expect(age).toHaveLength(1);
    expect(age[0]?.severity).toBe(3);
    expect(age[0]?.computed.days_between).toBe(42);
    expect(age[0]?.independence).toBe(1);
    expectWellFormed(hits);
  });

  it('fires at severity 2 between six and twelve months, and not at all after a year', async () => {
    const at8 = await B1_companyAge(
      ctxWith([
        {
          match: "check_type = 'company_profile'",
          rows: [profileRow({ first_invoice: '2022-07-08' })],
        },
      ]),
    );
    expect(at8.find((h) => h.eventKey.endsWith(':company_age'))?.severity).toBe(2);
    const at18 = await B1_companyAge(
      ctxWith([
        {
          match: "check_type = 'company_profile'",
          rows: [profileRow({ first_invoice: '2023-05-08' })],
        },
      ]),
    );
    expect(at18.find((h) => h.eventKey.endsWith(':company_age'))).toBeUndefined();
  });

  it('reports capital against works only above the works threshold', async () => {
    const big = await B1_companyAge(
      ctxWith([{ match: "check_type = 'company_profile'", rows: [profileRow()] }]),
    );
    expect(big.find((h) => h.eventKey.endsWith(':capital_vs_works'))?.severity).toBe(2);
    const small = await B1_companyAge(
      ctxWith([
        { match: "check_type = 'company_profile'", rows: [profileRow({ works_total: '900.00' })] },
      ]),
    );
    expect(small.find((h) => h.eventKey.endsWith(':capital_vs_works'))).toBeUndefined();
  });

  it('reports an activity code that does not cover the work, and stays silent when it does', async () => {
    const unrelated = await B1_companyAge(
      ctxWith([
        {
          match: "check_type = 'company_profile'",
          rows: [
            profileRow({
              profile: { incorporation_date: '2010-01-01', cnae: '6820' },
              first_invoice: '2022-01-01',
              categories: ['MASONRY'],
            }),
          ],
        },
      ]),
    );
    expect(unrelated.find((h) => h.eventKey.endsWith(':cnae'))?.severity).toBe(2);

    const related = await B1_companyAge(
      ctxWith([
        {
          match: "check_type = 'company_profile'",
          rows: [
            profileRow({
              profile: { incorporation_date: '2010-01-01', cnae: '4399' },
              first_invoice: '2022-01-01',
              categories: ['MASONRY'],
            }),
          ],
        },
      ]),
    );
    expect(related.find((h) => h.eventKey.endsWith(':cnae'))).toBeUndefined();
  });

  it('drops the independence of a check whose evidence was captured by hand', async () => {
    const hits = await B1_companyAge(
      ctxWith([
        { match: "check_type = 'company_profile'", rows: [profileRow({ manual_evidence: true })] },
      ]),
    );
    expect(hits[0]?.independence).toBe(0.7);
  });
});

describe('B2 — address coincidence', () => {
  it('turns a stored S5 link into a severity-3 hit and keeps its explanation', async () => {
    const hits = await B2_addressCoincidence(
      ctxWith([
        {
          match: "l.signal in ('S5', 'S6')",
          rows: [
            {
              id: 'link-1',
              from_party_id: VENDOR,
              display_name: 'OBRES EXEMPLE BARNA SL',
              to_role: 'president',
              signal: 'S5',
              points: '80',
              tier: 'priority',
              explanation:
                'Possible link to verify: the vendor’s registered address coincides with an address recorded for this role; expected homonyms: not applicable; source: company_profile 2026-09-01; nota informativa not yet obtained.',
              updated_on: '2026-09-02',
            },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(3);
    expect(hits[0]?.summaryEn).toContain('the presidency');
    expect(hits[0]?.summaryEn).toContain('Possible link to verify');
    expectWellFormed(hits);
  });

  it('reports a shared address at severity 2, and downgrades it to 1 at a domiciliation address', async () => {
    const shared = (atAddress: number): Canned[] => [
      {
        match: 'join public.communities c',
        rows: [
          {
            id: VENDOR,
            display_name: 'A',
            kind: 'vendor',
            address_norm: 'carrer compartit 3',
            community_address: 'carrer de mostra 25',
            at_address: atAddress,
          },
          {
            id: OTHER,
            display_name: 'B',
            kind: 'vendor',
            address_norm: 'carrer compartit 3',
            community_address: 'carrer de mostra 25',
            at_address: atAddress,
          },
        ],
      },
    ];
    const few = await B2_addressCoincidence(ctxWith(shared(2)));
    expect(few.filter((h) => h.eventKey.endsWith(':address_shared'))).toHaveLength(2);
    expect(few[0]?.severity).toBe(2);

    const many = await B2_addressCoincidence(ctxWith(shared(41)));
    expect(many[0]?.severity).toBe(1);
    expect(many[0]?.computed.domiciliation).toBe(true);
    expect(many[0]?.innocentExplanations.join(' ')).toMatch(/41 entities/);
  });

  it('reports the administrator’s office address at severity 3', async () => {
    const hits = await B2_addressCoincidence(
      ctxWith([
        {
          match: 'join public.communities c',
          rows: [
            {
              id: VENDOR,
              display_name: 'A',
              kind: 'vendor',
              address_norm: 'carrer gestor 9',
              community_address: 'carrer de mostra 25',
              at_address: 2,
            },
            {
              id: ADMIN,
              display_name: 'Administració',
              kind: 'administrator',
              address_norm: 'carrer gestor 9',
              community_address: 'carrer de mostra 25',
              at_address: 2,
            },
          ],
        },
      ]),
    );
    const hit = hits.find((h) => h.entityId === VENDOR);
    expect(hit?.severity).toBe(3);
    expect(hit?.computed.shared_with_administrator).toBe(true);
  });

  it('reports the building itself', async () => {
    const hits = await B2_addressCoincidence(
      ctxWith([
        {
          match: 'join public.communities c',
          rows: [
            {
              id: VENDOR,
              display_name: 'A',
              kind: 'vendor',
              address_norm: 'Carrer de Mostra 25',
              community_address: 'carrer de mostra, 25',
              at_address: 1,
            },
          ],
        },
      ]),
    );
    expect(hits.filter((h) => h.eventKey.endsWith(':address_building'))).toHaveLength(1);
  });
});

describe('B3 — surname coincidence', () => {
  const link = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'link-1',
    from_party_id: VENDOR,
    display_name: 'OBRES EXEMPLE BARNA SL',
    to_role: 'president',
    signal: 'S3',
    points: '48.02',
    rarity_weight: '1.0672',
    expected_collisions: '0.27',
    tier: 'review',
    explanation:
      'Possible link to verify: both surnames of an officer coincide, in the same order, with those recorded for this role; expected homonyms: 0.27; source: company_profile 2026-09-01; nota informativa not yet obtained.',
    status: 'open',
    updated_on: '2026-09-02',
    nota_obtained: false,
    ...over,
  });

  it('prints the expected homonyms and the missing registry note, and names nobody', async () => {
    const hits = await B3_surnameCoincidence(
      ctxWith([{ match: "l.signal in ('S1', 'S2', 'S3', 'S4')", rows: [link()] }]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(4);
    expect(hits[0]?.summaryEn).toContain('0.27 people expected to share the same coincidence');
    expect(hits[0]?.summaryEn).toContain('has not been obtained');
    expect(hits[0]?.summaryEn).toContain('the presidency');
    expect(hits[0]?.summaryEs).toContain('la presidencia');
    expect(hits[0]?.summaryEn).not.toMatch(/EXEMPLE|MOSTRA|ROCA/);
    expect(hits[0]?.innocentExplanations.join(' ')).toMatch(/family-run contractor/);
    expectWellFormed(hits);
  });

  it('says so when the note has been obtained', async () => {
    const hits = await B3_surnameCoincidence(
      ctxWith([
        { match: "l.signal in ('S1', 'S2', 'S3', 'S4')", rows: [link({ nota_obtained: true })] },
      ]),
    );
    expect(hits[0]?.summaryEn).toContain('already in the file');
    expect(hits[0]?.computed.nota_informativa_obtained).toBe(true);
  });

  it('states that the frequency was not obtained instead of inventing a count', async () => {
    const hits = await B3_surnameCoincidence(
      ctxWith([
        {
          match: "l.signal in ('S1', 'S2', 'S3', 'S4')",
          rows: [link({ expected_collisions: null })],
        },
      ]),
    );
    expect(hits[0]?.summaryEn).toContain('the surname frequency was not obtained');
  });

  it('maps points to severity, capping a single common surname at 1', () => {
    expect(surnameSeverity('S1', 100)).toBe(4);
    expect(surnameSeverity('S2', 90)).toBe(4);
    expect(surnameSeverity('S3', 48)).toBe(4);
    expect(surnameSeverity('S3', 27)).toBe(3);
    expect(surnameSeverity('S4', 10.4)).toBe(3);
    expect(surnameSeverity('S4', 4.8)).toBe(1);
  });
});

describe('B7 — REA and RASIC', () => {
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: VENDOR,
    display_name: 'OBRES EXEMPLE BARNA SL',
    nif_kind: 'CIF',
    categories: ['MASONRY'],
    invoice_total: '45000.00',
    first_invoice: '2022-01-10',
    rea_status: 'not_found',
    rea_on: '2026-09-01',
    rea_archived: true,
    rea_manual: false,
    rasic_status: null,
    rasic_on: null,
    rasic_archived: null,
    rasic_manual: null,
    ...over,
  });

  it('fires on REA only for the trades that need it', async () => {
    const construction = await B7_registryRegistration(
      ctxWith([{ match: "check_type = 'rea'", rows: [row()] }]),
    );
    expect(construction).toHaveLength(1);
    expect(construction[0]?.severity).toBe(2);
    expect(construction[0]?.summaryEn).toContain('No REA entry located');
    expect(construction[0]?.innocentExplanations.join(' ')).toMatch(
      /sole trader without employees is exempt/,
    );
    expectWellFormed(construction);

    const cleaning = await B7_registryRegistration(
      ctxWith([{ match: "check_type = 'rea'", rows: [row({ categories: ['CLEANING'] })] }]),
    );
    expect(cleaning).toHaveLength(0);
  });

  it('fires on RASIC at severity 3 for a regulated installation trade', async () => {
    const hits = await B7_registryRegistration(
      ctxWith([
        {
          match: "check_type = 'rea'",
          rows: [
            row({
              categories: ['ELEV_MAINT'],
              rea_status: null,
              rasic_status: 'not_found',
              rasic_on: '2026-09-01',
            }),
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(3);
    expect(hits[0]?.computed.register).toBe('RASIC');
  });

  it('stays silent when the register answered "registered"', async () => {
    const hits = await B7_registryRegistration(
      ctxWith([{ match: "check_type = 'rea'", rows: [row({ rea_status: 'ok' })] }]),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('B8 — vendor concentration', () => {
  it('measures ordinary spend only, at severity 1', async () => {
    const hits = await B8_vendorConcentration(
      ctxWith([
        {
          match: 'group by p.id, p.display_name',
          rows: [
            { id: VENDOR, display_name: 'A', ordinary_total: '5000.00', categories: 4 },
            { id: OTHER, display_name: 'B', ordinary_total: '1000.00', categories: 1 },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(1);
    expect(hits[0]?.computed.scope).toBe('ordinary_spend_only');
    expect(hits[0]?.computed.share_pct).toBeCloseTo(83.3, 1);
    expect(hits[0]?.summaryEn).toContain('Context only');
    expectWellFormed(hits);
  });

  it('does not fire below the 60% share', async () => {
    const hits = await B8_vendorConcentration(
      ctxWith([
        {
          match: 'group by p.id, p.display_name',
          rows: [
            { id: VENDOR, display_name: 'A', ordinary_total: '5000.00', categories: 4 },
            { id: OTHER, display_name: 'B', ordinary_total: '5000.00', categories: 3 },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('B9 — implied invoicing volume', () => {
  it('reports a low implied volume for a vendor above the works threshold', async () => {
    const hits = await B9_impliedVolume(
      ctxWith([
        {
          match: 'extract(year from v.fecha_expedicion)::int as year',
          rows: [
            {
              id: VENDOR,
              display_name: 'A',
              year: 2022,
              min_num: 40,
              max_num: 52,
              first_date: '2022-01-10',
              last_date: '2022-12-15',
              n: 5,
              total: '45000.00',
            },
          ],
        },
      ]),
    );
    const implied = hits.find((h) => h.eventKey.includes('implied_volume'));
    expect(implied?.severity).toBe(2);
    expect(implied?.computed.implied_invoices_per_year).toBe(13);
    expect(implied?.innocentExplanations.join(' ')).toMatch(/one series per client/);
    expectWellFormed(hits);
  });

  it('records a low first number as context only', async () => {
    const hits = await B9_impliedVolume(
      ctxWith([
        {
          match: 'extract(year from v.fecha_expedicion)::int as year',
          rows: [
            {
              id: VENDOR,
              display_name: 'A',
              year: 2022,
              min_num: 3,
              max_num: 400,
              first_date: '2022-01-10',
              last_date: '2022-12-15',
              n: 5,
              total: '45000.00',
            },
          ],
        },
      ]),
    );
    const first = hits.find((h) => h.eventKey.includes('first_number'));
    expect(first?.severity).toBe(1);
    expect(hits.find((h) => h.eventKey.includes('implied_volume'))).toBeUndefined();
  });
});

describe('A10 — comparison-quote authenticity', () => {
  const quoteRows = (over: Array<Record<string, unknown>> = []): Canned[] => [
    {
      match: 'from public.quotes q',
      rows:
        over.length > 0
          ? over
          : [
              {
                quote_id: 'q1',
                vendor_party_id: VENDOR,
                vendor_name: 'A',
                works_package_id: 'pkg-1',
                numero: 'P-2022/0140',
                fecha: '2022-03-01',
                document_id: 'd1',
                total_con_iva: '40000',
                pdf_meta: { Producer: 'ExempleWriter 1.0', Author: 'oficina' },
                phone_norm: '+34930000000',
              },
              {
                quote_id: 'q2',
                vendor_party_id: OTHER,
                vendor_name: 'B',
                works_package_id: 'pkg-1',
                numero: 'PR 0142',
                fecha: '2022-03-02',
                document_id: 'd2',
                total_con_iva: '44000',
                pdf_meta: { Producer: 'ExempleWriter 1.0', Author: 'oficina' },
                phone_norm: '+34930000000',
              },
            ],
    },
  ];

  it('reports one hit per works package, at severity 3 when several fingerprints coincide', async () => {
    const hits = await A10_quoteAuthenticity(ctxWith(quoteRows()));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(3);
    expect(hits[0]?.worksPackageId).toBe('pkg-1');
    expect(hits[0]?.computed.distinct_vendors).toBe(2);
    expect(hits[0]?.summaryEn).toMatch(/the same PDF producer/);
    expect(hits[0]?.innocentExplanations.join(' ')).toMatch(
      /architect’s or the administrator’s template/,
    );
    expectWellFormed(hits);
  });

  it('stays silent when the quotes share nothing', async () => {
    const hits = await A10_quoteAuthenticity(
      ctxWith(
        quoteRows([
          {
            quote_id: 'q1',
            vendor_party_id: VENDOR,
            vendor_name: 'A',
            works_package_id: 'pkg-1',
            numero: 'P-2022/0140',
            fecha: '2022-03-01',
            document_id: 'd1',
            total_con_iva: '40000',
            pdf_meta: { Producer: 'ExempleWriter 1.0' },
            phone_norm: '+34930000000',
          },
          {
            quote_id: 'q2',
            vendor_party_id: OTHER,
            vendor_name: 'B',
            works_package_id: 'pkg-1',
            numero: 'B/9912',
            fecha: '2022-03-02',
            document_id: 'd2',
            total_con_iva: '44000',
            pdf_meta: { Producer: 'AltraEina 3' },
            phone_norm: '+34931111111',
          },
        ]),
      ),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('G2, G5, G6 and G7', () => {
  it('G2 reports absent tax filings as a document request, dated from the request', async () => {
    const hits = await G2_taxFilings(
      ctxWith([
        {
          match: 'filings_on_file',
          rows: [
            {
              filings_on_file: 0,
              withholding_invoices: 2,
              natural_person_invoices: 1,
              requests: [
                {
                  id: 'r1',
                  class: 'modelo_347',
                  status: 'requested',
                  requested_on: '2026-07-14',
                  fiscal_year: 2024,
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(2);
    expect(hits[0]?.summaryEn).toContain('requested on 2026-07-14');
    expect(hits[0]?.summaryEn).toContain('not received as of 2026-09-04');
    expectWellFormed(hits);
  });

  it('G2 stays silent once a filing is in the corpus', async () => {
    const hits = await G2_taxFilings(
      ctxWith([
        {
          match: 'filings_on_file',
          rows: [
            {
              filings_on_file: 1,
              withholding_invoices: 2,
              natural_person_invoices: 1,
              requests: [],
            },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(0);
  });

  it('G5 reports the CE declaration, the maintainer’s register and the missing inspection', async () => {
    const hits = await G5_liftCompliance(
      ctxWith([
        {
          match: 'lift_packages',
          rows: [
            {
              lift_packages: 1,
              lift_invoices: 3,
              maintenance_invoices: 12,
              inspection_invoices: 0,
              ce_documents: 0,
              maintainers: [
                {
                  id: 's1',
                  vendor_party_id: OTHER,
                  label: 'Manteniment',
                  started_on: '2024-01-01',
                },
              ],
              lift_vendor_checks: [
                { party_id: OTHER, status: 'not_found', checked_on: '2026-09-01' },
              ],
            },
          ],
        },
      ]),
    );
    expect(hits.map((h) => h.eventKey.split(':').pop())).toEqual([
      'lift_ce_declaration',
      'rasic_absent',
      'lift_oca_inspection',
    ]);
    expect(hits[1]?.severity).toBe(2);
    expectWellFormed(hits);
  });

  it('G5 stays silent when there is no lift in the corpus at all', async () => {
    const hits = await G5_liftCompliance(
      ctxWith([
        {
          match: 'lift_packages',
          rows: [
            {
              lift_packages: 0,
              lift_invoices: 0,
              maintenance_invoices: 0,
              inspection_invoices: 0,
              ce_documents: 0,
              maintainers: [],
              lift_vendor_checks: [],
            },
          ],
        },
      ]),
    );
    expect(hits).toHaveLength(0);
  });

  it('G6 fires when coordination was billed and no appointment is on file, and harder with several contractors', async () => {
    const one = await G6_healthAndSafety(
      ctxWith([
        {
          match: 'prl_billed',
          rows: [
            {
              prl_billed: '1200.00',
              prl_invoices: 2,
              appointment_documents: 0,
              contractors_on_site: 1,
              first_prl_invoice: '2022-04-01',
            },
          ],
        },
      ]),
    );
    expect(one[0]?.severity).toBe(1);
    const many = await G6_healthAndSafety(
      ctxWith([
        {
          match: 'prl_billed',
          rows: [
            {
              prl_billed: '1200.00',
              prl_invoices: 2,
              appointment_documents: 0,
              contractors_on_site: 3,
              first_prl_invoice: '2022-04-01',
            },
          ],
        },
      ]),
    );
    expect(many[0]?.severity).toBe(2);
    expectWellFormed(many);

    const documented = await G6_healthAndSafety(
      ctxWith([
        {
          match: 'prl_billed',
          rows: [
            {
              prl_billed: '1200.00',
              prl_invoices: 2,
              appointment_documents: 1,
              contractors_on_site: 3,
              first_prl_invoice: '2022-04-01',
            },
          ],
        },
      ]),
    );
    expect(documented).toHaveLength(0);
  });

  it('G7 fires when no inspection document exists and says the construction year is not recorded', async () => {
    const hits = await G7_ite(
      ctxWith([
        {
          match: 'ite_documents',
          rows: [{ ite_documents: 0, ite_permits: 0, ite_invoices: 0, subsidies: 1 }],
        },
      ]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(1);
    expect(hits[0]?.summaryEn).toContain('year of construction is not recorded');
    expectWellFormed(hits);
  });

  it('G7 stands down for a building the parameters date after 1965, and when the certificate is on file', async () => {
    const recent = await G7_ite(
      ctxWith(
        [
          {
            match: 'ite_documents',
            rows: [{ ite_documents: 0, ite_permits: 0, ite_invoices: 0, subsidies: 0 }],
          },
        ],
        { building_year: 1998 },
      ),
    );
    expect(recent).toHaveLength(0);
    const onFile = await G7_ite(
      ctxWith(
        [
          {
            match: 'ite_documents',
            rows: [{ ite_documents: 1, ite_permits: 0, ite_invoices: 1, subsidies: 0 }],
          },
        ],
        { building_year: 1928 },
      ),
    );
    expect(onFile).toHaveLength(0);
  });
});

describe('registry and module wiring', () => {
  it('exports exactly the M5 codes of the catalogue', () => {
    expect(Object.keys(M5_RULES).sort()).toEqual([
      'A10',
      'B1',
      'B2',
      'B3',
      'B7',
      'B8',
      'B9',
      'G2',
      'G5',
      'G6',
      'G7',
    ]);
  });

  it('scores an archived machine response above a manual capture', () => {
    expect(checkIndependence({ archived: true, manual_evidence: false })).toBe(1);
    expect(checkIndependence({ archived: true, manual_evidence: true })).toBe(0.7);
    expect(checkIndependence({ archived: false })).toBe(0.7);
    expect(checkIndependence(null)).toBe(0.7);
  });

  it('collapses B7 and G5 onto one event when both fire on the same absent RASIC entry', async () => {
    const b7 = await B7_registryRegistration(
      ctxWith([
        {
          match: "check_type = 'rea'",
          rows: [
            {
              id: OTHER,
              display_name: 'ASCENSORS EXEMPLE SL',
              nif_kind: 'CIF',
              categories: ['ELEV_MAINT'],
              invoice_total: '9000',
              first_invoice: '2024-02-01',
              rea_status: null,
              rasic_status: 'not_found',
              rasic_on: '2026-09-01',
              rasic_archived: true,
              rasic_manual: false,
            },
          ],
        },
      ]),
    );
    const g5 = await G5_liftCompliance(
      ctxWith([
        {
          match: 'lift_packages',
          rows: [
            {
              lift_packages: 1,
              lift_invoices: 0,
              maintenance_invoices: 12,
              inspection_invoices: 4,
              ce_documents: 1,
              maintainers: [],
              lift_vendor_checks: [
                { party_id: OTHER, status: 'not_found', checked_on: '2026-09-01' },
              ],
            },
          ],
        },
      ]),
    );
    const collapsed = collapse([...b7, ...g5]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.ruleCode).toBe('B7');
    expect(collapsed[0]?.collapsedFrom).toEqual(['G5']);
  });
});
