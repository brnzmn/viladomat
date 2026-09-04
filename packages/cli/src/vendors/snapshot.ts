/**
 * Assemble the inputs the related-party scorer needs from the database.
 *
 * Everything here is a read. The office-holder side comes exclusively from
 * `public.reference_match_keys`; the vendor side from `parties`, `party_ibans`,
 * `entity_officers`, the latest `external_checks` row of each type, the invoices and the quotes.
 */
import { normaliseName, validateNif } from '@viladomat/core';
import { envOptional } from '../lib/env.ts';
import { hmacNif, loadReferenceKeys, type CensusState, type ChecksumState, type RegistryState, type ScoringContext, type VendorSnapshot } from './links.ts';
import { loadOfficers } from './officers.ts';
import { latestChecks, type Queryable } from './persist.ts';
import { fingerprintsByParty, findQuoteOverlaps, loadQuoteRows } from './quotes.ts';

/**
 * Activity codes (CNAE-2009 divisions) that cover each line category. Used only to say
 * "the declared activity does not cover the work invoiced" — a soft signal with a documented
 * innocent explanation (activity codes are rarely updated). **To verify** against the official
 * CNAE table; a category or code absent from this map yields `null` (not assessed), never
 * `false`, so an unmapped case never produces a signal.
 */
export const CNAE_DIVISIONS_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ELEV_INSTALL: ['28', '33', '43'],
  ELEV_CIVIL: ['41', '43'],
  ELEV_MAINT: ['33', '43'],
  ELEV_INSPECT: ['71', '74'],
  FACADE_REHAB: ['41', '43'],
  BALCONY: ['41', '43'],
  SCAFFOLD: ['43', '77'],
  ROOF: ['41', '43'],
  STAIR_REHAB: ['41', '43'],
  PAINT_INT: ['43'],
  ENTRANCE_DOOR: ['25', '43', '16'],
  INTERCOM: ['43', '61'],
  WINDOWS: ['25', '43', '16'],
  LOCKSMITH: ['25', '43', '80'],
  ELECTRICAL: ['43'],
  PLUMB_SEWER: ['43', '37'],
  WATER_SUPPLY: ['43', '36'],
  MASONRY: ['41', '43'],
  ARCH_PROJECT: ['71'],
  ARCH_DO: ['71'],
  HS_COORD: ['71', '74'],
  ITE: ['71'],
  ADMIN_FEE: ['68', '69'],
  ADMIN_EXTRA: ['68', '69'],
  INSURANCE: ['65', '66'],
  CLEANING: ['81'],
  ELECTRICITY: ['35'],
  WATER_UTIL: ['36'],
  CAE_PRL: ['71', '74', '86'],
  LEGAL: ['69'],
  BANK: ['64'],
  WASTE: ['38'],
  PEST: ['81'],
  FIRE: ['43', '80'],
  TELECOM: ['43', '61'],
  GAS: ['43', '35'],
  ASBESTOS: ['39', '43'],
});

/** Category codes whose vendors are expected in REA (construction) or RASIC (regulated trades). */
export const REA_CATEGORIES: ReadonlySet<string> = new Set([
  'ELEV_CIVIL', 'FACADE_REHAB', 'BALCONY', 'ROOF', 'STAIR_REHAB', 'MASONRY', 'PLUMB_SEWER',
  'WATER_SUPPLY', 'SCAFFOLD', 'PAINT_INT', 'ASBESTOS', 'WINDOWS', 'ENTRANCE_DOOR',
]);

export const RASIC_CATEGORIES: ReadonlySet<string> = new Set([
  'ELEV_INSTALL', 'ELEV_MAINT', 'ELECTRICAL', 'GAS', 'INTERCOM', 'FIRE',
]);

export interface PartyFacts {
  id: string;
  kind: string;
  displayName: string;
  nif: string | null;
  nifValid: boolean | null;
  addressNorm: string | null;
  postcode: string | null;
  phoneNorm: string | null;
  emailNorm: string | null;
  domain: string | null;
  ibanHmacs: string[];
  categories: string[];
  firstInvoiceDate: string | null;
  firstDocumentDate: string | null;
  invoiceCount: number;
  invoiceTotal: number;
  worksTotal: number;
  ordinaryTotal: number;
  numeroInts: number[];
}

