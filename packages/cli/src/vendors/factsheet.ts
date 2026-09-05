/**
 * Vendor fact sheet: registry facts only.
 *
 * This is the one vendor output that may reach the assembly of owners. It answers "what do the
 * public registers say about the companies the Community contracted with", and nothing else:
 * no scores, no tiers, no links, no severities, and no names of natural persons — officers are
 * rendered as a role and initials. What the register does not say is printed as "not located",
 * with the note that absence is not exculpatory. The register columns (REA, RASIC, the AEAT
 * census, the Registro Público Concursal) share one closed vocabulary, {@link FactSheetStatus};
 * the result strings a register answered with stay on the check rows and are not printed here.
 *
 * The related-party material (`party_links`) belongs to the reviewer screen and to the lawyer or
 * auditor annex, and is deliberately absent from this structure.
 */
import { CIF_ENTITY_LABELS, validateNif } from '@viladomat/core';
import { officerInitials, loadOfficers } from './officers.ts';
import { latestChecks, type Queryable } from './persist.ts';

export interface FactSheetOfficer {
  initials: string;
  cargo: string | null;
  date_from: string | null;
  date_to: string | null;
}

export interface FactSheetGrant {
  register: string;
  programme: string | null;
  date: string | null;
  amount_granted: number | null;
  amount_paid: number | null;
}

/**
 * The closed vocabulary of every register column. `registered` and `not located` state what the
 * register answered on the date shown; `pending manual check` means a reviewer has been asked
 * to open the page; `not checked` means the structure holds no answer (no check run, a failed
 * call, nothing to look up, or a manual completion whose outcome is in the evidence file, not in
 * the row). Absence is non-exculpatory in every case; the notes say so.
 */
export type FactSheetStatus = 'registered' | 'not located' | 'not checked' | 'pending manual check';

export interface VendorFactSheetRow {
  party_id: string;
  display_name: string;
  kind: string;
  nif: string | null;
  nif_valid: boolean | null;
  nif_kind: string | null;
  /** Legal form implied by the entity letter of a CIF, e.g. "Sociedad de responsabilidad limitada". */
  entity_kind: string | null;
  incorporation_date: string | null;
  capital_eur: number | null;
  cnae: string | null;
  registered_address_known: boolean;
  officers: FactSheetOfficer[];
  rea_status: FactSheetStatus;
  rasic_status: FactSheetStatus;
  /**
   * AEAT census (`aeat_census`, VNifV2): `registered` when the identifier and the name printed on
   * the documents were identified as a pair; `not located` when the census answered anything else
   * (not identified, de-registered, revoked). The result string itself stays on the check row.
   */
  census_status: FactSheetStatus;
  /**
   * Registro Público Concursal (`insolvency`): `registered` when an insolvency publication was
   * located for the identifier, `not located` when the register answered none. The check is a
   * manual route today, so the usual value is `pending manual check` or `not checked`.
   */
  insolvency_status: FactSheetStatus;
  grants: FactSheetGrant[];
  first_document_date: string | null;
  first_invoice_date: string | null;
  invoice_count: number;
  checks: Array<{
    type: string;
    status: string;
    fetched_at: string | null;
    source_url: string | null;
  }>;
}

export interface VendorFactSheet {
  community_id: string;
  generated_at: string;
  /** Grants published for the Community itself (BDNS and RAISC), the D8 independent leg. */
  community_grants: FactSheetGrant[];
  /** Sources whose endpoint or dataset is still unverified, printed under the table. */
  unverified_sources: string[];
  vendors: VendorFactSheetRow[];
  note_es: string;
  note_en: string;
}

const NOTE_ES =
  'Datos registrales públicos consultados en las fechas indicadas. La ausencia de una inscripción ' +
  'no acredita incumplimiento alguno: existen exenciones (por ejemplo, el empresario individual sin ' +
  'trabajadores respecto del REA) y la inscripción puede constar en otra comunidad autónoma o haber ' +
  'caducado después de las obras. Los cargos se identifican por iniciales.';

const NOTE_EN =
  'Public registry data consulted on the dates shown. The absence of an entry does not establish any ' +
  'breach: exemptions exist (a sole trader without employees is outside REA, for instance) and a ' +
  'registration may sit in another autonomous community or have lapsed after the works. Officers are ' +
  'identified by initials.';

