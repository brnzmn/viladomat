/**
 * End-to-end check of the M5 vendor module against a real Postgres with the migrations applied.
 *
 * The whole scenario is seeded inside one transaction and rolled back, so the database is left
 * exactly as it was. Set `M5_DATABASE_URL` to a database of your own (`m5test`) when other work
 * is using `DATABASE_URL`; the suite is skipped when neither is configured.
 *
 * What it proves end to end: `external_checks` really is append-only, a re-run appends rather
 * than overwrites, `public.upsert_reference_person` + `public.reference_match_keys` are the only
 * route to the office-holder material, officers land in `entity_officers`, and the scorer turns
 * all of that into `party_links` rows with the tier and the explanation the plan fixes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { envOptional, REPO_ROOT } from '../lib/env.ts';
import { parseCompanyProfile } from './checks/company-profile.ts';
import {
  aggregateLinks,
  hmacNif,
  scoreVendorLinks,
  writePartyLinks,
  loadPartyLinks,
  loadReferenceKeys,
} from './links.ts';
import { officersFromProfile, upsertOfficers } from './officers.ts';
import { cachedNormalised, latestChecks, persistCheck } from './persist.ts';
import { loadLinkInputs } from './snapshot.ts';
import { vendorFactSheet } from './factsheet.ts';
import type { CheckResult, CheckSubject } from './types.ts';

const DATABASE_URL = envOptional('M5_DATABASE_URL') ?? envOptional('DATABASE_URL');
const suite = DATABASE_URL ? describe : describe.skip;

const HMAC_KEY = Buffer.from('m5-integration-test-key-0000000000').toString('base64');
const VENDOR_NIF = 'B12345674';
const TODAY = '2026-09-04';

interface Seeded {
  cid: string;
  vendorId: string;
  otherVendorId: string;
  adminId: string;
  profileCheckId: string;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'm5', name), 'utf8'));
}

function checkResult(
  type: string,
  normalised: Record<string, unknown>,
  raw: unknown = { fixture: true },
): CheckResult {
  return {
    type,
    status: 'ok',
    normalised,
    raw,
    source_url: `https://example.test/${type}`,
    cost_cents: 0,
    request: { fixture: true },
  };
}

suite('M5 vendor module against Postgres', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let seeded: Seeded;
  const previousKey = process.env.IBAN_HMAC_KEY;

  beforeAll(async () => {
    process.env.IBAN_HMAC_KEY = HMAC_KEY;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    client = await pool.connect();
    await client.query('begin');

    const one = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> => {
      const r = await client.query(sql, params);
      return r.rows[0] as Record<string, unknown>;
    };

    const community = await one(
      `insert into public.communities (name, nif, address, fy_start_month, ordinary_budget_default)
       values ('Comunitat M5 de prova', 'H12345674', 'carrer de mostra 25', 1, 6700) returning id`,
    );
    const cid = String(community.id);

    const vendor = await one(
      `insert into public.parties (community_id, kind, display_name, legal_name_norm, nif, nif_valid, nif_kind, entity_letter, address_norm, phone_norm, email_norm, domain)
       values ($1, 'vendor', 'OBRES EXEMPLE BARNA SL', 'obres exemple barna', $2, true, 'CIF', 'B',
               'carrer de prova 7', '+34930000000', 'info@exemple.test', 'exemple.test') returning id`,
      [cid, VENDOR_NIF],
    );
    const otherVendor = await one(
      `insert into public.parties (community_id, kind, display_name, legal_name_norm, nif, nif_valid, nif_kind, address_norm, phone_norm)
       values ($1, 'vendor', 'ASCENSORS EXEMPLE SL', 'ascensors exemple', 'B58818501', true, 'CIF',
               'carrer compartit 3', '+34930000000') returning id`,
      [cid],
    );
    const admin = await one(
      `insert into public.parties (community_id, kind, display_name, legal_name_norm, address_norm)
       values ($1, 'administrator', 'Administracio Exemple SL', 'administracio exemple', 'carrer compartit 3') returning id`,
      [cid],
    );
    await client.query(
      `insert into public.office_terms (community_id, office, party_id, valid_from) values ($1, 'administrator', $2, '2019-01-01')`,
      [cid, admin.id],
    );
    // Both vendors are recorded against the same account digest.
    for (const partyId of [vendor.id, otherVendor.id]) {
      await client.query(
        `insert into public.party_ibans (community_id, party_id, iban_hmac, iban_last4) values ($1, $2, 'hmac-shared-account', '0001')`,
        [cid, partyId],
      );
    }

    // The office-holder material goes in through the RPC and comes back only through the other one.
    await client.query(
      `select public.upsert_reference_person($1, 'president', 'Exemple', 'Mostra', 'Josep Maria',
                array['carrer de prova 7'], array['hmac-president-quota-iban'], $2, null, '{}', 'test fixture')`,
      [cid, hmacNif(VENDOR_NIF, HMAC_KEY)],
    );

    // Registry checks, appended as they would be by `vx vendors check`.
    const profile = parseCompanyProfile(fixture('company-profile-detail.json'));
    const vendorSubject: CheckSubject = {
      subjectType: 'party',
      subjectKey: String(vendor.id),
      partyId: String(vendor.id),
      nif: VENDOR_NIF,
    };
    const profileRow = await persistCheck(
      client,
      cid,
      vendorSubject,
      checkResult(
        'company_profile',
        profile as unknown as Record<string, unknown>,
        fixture('company-profile-detail.json'),
      ),
    );
    await persistCheck(client, cid, vendorSubject, {
      ...checkResult('rea', { registered: false }),
      status: 'not_found',
    });
    // EXEMPLE is rare, MOSTRA is above the 5 per mille cut-off and must therefore be ignored
    // when it is the only surname that coincides.
    for (const [surname, perMille] of [
      ['EXEMPLE', 0.07],
      ['MOSTRA', 12],
      ['ROCA', 3],
      ['VIVES', 4],
    ] as const) {
      await persistCheck(
        client,
        cid,
        { subjectType: 'surname', subjectKey: surname },
        checkResult('surname_frequency', { surname, per_mille: perMille, basis: 'published_rate' }),
      );
    }

    await upsertOfficers(
      client,
      cid,
      String(vendor.id),
      officersFromProfile(profile),
      profileRow.id,
    );

    // One invoice, so the company-age signal has a first invoice to compare against.
    const doc = await one(
      `insert into public.documents (community_id, doc_type, doc_date, issuer_party_id) values ($1, 'factura', '2021-12-20', $2) returning id`,
      [cid, vendor.id],
    );
    await client.query(
      `insert into public.invoices (community_id, document_id, vendor_party_id, serie, numero, numero_int, fecha_expedicion, total, category_code)
       values ($1, $2, $3, 'A', '41', 41, '2021-12-20', 45000, 'MASONRY')`,
      [cid, doc.id, vendor.id],
    );

    seeded = {
      cid,
      vendorId: String(vendor.id),
      otherVendorId: String(otherVendor.id),
      adminId: String(admin.id),
      profileCheckId: profileRow.id,
    };
  });

  afterAll(async () => {
    if (client) {
      await client.query('rollback');
      client.release();
    }
    if (pool) await pool.end();
    if (previousKey === undefined) delete process.env.IBAN_HMAC_KEY;
    else process.env.IBAN_HMAC_KEY = previousKey;
  });

  it('appends external checks and refuses to change one', async () => {
    const before = await latestChecks(client, seeded.cid, ['company_profile']);
    expect(before).toHaveLength(1);

    await persistCheck(
      client,
      seeded.cid,
      {
        subjectType: 'party',
        subjectKey: seeded.vendorId,
        partyId: seeded.vendorId,
        nif: VENDOR_NIF,
      },
      checkResult('company_profile', { incorporation_date: '2021-11-08', note: 're-run' }),
    );
    const all = await client.query(
      `select count(*)::int as n from public.external_checks where community_id = $1 and check_type = 'company_profile'`,
      [seeded.cid],
    );
    expect((all.rows[0] as { n: number }).n).toBe(2);
    // The latest row is the re-run; the earlier answer is still on the record.
    const latest = await latestChecks(client, seeded.cid, ['company_profile']);
    expect((latest[0]?.normalised as { note?: string }).note).toBe('re-run');

    // A failed statement aborts the surrounding transaction, so the attempt runs in a savepoint.
    await client.query('savepoint sp_append');
    await expect(
      client.query(`update public.external_checks set status = 'error' where id = $1`, [
        seeded.profileCheckId,
      ]),
    ).rejects.toThrow(/append-only/);
    await client.query('rollback to savepoint sp_append');
    await client.query('savepoint sp_delete');
    await expect(
      client.query(`delete from public.external_checks where id = $1`, [seeded.profileCheckId]),
    ).rejects.toThrow(/append-only/);
    await client.query('rollback to savepoint sp_delete');
  });

  it('reads a recent surname frequency back from the check log', async () => {
    const cached = await cachedNormalised(client, seeded.cid, 'surname_frequency', 'EXEMPLE', 365);
    expect(cached).toMatchObject({ surname: 'EXEMPLE', per_mille: 0.07 });
    expect(
      await cachedNormalised(client, seeded.cid, 'surname_frequency', 'NO-SUCH-SURNAME', 365),
    ).toBeNull();
  });

  it('records the officers of the gazette profile', async () => {
    const res = await client.query(
      `select person_name_norm, surname1_norm, surname2_norm, given_norm, cargo, borme_ref, source_check_id
         from public.entity_officers where community_id = $1 order by surname1_norm`,
      [seeded.cid],
    );
    expect(res.rows).toHaveLength(2);
    const first = res.rows[0] as Record<string, unknown>;
    expect(first.surname1_norm).toBe('EXEMPLE');
    expect(first.surname2_norm).toBe('ROCA');
    expect(first.given_norm).toBe('JOSEP MARIA');
    expect(first.source_check_id).toBe(seeded.profileCheckId);
    expect(first.borme_ref).toMatchObject({ seccion: 'A' });
  });

  it('reaches the office-holder material only through public.reference_match_keys', async () => {
    const keys = await loadReferenceKeys(client, seeded.cid);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ role: 'president', surname1: 'EXEMPLE', surname2: 'MOSTRA' });
    expect(keys[0]?.nifHmac).toBe(hmacNif(VENDOR_NIF, HMAC_KEY));
  });

  it('scores the signals and writes party_links with tier, points and the explanation template', async () => {
    const inputs = await loadLinkInputs(client, seeded.cid, TODAY);
    expect(inputs.vendors.map((v) => v.partyId).sort()).toEqual(
      [seeded.vendorId, seeded.otherVendorId, seeded.adminId].sort(),
    );

    const signals = inputs.vendors.flatMap((v) => scoreVendorLinks(v, inputs.context));
    // Two officers each share one surname with the presidency record, but the second surname is
    // carried by 12 per mille, so only the rare one produces a signal at all.
    expect(signals.filter((s) => s.signal === 'S4')).toHaveLength(1);

    const links = aggregateLinks(signals);
    const res = await writePartyLinks(client, seeded.cid, links);
    expect(res.written).toBeGreaterThan(0);

    const stored = await loadPartyLinks(client, seeded.cid);
    const byCode = new Map(stored.map((r) => [String(r.signal), r]));

    // S1: the vendor's identifier digest equals the one recorded for the presidency.
    expect(byCode.get('S1')).toMatchObject({ to_role: 'president', tier: 'priority' });
    expect(Number(byCode.get('S1')?.points)).toBe(100);

    // S4: the rare surname, weighted 1.3, with its expected-homonym count printed.
    const s4 = byCode.get('S4');
    expect(s4).toBeDefined();
    expect(Number(s4?.points)).toBeCloseTo(8 * 1.3, 2);
    expect(Number(s4?.expected_collisions)).toBeCloseTo(1_600_000 * 0.00007, 2);
    expect(String(s4?.tier)).toBe('note');

    // S5: the vendor's registered address is the one recorded for the presidency.
    expect(byCode.get('S5')).toMatchObject({ to_role: 'president', tier: 'priority' });

    for (const row of stored) {
      expect(String(row.explanation)).toMatch(/^Possible link to verify: /);
      expect(String(row.explanation)).toMatch(/nota informativa not yet obtained\.$/);
      expect(String(row.status)).toBe('open');
    }

    // Re-running is idempotent: one row per vendor, role and signal.
    await writePartyLinks(client, seeded.cid, links);
    expect(await loadPartyLinks(client, seeded.cid)).toHaveLength(stored.length);
  });

  it('keeps the coincidences that have no office-holder role out of party_links', async () => {
    const inputs = await loadLinkInputs(client, seeded.cid, TODAY);
    const links = aggregateLinks(
      inputs.vendors.flatMap((v) => scoreVendorLinks(v, inputs.context)),
    );
    const roleless = links.filter((l) => l.role === null);
    // Shared account digest between the two vendors, shared address with the administrator,
    // the company's age against its first invoice, and the absent REA entry.
    expect(roleless.map((l) => l.signal).sort()).toEqual(
      expect.arrayContaining(['S10', 'S7', 'S8']),
    );
    const stored = await loadPartyLinks(client, seeded.cid);
    for (const row of stored) {
      expect(['president', 'president_family', 'administrator']).toContain(String(row.to_role));
    }
  });

  it('builds a fact sheet with no score, no link and no natural-person name', async () => {
    const sheet = await vendorFactSheet(client, seeded.cid);
    expect(sheet.vendors.length).toBeGreaterThanOrEqual(2);
    const vendor = sheet.vendors.find((v) => v.party_id === seeded.vendorId);
    expect(vendor?.entity_kind).toBe('Sociedad de responsabilidad limitada');
    expect(vendor?.incorporation_date).toBe('2021-11-08');
    expect(vendor?.officers.map((o) => o.initials)).toContain('J.M. E. R.');
    expect(vendor?.rea_status).toBe('not located');
    const text = JSON.stringify(sheet);
    expect(text).not.toContain('JOSEP');
    expect(text).not.toContain('party_link');
  });
});
