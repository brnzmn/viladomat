/**
 * Vendor fact sheet: registry facts only.
 *
 * This is the one vendor output that may reach the assembly of owners. It answers "what do the
 * public registers say about the companies the Community contracted with", and nothing else:
 * no scores, no tiers, no links, no severities, and no names of natural persons — officers are
 * rendered as a role and initials. What the register does not say is printed as "not located",
 * with the note that absence is not exculpatory.
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
  rea_status: 'registered' | 'not located' | 'not checked' | 'pending manual check';
  rasic_status: 'registered' | 'not located' | 'not checked' | 'pending manual check';
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

function statusFrom(row: Record<string, unknown> | undefined): VendorFactSheetRow['rea_status'] {
  if (!row) return 'not checked';
  const status = String(row.status ?? '');
  if (status === 'manual_pending') return 'pending manual check';
  if (status === 'not_found') return 'not located';
  if (status === 'ok') {
    const n = (row.normalised as Record<string, unknown> | null) ?? {};
    if (n.registered === false) return 'not located';
    return 'registered';
  }
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
        rea_status: statusFrom(byKey.get(`rea|${id}`)),
        rasic_status: statusFrom(byKey.get(`rasic|${id}`) ?? byKey.get(`rasic_manual|${id}`)),
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
