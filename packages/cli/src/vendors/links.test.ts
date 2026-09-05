/**
 * Scoring tests for the related-party signals.
 *
 * Everything here is canned: invented officers, invented addresses, invented digests. The point
 * of the suite is that the arithmetic of the rarity weights and of the expected-homonym count is
 * exactly what the rule catalogue says, and that a coincidence on a common surname produces
 * nothing at all.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateLinks,
  expectedCollisions,
  explanationFor,
  hmacNif,
  linkTargets,
  pairWeight,
  rarityWeight,
  scoreVendorLinks,
  tierForPoints,
  vendorLinkScore,
  writePartyLinks,
  UNKNOWN_FREQUENCY_WEIGHT,
  type AggregatedLink,
  type LinkSignal,
  type ScoringContext,
  type VendorSnapshot,
} from './links.ts';
import type { Queryable } from './persist.ts';

const VENDOR_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_VENDOR = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

function vendor(overrides: Partial<VendorSnapshot> = {}): VendorSnapshot {
  return {
    partyId: VENDOR_ID,
    displayName: 'OBRES EXEMPLE BARNA SL',
    kind: 'vendor',
    nifHmac: null,
    addressNorm: null,
    phoneNorm: null,
    emailNorm: null,
    emailDomain: null,
    ibanHmacs: [],
    officers: [],
    incorporationDate: null,
    capitalEur: null,
    cnae: null,
    cnaeRelated: null,
    firstInvoiceDate: null,
    registry: { rea: 'unknown', rasic: 'unknown', census: 'unknown', nifChecksum: 'unknown' },
    quoteFingerprints: [],
    signerAlsoAdvises: null,
    profileSource: { checkType: 'company_profile', date: '2026-09-01', checkId: 'c1' },
    evidenceIds: [],
    notaInformativaOn: null,
    ...overrides,
  };
}

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    reference: [],
    buildingAddresses: [],
    addressCounts: {},
    addressOwners: {},
    ibanOwners: {},
    phoneOwners: {},
    emailDomainOwners: {},
    mailboxOwners: {},
    administratorPartyIds: [ADMIN_ID],
    presidencyQuotaIbans: [],
    surnamePerMille: {},
    today: '2026-09-04',
    ...overrides,
  };
}

/** A president reference record: surnames, an address and a digest, nothing else. */
const PRESIDENT = {
  role: 'president' as const,
  surname1: 'EXEMPLE',
  surname2: 'MOSTRA',
  given: 'JOSEP MARIA',
  addresses: ['carrer de prova 7'],
  ibanHmacs: ['hmac-president-quota-iban'],
  nifHmac: 'hmac-president-nif',
};

const officer = (
  surname1: string,
  surname2: string,
  given = 'JOSEP MARIA',
): VendorSnapshot['officers'][number] => ({
  personNameNorm: `${given} ${surname1} ${surname2}`.trim(),
  surname1,
  surname2,
  given,
  cargo: 'Administrador único',
  nifHmac: null,
});

function only(signals: readonly LinkSignal[], code: string): LinkSignal[] {
  return signals.filter((s) => s.signal === code);
}

describe('rarity weights and expected homonyms', () => {
  it('follows the bands of the catalogue', () => {
    expect(rarityWeight(0.05)).toBe(1.3);
    expect(rarityWeight(0.1)).toBe(1.0);
    expect(rarityWeight(1)).toBe(1.0);
    expect(rarityWeight(1.01)).toBe(0.6);
    expect(rarityWeight(10)).toBe(0.6);
    expect(rarityWeight(10.1)).toBe(0.3);
    expect(rarityWeight(null)).toBe(UNKNOWN_FREQUENCY_WEIGHT);
  });

  it('combines a pair of surnames as the geometric mean', () => {
    expect(pairWeight(1.3, 0.3)).toBeCloseTo(Math.sqrt(0.39), 10);
    expect(pairWeight(1, 1)).toBe(1);
  });

  it('computes expected homonyms as population x f1 x f2', () => {
    // 1.6 M x 0.5/1000 x 2/1000 = 1.6
    expect(expectedCollisions([0.5, 2])).toBeCloseTo(1.6, 6);
    // A single surname at 20 per mille: 1.6 M x 0.02 = 32,000 people.
    expect(expectedCollisions([20])).toBe(32000);
    expect(expectedCollisions([0.5, null])).toBeNull();
  });

  it('maps points to the tiers of the plan', () => {
    expect(tierForPoints(100)).toBe('priority');
    expect(tierForPoints(80)).toBe('priority');
    expect(tierForPoints(79.9)).toBe('review');
    expect(tierForPoints(40)).toBe('review');
    expect(tierForPoints(39.9)).toBe('note');
  });
});

