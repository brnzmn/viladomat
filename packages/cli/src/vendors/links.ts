/**
 * Related-party signals S1–S11: **possible links to verify**, never statements about people.
 *
 * What this module does and does not claim
 * ----------------------------------------
 * It compares equality material — keyed digests of identifiers and account numbers, normalised
 * surnames, normalised addresses — and reports coincidences with the number of people who would
 * be expected to produce the same coincidence by chance. A coincidence of surnames in a city of
 * 1.6 million is a question for the Registro Mercantil, not an answer: every output says so, and
 * every row records whether the confirming nota informativa has been obtained.
 *
 * Reference material about office-holders is read **only** through `public.reference_match_keys`,
 * which returns digests and normalised surname tokens and nothing else. No given name, address or
 * identifier of an office-holder is ever loaded into this process in clear.
 *
 * Scoring (from the rule catalogue and the plan)
 * ---------------------------------------------
 * | Signal | Test | Points |
 * |---|---|---|
 * | S1  | identifier digest of the vendor or an officer equals an office-holder's | 100 |
 * | S2  | officer given name and both surnames equal an office-holder's | 90 |
 * | S3  | both surnames equal, same order | 45 × w |
 * | S3  | both surnames equal, reversed | 30 × w |
 * | S4  | one surname equal (skipped when the surname is carried by more than 5 ‰) | 8 × w |
 * | S5  | vendor's registered address equals the building's or an office-holder's | 80 |
 * | S6  | address shared with another vendor or the administrator | 40, or 15 at a domiciliation address |
 * | S7  | account digest shared with another vendor | 90 |
 * | S7  | account digest equals one that pays the presidency's quotas | 100 |
 * | S7  | telephone shared | 60 |
 * | S7  | e-mail mailbox or domain shared | 50 |
 * | S8  | incorporated less than 12 months before the first invoice | 25 (45 if under 3 months) |
 * | S8  | share capital at or below €3,000 | +10 |
 * | S8  | activity code unrelated to what was invoiced | +25 |
 * | S9  | comparison quotes sharing a producer, author, telephone, account or number series | 50 |
 * | S10 | REA absent 30 · RASIC absent 50 · census check fails 60 · check digit invalid 20 | max |
 * | S11 | the person signing for the vendor also appears advising in the minutes | 40 |
 *
 * Rarity weight w from the Idescat frequency f (‰): 1.3 below 0.1, 1.0 from 0.1 to 1, 0.6 above 1
 * to 10, 0.3 above 10; for a pair of surnames w = √(w₁·w₂). Expected homonyms ≈ 1.6 M × f₁ × f₂.
 *
 * Tiers: 80 and above `priority`, 40–79 `review`, below 40 `note`.
 */
import { createHmac } from 'node:crypto';
import { canonicalGivenName, normaliseName, normaliseNif } from '@viladomat/core';
import {
  COMMON_SURNAME_PER_MILLE,
  DOMICILIATION_MIN_COMPANIES,
  HOMONYM_POPULATION,
} from './config.ts';
import type { Queryable } from './persist.ts';

export const LINKS_ENGINE_VERSION = 'm5.links.1';

export type LinkSignalCode =
  'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11';
export type LinkRole = 'president' | 'president_family' | 'administrator';
export type LinkTier = 'priority' | 'review' | 'note';

/**
 * Keyed digest of an identifier, the convention M5 introduces for `reference_persons.nif_hmac`
 * and for vendor identifiers: HMAC-SHA256 over the canonical 9-character form, hex encoded, with
 * the same server secret as the IBAN digests (`IBAN_HMAC_KEY`). The clear identifier of an
 * office-holder is never stored.
 */
export function hmacNif(nif: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length === 0) throw new RangeError('hmacNif: empty key');
  return createHmac('sha256', key).update(normaliseNif(nif)).digest('hex');
}

// ---------------------------------------------------------------------------
// Rarity and expected homonyms
// ---------------------------------------------------------------------------

