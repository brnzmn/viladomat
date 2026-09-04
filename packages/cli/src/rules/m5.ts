/**
 * M5 rules: what the public registers and the vendor documents say once the checks have run.
 *
 * B1 company age and form · B2 address coincidence · B3 surname coincidence · B7 registry
 * registration (REA/RASIC) · B8 vendor concentration · B9 implied invoicing volume ·
 * A10 comparison-quote authenticity · G2 tax filings · G5 lift compliance · G6 health and safety
 * on site · G7 technical building inspection.
 *
 * Neutrality, which matters more here than anywhere else in the system:
 *
 * - No natural person is named. Officers appear as a role and initials; office-holders appear as
 *   "the presidency" or "the administrator". The names live in `entity_officers` and in
 *   `restricted.reference_persons` and never leave the reviewer screen.
 * - A surname coincidence is printed with the number of people expected to produce the same
 *   coincidence by chance, and with the statement that a Registro Mercantil note is what would
 *   confirm or rule out identity. Family-run contractors are lawful; what a pack can ask about is
 *   disclosure and competition.
 * - Absence from a register is stated as not located and non-exculpatory, with the exemptions
 *   spelled out (a sole trader without employees is outside REA, a maintainer may be registered
 *   in another autonomous community).
 * - Independence follows provenance: a register response fetched and archived by the system is
 *   1.0; a screenshot a reviewer captured, or a check with no archived response, is 0.7.
 */
import { fmtEur, fp, money, type Rule, type RuleHit } from './engine.ts';
import { DOMICILIATION_MIN_COMPANIES } from '../vendors/config.ts';
import { cnaeRelated, REA_CATEGORIES, RASIC_CATEGORIES } from '../vendors/snapshot.ts';
import { findQuoteOverlaps, loadQuoteRows } from '../vendors/quotes.ts';

/** A register response the system fetched and archived. */
const REGISTRY_ARCHIVED = 1;
/** A manual capture, an unarchived response, or a single document. */
const REGISTRY_MANUAL = 0.7;
const EXTRACTED_QUALITY = 0.9;
const RECORD_QUALITY = 1;

/** Independence of a check row: archived machine response 1.0, everything else 0.7. */
export function checkIndependence(
  row: { archived?: unknown; manual_evidence?: unknown } | null | undefined,
): number {
  if (!row) return REGISTRY_MANUAL;
  if (row.manual_evidence === true) return REGISTRY_MANUAL;
  return row.archived === true ? REGISTRY_ARCHIVED : REGISTRY_MANUAL;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10);
}