describe('S1 and S2 — identifiers and full names', () => {
  it('scores an identifier digest equality at 100', () => {
    const signals = scoreVendorLinks(
      vendor({ nifHmac: 'hmac-president-nif' }),
      context({ reference: [PRESIDENT] }),
    );
    const s1 = only(signals, 'S1');
    expect(s1).toHaveLength(1);
    expect(s1[0]?.points).toBe(100);
    expect(s1[0]?.role).toBe('president');
  });

  it('scores a full-name officer coincidence at 90 and recognises given-name variants', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('EXEMPLE', 'MOSTRA', 'JOSE MARIA')] }),
      context({ reference: [PRESIDENT], surnamePerMille: { EXEMPLE: 0.07, MOSTRA: 2.4 } }),
    );
    const s2 = only(signals, 'S2');
    expect(s2).toHaveLength(1);
    expect(s2[0]?.points).toBe(90);
    // The expected-homonym count is printed even for a full-name match (rounded to 2 decimals).
    expect(s2[0]?.expectedCollisions).toBe(0.27);
    expect(only(signals, 'S3')).toHaveLength(0);
  });
});

describe('S3 and S4 — surnames', () => {
  it('scores both surnames in the same order at 45 x w', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('EXEMPLE', 'MOSTRA', 'LAIA')] }),
      context({ reference: [PRESIDENT], surnamePerMille: { EXEMPLE: 0.07, MOSTRA: 2.4 } }),
    );
    const s3 = only(signals, 'S3');
    const w = pairWeight(1.3, 0.6);
    expect(s3).toHaveLength(1);
    expect(s3[0]?.points).toBeCloseTo(Math.round(45 * w * 100) / 100, 2);
    expect(s3[0]?.detail.order).toBe('same');
  });

  it('scores the reversed order at 30 x w', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('MOSTRA', 'EXEMPLE', 'LAIA')] }),
      context({ reference: [PRESIDENT], surnamePerMille: { EXEMPLE: 0.07, MOSTRA: 2.4 } }),
    );
    const s3 = only(signals, 'S3');
    expect(s3[0]?.detail.order).toBe('reversed');
    expect(s3[0]?.points).toBeCloseTo(Math.round(30 * pairWeight(1.3, 0.6) * 100) / 100, 2);
  });

  it('scores one rare surname at 8 x w', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('EXEMPLE', 'ALTRACOSA', 'LAIA')] }),
      context({ reference: [PRESIDENT], surnamePerMille: { EXEMPLE: 0.07 } }),
    );
    const s4 = only(signals, 'S4');
    expect(s4).toHaveLength(1);
    expect(s4[0]?.points).toBeCloseTo(8 * 1.3, 2);
    expect(s4[0]?.expectedCollisions).toBeCloseTo(112, 5);
  });

  it('produces nothing at all when the single surname is carried by more than 5 per mille', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('MOSTRA', 'ALTRACOSA', 'LAIA')] }),
      context({ reference: [PRESIDENT], surnamePerMille: { MOSTRA: 12 } }),
    );
    expect(only(signals, 'S4')).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  it('keeps a single-surname coincidence with an unknown frequency, at the neutral weight', () => {
    const signals = scoreVendorLinks(
      vendor({ officers: [officer('EXEMPLE', 'ALTRACOSA', 'LAIA')] }),
      context({ reference: [PRESIDENT] }),
    );
    const s4 = only(signals, 'S4')[0];
    expect(s4?.points).toBeCloseTo(8 * UNKNOWN_FREQUENCY_WEIGHT, 2);
    expect(s4?.expectedCollisions).toBeNull();
    expect(s4?.detail.frequency_known).toBe(false);
  });
});