/**
 * Normalise an address for equality tests: accents stripped, upper case, everything that is not
 * a letter or a digit becomes a space, spaces collapsed. Deliberately **not** the person-name
 * normaliser, which drops particles and digits and would turn "Carrer de Prova 7" into
 * "CARRER PROVA". Both sides of every address comparison go through this one function.
 */
export function normaliseAddress(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Weight used when the frequency could not be obtained: the "fairly common" band. */
export const UNKNOWN_FREQUENCY_WEIGHT = 0.6;

/** Rarity weight of a surname from its frequency in ‰. */
export function rarityWeight(perMille: number | null | undefined): number {
  if (perMille === null || perMille === undefined || !Number.isFinite(perMille))
    return UNKNOWN_FREQUENCY_WEIGHT;
  if (perMille < 0.1) return 1.3;
  if (perMille <= 1) return 1.0;
  if (perMille <= 10) return 0.6;
  return 0.3;
}

/** Weight of a pair of surnames: the geometric mean of the two weights. */
export function pairWeight(a: number, b: number): number {
  return Math.sqrt(a * b);
}

/**
 * Number of people in the reference population expected to carry the same surname (or the same
 * pair), printed next to every surname coincidence. `null` when a frequency is unknown.
 */
export function expectedCollisions(
  perMille: readonly (number | null | undefined)[],
): number | null {
  let acc = HOMONYM_POPULATION;
  for (const f of perMille) {
    if (f === null || f === undefined || !Number.isFinite(f)) return null;
    acc *= f / 1000;
  }
  return Math.round(acc * 100) / 100;
}

export function tierForPoints(points: number): LinkTier {
  if (points >= 80) return 'priority';
  if (points >= 40) return 'review';
  return 'note';
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Office-holder equality material, exactly as `public.reference_match_keys` returns it. */
export interface ReferenceKey {
  role: LinkRole;
  surname1: string;
  surname2: string;
  given: string;
  addresses: string[];
  ibanHmacs: string[];
  nifHmac: string | null;
}

/** An officer of a vendor entity, reduced to what the equality tests need. */
export interface OfficerKey {
  personNameNorm: string;
  surname1: string;
  surname2: string;
  given: string;
  nifHmac?: string | null;
  cargo?: string | null;
}

export type RegistryState = 'present' | 'absent' | 'unknown';
export type CensusState = 'pass' | 'fail' | 'unknown';
export type ChecksumState = 'valid' | 'invalid' | 'unknown';

/** A fingerprint two quotes for the same package share. */
export interface QuoteFingerprint {
  kind: 'pdf_producer' | 'pdf_author' | 'phone' | 'iban' | 'sequential_numbers' | 'typo';
  value: string;
  otherPartyIds: string[];
  quoteIds: string[];
}

export interface VendorSnapshot {
  partyId: string;
  displayName: string;
  kind: string;
  nifHmac: string | null;
  addressNorm: string | null;
  phoneNorm: string | null;
  emailNorm: string | null;
  emailDomain: string | null;
  ibanHmacs: string[];
  officers: OfficerKey[];
  incorporationDate: string | null;
  capitalEur: number | null;
  cnae: string | null;
  /** null when the activity code was never compared with what the vendor invoiced. */
  cnaeRelated: boolean | null;
  firstInvoiceDate: string | null;
  registry: {
    rea: RegistryState;
    rasic: RegistryState;
    census: CensusState;
    nifChecksum: ChecksumState;
  };
  quoteFingerprints: QuoteFingerprint[];
  /** Set when the same person signs for the vendor and appears advising in the minutes. */
  signerAlsoAdvises: { role: LinkRole; note: string } | null;
  /** Where the registry facts came from, for the "source:" clause of the explanation. */
  profileSource: { checkType: string; date: string | null; checkId: string | null } | null;
  /** Ids of the `external_checks` rows this snapshot rests on. */
  evidenceIds: string[];
  /** Set when a Registro Mercantil nota informativa has been obtained for this vendor. */
  notaInformativaOn: string | null;
}

export interface ScoringContext {
  reference: ReferenceKey[];
  /** Normalised addresses of the building itself. */
  buildingAddresses: string[];
  /** How many distinct entities share each normalised address. */
  addressCounts: Record<string, number>;
  /** Party ids at each normalised address. */
  addressOwners: Record<string, string[]>;
  ibanOwners: Record<string, string[]>;
  phoneOwners: Record<string, string[]>;
  emailDomainOwners: Record<string, string[]>;
  mailboxOwners: Record<string, string[]>;
  /** Party ids that are the administrator of the community. */
  administratorPartyIds: string[];
  /** Account digests that pay the presidency's quotas (from the reference keys). */
  presidencyQuotaIbans: string[];
  /** Surname (normalised) → frequency in ‰, from `surname_frequency` checks. */
  surnamePerMille: Record<string, number | null>;
  today: string;
}

/** One scored coincidence. `role` is null when the coincidence is not with an office-holder. */
export interface LinkSignal {
  partyId: string;
  signal: LinkSignalCode;
  role: LinkRole | null;
  points: number;
  rarityWeight: number | null;
  expectedCollisions: number | null;
  /** Neutral descriptions of what coincided, joined into the explanation. */
  facts: string[];
  detail: Record<string, unknown>;
  source: { checkType: string; date: string | null };
  evidenceIds: string[];
  notaInformativaOn: string | null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return (to - from) / (1000 * 60 * 60 * 24 * 30.4375);
}

function sameGiven(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ca = a.split(' ').map(canonicalGivenName).join(' ');
  const cb = b.split(' ').map(canonicalGivenName).join(' ');
  return ca === cb;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function others(list: readonly string[] | undefined, self: string): string[] {
  return (list ?? []).filter((id) => id !== self);
}

/**
 * Score one vendor against the office-holder reference material and the rest of the corpus.
 * Pure: every input is passed in, so the whole table of the module header is unit-testable.
 */
export function scoreVendorLinks(vendor: VendorSnapshot, ctx: ScoringContext): LinkSignal[] {
  const out: LinkSignal[] = [];
  const source = vendor.profileSource ?? {
    checkType: 'company_profile',
    date: null,
    checkId: null,
  };
  const base = {
    partyId: vendor.partyId,
    source: { checkType: source.checkType, date: source.date },
    evidenceIds: vendor.evidenceIds,
    notaInformativaOn: vendor.notaInformativaOn,
  };
  const push = (s: Omit<LinkSignal, keyof typeof base> & Partial<LinkSignal>): void => {
    out.push({ ...base, ...s } as LinkSignal);
  };
  const freq = (surname: string): number | null => ctx.surnamePerMille[surname] ?? null;

  // ---- S1: identifier digests -------------------------------------------------
  for (const ref of ctx.reference) {
    if (!ref.nifHmac) continue;
    if (vendor.nifHmac && vendor.nifHmac === ref.nifHmac) {
      push({
        signal: 'S1',
        role: ref.role,
        points: 100,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ["the vendor's identifier digest equals the one recorded for this role"],
        detail: { basis: 'party_nif_hmac' },
      });
    }
    const officer = vendor.officers.find((o) => o.nifHmac && o.nifHmac === ref.nifHmac);
    if (officer) {
      push({
        signal: 'S1',
        role: ref.role,
        points: 100,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ["an officer's identifier digest equals the one recorded for this role"],
        detail: { basis: 'officer_nif_hmac', cargo: officer.cargo ?? null },
      });
    }
  }

  // ---- S2 / S3 / S4: names ----------------------------------------------------
  for (const ref of ctx.reference) {
    for (const o of vendor.officers) {
      const bothSameOrder = Boolean(
        o.surname1 && o.surname2 && o.surname1 === ref.surname1 && o.surname2 === ref.surname2,
      );
      const bothReversed = Boolean(
        o.surname1 && o.surname2 && o.surname1 === ref.surname2 && o.surname2 === ref.surname1,
      );

      if (bothSameOrder && ref.given && sameGiven(o.given, ref.given)) {
        push({
          signal: 'S2',
          role: ref.role,
          points: 90,
          rarityWeight: null,
          expectedCollisions: expectedCollisions([freq(ref.surname1), freq(ref.surname2)]),
          facts: [
            "an officer's given name and both surnames coincide with those recorded for this role",
          ],
          detail: { cargo: o.cargo ?? null, order: 'same' },
        });
        continue;
      }
      if (bothSameOrder || bothReversed) {
        const w1 = rarityWeight(freq(ref.surname1));
        const w2 = rarityWeight(freq(ref.surname2));
        const w = pairWeight(w1, w2);
        const points = round((bothSameOrder ? 45 : 30) * w);
        push({
          signal: 'S3',
          role: ref.role,
          points,
          rarityWeight: round(w),
          expectedCollisions: expectedCollisions([freq(ref.surname1), freq(ref.surname2)]),
          facts: [
            bothSameOrder
              ? 'both surnames of an officer coincide, in the same order, with those recorded for this role'
              : 'both surnames of an officer coincide, in the reverse order, with those recorded for this role',
          ],
          detail: {
            cargo: o.cargo ?? null,
            order: bothSameOrder ? 'same' : 'reversed',
            surname_frequencies_per_mille: {
              first: freq(ref.surname1),
              second: freq(ref.surname2),
            },
            weights: { first: w1, second: w2 },
          },
        });
        continue;
      }

      // one surname only
      const matches = [ref.surname1, ref.surname2].filter(
        (s) => s !== '' && (s === o.surname1 || s === o.surname2),
      );
      if (matches.length !== 1) continue;
      const surname = matches[0] as string;
      const f = freq(surname);
      if (f !== null && f > COMMON_SURNAME_PER_MILLE) continue; // too common to carry weight
      const w = rarityWeight(f);
      push({
        signal: 'S4',
        role: ref.role,
        points: round(8 * w),
        rarityWeight: round(w),
        expectedCollisions: expectedCollisions([f]),
        facts: ['one surname of an officer coincides with one recorded for this role'],
        detail: {
          cargo: o.cargo ?? null,
          surname_frequency_per_mille: f,
          frequency_known: f !== null,
        },
      });
    }
  }

  // ---- S5: registered address equals the building's or an office-holder's -----
  if (vendor.addressNorm) {
    const addr = vendor.addressNorm;
    if (ctx.buildingAddresses.includes(addr)) {
      push({
        signal: 'S5',
        role: null,
        points: 80,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ["the vendor's registered address is the building itself"],
        detail: { address_norm: addr, basis: 'building' },
      });
    }
    for (const ref of ctx.reference) {
      if (!ref.addresses.includes(addr)) continue;
      push({
        signal: 'S5',
        role: ref.role,
        points: 80,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ["the vendor's registered address coincides with an address recorded for this role"],
        detail: { address_norm: addr, basis: 'reference_address' },
      });
    }

    // ---- S6: address shared with another vendor or with the administrator ----
    const sharing = others(ctx.addressOwners[addr], vendor.partyId);
    if (sharing.length > 0) {
      const count = ctx.addressCounts[addr] ?? sharing.length + 1;
      const domiciliation = count >= DOMICILIATION_MIN_COMPANIES;
      const withAdministrator = sharing.some((id) => ctx.administratorPartyIds.includes(id));
      push({
        signal: 'S6',
        role: withAdministrator ? 'administrator' : null,
        points: domiciliation ? 15 : 40,
        rarityWeight: null,
        expectedCollisions: null,
        facts: [
          withAdministrator
            ? "the vendor's address coincides with the administrator's office address"
            : "the vendor's address coincides with another vendor's address",
          ...(domiciliation
            ? [
                `the address hosts ${count} entities on the record, which is consistent with a domiciliation or accountancy address`,
              ]
            : []),
        ],
        detail: {
          address_norm: addr,
          entities_at_address: count,
          domiciliation,
          shared_with_party_ids: sharing,
          shared_with_administrator: withAdministrator,
        },
      });
    }
  }

  // ---- S7: account, telephone and e-mail ------------------------------------
  for (const iban of vendor.ibanHmacs) {
    if (ctx.presidencyQuotaIbans.includes(iban)) {
      push({
        signal: 'S7',
        role: 'president',
        points: 100,
        rarityWeight: null,
        expectedCollisions: null,
        facts: [
          "an account digest of the vendor equals one that the presidency's quotas are paid from",
        ],
        detail: { basis: 'presidency_quota_iban' },
      });
    }
    const sharing = others(ctx.ibanOwners[iban], vendor.partyId);
    if (sharing.length > 0) {
      const withAdministrator = sharing.some((id) => ctx.administratorPartyIds.includes(id));
      push({
        signal: 'S7',
        role: withAdministrator ? 'administrator' : null,
        points: 90,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ['an account digest of the vendor is also recorded for another party'],
        detail: { basis: 'iban_reuse', shared_with_party_ids: sharing },
      });
    }
  }
  if (vendor.phoneNorm) {
    const sharing = others(ctx.phoneOwners[vendor.phoneNorm], vendor.partyId);
    if (sharing.length > 0) {
      const withAdministrator = sharing.some((id) => ctx.administratorPartyIds.includes(id));
      push({
        signal: 'S7',
        role: withAdministrator ? 'administrator' : null,
        points: 60,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ['the telephone number printed by the vendor is also printed by another party'],
        detail: { basis: 'phone', shared_with_party_ids: sharing },
      });
    }
  }
  if (vendor.emailNorm) {
    const sharing = others(ctx.mailboxOwners[vendor.emailNorm], vendor.partyId);
    if (sharing.length > 0) {
      push({
        signal: 'S7',
        role: null,
        points: 50,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ['the e-mail mailbox printed by the vendor is also printed by another party'],
        detail: { basis: 'email_mailbox', shared_with_party_ids: sharing },
      });
    }
  }
  if (vendor.emailDomain) {
    const sharing = others(ctx.emailDomainOwners[vendor.emailDomain], vendor.partyId);
    if (sharing.length > 0) {
      push({
        signal: 'S7',
        role: null,
        points: 50,
        rarityWeight: null,
        expectedCollisions: null,
        facts: ['the e-mail domain printed by the vendor is also printed by another party'],
        detail: {
          basis: 'email_domain',
          domain: vendor.emailDomain,
          shared_with_party_ids: sharing,
        },
      });
    }
  }

  // ---- S8: age, capital and declared activity --------------------------------
  {
    const facts: string[] = [];
    const detail: Record<string, unknown> = {};
    let points = 0;
    if (vendor.incorporationDate && vendor.firstInvoiceDate) {
      const months = monthsBetween(vendor.incorporationDate, vendor.firstInvoiceDate);
      detail.months_between_incorporation_and_first_invoice = Number.isFinite(months)
        ? round(months)
        : null;
      if (Number.isFinite(months) && months >= 0 && months < 3) {
        points += 45;
        facts.push(
          'the first invoice is dated less than three months after the company was incorporated',
        );
      } else if (Number.isFinite(months) && months >= 0 && months < 12) {
        points += 25;
        facts.push(
          'the first invoice is dated less than twelve months after the company was incorporated',
        );
      }
    }
    if (points > 0 || vendor.capitalEur !== null || vendor.cnaeRelated === false) {
      if (vendor.capitalEur !== null && vendor.capitalEur <= 3000 && points > 0) {
        points += 10;
        facts.push('the share capital on the record is €3,000 or less');
        detail.capital_eur = vendor.capitalEur;
      }
      if (vendor.cnaeRelated === false && points > 0) {
        points += 25;
        facts.push('the declared activity code does not cover the work invoiced');
        detail.cnae = vendor.cnae;
      }
    }
    if (points > 0) {
      push({
        signal: 'S8',
        role: null,
        points,
        rarityWeight: null,
        expectedCollisions: null,
        facts,
        detail: {
          ...detail,
          incorporation_date: vendor.incorporationDate,
          first_invoice_date: vendor.firstInvoiceDate,
        },
      });
    }
  }

  // ---- S9: look-alike comparison quotes --------------------------------------
  if (vendor.quoteFingerprints.length > 0) {
    const kinds = [...new Set(vendor.quoteFingerprints.map((f) => f.kind))];
    const withOthers = vendor.quoteFingerprints.filter((f) => f.otherPartyIds.length > 0);
    if (withOthers.length > 0) {
      push({
        signal: 'S9',
        role: null,
        points: 50,
        rarityWeight: null,
        expectedCollisions: null,
        facts: [`quotes presented as coming from different vendors share ${kinds.join(', ')}`],
        detail: {
          fingerprints: withOthers.map((f) => ({
            kind: f.kind,
            value: f.value,
            other_party_ids: f.otherPartyIds,
            quote_ids: f.quoteIds,
          })),
        },
      });
    }
  }

  // ---- S10: registry and identifier state ------------------------------------
  {
    const candidates: Array<{ points: number; fact: string; key: string }> = [];
    if (vendor.registry.census === 'fail')
      candidates.push({
        points: 60,
        fact: 'the census check of the identifier did not confirm the entity',
        key: 'census',
      });
    if (vendor.registry.rasic === 'absent')
      candidates.push({
        points: 50,
        fact: 'no entry located in the industrial-safety agents register',
        key: 'rasic',
      });
    if (vendor.registry.rea === 'absent')
      candidates.push({
        points: 30,
        fact: 'no entry located in the register of accredited construction companies',
        key: 'rea',
      });
    if (vendor.registry.nifChecksum === 'invalid')
      candidates.push({
        points: 20,
        fact: 'the identifier as transcribed does not pass its check digit',
        key: 'checksum',
      });
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.points - a.points);
      const top = candidates[0] as { points: number; fact: string; key: string };
      push({
        signal: 'S10',
        role: null,
        points: top.points,
        rarityWeight: null,
        expectedCollisions: null,
        facts: candidates.map((c) => c.fact),
        detail: { states: vendor.registry, leading: top.key },
      });
    }
  }

  // ---- S11: the signer also advises ------------------------------------------
  if (vendor.signerAlsoAdvises) {
    push({
      signal: 'S11',
      role: vendor.signerAlsoAdvises.role,
      points: 40,
      rarityWeight: null,
      expectedCollisions: null,
      facts: ['the person who signs for the vendor also appears advising in the minutes'],
      detail: { note: vendor.signerAlsoAdvises.note },
    });
  }

  return out;
}

/** One `party_links` row: the aggregate of every signal of one code for one vendor and role. */
export interface AggregatedLink {
  partyId: string;
  role: LinkRole | null;
  signal: LinkSignalCode;
  points: number;
  rarityWeight: number | null;
  expectedCollisions: number | null;
  tier: LinkTier;
  facts: string[];
  detail: Record<string, unknown>;
  source: { checkType: string; date: string | null };
  evidenceIds: string[];
  explanation: string;
}

/**
 * Collapse the raw signals into one entry per vendor, role and signal code.
 *
 * S8 is additive by construction (age, capital and activity are separate modifiers of one
 * observation); every other signal takes the strongest coincidence and lists the rest, so a
 * vendor sharing both an account and a telephone with another party is not counted twice.
 */
export function aggregateLinks(signals: readonly LinkSignal[]): AggregatedLink[] {
  const groups = new Map<string, LinkSignal[]>();
  for (const s of signals) {
    const key = `${s.partyId}|${s.role ?? '-'}|${s.signal}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out: AggregatedLink[] = [];
  for (const list of groups.values()) {
    const first = list[0] as LinkSignal;
    const additive = first.signal === 'S8';
    const points = additive
      ? round(list.reduce((acc, s) => acc + s.points, 0))
      : round(Math.max(...list.map((s) => s.points)));
    const leading = [...list].sort((a, b) => b.points - a.points)[0] as LinkSignal;
    const facts = [...new Set(list.flatMap((s) => s.facts))];
    const collisions = list.map((s) => s.expectedCollisions).filter((n): n is number => n !== null);
    const link: AggregatedLink = {
      partyId: first.partyId,
      role: first.role,
      signal: first.signal,
      points,
      rarityWeight: leading.rarityWeight,
      expectedCollisions: collisions.length > 0 ? Math.min(...collisions) : null,
      tier: tierForPoints(points),
      facts,
      detail: Object.assign({}, ...list.map((s) => s.detail)) as Record<string, unknown>,
      source: leading.source,
      evidenceIds: [...new Set(list.flatMap((s) => s.evidenceIds))],
      explanation: '',
    };
    link.explanation = explanationFor(link, leading.notaInformativaOn);
    out.push(link);
  }
  out.sort(
    (a, b) =>
      b.points - a.points || a.partyId.localeCompare(b.partyId) || a.signal.localeCompare(b.signal),
  );
  return out;
}

/**
 * The sentence printed for a link, in the template the neutrality policy fixes. It states what
 * coincided, how many people would be expected to produce the same coincidence, where the fact
 * came from, and whether the registry document that would confirm identity has been obtained.
 */
export function explanationFor(
  link: Pick<AggregatedLink, 'facts' | 'expectedCollisions' | 'source'>,
  notaOn: string | null,
): string {
  const signals =
    link.facts.length > 0 ? link.facts.join('; ') : 'coincidence recorded without detail';
  const homonyms =
    link.expectedCollisions === null ? 'not applicable' : String(link.expectedCollisions);
  const date = link.source.date ?? 'date not recorded';
  const nota = notaOn
    ? `nota informativa obtained on ${notaOn}.`
    : 'nota informativa not yet obtained.';
  return `Possible link to verify: ${signals}; expected homonyms: ${homonyms}; source: ${link.source.checkType} ${date}; ${nota}`;
}

/** Total related-party points of a vendor, used only to order the reviewer's queue. */
export function vendorLinkScore(links: readonly AggregatedLink[]): number {
  return round(links.reduce((acc, l) => acc + l.points, 0));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface WriteLinksResult {
  written: number;
  /**
   * Links with neither an office-holder role nor another party to point at (a company's age, a
   * registry state): they have no target row and are reported by the fact sheet instead.
   */
  skippedRoleless: number;
}

/** Party ids a link points at, read from the detail of the signals that recorded a coincidence. */
export function linkTargets(link: Pick<AggregatedLink, 'partyId' | 'detail'>): string[] {
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v && v !== link.partyId) ids.add(v);
  };
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const d = link.detail ?? {};
  for (const key of ['shared_with_party_ids', 'other_party_ids', 'to_party_ids']) {
    for (const v of list(d[key])) add(v);
  }
  for (const key of ['other_party_id', 'to_party_id']) add(d[key]);
  for (const f of list(d.fingerprints)) {
    if (f && typeof f === 'object') {
      for (const v of list((f as Record<string, unknown>).other_party_ids)) add(v);
    }
  }
  return [...ids].sort();
}

/**
 * Write the links to `public.party_links`.
 *
 * A link with an office-holder role (`to_role` in president, president_family, administrator) is
 * upserted on the unique key (community, vendor, role, signal). A link without a role points at
 * the other party it coincides with (`to_party_id`, 0013), one row per target party; no unique
 * index covers a null role, so that upsert is done by hand (update, then insert). A role-less
 * link with no target party at all is skipped and counted. `detail` carries the structured facts
 * of the signal (digests are truncated by the data-room redaction, never printed in a pack).
 */
export async function writePartyLinks(
  client: Queryable,
  cid: string,
  links: readonly AggregatedLink[],
  engineVersion: string = LINKS_ENGINE_VERSION,
): Promise<WriteLinksResult> {
  let written = 0;
  let skippedRoleless = 0;
  for (const link of links) {
    const detail = JSON.stringify(link.detail ?? {});
    if (link.role !== null) {
      await client.query(
        `insert into public.party_links
           (community_id, from_party_id, to_role, to_party_id, signal, points, rarity_weight, expected_collisions,
            evidence_ids, tier, status, explanation, detail, engine_version)
         values ($1,$2,$3,null,$4,$5,$6,$7,$8::uuid[],$9,'open',$10,$11::jsonb,$12)
         on conflict (community_id, from_party_id, to_role, signal) do update set
           points = excluded.points, rarity_weight = excluded.rarity_weight,
           expected_collisions = excluded.expected_collisions, evidence_ids = excluded.evidence_ids,
           tier = excluded.tier, explanation = excluded.explanation, detail = excluded.detail,
           engine_version = excluded.engine_version`,
        [
          cid,
          link.partyId,
          link.role,
          link.signal,
          link.points,
          link.rarityWeight,
          link.expectedCollisions,
          link.evidenceIds,
          link.tier,
          link.explanation,
          detail,
          engineVersion,
        ],
      );
      written++;
      continue;
    }
    const targets = linkTargets(link);
    if (targets.length === 0) {
      skippedRoleless++;
      continue;
    }
    for (const target of targets) {
      const updated = await client.query(
        `update public.party_links set
           points = $5, rarity_weight = $6, expected_collisions = $7, evidence_ids = $8::uuid[],
           tier = $9, explanation = $10, detail = $11::jsonb, engine_version = $12
         where community_id = $1 and from_party_id = $2 and to_role is null and to_party_id = $3 and signal = $4`,
        [
          cid,
          link.partyId,
          target,
          link.signal,
          link.points,
          link.rarityWeight,
          link.expectedCollisions,
          link.evidenceIds,
          link.tier,
          link.explanation,
          detail,
          engineVersion,
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query(
          `insert into public.party_links
             (community_id, from_party_id, to_role, to_party_id, signal, points, rarity_weight, expected_collisions,
              evidence_ids, tier, status, explanation, detail, engine_version)
           values ($1,$2,null,$3,$4,$5,$6,$7,$8::uuid[],$9,'open',$10,$11::jsonb,$12)`,
          [
            cid,
            link.partyId,
            target,
            link.signal,
            link.points,
            link.rarityWeight,
            link.expectedCollisions,
            link.evidenceIds,
            link.tier,
            link.explanation,
            detail,
            engineVersion,
          ],
        );
      }
      written++;
    }
  }
  return { written, skippedRoleless };
}

/** Reference equality material. The only route to `restricted.reference_persons`. */
export async function loadReferenceKeys(client: Queryable, cid: string): Promise<ReferenceKey[]> {
  const res = await client.query(`select * from public.reference_match_keys($1)`, [cid]);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    role: String(r.role) as LinkRole,
    surname1: normaliseName((r.surname1_norm as string | null) ?? ''),
    surname2: normaliseName((r.surname2_norm as string | null) ?? ''),
    given: normaliseName((r.given_norm as string | null) ?? ''),
    addresses: ((r.addresses_norm as string[] | null) ?? [])
      .map((a) => normaliseAddress(a))
      .filter(Boolean),
    ibanHmacs: (r.iban_hmacs as string[] | null) ?? [],
    nifHmac: (r.nif_hmac as string | null) ?? null,
  }));
}

/** Links already stored, for the CLI listing and for rule B3. */
export async function loadPartyLinks(
  client: Queryable,
  cid: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await client.query(
    `select l.id, l.from_party_id, p.display_name, l.to_role, l.signal, l.points, l.rarity_weight,
            l.expected_collisions, l.tier, l.status, l.explanation, l.engine_version, l.evidence_ids
       from public.party_links l
       join public.parties p on p.id = l.from_party_id
      where l.community_id = $1
      order by l.points desc, p.display_name, l.signal`,
    [cid],
  );
  return res.rows as Array<Record<string, unknown>>;
}