function monthsBetween(a: string, b: string): number {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return (to - from) / (1000 * 60 * 60 * 24 * 30.4375);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Role labels used in the output. People are referred to by role, never by name. */
const ROLE_ES: Readonly<Record<string, string>> = {
  president: 'la presidencia',
  president_family: 'el entorno familiar de la presidencia',
  administrator: 'la administración de fincas',
};
const ROLE_EN: Readonly<Record<string, string>> = {
  president: 'the presidency',
  president_family: 'the presidency’s family',
  administrator: 'the managing agent',
};

// ---------------------------------------------------------------------------
// B1 — company age and form against the first invoice
// ---------------------------------------------------------------------------

export const B1_companyAge: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select p.id, p.display_name, p.kind::text as kind,
            e.normalised as profile, e.fetched_at::date::text as profile_date,
            (e.raw_response is not null) as archived,
            (e.request ? 'answers_check_id') as manual_evidence,
            inv.first_invoice::text as first_invoice,
            coalesce(inv.works_total, 0) as works_total,
            coalesce(inv.invoice_total, 0) as invoice_total,
            coalesce(inv.categories, '{}') as categories
       from public.parties p
       left join lateral (
         select c.normalised, c.fetched_at, c.raw_response, c.request
           from public.external_checks c
          where c.community_id = p.community_id and c.check_type = 'company_profile'
            and c.subject_key = p.id::text and c.status = 'ok'
          order by c.fetched_at desc limit 1
       ) e on true
       left join lateral (
         select min(v.fecha_expedicion) as first_invoice,
                coalesce(sum(v.total), 0) as invoice_total,
                coalesce(sum(v.total) filter (where v.works_package_id is not null), 0) as works_total,
                array_remove(array_agg(distinct v.category_code), null) as categories
           from public.invoices v where v.vendor_party_id = p.id and v.community_id = $1
       ) inv on true
      where p.community_id = $1 and p.kind in ('vendor', 'architect')
        and e.normalised is not null
      order by p.display_name`,
    [cid],
  );

  for (const r of res.rows as Array<Record<string, unknown>>) {
    const profile = (r.profile as Record<string, unknown> | null) ?? {};
    const partyId = String(r.id);
    const independence = checkIndependence(r as { archived?: unknown; manual_evidence?: unknown });
    const profileDate = iso(r.profile_date) ?? today;
    const incorporation = iso(profile.incorporation_date);
    const firstInvoice = iso(r.first_invoice);
    const worksTotal = money(r.works_total);
    const capital = num(profile.capital_eur);
    const evidence = [
      { label: 'company_profile', computed: { party_id: partyId, fetched_at: profileDate } },
    ];

    if (incorporation && firstInvoice) {
      const months = monthsBetween(incorporation, firstInvoice);
      const days = Math.round(months * 30.4375);
      if (Number.isFinite(months) && months >= 0 && months < 12) {
        const severity: 2 | 3 = months < 6 ? 3 : 2;
        hits.push({
          ruleCode: 'B1',
          severity,
          eventKey: `party:${partyId}:company_age`,
          fingerprint: fp('B1', partyId, 'age', incorporation, firstInvoice),
          entityType: 'party',
          entityId: partyId,
          amountAtStake: worksTotal || money(r.invoice_total),
          actDateFirst: incorporation,
          actDateLast: firstInvoice,
          computed: {
            incorporation_date: incorporation,
            first_invoice_date: firstInvoice,
            days_between: days,
            source_fetched_at: profileDate,
          },
          summaryEs:
            `El proveedor consta constituido el ${incorporation} y la primera factura localizada es de ${firstInvoice} ` +
            `(${days} días después). Verificar la trayectoria de la empresa y cómo se seleccionó.`,
          summaryEn:
            `The vendor is recorded as incorporated on ${incorporation} and the first invoice located is dated ${firstInvoice} ` +
            `(${days} days later). Verify the company’s track record and how it was selected.`,
          innocentExplanations: [
            'New companies are common in construction: spin-offs, retirements and successions all produce them.',
            'The registry date may be the date of a change of legal form or of a re-registration rather than of first activity.',
            'The team may have worked for years under another company or as sole traders.',
          ],
          nextCheck:
            'Read the Registro Mercantil note for the company and the quotes considered for the same package.',
          resolvingDocument:
            'Nota informativa del Registro Mercantil; presupuestos comparados; referencias de obra anteriores',
          independence,
          extractionQuality: RECORD_QUALITY,
          evidence,
        });
      }
    }

    if (capital !== null && capital <= 3000 && worksTotal > 20000) {
      hits.push({
        ruleCode: 'B1',
        severity: 2,
        eventKey: `party:${partyId}:capital_vs_works`,
        fingerprint: fp('B1', partyId, 'capital', String(capital)),
        entityType: 'party',
        entityId: partyId,
        amountAtStake: worksTotal,
        actDateFirst: incorporation,
        computed: { capital_eur: capital, works_total: worksTotal, source_fetched_at: profileDate },
        summaryEs:
          `El capital social que consta es de ${fmtEur(capital)} frente a ${fmtEur(worksTotal)} de obra facturada. ` +
          'Verificar la solvencia y las garantías exigidas en el contrato.',
        summaryEn:
          `The share capital on the record is ${fmtEur(capital)} against ${fmtEur(worksTotal)} of works invoiced. ` +
          'Verify solvency and the guarantees required by the contract.',
        innocentExplanations: [
          'Limited companies may lawfully be incorporated with €1 of capital since Ley 18/2022; capital says little about capacity.',
          'Reserves, insurance and a bank guarantee are the relevant protections, not the nominal capital.',
        ],
        nextCheck:
          'Check whether the contract required a retention, a guarantee or civil-liability insurance, and whether accounts have been filed.',
        resolvingDocument:
          'Cuentas anuales depositadas; póliza de responsabilidad civil; aval o retención de garantía',
        independence,
        extractionQuality: RECORD_QUALITY,
        evidence,
      });
    }

    const cnae = (profile.cnae as string | null) ?? null;
    const categories = ((r.categories as string[] | null) ?? []).filter(Boolean);
    const related = cnaeRelated(cnae, categories);
    if (related === false) {
      hits.push({
        ruleCode: 'B1',
        severity: 2,
        eventKey: `party:${partyId}:cnae`,
        fingerprint: fp('B1', partyId, 'cnae', cnae ?? ''),
        entityType: 'party',
        entityId: partyId,
        amountAtStake: money(r.invoice_total),
        computed: { cnae, invoiced_categories: categories, source_fetched_at: profileDate },
        summaryEs: `La actividad declarada (CNAE ${cnae}) no cubre los trabajos facturados (${categories.join(', ')}). Verificar.`,
        summaryEn: `The declared activity (CNAE ${cnae}) does not cover the work invoiced (${categories.join(', ')}). Verify.`,
        innocentExplanations: [
          'Activity codes are declared once and rarely updated; many companies work well outside the code they registered.',
          'The company may hold several codes and only the principal one is published.',
          'The line classification is automatic and may itself be wrong.',
        ],
        nextCheck:
          'Compare the object of the company in the Registro Mercantil note with the scope of the contract.',
        resolvingDocument:
          'Nota informativa del Registro Mercantil (objeto social); alta censal (modelo 036/037)',
        independence,
        extractionQuality: EXTRACTED_QUALITY,
        evidence,
      });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// B2 — address coincidence
// ---------------------------------------------------------------------------

export const B2_addressCoincidence: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];

  // Role-bearing coincidences already scored into party_links (S5, S6).
  const links = await client.query(
    `select l.id, l.from_party_id, p.display_name, l.to_role, l.signal, l.points, l.tier, l.explanation,
            l.updated_at::date::text as updated_on
       from public.party_links l join public.parties p on p.id = l.from_party_id
      where l.community_id = $1 and l.signal in ('S5', 'S6') and l.status <> 'dismissed'
      order by l.points desc`,
    [cid],
  );
  for (const l of links.rows as Array<Record<string, unknown>>) {
    const partyId = String(l.from_party_id);
    const role = String(l.to_role);
    const points = num(l.points) ?? 0;
    const severity: 1 | 2 | 3 = points >= 80 ? 3 : points >= 40 ? 2 : 1;
    hits.push({
      ruleCode: 'B2',
      severity,
      eventKey: `party:${partyId}:address_link:${role}`,
      fingerprint: fp('B2', partyId, role, String(l.signal)),
      entityType: 'party',
      entityId: partyId,
      actDateLast: iso(l.updated_on) ?? today,
      computed: { signal: l.signal, points, tier: l.tier, to_role: role },
      summaryEs: `Posible coincidencia de domicilio entre un proveedor y ${ROLE_ES[role] ?? role}. ${String(l.explanation ?? '')}`,
      summaryEn: `Possible address coincidence between a vendor and ${ROLE_EN[role] ?? role}. ${String(l.explanation ?? '')}`,
      innocentExplanations: [
        'Domiciliation and accountancy addresses in the Eixample host dozens of companies at one door.',
        'A resident may lawfully run a company from home and lawfully work for the community, provided the interest is disclosed and competition preserved.',
        'Addresses are transcribed from documents and may be normalised differently in each source.',
      ],
      nextCheck:
        'Count the companies registered at the address and read the Registro Mercantil note of each entity involved.',
      resolvingDocument:
        'Nota informativa del Registro Mercantil; declaración de vinculación solicitada a la administración',
      independence: REGISTRY_MANUAL,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'party_link', computed: { party_link_id: l.id, signal: l.signal } }],
    });
  }

  // Coincidences that have no office-holder role: the building itself, another vendor.
  const parties = await client.query(
    `select p.id, p.display_name, p.kind::text as kind, p.address_norm,
            c.address as community_address,
            (select count(*) from public.parties q
              where q.community_id = p.community_id and q.address_norm = p.address_norm) as at_address
       from public.parties p
       join public.communities c on c.id = p.community_id
      where p.community_id = $1 and p.address_norm is not null
      order by p.display_name`,
    [cid],
  );
  const rows = parties.rows as Array<Record<string, unknown>>;
  const norm = (s: unknown): string =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  const byAddress = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const key = norm(r.address_norm);
    if (!key) continue;
    const list = byAddress.get(key) ?? [];
    list.push(r);
    byAddress.set(key, list);
  }

  for (const r of rows) {
    if (String(r.kind) !== 'vendor' && String(r.kind) !== 'architect') continue;
    const partyId = String(r.id);
    const key = norm(r.address_norm);
    const communityKey = norm(r.community_address);

    if (key && communityKey && key === communityKey) {
      hits.push({
        ruleCode: 'B2',
        severity: 3,
        eventKey: `party:${partyId}:address_building`,
        fingerprint: fp('B2', partyId, 'building'),
        entityType: 'party',
        entityId: partyId,
        computed: { basis: 'building_address' },
        summaryEs:
          'El domicilio que consta del proveedor coincide con el del edificio de la Comunidad. Verificar.',
        summaryEn: 'The vendor’s address on the record is the Community’s own building. Verify.',
        innocentExplanations: [
          'An owner or resident may lawfully run a company from the building.',
          'The address may have been transcribed from the invoice header, which sometimes carries the site address rather than the registered one.',
        ],
        nextCheck:
          'Read the registered address in the Registro Mercantil note and compare it with the unit table.',
        resolvingDocument:
          'Nota informativa del Registro Mercantil; cuadro de entidades del título constitutivo',
        independence: REGISTRY_MANUAL,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'party', computed: { party_id: partyId } }],
      });
    }

    const sharing = (byAddress.get(key) ?? []).filter((o) => String(o.id) !== partyId);
    if (sharing.length === 0) continue;
    const atAddress = Number(r.at_address ?? sharing.length + 1);
    const domiciliation = atAddress >= DOMICILIATION_MIN_COMPANIES;
    const withAdministrator = sharing.some((o) => String(o.kind) === 'administrator');
    hits.push({
      ruleCode: 'B2',
      severity: domiciliation ? 1 : withAdministrator ? 3 : 2,
      eventKey: `party:${partyId}:address_shared`,
      fingerprint: fp('B2', partyId, 'shared', key),
      entityType: 'party',
      entityId: partyId,
      computed: {
        entities_at_address: atAddress,
        domiciliation,
        shared_with_administrator: withAdministrator,
        shared_with_party_ids: sharing.map((o) => String(o.id)),
      },
      summaryEs: withAdministrator
        ? 'El domicilio que consta del proveedor coincide con el de la administración de fincas. Verificar.'
        : `El domicilio que consta del proveedor coincide con el de otra(s) ${sharing.length} entidad(es) del expediente. Verificar.`,
      summaryEn: withAdministrator
        ? 'The vendor’s address on the record is the managing agent’s office address. Verify.'
        : `The vendor’s address on the record is shared with ${sharing.length} other entity(ies) in the file. Verify.`,
      innocentExplanations: [
        domiciliation
          ? `The address hosts ${atAddress} entities on the record, which is what a domiciliation or accountancy address looks like; the coincidence then carries little weight.`
          : 'Small firms frequently share a gestoría or a coworking address.',
        'The managing agent may lawfully act as the registered address of client companies it also administers.',
      ],
      nextCheck:
        'Count the companies registered at the address (registry search by address) before drawing anything from the coincidence.',
      resolvingDocument:
        'Nota informativa del Registro Mercantil de cada entidad; contrato de domiciliación',
      independence: REGISTRY_MANUAL,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'party', computed: { party_id: partyId, at_address: atAddress } }],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// B3 — surname coincidence (reads party_links; never reads reference_persons directly)
// ---------------------------------------------------------------------------

/**
 * Severity from the points a surname coincidence scored. The order of the surnames and which one
 * matched are in the link's explanation, not in a column: `party_links` has no detail field.
 */
export function surnameSeverity(signal: string, points: number): 1 | 2 | 3 | 4 {
  if (signal === 'S1' || signal === 'S2') return 4;
  if (signal === 'S4') return points >= 10 ? 3 : 1;
  if (points >= 40) return 4;
  if (points >= 25) return 3;
  if (points >= 10) return 2;
  return 1;
}

export const B3_surnameCoincidence: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select l.id, l.from_party_id, p.display_name, l.to_role, l.signal, l.points, l.rarity_weight,
            l.expected_collisions, l.tier, l.explanation, l.status,
            l.updated_at::date::text as updated_on,
            exists (select 1 from public.external_checks c
                     where c.community_id = l.community_id and c.check_type = 'registro_mercantil_nota'
                       and c.subject_key = l.from_party_id::text and c.status = 'ok') as nota_obtained
       from public.party_links l join public.parties p on p.id = l.from_party_id
      where l.community_id = $1 and l.signal in ('S1', 'S2', 'S3', 'S4') and l.status <> 'dismissed'
      order by l.points desc`,
    [cid],
  );
  for (const l of res.rows as Array<Record<string, unknown>>) {
    const partyId = String(l.from_party_id);
    const role = String(l.to_role);
    const signal = String(l.signal);
    const points = num(l.points) ?? 0;
    const collisions = num(l.expected_collisions);
    const severity = surnameSeverity(signal, points);
    const homonyms =
      collisions === null
        ? 'no se ha obtenido la frecuencia del apellido'
        : `${collisions} personas esperadas con la misma coincidencia`;
    const homonymsEn =
      collisions === null
        ? 'the surname frequency was not obtained'
        : `${collisions} people expected to share the same coincidence`;
    hits.push({
      ruleCode: 'B3',
      severity,
      eventKey: `party:${partyId}:name_link:${role}`,
      fingerprint: fp('B3', partyId, role, signal),
      entityType: 'party',
      entityId: partyId,
      actDateLast: iso(l.updated_on) ?? today,
      computed: {
        signal,
        points,
        tier: l.tier,
        rarity_weight: num(l.rarity_weight),
        expected_collisions: collisions,
        to_role: role,
        nota_informativa_obtained: l.nota_obtained === true,
      },
      summaryEs:
        `Posible vínculo por verificar entre un cargo del proveedor y ${ROLE_ES[role] ?? role} ` +
        `(${homonyms}). La identidad sólo puede confirmarse con una nota informativa del Registro Mercantil` +
        `${l.nota_obtained === true ? ', que ya obra en el expediente' : ', que aún no se ha obtenido'}.`,
      summaryEn:
        `Possible link to verify between an officer of the vendor and ${ROLE_EN[role] ?? role} ` +
        `(${homonymsEn}). Identity can only be confirmed by a Registro Mercantil note` +
        `${l.nota_obtained === true ? ', which is already in the file' : ', which has not been obtained'}.`,
      innocentExplanations: [
        'Common surnames produce hundreds of coincidences in a city of this size; the expected count is printed with the finding for that reason.',
        'The two surnames may appear in the reverse order in different sources, and gazette entries are transcribed inconsistently.',
        'Registered officers may be nominees, and a family-run contractor is perfectly lawful — what a meeting can ask about is disclosure and competition, not the relationship.',
      ],
      nextCheck:
        'Obtain the Registro Mercantil note for the company and compare identifiers, not names, before treating the coincidence as a relationship.',
      resolvingDocument:
        'Nota informativa del Registro Mercantil; declaración de vinculación solicitada bajo el requerimiento de la junta',
      independence: REGISTRY_MANUAL,
      extractionQuality: RECORD_QUALITY,
      evidence: [
        {
          label: 'party_link',
          computed: { party_link_id: l.id, signal, explanation: l.explanation },
        },
      ],
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// B7 — REA and RASIC for the trades that require them
// ---------------------------------------------------------------------------

export const B7_registryRegistration: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select p.id, p.display_name, p.nif_kind,
            coalesce(inv.categories, '{}') as categories,
            coalesce(inv.invoice_total, 0) as invoice_total,
            inv.first_invoice::text as first_invoice,
            rea.status as rea_status, rea.fetched_at::date::text as rea_on,
            (rea.raw_response is not null) as rea_archived,
            (rea.request ? 'answers_check_id') as rea_manual,
            ras.status as rasic_status, ras.fetched_at::date::text as rasic_on,
            (ras.raw_response is not null) as rasic_archived,
            (ras.request ? 'answers_check_id') as rasic_manual
       from public.parties p
       left join lateral (
         select min(v.fecha_expedicion) as first_invoice, coalesce(sum(v.total), 0) as invoice_total,
                array_remove(array_agg(distinct v.category_code), null) as categories
           from public.invoices v where v.vendor_party_id = p.id and v.community_id = $1
       ) inv on true
       left join lateral (
         select c.status, c.fetched_at, c.raw_response, c.request from public.external_checks c
          where c.community_id = p.community_id and c.check_type = 'rea' and c.subject_key = p.id::text
          order by c.fetched_at desc limit 1
       ) rea on true
       left join lateral (
         select c.status, c.fetched_at, c.raw_response, c.request from public.external_checks c
          where c.community_id = p.community_id and c.check_type in ('rasic', 'rasic_manual')
            and c.subject_key = p.id::text
          order by c.fetched_at desc limit 1
       ) ras on true
      where p.community_id = $1 and p.kind = 'vendor'
      order by p.display_name`,
    [cid],
  );

  for (const r of res.rows as Array<Record<string, unknown>>) {
    const partyId = String(r.id);
    const categories = ((r.categories as string[] | null) ?? []).filter(Boolean);
    const total = money(r.invoice_total);
    const reaNeeded = categories.some((c) => REA_CATEGORIES.has(c));
    const rasicNeeded = categories.some((c) => RASIC_CATEGORIES.has(c));
    const soleTrader = String(r.nif_kind ?? '') === 'DNI' || String(r.nif_kind ?? '') === 'NIE';

    if (reaNeeded && String(r.rea_status ?? '') === 'not_found') {
      hits.push({
        ruleCode: 'B7',
        severity: 2,
        eventKey: `party:${partyId}:rea_absent`,
        fingerprint: fp('B7', partyId, 'rea'),
        entityType: 'party',
        entityId: partyId,
        amountAtStake: total,
        actDateFirst: iso(r.first_invoice),
        actDateLast: iso(r.rea_on) ?? today,
        computed: {
          register: 'REA',
          categories,
          checked_on: iso(r.rea_on),
          sole_trader_shape: soleTrader,
        },
        summaryEs:
          `No se ha localizado inscripción en el REA para un proveedor que ha facturado trabajos de construcción ` +
          `(${categories.join(', ')}; ${fmtEur(total)}). Verificar.`,
        summaryEn: `No REA entry located for a vendor that invoiced construction work (${categories.join(', ')}; ${fmtEur(total)}). Verify.`,
        innocentExplanations: [
          'A sole trader without employees is exempt from REA.',
          'The company may be registered in another autonomous community’s section of the register, or under a group company.',
          'A registration valid at the time of the works may have lapsed before the check was run.',
          'The public search may not match the exact company name transcribed from the invoice.',
        ],
        nextCheck:
          'Ask the contractor, through the administrator, for its REA certificate covering the dates of the works.',
        resolvingDocument: 'Certificado de inscripción en el REA con fechas de validez',
        independence: checkIndependence({
          archived: r.rea_archived,
          manual_evidence: r.rea_manual,
        }),
        extractionQuality: RECORD_QUALITY,
        evidence: [
          { label: 'rea_check', computed: { party_id: partyId, checked_on: iso(r.rea_on) } },
        ],
      });
    }

    if (rasicNeeded && String(r.rasic_status ?? '') === 'not_found') {
      hits.push({
        ruleCode: 'B7',
        severity: 3,
        eventKey: `party:${partyId}:rasic_absent`,
        fingerprint: fp('B7', partyId, 'rasic'),
        entityType: 'party',
        entityId: partyId,
        amountAtStake: total,
        actDateFirst: iso(r.first_invoice),
        actDateLast: iso(r.rasic_on) ?? today,
        computed: { register: 'RASIC', categories, checked_on: iso(r.rasic_on) },
        summaryEs:
          `No se ha localizado inscripción en el RASIC para un proveedor de trabajos regulados ` +
          `(${categories.join(', ')}; ${fmtEur(total)}). Verificar.`,
        summaryEn: `No RASIC entry located for a vendor of regulated installation work (${categories.join(', ')}; ${fmtEur(total)}). Verify.`,
        innocentExplanations: [
          'The dataset identifier and the column names of the register are still to verify; a negative result may be an artefact of the query.',
          'A lift maintainer may hold the registration through a group company or through the manufacturer.',
          'Registration may have been obtained after the first invoice or lapsed afterwards.',
        ],
        nextCheck:
          'Ask the installer or maintainer for its RASIC registration number and check it in the register.',
        resolvingDocument:
          'Número de inscripción RASIC; declaración responsable presentada ante la Generalitat',
        independence: checkIndependence({
          archived: r.rasic_archived,
          manual_evidence: r.rasic_manual,
        }),
        extractionQuality: RECORD_QUALITY,
        evidence: [
          { label: 'rasic_check', computed: { party_id: partyId, checked_on: iso(r.rasic_on) } },
        ],
      });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// B8 — vendor concentration, ordinary spend only (base-rate rule, never worklist)
// ---------------------------------------------------------------------------

export const B8_vendorConcentration: Rule = async ({ cid, client }) => {
  const res = await client.query(
    `select p.id, p.display_name, coalesce(sum(v.total), 0) as ordinary_total,
            count(distinct v.category_code) as categories
       from public.invoices v
       join public.parties p on p.id = v.vendor_party_id
      where v.community_id = $1 and v.works_package_id is null
      group by p.id, p.display_name
      having coalesce(sum(v.total), 0) > 0
      order by ordinary_total desc`,
    [cid],
  );
  const rows = res.rows as Array<Record<string, unknown>>;
  const total = rows.reduce((acc, r) => acc + money(r.ordinary_total), 0);
  const top = rows[0];
  if (!top || total <= 0) return [];
  const share = money(top.ordinary_total) / total;
  if (share <= 0.6) return [];
  const partyId = String(top.id);
  return [
    {
      ruleCode: 'B8',
      severity: 1,
      eventKey: `community:${cid}:vendor_concentration_ordinary`,
      fingerprint: fp('B8', cid, partyId),
      entityType: 'party',
      entityId: partyId,
      amountAtStake: money(top.ordinary_total),
      computed: {
        scope: 'ordinary_spend_only',
        share_pct: Math.round(share * 1000) / 10,
        vendor_ordinary_total: money(top.ordinary_total),
        ordinary_total: Math.round(total * 100) / 100,
        distinct_categories: Number(top.categories ?? 0),
        vendors: rows.length,
      },
      summaryEs:
        `Un solo proveedor concentra el ${Math.round(share * 100)}% del gasto ordinario facturado (${fmtEur(money(top.ordinary_total))} ` +
        `de ${fmtEur(total)}), sobre ${Number(top.categories ?? 0)} tipo(s) de trabajo. Dato de contexto.`,
      summaryEn:
        `One vendor accounts for ${Math.round(share * 100)}% of ordinary invoiced spend (${fmtEur(money(top.ordinary_total))} ` +
        `of ${fmtEur(total)}) across ${Number(top.categories ?? 0)} type(s) of work. Context only.`,
      innocentExplanations: [
        'A small community using one trusted contractor for everything is normal and is a matter of efficiency, not of regularity.',
        'Works-package spend is excluded from this measure precisely because one project dominates any small community’s accounts.',
      ],
      nextCheck:
        'Read this alongside the quotes on file for the ordinary items; on its own it supports nothing.',
      resolvingDocument: 'Presupuestos comparados de los trabajos ordinarios',
      independence: 0.7,
      extractionQuality: EXTRACTED_QUALITY,
      evidence: [{ label: 'ordinary_spend', computed: { vendors: rows.length } }],
    },
  ];
};

// ---------------------------------------------------------------------------
// B9 — implied invoicing volume from the invoice numbers
// ---------------------------------------------------------------------------

export const B9_impliedVolume: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select p.id, p.display_name,
            extract(year from v.fecha_expedicion)::int as year,
            min(v.numero_int) as min_num, max(v.numero_int) as max_num,
            min(v.fecha_expedicion)::text as first_date, max(v.fecha_expedicion)::text as last_date,
            count(*)::int as n, coalesce(sum(v.total), 0) as total
       from public.invoices v
       join public.parties p on p.id = v.vendor_party_id
      where v.community_id = $1 and v.numero_int is not null and v.fecha_expedicion is not null
      group by p.id, p.display_name, extract(year from v.fecha_expedicion)
      order by p.display_name, year`,
    [cid],
  );

  for (const r of res.rows as Array<Record<string, unknown>>) {
    const partyId = String(r.id);
    const year = Number(r.year);
    const minNum = num(r.min_num);
    const maxNum = num(r.max_num);
    const n = Number(r.n ?? 0);
    const total = money(r.total);
    const first = iso(r.first_date);
    const last = iso(r.last_date);
    if (minNum === null || maxNum === null || !first || !last) continue;

    if (n >= 2 && maxNum > minNum) {
      const days = Math.max(
        1,
        (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000,
      );
      const implied = Math.round(((maxNum - minNum) / days) * 365);
      if (implied < 30 && total > 10000) {
        hits.push({
          ruleCode: 'B9',
          severity: 2,
          eventKey: `party:${partyId}:implied_volume:${year}`,
          fingerprint: fp('B9', partyId, 'implied', String(year)),
          entityType: 'party',
          entityId: partyId,
          fiscalYear: year,
          amountAtStake: total,
          actDateFirst: first,
          actDateLast: last,
          computed: {
            year,
            min_numero: minNum,
            max_numero: maxNum,
            span_days: Math.round(days),
            implied_invoices_per_year: implied,
            invoices_seen: n,
            total,
          },
          summaryEs:
            `La numeración de las facturas del proveedor implica del orden de ${implied} facturas al año en ${year}, ` +
            `mientras que ha facturado ${fmtEur(total)} a la Comunidad. Verificar el sistema de numeración.`,
          summaryEn:
            `The vendor’s invoice numbering implies of the order of ${implied} invoices a year in ${year}, ` +
            `while it invoiced ${fmtEur(total)} to the Community. Verify the numbering scheme.`,
          innocentExplanations: [
            'Many small firms keep one series per client, or restart the numbering every year, which makes the implied volume meaningless.',
            'Rectifying invoices and other series are numbered separately.',
            'Numbers transcribed from photographs may be misread.',
          ],
          nextCheck:
            'Ask the vendor, through the administrator, how its invoice series are organised.',
          resolvingDocument:
            'Explicación del sistema de series y numeración; cuentas anuales depositadas (cifra de negocio)',
          independence: 0.7,
          extractionQuality: EXTRACTED_QUALITY,
          evidence: [{ label: 'invoice_numbering', computed: { party_id: partyId, year } }],
        });
      }
    }

    if (minNum <= 10) {
      hits.push({
        ruleCode: 'B9',
        severity: 1,
        eventKey: `party:${partyId}:first_number:${year}`,
        fingerprint: fp('B9', partyId, 'first_number', String(year)),
        entityType: 'party',
        entityId: partyId,
        fiscalYear: year,
        amountAtStake: total,
        actDateFirst: first,
        computed: { year, min_numero: minNum, invoices_seen: n },
        summaryEs: `La primera factura localizada del proveedor en ${year} lleva el número ${minNum}. Dato de contexto.`,
        summaryEn: `The first invoice located from this vendor in ${year} carries number ${minNum}. Context only.`,
        innocentExplanations: [
          'Numbering restarts at 1 every year for most small firms.',
          'A dedicated series per client also starts at 1.',
        ],
        nextCheck: 'Read together with the implied-volume observation; alone it means nothing.',
        resolvingDocument: 'Explicación del sistema de series y numeración',
        independence: 0.7,
        extractionQuality: EXTRACTED_QUALITY,
        evidence: [{ label: 'invoice_numbering', computed: { party_id: partyId, year } }],
      });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// A10 — authenticity of the comparison quotes
// ---------------------------------------------------------------------------

const FINGERPRINT_LABEL_ES: Readonly<Record<string, string>> = {
  pdf_producer: 'el mismo programa productor del PDF',
  pdf_author: 'el mismo autor en los metadatos del PDF',
  phone: 'el mismo teléfono',
  iban: 'la misma cuenta bancaria',
  sequential_numbers: 'números de presupuesto correlativos',
  typo: 'la misma errata',
};
const FINGERPRINT_LABEL_EN: Readonly<Record<string, string>> = {
  pdf_producer: 'the same PDF producer',
  pdf_author: 'the same author in the PDF metadata',
  phone: 'the same telephone number',
  iban: 'the same bank account',
  sequential_numbers: 'consecutive quote numbers',
  typo: 'the same typographic error',
};

export const A10_quoteAuthenticity: Rule = async ({ cid, client }) => {
  const rows = await loadQuoteRows(client, cid);
  const overlaps = findQuoteOverlaps(rows);
  if (overlaps.length === 0) return [];

  // One hit per works package: the question is about the procurement file, not about a vendor.
  const byPackage = new Map<string, typeof overlaps>();
  for (const o of overlaps) {
    const key = o.worksPackageId ?? 'unassigned';
    const list = byPackage.get(key) ?? [];
    list.push(o);
    byPackage.set(key, list);
  }

  const hits: RuleHit[] = [];
  for (const [pkg, list] of byPackage) {
    const kinds = [...new Set(list.map((o) => o.kind))];
    const parties = [...new Set(list.flatMap((o) => o.partyIds))];
    const quoteIds = [...new Set(list.flatMap((o) => o.quotes.map((q) => q.quoteId)))];
    const severity: 2 | 3 = kinds.length >= 2 || kinds.includes('sequential_numbers') ? 3 : 2;
    hits.push({
      ruleCode: 'A10',
      severity,
      eventKey: `works_package:${pkg}:quote_fingerprints`,
      fingerprint: fp('A10', pkg, kinds.join(',')),
      entityType: 'works_package',
      entityId: pkg === 'unassigned' ? null : pkg,
      worksPackageId: pkg === 'unassigned' ? null : pkg,
      computed: {
        fingerprints: list.map((o) => ({
          kind: o.kind,
          value: o.value,
          party_ids: o.partyIds,
          quote_ids: o.quotes.map((q) => q.quoteId),
        })),
        distinct_vendors: parties.length,
        quotes: quoteIds.length,
      },
      summaryEs:
        `Presupuestos presentados como de proveedores distintos comparten ${kinds.map((k) => FINGERPRINT_LABEL_ES[k] ?? k).join(', ')} ` +
        `(${quoteIds.length} presupuestos, ${parties.length} proveedores). Verificar el origen de cada oferta.`,
      summaryEn:
        `Quotes presented as coming from different vendors share ${kinds.map((k) => FINGERPRINT_LABEL_EN[k] ?? k).join(', ')} ` +
        `(${quoteIds.length} quotes, ${parties.length} vendors). Verify where each offer came from.`,
      innocentExplanations: [
        'Quotes are often typed on the architect’s or the administrator’s template, which leaves one producer in every file.',
        'Bidders in the same trade frequently use the same estimating software.',
        'A PDF re-saved or re-printed by the administrator before delivery carries that machine’s metadata, not the issuer’s.',
        'Telephone numbers read from photographs are a common OCR error.',
      ],
      nextCheck:
        'Ask for the original files as the vendors sent them, and confirm each offer with the unsuccessful bidders through counsel.',
      resolvingDocument:
        'Presupuestos originales (correo del remitente); confirmación de los licitadores no adjudicatarios',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: quoteIds.slice(0, 8).map((id) => ({ label: 'quote', computed: { quote_id: id } })),
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// G2 — tax filings 111 / 190 / 347
// ---------------------------------------------------------------------------

export const G2_taxFilings: Rule = async ({ cid, client, today }) => {
  const res = await client.query(
    `select
       (select count(*)::int from public.documents d
         where d.community_id = $1 and d.doc_type = 'modelo_111_190_347') as filings_on_file,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and coalesce(v.retencion_irpf_importe, 0) <> 0) as withholding_invoices,
       (select count(*)::int from public.parties p
         join public.invoices v on v.vendor_party_id = p.id and v.community_id = $1
        where p.community_id = $1 and p.nif_kind in ('DNI', 'NIE')) as natural_person_invoices,
       (select coalesce(json_agg(json_build_object(
                 'id', r.id, 'class', r.class::text, 'status', r.status::text,
                 'requested_on', r.requested_on::text, 'fiscal_year', r.fiscal_year)), '[]'::json)
          from public.document_requests r
         where r.community_id = $1 and r.class = 'modelo_347') as requests`,
    [cid],
  );
  const row = (res.rows[0] as Record<string, unknown> | undefined) ?? {};
  const filings = Number(row.filings_on_file ?? 0);
  const withholding = Number(row.withholding_invoices ?? 0);
  const naturalPersons = Number(row.natural_person_invoices ?? 0);
  const requests = (row.requests as Array<Record<string, unknown>> | null) ?? [];
  const outstanding = requests.filter((r) =>
    ['requested', 'partial', 'refused', 'inspected_only'].includes(String(r.status)),
  );

  if (filings > 0) return [];
  if (outstanding.length === 0 && withholding === 0 && naturalPersons === 0) return [];

  const requestedOn =
    outstanding
      .map((r) => (r.requested_on ? String(r.requested_on) : null))
      .filter((d): d is string => d !== null)
      .sort()[0] ?? null;
  const severity: 1 | 2 = outstanding.length > 0 ? 2 : 1;

  return [
    {
      ruleCode: 'G2',
      severity,
      eventKey: `community:${cid}:tax_filings_absent`,
      fingerprint: fp('G2', cid, 'filings'),
      entityType: 'community',
      entityId: cid,
      actDateFirst: requestedOn,
      actDateLast: today,
      computed: {
        filings_on_file: filings,
        invoices_with_withholding: withholding,
        invoices_from_natural_persons: naturalPersons,
        outstanding_requests: outstanding,
      },
      summaryEs: requestedOn
        ? `No consta en el expediente ninguna declaración 111/190/347, solicitada el ${requestedOn} y no recibida a ${today}.`
        : 'No consta en el expediente ninguna declaración 111/190/347, pese a existir facturas con retención o de personas físicas. Procede solicitarlas.',
      summaryEn: requestedOn
        ? `No 111/190/347 filing is in the file; requested on ${requestedOn} and not received as of ${today}.`
        : 'No 111/190/347 filing is in the file although invoices with withholding or from natural persons exist. They should be requested.',
      innocentExplanations: [
        'Filings are held by the administrator and are not usually circulated with the annual accounts.',
        'Suppliers below €3,005.06 a year, and utilities and insurance, are outside the 347 declaration.',
        'The 347 is filed in February for the previous year, so the most recent year may not be due yet.',
      ],
      nextCheck:
        'Add the 111, 190 and 347 filings for each year under review to the document request, with the AEAT submission receipts.',
      resolvingDocument:
        'Modelos 111, 190 y 347 presentados, con justificante de presentación de la AEAT',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'document_requests', computed: { outstanding: outstanding.length } }],
    },
  ];
};

// ---------------------------------------------------------------------------
// G5 — lift compliance documents
// ---------------------------------------------------------------------------

export const G5_liftCompliance: Rule = async ({ cid, client, today }) => {
  const res = await client.query(
    `select
       (select count(*)::int from public.works_packages w
         where w.community_id = $1 and w.code = 'ELEVATOR') as lift_packages,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and v.category_code in ('ELEV_INSTALL', 'ELEV_CIVIL')) as lift_invoices,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and v.category_code = 'ELEV_MAINT') as maintenance_invoices,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and v.category_code = 'ELEV_INSPECT') as inspection_invoices,
       (select count(*)::int from public.documents d
         where d.community_id = $1 and d.doc_type = 'declaracio_responsable_ascensor') as ce_documents,
       (select coalesce(json_agg(json_build_object(
                 'id', s.id, 'vendor_party_id', s.vendor_party_id, 'label', s.label,
                 'started_on', s.started_on::text)), '[]'::json)
          from public.recurring_services s
         where s.community_id = $1 and s.category_code = 'ELEV_MAINT') as maintainers,
       (select coalesce(json_agg(json_build_object(
                 'party_id', p.id, 'status', c.status, 'checked_on', c.fetched_at::date::text)), '[]'::json)
          from public.parties p
          join lateral (
            select c2.status, c2.fetched_at from public.external_checks c2
             where c2.community_id = $1 and c2.check_type in ('rasic', 'rasic_manual')
               and c2.subject_key = p.id::text
             order by c2.fetched_at desc limit 1
          ) c on true
         where p.community_id = $1
           and exists (select 1 from public.invoices v
                        where v.vendor_party_id = p.id and v.community_id = $1
                          and v.category_code in ('ELEV_INSTALL', 'ELEV_MAINT'))) as lift_vendor_checks`,
    [cid],
  );
  const row = (res.rows[0] as Record<string, unknown> | undefined) ?? {};
  const liftPresent =
    Number(row.lift_packages ?? 0) > 0 ||
    Number(row.lift_invoices ?? 0) > 0 ||
    Number(row.maintenance_invoices ?? 0) > 0;
  if (!liftPresent) return [];

  const hits: RuleHit[] = [];
  const maintainers = (row.maintainers as Array<Record<string, unknown>> | null) ?? [];
  const vendorChecks = (row.lift_vendor_checks as Array<Record<string, unknown>> | null) ?? [];
  const evidence = [
    { label: 'lift_documents', computed: { ce_documents: Number(row.ce_documents ?? 0) } },
  ];

  if (Number(row.ce_documents ?? 0) === 0) {
    hits.push({
      ruleCode: 'G5',
      severity: 1,
      eventKey: `community:${cid}:lift_ce_declaration`,
      fingerprint: fp('G5', cid, 'ce'),
      entityType: 'community',
      entityId: cid,
      actDateLast: today,
      computed: {
        lift_invoices: Number(row.lift_invoices ?? 0),
        maintenance_invoices: Number(row.maintenance_invoices ?? 0),
      },
      summaryEs:
        'No se ha localizado en el expediente la declaración de conformidad ni el registro de puesta en servicio del ascensor. Procede solicitarlos.',
      summaryEn:
        'No declaration of conformity or commissioning registration for the lift has been located in the file. They should be requested.',
      innocentExplanations: [
        'The lift may not have been commissioned yet, the works having been suspended.',
        'The dossier is normally held by the installer and handed over at reception.',
      ],
      nextCheck:
        'Ask the installer, through the administrator, for the CE declaration and the Generalitat registration number.',
      resolvingDocument:
        'Declaración CE de conformidad; número de registro de puesta en servicio (Generalitat)',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence,
    });
  }

  const maintainerNotRegistered = vendorChecks.filter(
    (c) => String(c.status ?? '') === 'not_found',
  );
  for (const c of maintainerNotRegistered) {
    const partyId = String(c.party_id);
    hits.push({
      ruleCode: 'G5',
      severity: 2,
      eventKey: `party:${partyId}:rasic_absent`,
      fingerprint: fp('G5', partyId, 'rasic'),
      entityType: 'party',
      entityId: partyId,
      actDateLast: iso(c.checked_on) ?? today,
      computed: {
        register: 'RASIC',
        checked_on: iso(c.checked_on),
        role: 'lift installer or maintainer',
      },
      summaryEs:
        'No se ha localizado inscripción en el RASIC de la empresa que instala o mantiene el ascensor. Verificar.',
      summaryEn:
        'No RASIC entry located for the company installing or maintaining the lift. Verify.',
      innocentExplanations: [
        'The dataset identifier and column names of the register are still to verify; a negative result may be an artefact of the query.',
        'The registration may be held by a group company or by the manufacturer.',
      ],
      nextCheck: 'Ask for the RASIC registration number and check it in the register.',
      resolvingDocument: 'Número de inscripción RASIC de la empresa conservadora',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'rasic_check', computed: { party_id: partyId } }],
    });
  }

  if (Number(row.maintenance_invoices ?? 0) > 0 && Number(row.inspection_invoices ?? 0) === 0) {
    hits.push({
      ruleCode: 'G5',
      severity: 1,
      eventKey: `community:${cid}:lift_oca_inspection`,
      fingerprint: fp('G5', cid, 'oca'),
      entityType: 'community',
      entityId: cid,
      actDateLast: today,
      computed: {
        maintenance_invoices: Number(row.maintenance_invoices ?? 0),
        inspection_invoices: 0,
        maintainers_on_file: maintainers.length,
      },
      summaryEs:
        'Constan facturas de mantenimiento del ascensor pero ninguna de inspección periódica por organismo de control. Verificar la periodicidad aplicable.',
      summaryEn:
        'Lift maintenance invoices are on file but none from a control body for the periodic inspection. Verify the applicable periodicity.',
      innocentExplanations: [
        'The periodicity depends on the number of stops and dwellings served; the inspection may not be due within the period under review.',
        'The inspection may be invoiced to the maintainer and passed on inside the maintenance fee.',
        'A newly commissioned lift starts its inspection cycle later.',
      ],
      nextCheck:
        'Ask for the last periodic inspection report and the certificate issued by the control body.',
      resolvingDocument: 'Acta de inspección periódica del organismo de control (OCA)',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence,
    });
  }
  return hits;
};

// ---------------------------------------------------------------------------
// G6 — health and safety on site
// ---------------------------------------------------------------------------

export const G6_healthAndSafety: Rule = async ({ cid, client, today }) => {
  const res = await client.query(
    `select
       (select coalesce(sum(v.total), 0) from public.invoices v
         where v.community_id = $1 and v.category_code in ('CAE_PRL', 'HS_COORD')) as prl_billed,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and v.category_code in ('CAE_PRL', 'HS_COORD')) as prl_invoices,
       (select count(*)::int from public.documents d
         where d.community_id = $1 and d.doc_type = 'full_encarrec') as appointment_documents,
       (select count(distinct v.vendor_party_id)::int from public.invoices v
         where v.community_id = $1 and v.works_package_id is not null) as contractors_on_site,
       (select min(v.fecha_expedicion)::text from public.invoices v
         where v.community_id = $1 and v.category_code in ('CAE_PRL', 'HS_COORD')) as first_prl_invoice`,
    [cid],
  );
  const row = (res.rows[0] as Record<string, unknown> | undefined) ?? {};
  const billed = money(row.prl_billed);
  const invoices = Number(row.prl_invoices ?? 0);
  const appointments = Number(row.appointment_documents ?? 0);
  const contractors = Number(row.contractors_on_site ?? 0);
  if (invoices === 0 || appointments > 0) return [];

  const severity: 1 | 2 = contractors > 1 ? 2 : 1;
  return [
    {
      ruleCode: 'G6',
      severity,
      eventKey: `community:${cid}:hs_coordination_documents`,
      fingerprint: fp('G6', cid, 'coordination'),
      entityType: 'community',
      entityId: cid,
      amountAtStake: billed,
      actDateFirst: iso(row.first_prl_invoice),
      actDateLast: today,
      computed: {
        prl_billed: billed,
        prl_invoices: invoices,
        appointment_documents: appointments,
        contractors_on_site: contractors,
      },
      summaryEs:
        `Se ha facturado coordinación de actividades empresariales o de seguridad y salud por ${fmtEur(billed)} y no consta en el ` +
        'expediente el nombramiento del coordinador ni el plan de seguridad. Procede solicitarlos.',
      summaryEn:
        `Contractor coordination or health-and-safety services were billed for ${fmtEur(billed)} and neither the coordinator’s ` +
        'appointment nor the safety plan is in the file. They should be requested.',
      innocentExplanations: [
        'With a single contractor on site no coordinator is required; the service billed may be contractor coordination of a different kind.',
        'The appointment and the plan are held by the coordinator or by the contractor and are rarely circulated to owners.',
        'The documents may exist under a document class that has not been grouped yet.',
      ],
      nextCheck:
        'Ask for the coordinator’s appointment (full d’encàrrec), the approved safety plan and the work-centre opening notice.',
      resolvingDocument:
        'Nombramiento del coordinador de seguridad y salud; plan de seguridad aprobado; apertura de centro de trabajo',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'prl_invoices', computed: { invoices, billed } }],
    },
  ];
};

// ---------------------------------------------------------------------------
// G7 — technical building inspection (ITE)
// ---------------------------------------------------------------------------

export const G7_ite: Rule = async ({ cid, client, today, param }) => {
  const buildingYear = await param('building_year');
  const res = await client.query(
    `select
       (select count(*)::int from public.documents d
         where d.community_id = $1 and d.doc_type = 'ite') as ite_documents,
       (select count(*)::int from public.permits pm
         where pm.community_id = $1 and pm.tipus = 'ite') as ite_permits,
       (select count(*)::int from public.invoices v
         where v.community_id = $1 and v.category_code = 'ITE') as ite_invoices,
       (select count(*)::int from public.subsidies s where s.community_id = $1) as subsidies`,
    [cid],
  );
  const row = (res.rows[0] as Record<string, unknown> | undefined) ?? {};
  const documents = Number(row.ite_documents ?? 0) + Number(row.ite_permits ?? 0);
  if (documents > 0) return [];
  if (buildingYear !== null && buildingYear >= 1965) return [];

  return [
    {
      ruleCode: 'G7',
      severity: 1,
      eventKey: `community:${cid}:ite_absent`,
      fingerprint: fp('G7', cid, 'ite'),
      entityType: 'community',
      entityId: cid,
      actDateLast: today,
      computed: {
        ite_documents: documents,
        ite_invoices: Number(row.ite_invoices ?? 0),
        building_year_parameter: buildingYear,
        subsidies_on_file: Number(row.subsidies ?? 0),
      },
      summaryEs:
        'No consta en el expediente el certificado de aptitud ni el informe de la inspección técnica del edificio. Procede solicitarlo.' +
        (buildingYear === null
          ? ' El año de construcción no está registrado como parámetro; la obligación se comprueba con esa fecha.'
          : ''),
      summaryEn:
        'Neither the certificate of aptitude nor the technical building inspection report is in the file. It should be requested.' +
        (buildingYear === null
          ? ' The year of construction is not recorded as a parameter; the duty depends on that date.'
          : ''),
      innocentExplanations: [
        'The inspection may have been carried out under a previous administrator and the report kept outside the accounts.',
        'The certificate is issued by the Generalitat and may be held only in electronic form.',
        'Works may have been decided for reasons other than an inspection deficiency (accessibility, for instance).',
      ],
      nextCheck:
        'Ask for the ITE report and the certificate of aptitude, and check whether the works under review appear in its list of deficiencies.',
      resolvingDocument:
        'Informe de la inspección técnica del edificio; certificado de aptitud de la Generalitat',
      independence: 0.7,
      extractionQuality: RECORD_QUALITY,
      evidence: [{ label: 'ite_documents', computed: { found: documents } }],
    },
  ];
};

export const M5_RULES: Record<string, Rule> = {
  B1: B1_companyAge,
  B2: B2_addressCoincidence,
  B3: B3_surnameCoincidence,
  B7: B7_registryRegistration,
  B8: B8_vendorConcentration,
  B9: B9_impliedVolume,
  A10: A10_quoteAuthenticity,
  G2: G2_taxFilings,
  G5: G5_liftCompliance,
  G6: G6_healthAndSafety,
  G7: G7_ite,
};