describe('S5 and S6 — addresses', () => {
  it('scores the office-holder address at 80 and keeps the role', () => {
    const signals = scoreVendorLinks(
      vendor({ addressNorm: 'carrer de prova 7' }),
      context({ reference: [PRESIDENT] }),
    );
    const s5 = only(signals, 'S5');
    expect(s5).toHaveLength(1);
    expect(s5[0]?.points).toBe(80);
    expect(s5[0]?.role).toBe('president');
  });

  it('scores the building itself at 80 but with no office-holder role', () => {
    const signals = scoreVendorLinks(
      vendor({ addressNorm: 'carrer de mostra 25' }),
      context({ buildingAddresses: ['carrer de mostra 25'] }),
    );
    expect(only(signals, 'S5')[0]?.points).toBe(80);
    expect(only(signals, 'S5')[0]?.role).toBeNull();
  });

  it('scores a shared address at 40', () => {
    const addr = 'carrer compartit 3';
    const signals = scoreVendorLinks(
      vendor({ addressNorm: addr }),
      context({
        addressOwners: { [addr]: [VENDOR_ID, OTHER_VENDOR] },
        addressCounts: { [addr]: 2 },
      }),
    );
    const s6 = only(signals, 'S6')[0];
    expect(s6?.points).toBe(40);
    expect(s6?.detail.domiciliation).toBe(false);
  });

  it('downgrades a shared address to 15 once it looks like a domiciliation address', () => {
    const addr = 'carrer compartit 3';
    const signals = scoreVendorLinks(
      vendor({ addressNorm: addr }),
      context({
        addressOwners: { [addr]: [VENDOR_ID, OTHER_VENDOR, ADMIN_ID] },
        addressCounts: { [addr]: 41 },
      }),
    );
    const s6 = only(signals, 'S6')[0];
    expect(s6?.points).toBe(15);
    expect(s6?.detail.domiciliation).toBe(true);
    expect(s6?.role).toBe('administrator');
    expect(s6?.facts.join(' ')).toMatch(/41 entities/);
  });
});

describe('S7 — accounts, telephone and e-mail', () => {
  it('scores an account that pays the presidency quotas at 100 and reuse across parties at 90', () => {
    const signals = scoreVendorLinks(
      vendor({ ibanHmacs: ['hmac-president-quota-iban', 'hmac-shared'] }),
      context({
        reference: [PRESIDENT],
        presidencyQuotaIbans: ['hmac-president-quota-iban'],
        ibanOwners: { 'hmac-shared': [VENDOR_ID, OTHER_VENDOR] },
      }),
    );
    const s7 = only(signals, 'S7');
    expect(s7.map((s) => s.points).sort((a, b) => b - a)).toEqual([100, 90]);
    expect(s7.find((s) => s.points === 100)?.role).toBe('president');
  });

  it('scores a shared telephone at 60 and a shared e-mail at 50', () => {
    const signals = scoreVendorLinks(
      vendor({
        phoneNorm: '+34930000000',
        emailNorm: 'info@exemple.test',
        emailDomain: 'exemple.test',
      }),
      context({
        phoneOwners: { '+34930000000': [VENDOR_ID, OTHER_VENDOR] },
        mailboxOwners: { 'info@exemple.test': [VENDOR_ID, OTHER_VENDOR] },
        emailDomainOwners: { 'exemple.test': [VENDOR_ID, OTHER_VENDOR] },
      }),
    );
    const points = only(signals, 'S7')
      .map((s) => s.points)
      .sort((a, b) => b - a);
    expect(points).toEqual([60, 50, 50]);
  });
});

describe('S8, S9, S10 and S11', () => {
  it('adds the age, capital and activity modifiers of S8', () => {
    const signals = scoreVendorLinks(
      vendor({
        incorporationDate: '2021-11-08',
        firstInvoiceDate: '2021-12-20',
        capitalEur: 3000,
        cnaeRelated: false,
      }),
      context(),
    );
    const s8 = only(signals, 'S8')[0];
    expect(s8?.points).toBe(45 + 10 + 25);
    expect(s8?.role).toBeNull();
  });

  it('uses 25 points when the first invoice is between three and twelve months after incorporation', () => {
    const signals = scoreVendorLinks(
      vendor({ incorporationDate: '2021-01-10', firstInvoiceDate: '2021-09-10' }),
      context(),
    );
    expect(only(signals, 'S8')[0]?.points).toBe(25);
  });

  it('produces no S8 at all for an established company', () => {
    const signals = scoreVendorLinks(
      vendor({ incorporationDate: '2005-01-10', firstInvoiceDate: '2022-09-10', capitalEur: 3000 }),
      context(),
    );
    expect(only(signals, 'S8')).toHaveLength(0);
  });

  it('scores look-alike quotes at 50', () => {
    const signals = scoreVendorLinks(
      vendor({
        quoteFingerprints: [
          {
            kind: 'pdf_producer',
            value: 'ExempleWriter 1.0',
            otherPartyIds: [OTHER_VENDOR],
            quoteIds: ['q1', 'q2'],
          },
        ],
      }),
      context(),
    );
    expect(only(signals, 'S9')[0]?.points).toBe(50);
  });

  it('takes the strongest registry state for S10 and lists the rest', () => {
    const signals = scoreVendorLinks(
      vendor({
        registry: { rea: 'absent', rasic: 'absent', census: 'fail', nifChecksum: 'invalid' },
      }),
      context(),
    );
    const s10 = only(signals, 'S10')[0];
    expect(s10?.points).toBe(60);
    expect(s10?.facts).toHaveLength(4);
    expect(s10?.detail.leading).toBe('census');
  });

  it('scores the signer who also advises at 40, with the role observed', () => {
    const signals = scoreVendorLinks(
      vendor({
        signerAlsoAdvises: { role: 'administrator', note: 'minutes of 2022-05-11, item 4' },
      }),
      context(),
    );
    expect(only(signals, 'S11')[0]).toMatchObject({ points: 40, role: 'administrator' });
  });
});