function normalisedOf(row: Record<string, unknown>): Record<string, unknown> {
  return (row.normalised as Record<string, unknown> | null) ?? {};
}

/** REA and RASIC: `normalised.registered`, or the row status when the check answered nothing. */
function statusFrom(row: Record<string, unknown> | undefined): FactSheetStatus {
  if (!row) return 'not checked';
  const status = String(row.status ?? '');
  if (status === 'manual_pending') return 'pending manual check';
  if (status === 'not_found') return 'not located';
  if (status === 'ok') {
    const n = normalisedOf(row);
    if (n.registered === false) return 'not located';
    if (n.registered === true) return 'registered';
    // A manual completion: the reviewer's evidence is on file, the outcome is not in the row.
    if (n.evidence_uploaded === true) return 'not checked';
    return 'registered';
  }
  return 'not checked';
}

/**
 * AEAT census: only `normalised.census_match` of an `ok` row is an answer. `not_found` here means
 * no identifier was transcribed (nothing was looked up), and an `ok` row without the flag is a
 * manual completion, so both read `not checked`.
 */
export function censusStatusFrom(row: Record<string, unknown> | undefined): FactSheetStatus {
  if (!row) return 'not checked';
  const status = String(row.status ?? '');
  if (status === 'manual_pending') return 'pending manual check';
  if (status !== 'ok') return 'not checked';
  const n = normalisedOf(row);
  if (n.census_match === true) return 'registered';
  if (n.census_match === false) return 'not located';
  return 'not checked';
}

/**
 * Registro Público Concursal: `registered` when a publication was located for the identifier
 * (`normalised.registered`, the key the REA and RASIC checks use, so an automated module fits
 * without touching this sheet), `not located` when the register answered none. A manual
 * completion carries no structured outcome and reads `not checked`.
 */
export function insolvencyStatusFrom(row: Record<string, unknown> | undefined): FactSheetStatus {
  if (!row) return 'not checked';
  const status = String(row.status ?? '');
  if (status === 'manual_pending') return 'pending manual check';
  if (status === 'not_found') return 'not located';
  if (status !== 'ok') return 'not checked';
  const n = normalisedOf(row);
  if (n.registered === true) return 'registered';
  if (n.registered === false) return 'not located';
  return 'not checked';
}

function grantsFrom(row: Record<string, unknown> | undefined): FactSheetGrant[] {
  if (!row || String(row.status) !== 'ok') return [];
  const n = (row.normalised as Record<string, unknown> | null) ?? {};
  const list = Array.isArray(n.grants) ? (n.grants as Array<Record<string, unknown>>) : [];
  return list.map((g) => ({
    register: String(g.register ?? ''),
    programme: (g.programme as string | null) ?? null,
    date: (g.date as string | null) ?? null,
    amount_granted:
      g.amount_granted === null || g.amount_granted === undefined ? null : Number(g.amount_granted),
    amount_paid:
      g.amount_paid === null || g.amount_paid === undefined ? null : Number(g.amount_paid),
  }));
}

/**
 * Build the fact sheet. Exported so the pre-junta pack renders exactly the rows the CLI prints.
 */