function normAddress(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = normaliseName(s).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Parties with their accounts, the categories they invoiced and their first dates. */
export async function loadPartyFacts(client: Queryable, cid: string): Promise<PartyFacts[]> {
  const res = await client.query(
    `select p.id, p.kind::text as kind, p.display_name, p.nif, p.nif_valid, p.address_norm, p.postcode,
            p.phone_norm, p.email_norm::text as email_norm, p.domain,
            coalesce(ib.hmacs, '{}') as iban_hmacs,
            coalesce(inv.categories, '{}') as categories,
            inv.first_invoice::text as first_invoice,
            inv.invoice_count, inv.invoice_total, inv.works_total, inv.ordinary_total,
            coalesce(inv.numero_ints, '{}') as numero_ints,
            doc.first_document::text as first_document
       from public.parties p
       left join lateral (
         select array_agg(distinct i.iban_hmac) as hmacs
           from public.party_ibans i where i.party_id = p.id
       ) ib on true
       left join lateral (
         select min(v.fecha_expedicion) as first_invoice,
                count(*)::int as invoice_count,
                coalesce(sum(v.total), 0) as invoice_total,
                coalesce(sum(v.total) filter (where v.works_package_id is not null), 0) as works_total,
                coalesce(sum(v.total) filter (where v.works_package_id is null), 0) as ordinary_total,
                array_remove(array_agg(distinct v.category_code), null) as categories,
                array_remove(array_agg(distinct v.numero_int), null) as numero_ints
           from public.invoices v where v.vendor_party_id = p.id and v.community_id = $1
       ) inv on true
       left join lateral (
         select min(d.doc_date) as first_document
           from public.documents d where d.community_id = $1 and d.issuer_party_id = p.id
       ) doc on true
      where p.community_id = $1
      order by p.display_name`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    displayName: String(r.display_name),
    nif: (r.nif as string | null) ?? null,
    nifValid: (r.nif_valid as boolean | null) ?? null,
    addressNorm: normAddress((r.address_norm as string | null) ?? null),
    postcode: (r.postcode as string | null) ?? null,
    phoneNorm: (r.phone_norm as string | null) ?? null,
    emailNorm: (r.email_norm as string | null)?.toLowerCase() ?? null,
    domain: (r.domain as string | null)?.toLowerCase() ?? null,
    ibanHmacs: ((r.iban_hmacs as string[] | null) ?? []).filter(Boolean),
    categories: ((r.categories as string[] | null) ?? []).filter(Boolean),
    firstInvoiceDate: (r.first_invoice as string | null) ?? null,
    firstDocumentDate: (r.first_document as string | null) ?? null,
    invoiceCount: Number(r.invoice_count ?? 0),
    invoiceTotal: Number(r.invoice_total ?? 0),
    worksTotal: Number(r.works_total ?? 0),
    ordinaryTotal: Number(r.ordinary_total ?? 0),
    numeroInts: ((r.numero_ints as Array<string | number> | null) ?? []).map(Number).filter(Number.isFinite),
  }));
}

/** Latest check of each type, keyed by `<check_type>|<subject_key>`. */
export async function loadLatestCheckMap(client: Queryable, cid: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = await latestChecks(client, cid);
  const map = new Map<string, Record<string, unknown>>();
  for (const r of rows) map.set(`${String(r.check_type)}|${String(r.subject_key)}`, r);
  return map;
}

function registryState(row: Record<string, unknown> | undefined): RegistryState {
  if (!row) return 'unknown';
  const status = String(row.status ?? '');
  if (status === 'ok') {
    const n = (row.normalised as Record<string, unknown> | null) ?? {};
    if (n.registered === false) return 'absent';
    if (n.registered === true) return 'present';
    // A manual check completed with evidence: the reviewer records the outcome in the note.
    if (n.evidence_uploaded === true && n.registered === undefined) return 'unknown';
    return 'present';
  }
  if (status === 'not_found') return 'absent';
  return 'unknown';
}

function censusState(row: Record<string, unknown> | undefined): CensusState {
  if (!row) return 'unknown';
  const status = String(row.status ?? '');
  const n = (row.normalised as Record<string, unknown> | null) ?? {};
  if (status === 'ok' && n.census_match === false) return 'fail';
  if (status === 'ok' && n.census_match === true) return 'pass';
  if (status === 'not_found') return 'fail';
  return 'unknown';
}