describe('aggregation and wording', () => {
  it('takes the strongest sub-case per signal, except S8 which is additive', () => {
    const links = aggregateLinks(
      scoreVendorLinks(
        vendor({
          phoneNorm: '+34930000000',
          ibanHmacs: ['hmac-shared'],
          incorporationDate: '2021-11-08',
          firstInvoiceDate: '2021-12-20',
          capitalEur: 1,
        }),
        context({
          phoneOwners: { '+34930000000': [VENDOR_ID, OTHER_VENDOR] },
          ibanOwners: { 'hmac-shared': [VENDOR_ID, OTHER_VENDOR] },
        }),
      ),
    );
    const s7 = links.find((l) => l.signal === 'S7');
    expect(s7?.points).toBe(90);
    expect(s7?.facts).toHaveLength(2);
    expect(links.find((l) => l.signal === 'S8')?.points).toBe(55);
  });

  it('writes the explanation in the fixed template, with the homonym count and the nota status', () => {
    const links = aggregateLinks(
      scoreVendorLinks(
        vendor({ officers: [officer('EXEMPLE', 'MOSTRA', 'LAIA')] }),
        context({ reference: [PRESIDENT], surnamePerMille: { EXEMPLE: 0.07, MOSTRA: 2.4 } }),
      ),
    );
    const s3 = links.find((l) => l.signal === 'S3');
    expect(s3?.explanation).toMatch(/^Possible link to verify: /);
    expect(s3?.explanation).toMatch(/expected homonyms: 0\.27/);
    expect(s3?.explanation).toMatch(/source: company_profile 2026-09-01/);
    expect(s3?.explanation).toMatch(/nota informativa not yet obtained\.$/);
  });

  it('says so when the confirming registry note has been obtained', () => {
    const text = explanationFor(
      {
        facts: ['both surnames coincide'],
        expectedCollisions: 3.2,
        source: { checkType: 'company_profile', date: '2026-09-01' },
      },
      '2026-09-03',
    );
    expect(text).toMatch(/nota informativa obtained on 2026-09-03\.$/);
  });

  it('prints "not applicable" for signals that have no homonym arithmetic', () => {
    const links = aggregateLinks(
      scoreVendorLinks(
        vendor({ nifHmac: 'hmac-president-nif' }),
        context({ reference: [PRESIDENT] }),
      ),
    );
    expect(links[0]?.explanation).toMatch(/expected homonyms: not applicable/);
  });

  it('sums every signal into one ordering score, role-bearing or not', () => {
    const links = aggregateLinks(
      scoreVendorLinks(
        vendor({
          nifHmac: 'hmac-president-nif',
          registry: { rea: 'absent', rasic: 'unknown', census: 'unknown', nifChecksum: 'unknown' },
        }),
        context({ reference: [PRESIDENT] }),
      ),
    );
    expect(vendorLinkScore(links)).toBe(130);
    expect(links.filter((l) => l.role === null)).toHaveLength(1);
  });
});