export async function vendorFactSheet(client: Queryable, cid: string): Promise<VendorFactSheet> {
  // Sequential: a pooled client serialises queries and warns when two are issued at once.
  const partiesRes = await client.query(
    `select p.id, p.kind::text as kind, p.display_name, p.nif, p.nif_valid, p.nif_kind, p.entity_letter,
              p.address_norm,
              inv.first_invoice::text as first_invoice, coalesce(inv.invoice_count, 0) as invoice_count,
              doc.first_document::text as first_document
         from public.parties p
         left join lateral (
           select min(v.fecha_expedicion) as first_invoice, count(*)::int as invoice_count
             from public.invoices v where v.vendor_party_id = p.id and v.community_id = $1
         ) inv on true
         left join lateral (
           select min(d.doc_date) as first_document
             from public.documents d where d.community_id = $1 and d.issuer_party_id = p.id
         ) doc on true
        where p.community_id = $1 and p.kind in ('vendor', 'administrator', 'architect', 'insurer')
        order by p.display_name`,
    [cid],
  );
  const officers = await loadOfficers(client, cid);
  const checkRows = await latestChecks(client, cid);
  const communityRes = await client.query(`select nif from public.communities where id = $1`, [
    cid,
  ]);

  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of checkRows) byKey.set(`${String(r.check_type)}|${String(r.subject_key)}`, r);

  const officersByParty = new Map<string, typeof officers>();
  for (const o of officers) {
    const list = officersByParty.get(o.partyId) ?? [];
    list.push(o);
    officersByParty.set(o.partyId, list);
  }

  const communityNif = (communityRes.rows[0] as { nif?: string | null } | undefined)?.nif ?? null;
  const communityGrants = [
    ...grantsFrom(
      byKey.get(`bdns_grants|${communityNif ?? cid}`) ?? byKey.get(`bdns_grants|${cid}`),
    ),
    ...grantsFrom(
      byKey.get(`raisc_grants|${communityNif ?? cid}`) ?? byKey.get(`raisc_grants|${cid}`),
    ),
  ];

  const unverified = new Set<string>();
  for (const r of checkRows) {
    const n = (r.normalised as Record<string, unknown> | null) ?? {};
    if (n.source_verified === false) unverified.add(String(r.check_type));
  }

  const vendors: VendorFactSheetRow[] = (partiesRes.rows as Array<Record<string, unknown>>).map(
    (p) => {
      const id = String(p.id);
      const nif = (p.nif as string | null) ?? null;
      const v = nif ? validateNif(nif) : null;
      const letter = (p.entity_letter as string | null) ?? v?.entityLetter ?? null;
      const profile =
        (byKey.get(`company_profile|${id}`)?.normalised as Record<string, unknown> | null) ?? null;
      const partyChecks = checkRows
        .filter((r) => String(r.subject_key) === id)
        .map((r) => ({
          type: String(r.check_type),
          status: String(r.status),
          fetched_at: String(r.fetched_at ?? '').slice(0, 10) || null,
          source_url: (r.source_url as string | null) ?? null,
        }));
      return {
        party_id: id,
        display_name: String(p.display_name),
        kind: String(p.kind),
        nif,
        nif_valid: (p.nif_valid as boolean | null) ?? (v ? v.valid : null),
        nif_kind: (p.nif_kind as string | null) ?? v?.kind ?? null,
        entity_kind: letter ? (CIF_ENTITY_LABELS[letter] ?? null) : null,
        incorporation_date: (profile?.incorporation_date as string | null) ?? null,
        capital_eur:
          profile?.capital_eur === null || profile?.capital_eur === undefined
            ? null
            : Number(profile.capital_eur),
        cnae: (profile?.cnae as string | null) ?? null,
        registered_address_known: Boolean(
          (p.address_norm as string | null) ?? profile?.address ?? null,
        ),
        officers: (officersByParty.get(id) ?? []).map((o) => ({
          initials: officerInitials(o),
          cargo: o.cargo,
          date_from: o.dateFrom,
          date_to: o.dateTo,
        })),
        rea_status: statusFrom(byKey.get(`rea|${id}`) ?? byKey.get(`rea_manual|${id}`)),
        rasic_status: statusFrom(byKey.get(`rasic|${id}`) ?? byKey.get(`rasic_manual|${id}`)),
        census_status: censusStatusFrom(byKey.get(`aeat_census|${id}`)),
        insolvency_status: insolvencyStatusFrom(byKey.get(`insolvency|${id}`)),
        grants: grantsFrom(byKey.get(`bdns_grants|${id}`)),
        first_document_date: (p.first_document as string | null) ?? null,
        first_invoice_date: (p.first_invoice as string | null) ?? null,
        invoice_count: Number(p.invoice_count ?? 0),
        checks: partyChecks,
      };
    },
  );

  return {
    community_id: cid,
    generated_at: new Date().toISOString().slice(0, 10),
    community_grants: communityGrants,
    unverified_sources: [...unverified].sort(),
    vendors,
    note_es: NOTE_ES,
    note_en: NOTE_EN,
  };
}
