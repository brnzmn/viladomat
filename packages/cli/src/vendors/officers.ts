/**
 * Officers of vendor entities, as published in the official gazette.
 *
 * `company_profile` returns names; this module normalises them (accents, `l·l`, particles), splits
 * them into given name and the two surnames with the core splitter, and upserts
 * `public.entity_officers` with the gazette reference and the id of the check the name came from.
 *
 * These are natural persons who are not parties to this review. Their names stay in
 * `entity_officers` and in the reviewer screen; every other output — pack, data room, letter —
 * renders them as a role and initials (`vendorInitials`). The only reason the full name is stored
 * at all is that a surname equality test cannot be run on an initial.
 */
import { normaliseName, splitSpanishName } from '@viladomat/core';
import type { CompanyProfile, ProfileOfficer } from './checks/company-profile.ts';
import type { Queryable } from './persist.ts';

export interface OfficerDraft {
  personNameNorm: string;
  surname1: string;
  surname2: string;
  given: string;
  cargo: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  bormeRef: Record<string, unknown> | null;
}

export interface OfficerRow extends OfficerDraft {
  id: string;
  partyId: string;
}

/**
 * Split one gazette officer into the stored shape.
 *
 * Gazette entries print `APELLIDO1 APELLIDO2 NOMBRE` more often than not, so the splitter runs in
 * `auto` mode: a known given name at the end and not at the start reads as surnames-first. When
 * the given name is unknown to the dictionary the split is recorded as-is and the surname tests
 * simply do not fire — a missed match, never a wrong one.
 */
export function officerFromProfile(o: ProfileOfficer): OfficerDraft | null {
  const norm = normaliseName(o.name);
  if (!norm) return null;
  const split = splitSpanishName(o.name);
  return {
    personNameNorm: norm,
    surname1: split.surname1,
    surname2: split.surname2,
    given: split.given,
    cargo: o.cargo,
    dateFrom: o.date_from,
    dateTo: o.date_to,
    bormeRef: o.borme_ref,
  };
}

/** Every officer of a parsed profile, de-duplicated on name + role. */
export function officersFromProfile(profile: Pick<CompanyProfile, 'officers'>): OfficerDraft[] {
  const seen = new Set<string>();
  const out: OfficerDraft[] = [];
  for (const o of profile.officers) {
    const draft = officerFromProfile(o);
    if (!draft) continue;
    const key = `${draft.personNameNorm}|${(draft.cargo ?? '').toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(draft);
  }
  return out;
}

/**
 * Initials for output outside the reviewer screen: `Josep Maria Garcia Roca` → `J.M. G. R.`
 * Enough to tell two officers of the same company apart, not enough to name anyone.
 */
export function officerInitials(o: Pick<OfficerDraft, 'given' | 'surname1' | 'surname2'>): string {
  const given = o.given
    .split(' ')
    .filter(Boolean)
    .map((t) => `${t.charAt(0)}.`)
    .join('');
  const surnames = [o.surname1, o.surname2]
    .filter(Boolean)
    .map((s) => `${s.charAt(0)}.`)
    .join(' ');
  return [given, surnames].filter(Boolean).join(' ');
}

export interface UpsertOfficersResult {
  inserted: number;
  updated: number;
}

/**
 * Upsert the officers of one party.
 *
 * `entity_officers` has no natural unique key (the same person can hold two offices), so the
 * match is on party + normalised name + role: a re-run of the same check updates the dates, the
 * gazette reference and the source check id instead of piling up duplicates.
 */
export async function upsertOfficers(
  client: Queryable,
  cid: string,
  partyId: string,
  officers: readonly OfficerDraft[],
  sourceCheckId: string | null,
): Promise<UpsertOfficersResult> {
  let inserted = 0;
  let updated = 0;
  for (const o of officers) {
    const existing = await client.query(
      `select id from public.entity_officers
        where community_id = $1 and party_id = $2 and person_name_norm = $3
          and coalesce(cargo, '') = coalesce($4, '')
        limit 1`,
      [cid, partyId, o.personNameNorm, o.cargo],
    );
    const row = existing.rows[0] as { id?: string } | undefined;
    if (row?.id) {
      await client.query(
        `update public.entity_officers
            set surname1_norm = $2, surname2_norm = $3, given_norm = $4,
                date_from = coalesce($5, date_from), date_to = coalesce($6, date_to),
                borme_ref = coalesce($7::jsonb, borme_ref), source_check_id = coalesce($8, source_check_id)
          where id = $1`,
        [
          row.id,
          o.surname1 || null,
          o.surname2 || null,
          o.given || null,
          o.dateFrom,
          o.dateTo,
          o.bormeRef ? JSON.stringify(o.bormeRef) : null,
          sourceCheckId,
        ],
      );
      updated++;
    } else {
      await client.query(
        `insert into public.entity_officers
           (community_id, party_id, person_name_norm, surname1_norm, surname2_norm, given_norm, cargo,
            date_from, date_to, source_check_id, borme_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [
          cid,
          partyId,
          o.personNameNorm,
          o.surname1 || null,
          o.surname2 || null,
          o.given || null,
          o.cargo,
          o.dateFrom,
          o.dateTo,
          sourceCheckId,
          o.bormeRef ? JSON.stringify(o.bormeRef) : null,
        ],
      );
      inserted++;
    }
  }
  return { inserted, updated };
}

/** Officers of a community's vendors, for the scorer and the fact sheet. */
export async function loadOfficers(client: Queryable, cid: string): Promise<OfficerRow[]> {
  const res = await client.query(
    `select id, party_id, person_name_norm, surname1_norm, surname2_norm, given_norm, cargo,
            date_from::text as date_from, date_to::text as date_to, borme_ref
       from public.entity_officers
      where community_id = $1
      order by party_id, surname1_norm, given_norm`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    partyId: String(r.party_id),
    personNameNorm: String(r.person_name_norm ?? ''),
    surname1: String(r.surname1_norm ?? ''),
    surname2: String(r.surname2_norm ?? ''),
    given: String(r.given_norm ?? ''),
    cargo: (r.cargo as string | null) ?? null,
    dateFrom: (r.date_from as string | null) ?? null,
    dateTo: (r.date_to as string | null) ?? null,
    bormeRef: (r.borme_ref as Record<string, unknown> | null) ?? null,
  }));
}