describe('identifier digests', () => {
  it('are deterministic, key-dependent and never reversible to the identifier', () => {
    const key = Buffer.from('m5-test-key-0123456789').toString('base64');
    const other = Buffer.from('a-different-key-0123456').toString('base64');
    expect(hmacNif('B12345674', key)).toBe(hmacNif('b-12345674', key));
    expect(hmacNif('B12345674', key)).not.toBe(hmacNif('B12345674', other));
    expect(hmacNif('B12345674', key)).not.toContain('12345674');
    expect(() => hmacNif('B12345674', '')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Persistence of the links (recording client; the real table is exercised in the integration test)
// ---------------------------------------------------------------------------

function aggregated(overrides: Partial<AggregatedLink> = {}): AggregatedLink {
  return {
    partyId: VENDOR_ID,
    role: null,
    signal: 'S7',
    points: 90,
    rarityWeight: null,
    expectedCollisions: null,
    tier: 'priority',
    facts: ['an account digest of the vendor is also recorded for another party'],
    detail: { basis: 'iban_reuse', shared_with_party_ids: [OTHER_VENDOR] },
    source: { checkType: 'iban_validate', date: '2026-09-01' },
    evidenceIds: [],
    explanation: 'Possible link to verify: …',
    ...overrides,
  };
}

interface Call {
  sql: string;
  params: unknown[];
}

function recordingClient(updateHits = 0): { client: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const isUpdate = /^\s*update/i.test(sql);
      return Promise.resolve({ rows: [], rowCount: isUpdate ? updateHits : 1 });
    },
  } as unknown as Queryable;
  return { client, calls };
}

describe('linkTargets', () => {
  it('reads the other parties out of the signal detail and never points a link at its own vendor', () => {
    expect(linkTargets(aggregated({ detail: { shared_with_party_ids: [OTHER_VENDOR, VENDOR_ID] } }))).toEqual([
      OTHER_VENDOR,
    ]);
    expect(
      linkTargets(
        aggregated({ detail: { fingerprints: [{ kind: 'phone', other_party_ids: [ADMIN_ID, OTHER_VENDOR] }] } }),
      ),
    ).toEqual([OTHER_VENDOR, ADMIN_ID].sort());
    expect(linkTargets(aggregated({ detail: { incorporation_date: '2021-11-08' } }))).toEqual([]);
  });
});

describe('writePartyLinks', () => {
  it('upserts a role-bearing link on the unique key and stores its detail', async () => {
    const { client, calls } = recordingClient();
    const res = await writePartyLinks(client, 'cid', [
      aggregated({ role: 'president', signal: 'S1', points: 100, detail: { basis: 'nif_hmac' } }),
    ]);
    expect(res).toEqual({ written: 1, skippedRoleless: 0 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.sql).toMatch(/on conflict \(community_id, from_party_id, to_role, signal\)/);
    expect(call.sql).toMatch(/detail/);
    expect(call.params[2]).toBe('president');
    expect(call.params[3]).toBe('S1');
    expect(JSON.parse(String(call.params[10]))).toEqual({ basis: 'nif_hmac' });
  });

  it('writes a role-less coincidence against each other party it points at (update, then insert)', async () => {
    const { client, calls } = recordingClient(0);
    const res = await writePartyLinks(client, 'cid', [aggregated()]);
    expect(res).toEqual({ written: 1, skippedRoleless: 0 });
    expect(calls).toHaveLength(2);
    const update = calls[0] as Call;
    const insert = calls[1] as Call;
    expect(update.sql).toMatch(/^\s*update public\.party_links/);
    expect(update.sql).toMatch(/to_role is null and to_party_id = \$3/);
    expect(update.params[2]).toBe(OTHER_VENDOR);
    expect(insert.sql).toMatch(/to_party_id/);
    expect(insert.params[2]).toBe(OTHER_VENDOR);
    expect(insert.params[3]).toBe('S7');
  });

  it('only updates when the role-less row already exists', async () => {
    const { client, calls } = recordingClient(1);
    const res = await writePartyLinks(client, 'cid', [aggregated()]);
    expect(res.written).toBe(1);
    expect(calls).toHaveLength(1);
    expect((calls[0] as Call).sql).toMatch(/^\s*update/);
  });

  it('skips and counts a role-less link with nothing to point at', async () => {
    const { client, calls } = recordingClient();
    const res = await writePartyLinks(client, 'cid', [
      aggregated({ signal: 'S8', detail: { incorporation_date: '2021-11-08', first_invoice_date: '2021-12-20' } }),
      aggregated({ signal: 'S10', detail: { states: {}, leading: 'rea' } }),
    ]);
    expect(res).toEqual({ written: 0, skippedRoleless: 2 });
    expect(calls).toHaveLength(0);
  });
});