function checksumState(nif: string | null, nifValid: boolean | null, row: Record<string, unknown> | undefined): ChecksumState {
  const n = (row?.normalised as Record<string, unknown> | null) ?? null;
  if (n && typeof n.valid === 'boolean') return n.valid ? 'valid' : 'invalid';
  if (typeof nifValid === 'boolean') return nifValid ? 'valid' : 'invalid';
  if (!nif) return 'unknown';
  return validateNif(nif).valid ? 'valid' : 'invalid';
}

/** Is the declared activity code compatible with any category the vendor invoiced? */
export function cnaeRelated(cnae: string | null, categories: readonly string[]): boolean | null {
  if (!cnae) return null;
  const division = /(\d{2})/.exec(cnae)?.[1];
  if (!division) return null;
  const known = categories.filter((c) => CNAE_DIVISIONS_BY_CATEGORY[c] !== undefined);
  if (known.length === 0) return null;
  return known.some((c) => (CNAE_DIVISIONS_BY_CATEGORY[c] ?? []).includes(division));
}

export interface LinkInputs {
  vendors: VendorSnapshot[];
  context: ScoringContext;
  /** Vendors keyed by id, for the callers that need the underlying facts. */
  facts: Map<string, PartyFacts>;
}

/** Build every input the scorer needs for one community. */
export async function loadLinkInputs(client: Queryable, cid: string, today: string): Promise<LinkInputs> {
  const [parties, officers, reference, checkMap, quoteRows] = await Promise.all([
    loadPartyFacts(client, cid),
    loadOfficers(client, cid),
    loadReferenceKeys(client, cid),
    loadLatestCheckMap(client, cid),
    loadQuoteRows(client, cid),
  ]);

  const communityRes = await client.query(`select address from public.communities where id = $1`, [cid]);
  const communityAddress = normAddress((communityRes.rows[0] as { address?: string | null } | undefined)?.address ?? null);

  const adminRes = await client.query(
    `select distinct party_id from public.office_terms
      where community_id = $1 and office = 'administrator' and party_id is not null`,
    [cid],
  );
  const administratorPartyIds = (adminRes.rows as Array<{ party_id: string }>).map((r) => String(r.party_id));

  const officersByParty = new Map<string, typeof officers>();
  for (const o of officers) {
    const list = officersByParty.get(o.partyId) ?? [];
    list.push(o);
    officersByParty.set(o.partyId, list);
  }

  const hmacKey = envOptional('IBAN_HMAC_KEY');
  const fingerprints = fingerprintsByParty(findQuoteOverlaps(quoteRows));

  // Cross-party indexes.
  const addressOwners: Record<string, string[]> = {};
  const addressCounts: Record<string, number> = {};
  const ibanOwners: Record<string, string[]> = {};
  const phoneOwners: Record<string, string[]> = {};
  const emailDomainOwners: Record<string, string[]> = {};
  const mailboxOwners: Record<string, string[]> = {};
  const pushTo = (index: Record<string, string[]>, key: string | null, id: string): void => {
    if (!key) return;
    const list = index[key] ?? [];
    if (!list.includes(id)) list.push(id);
    index[key] = list;
  };
  for (const p of parties) {
    pushTo(addressOwners, p.addressNorm, p.id);
    pushTo(phoneOwners, p.phoneNorm, p.id);
    pushTo(emailDomainOwners, p.domain, p.id);
    pushTo(mailboxOwners, p.emailNorm, p.id);
    for (const h of p.ibanHmacs) pushTo(ibanOwners, h, p.id);
  }
  for (const [addr, ids] of Object.entries(addressOwners)) addressCounts[addr] = ids.length;
  // A company_profile response may report how many entities the register shows at an address.
  for (const row of checkMap.values()) {
    if (String(row.check_type) !== 'company_profile') continue;
    const n = (row.normalised as Record<string, unknown> | null) ?? {};
    const addr = normAddress((n.address as string | null) ?? null);
    const atAddress = Number(n.companies_at_address ?? Number.NaN);
    if (addr && Number.isFinite(atAddress)) {
      addressCounts[addr] = Math.max(addressCounts[addr] ?? 0, atAddress);
    }
  }

  const surnamePerMille: Record<string, number | null> = {};
  for (const [key, row] of checkMap) {
    if (!key.startsWith('surname_frequency|')) continue;
    const n = (row.normalised as Record<string, unknown> | null) ?? {};
    const surname = normaliseName(String(n.surname ?? key.slice('surname_frequency|'.length)));
    const perMille = n.per_mille === null || n.per_mille === undefined ? null : Number(n.per_mille);
    surnamePerMille[surname] = Number.isFinite(perMille as number) ? (perMille as number) : null;
  }

  const presidencyQuotaIbans = reference
    .filter((r) => r.role === 'president')
    .flatMap((r) => r.ibanHmacs);

  const vendors: VendorSnapshot[] = [];
  const facts = new Map<string, PartyFacts>();
  for (const p of parties) {
    facts.set(p.id, p);
    if (p.kind !== 'vendor' && p.kind !== 'administrator' && p.kind !== 'architect') continue;
    const profileRow = checkMap.get(`company_profile|${p.id}`);
    const profile = (profileRow?.normalised as Record<string, unknown> | null) ?? null;
    const notaRow = checkMap.get(`registro_mercantil_nota|${p.id}`);
    const notaOn =
      notaRow && String(notaRow.status) === 'ok' ? String(notaRow.fetched_at ?? '').slice(0, 10) || null : null;

    const evidenceIds = [
      profileRow?.id, checkMap.get(`rea|${p.id}`)?.id, checkMap.get(`rasic|${p.id}`)?.id,
      checkMap.get(`aeat_census|${p.id}`)?.id, notaRow?.id,
    ]
      .filter((v): v is string => typeof v === 'string');

    const cnae = (profile?.cnae as string | null) ?? null;
    vendors.push({
      partyId: p.id,
      displayName: p.displayName,
      kind: p.kind,
      nifHmac: p.nif && hmacKey ? safeHmac(p.nif, hmacKey) : null,
      addressNorm: p.addressNorm ?? normAddress((profile?.address as string | null) ?? null),
      phoneNorm: p.phoneNorm,
      emailNorm: p.emailNorm,
      emailDomain: p.domain,
      ibanHmacs: p.ibanHmacs,
      officers: (officersByParty.get(p.id) ?? []).map((o) => ({
        personNameNorm: o.personNameNorm,
        surname1: o.surname1,
        surname2: o.surname2,
        given: o.given,
        cargo: o.cargo,
        nifHmac: null,
      })),
      incorporationDate: (profile?.incorporation_date as string | null) ?? null,
      capitalEur: profile?.capital_eur === null || profile?.capital_eur === undefined ? null : Number(profile.capital_eur),
      cnae,
      cnaeRelated: cnaeRelated(cnae, p.categories),
      firstInvoiceDate: p.firstInvoiceDate,
      registry: {
        rea: registryState(checkMap.get(`rea|${p.id}`)),
        rasic: registryState(checkMap.get(`rasic|${p.id}`)),
        census: censusState(checkMap.get(`aeat_census|${p.id}`)),
        nifChecksum: checksumState(p.nif, p.nifValid, checkMap.get(`nif_validate|${p.id}`)),
      },
      quoteFingerprints: fingerprints.get(p.id) ?? [],
      signerAlsoAdvises: null,
      profileSource: profileRow
        ? { checkType: 'company_profile', date: String(profileRow.fetched_at ?? '').slice(0, 10) || null, checkId: String(profileRow.id) }
        : null,
      evidenceIds,
      notaInformativaOn: notaOn,
    });
  }

  return {
    vendors,
    facts,
    context: {
      reference,
      buildingAddresses: communityAddress ? [communityAddress] : [],
      addressCounts,
      addressOwners,
      ibanOwners,
      phoneOwners,
      emailDomainOwners,
      mailboxOwners,
      administratorPartyIds,
      presidencyQuotaIbans,
      surnamePerMille,
      today,
    },
  };
}

function safeHmac(nif: string, key: string): string | null {
  try {
    return hmacNif(nif, key);
  } catch {
    return null;
  }
}
