/**
 * Distribution gates.
 *
 * A finding is a discrepancy to verify. Before it may leave the review screen it has to pass
 * five independent gates, all of them pure functions over data already stored, so a pack can
 * be re-derived and audited:
 *
 *  (a) right of reply   — no Tier-1/Tier-2 item enters a distributed pack until the
 *                         counterparty has been asked and the workflow has moved on;
 *  (b) legal citation   — an article number prints only from a `statutory` or `subsidy_bases`
 *                         rule and only once every primary text it cites sits archived;
 *  (c) tier             — Tier 1 needs four eyes or machine two-source fields; a single
 *                         reviewer's human confirmation caps the item at Tier 2;
 *  (d) base rate        — rules that fire in almost every small community stay in the annex;
 *  (e) scores           — `hit_score`, `specificity`, `independence` and `confidence` never
 *                         appear in narrative; they go to the data room with a methodology note.
 *
 * The loaders at the bottom read exactly what the gates need and nothing else.
 */
import type pg from 'pg';
import type { Lang } from './i18n.ts';
import { m6Strings } from './i18n.ts';

export type FindingStatus =
  | 'new'
  | 'in_review'
  | 'sent_for_explanation'
  | 'explained'
  | 'confirmed_discrepancy'
  | 'needs_document'
  | 'dismissed_fp';
export type Tier = 'T1' | 'T2' | 'T3';
export type LegalBasisKind = 'statutory' | 'subsidy_bases' | 'professional_standard' | 'internal_control';

/** Workflow states a finding must have reached before it may be circulated. */
export const DISTRIBUTABLE_STATUSES: readonly FindingStatus[] = ['explained', 'confirmed_discrepancy', 'needs_document'];

/** Only these bases may ever print an article number. */
export const CITABLE_BASIS_KINDS: readonly LegalBasisKind[] = ['statutory', 'subsidy_bases'];

/** Never printed in narrative; the data room carries them with the methodology note. */
export const SCORE_FIELDS = ['hit_score', 'specificity', 'independence', 'confidence'] as const;

/** The score fields plus the input the reader could reconstruct a score from. */
export const DATA_ROOM_ONLY_FIELDS: readonly string[] = [...SCORE_FIELDS, 'extraction_quality'];

/** Machine two-source thresholds that let an item stand at Tier 1 without a second person. */
export const T1_EXTRACTION_QUALITY_MIN = 0.99;
export const T1_INDEPENDENCE_MIN = 1.0;

/**
 * A dated refusal counts as a reply for the gate: the counterparty was asked and declined.
 * Matched against the reason of the latest review row, in Spanish, Catalan and English.
 */
const REFUSAL_RE =
  /(refus\w*|declin\w*|denegad\w*|deniega\w*|negativa|se\s+niega|es\s+nega|rebutj\w*|no\s+facilit\w*|no\s+atiende|no\s+aporta|sin\s+respuesta|no\s+reply|no\s+answer|declined\s+to\s+answer)/i;

/** Whether the latest review reason records a dated refusal to answer. */
export function refusalRecorded(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return REFUSAL_RE.test(reason);
}

// ---------------------------------------------------------------------------
// (a) right of reply
// ---------------------------------------------------------------------------

export interface ReplyGateInput {
  status: FindingStatus;
  explanationRequestedOn: string | null;
  /** reason of the latest `finding_reviews` row, where a refusal may be recorded */
  latestReviewReason?: string | null;
}

export type ReplyGateReason = 'ok' | 'status_not_reached' | 'no_request_recorded';

export interface ReplyGateResult {
  ok: boolean;
  reason: ReplyGateReason;
}

/**
 * A finding may enter a distributed pack's T1/T2 sections only when the workflow has reached
 * `explained`, `confirmed_discrepancy` or `needs_document` **and** the request for
 * clarifications is dated (or the counterparty's refusal is recorded). Everything else is
 * counted, never described.
 */
export function replyGate(input: ReplyGateInput): ReplyGateResult {
  if (!DISTRIBUTABLE_STATUSES.includes(input.status)) return { ok: false, reason: 'status_not_reached' };
  if (input.explanationRequestedOn) return { ok: true, reason: 'ok' };
  if (refusalRecorded(input.latestReviewReason)) return { ok: true, reason: 'ok' };
  return { ok: false, reason: 'no_request_recorded' };
}

// ---------------------------------------------------------------------------
// (b) legal citation
// ---------------------------------------------------------------------------

export interface LegalCitationInput {
  legalBasisKind: LegalBasisKind;
  articleRefs: readonly string[];
  legalSourceIds: readonly string[];
}

export type LegalCitationReason = 'ok' | 'no_articles' | 'basis_kind_not_citable' | 'source_not_archived';

export interface LegalCitationResult {
  /** true only when every article may be printed as researched */
  printable: boolean;
  /** the article strings to print, empty when the gate is closed */
  articles: string[];
  /** what to print instead when the gate is closed */
  placeholder: string | null;
  /** source ids that still lack an archived primary copy */
  missingSources: string[];
  reason: LegalCitationReason;
}

/**
 * An article number prints only from a statutory or subsidy-bases rule, and only when every
 * `legal_source_ids` entry has an archived primary copy. A rule with no source id at all is
 * treated as unarchived: the register has nothing to point at.
 */
export function legalCitationGate(input: LegalCitationInput, archived: ReadonlySet<string>, lang: Lang): LegalCitationResult {
  const t = m6Strings(lang);
  const articles = [...input.articleRefs];
  if (articles.length === 0) {
    return { printable: false, articles: [], placeholder: null, missingSources: [], reason: 'no_articles' };
  }
  if (!CITABLE_BASIS_KINDS.includes(input.legalBasisKind)) {
    return { printable: false, articles: [], placeholder: t.gateBasisNotCitable, missingSources: [], reason: 'basis_kind_not_citable' };
  }
  const missing = input.legalSourceIds.length === 0 ? ['(none declared)'] : input.legalSourceIds.filter((id) => !archived.has(id));
  if (missing.length > 0) {
    return { printable: false, articles: [], placeholder: t.gateLegalPending, missingSources: missing, reason: 'source_not_archived' };
  }
  return { printable: true, articles, placeholder: null, missingSources: [], reason: 'ok' };
}

// ---------------------------------------------------------------------------
// (c) tier
// ---------------------------------------------------------------------------

export interface TierGateInput {
  tier: Tier;
  fourEyesOk: boolean;
  extractionQuality: number | null;
  independence: number | null;
}

export interface TierGateResult {
  tier: Tier;
  capped: boolean;
  reason: 'ok' | 'capped_to_t2_single_reviewer';
}

/**
 * Tier 1 requires a second pair of eyes or machine two-source fields on an issuer-direct leg.
 * A single reviewer's human confirmation supports Tier 2 at most.
 */
export function tierGate(input: TierGateInput): TierGateResult {
  if (input.tier !== 'T1') return { tier: input.tier, capped: false, reason: 'ok' };
  const machineTwoSource =
    (input.extractionQuality ?? 0) >= T1_EXTRACTION_QUALITY_MIN && (input.independence ?? 0) >= T1_INDEPENDENCE_MIN;
  if (input.fourEyesOk || machineTwoSource) return { tier: 'T1', capped: false, reason: 'ok' };
  return { tier: 'T2', capped: true, reason: 'capped_to_t2_single_reviewer' };
}

// ---------------------------------------------------------------------------
// (d) base-rate rules
// ---------------------------------------------------------------------------

export interface BaseRateGateResult {
  annexOnly: boolean;
  tier: Tier;
}

/** Base-rate rules (`rules.never_t1t2`) are context inside the annex and nothing else. */
export function baseRateGate(input: { neverT1T2: boolean; tier: Tier }): BaseRateGateResult {
  if (input.neverT1T2) return { annexOnly: true, tier: 'T3' };
  return { annexOnly: input.tier === 'T3', tier: input.tier };
}

// ---------------------------------------------------------------------------
// (e) scores
// ---------------------------------------------------------------------------

/** Drop every score field from a record before it reaches a rendered pack. */
export function stripScores<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (DATA_ROOM_ONLY_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Which score fields a text still carries; empty means the text is safe to distribute. */
export function scoreFieldsPresent(text: string): string[] {
  return SCORE_FIELDS.filter((f) => text.includes(f));
}

// ---------------------------------------------------------------------------
// Composite: applying every gate to a run's findings
// ---------------------------------------------------------------------------

export interface RuleCatalogEntry {
  code: string;
  family: string;
  version: number;
  nameEs: string;
  nameEn: string;
  description: string | null;
  legalBasisKind: LegalBasisKind;
  attribution: string;
  articleRefs: string[];
  legalSourceIds: string[];
  neverT1T2: boolean;
  worklistEligible: boolean;
  enabledInV1: boolean;
  milestone: string | null;
  specificity: number;
}

export interface ReplyAttachment {
  fileId: string;
  sha256: string | null;
  originalName: string | null;
}

export interface FindingReview {
  toStatus: FindingStatus;
  fromStatus: FindingStatus | null;
  reason: string | null;
  createdAt: string;
  attachments: ReplyAttachment[];
}

export interface FindingEvidenceRow {
  label: string;
  documentId: string | null;
  pageId: string | null;
  pageNo: number | null;
  fileSha256: string | null;
  cropStatus: string | null;
  quote: string | null;
  runId: string | null;
  parameterVersion: number | null;
  benchmarkRecordId: string | null;
  bankTransactionId: string | null;
  resolutionId: string | null;
  computed: Record<string, unknown>;
}

export interface GateFinding {
  id: string;
  fingerprint: string;
  ruleCode: string;
  ruleVersion: number;
  tier: Tier;
  severity: number;
  status: FindingStatus;
  explanationRequestedOn: string | null;
  explanationReceivedOn: string | null;
  fourEyesOk: boolean;
  extractionQuality: number | null;
  independence: number | null;
  specificity: number | null;
  confidence: number | null;
  hitScore: number | null;
  amountAtStake: number | null;
  fiscalYear: number | null;
  actDateFirst: string | null;
  actDateLast: string | null;
  summaryEs: string;
  summaryEn: string;
  innocentExplanations: string[];
  nextCheck: string | null;
  resolvingDocument: string | null;
  computed: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  worksPackageId: string | null;
  rule: RuleCatalogEntry;
  reviews: FindingReview[];
  evidence: FindingEvidenceRow[];
}

export interface GatedFinding {
  finding: GateFinding;
  /** tier after the tier and base-rate gates */
  effectiveTier: Tier;
  tierCapped: boolean;
  reply: ReplyGateResult;
  legal: LegalCitationResult;
  annexOnly: boolean;
  /** verbatim reply, when one was received */
  replyText: string | null;
  replyReceivedOn: string | null;
  replyAttachments: ReplyAttachment[];
  refusalRecorded: boolean;
}

export interface GateStats {
  findings_total: number;
  findings_distributed: number;
  withheld_pending_reply: number;
  withheld_pending_legal_source: number;
  annex_only: number;
  tier_capped: number;
  pending_by_status: Record<string, number>;
  /** T1/T2 findings still in `new` or `in_review`: the auditor pack refuses on these */
  unreviewed_t1t2: number;
}

export interface GateOutcome {
  /** T1/T2 items that passed every gate, in deterministic order */
  distributed: GatedFinding[];
  /** T1/T2 items withheld because the right of reply is not complete */
  pendingReply: GatedFinding[];
  /** T3 and base-rate items: annex only */
  annex: GatedFinding[];
  stats: GateStats;
}

/** Deterministic pack order: fiscal year, then rule code, then fingerprint. */
export function compareFindings(a: GateFinding, b: GateFinding): number {
  const ay = a.fiscalYear ?? 9999;
  const by = b.fiscalYear ?? 9999;
  if (ay !== by) return ay - by;
  if (a.ruleCode !== b.ruleCode) return a.ruleCode < b.ruleCode ? -1 : 1;
  if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
  return 0;
}

function latestReview(f: GateFinding): FindingReview | null {
  if (f.reviews.length === 0) return null;
  return [...f.reviews].sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0))[f.reviews.length - 1] ?? null;
}

/** The counterparty's own words, taken from the review that recorded the answer. */
function replyOf(f: GateFinding): { text: string | null; on: string | null; attachments: ReplyAttachment[] } {
  const answered = [...f.reviews]
    .filter((r) => r.toStatus === 'explained' || r.toStatus === 'confirmed_discrepancy' || r.toStatus === 'needs_document')
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
  const last = answered[answered.length - 1];
  if (!last) return { text: null, on: null, attachments: [] };
  return { text: last.reason, on: f.explanationReceivedOn ?? last.createdAt.slice(0, 10), attachments: last.attachments };
}

/** Run every gate over a run's findings and produce the pack's three buckets and its statistics. */
export function applyGates(findings: readonly GateFinding[], archived: ReadonlySet<string>, lang: Lang): GateOutcome {
  const distributed: GatedFinding[] = [];
  const pendingReply: GatedFinding[] = [];
  const annex: GatedFinding[] = [];
  const pendingByStatus: Record<string, number> = {};
  let withheldLegal = 0;
  let capped = 0;
  let unreviewed = 0;

  for (const f of [...findings].sort(compareFindings)) {
    const tg = tierGate({
      tier: f.tier,
      fourEyesOk: f.fourEyesOk,
      extractionQuality: f.extractionQuality,
      independence: f.independence,
    });
    if (tg.capped) capped++;
    const br = baseRateGate({ neverT1T2: f.rule.neverT1T2, tier: tg.tier });
    const legal = legalCitationGate(
      { legalBasisKind: f.rule.legalBasisKind, articleRefs: f.rule.articleRefs, legalSourceIds: f.rule.legalSourceIds },
      archived,
      lang,
    );
    if (legal.reason === 'source_not_archived') withheldLegal++;
    const review = latestReview(f);
    const reply = replyGate({
      status: f.status,
      explanationRequestedOn: f.explanationRequestedOn,
      latestReviewReason: review?.reason ?? null,
    });
    const answered = replyOf(f);
    const gated: GatedFinding = {
      finding: f,
      effectiveTier: br.tier,
      tierCapped: tg.capped,
      reply,
      legal,
      annexOnly: br.annexOnly,
      replyText: answered.text,
      replyReceivedOn: answered.on,
      replyAttachments: answered.attachments,
      refusalRecorded: refusalRecorded(review?.reason ?? null),
    };

    if (br.annexOnly) {
      annex.push(gated);
      continue;
    }
    if (f.status === 'dismissed_fp') {
      annex.push(gated);
      continue;
    }
    if (f.status === 'new' || f.status === 'in_review') unreviewed++;
    if (reply.ok) distributed.push(gated);
    else {
      pendingReply.push(gated);
      pendingByStatus[f.status] = (pendingByStatus[f.status] ?? 0) + 1;
    }
  }

  return {
    distributed,
    pendingReply,
    annex,
    stats: {
      findings_total: findings.length,
      findings_distributed: distributed.length,
      withheld_pending_reply: pendingReply.length,
      withheld_pending_legal_source: withheldLegal,
      annex_only: annex.length,
      tier_capped: capped,
      pending_by_status: pendingByStatus,
      unreviewed_t1t2: unreviewed,
    },
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (v == null ? null : String(v));
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => (v == null ? null : String(v instanceof Date ? v.toISOString() : v));

/** Ids of legal sources with an archived primary copy. This set is the citation gate. */
export async function loadArchivedLegalSources(client: pg.PoolClient): Promise<Set<string>> {
  const res = await client.query<{ id: string }>('select id from public.legal_sources where archived_at is not null order by id');
  return new Set(res.rows.map((r) => r.id));
}

export interface LegalSourceRegisterRow {
  id: string;
  title: string | null;
  url: string | null;
  storagePath: string | null;
  sha256: string | null;
  archived: boolean;
  archivedAt: string | null;
  citedBy: string[];
}

/**
 * Every source id referenced by a rule, with its archive state. This is the verification
 * register readout: an id with `archived = false` blocks every article of every rule citing it.
 */
export async function loadLegalSourceRegister(client: pg.PoolClient): Promise<LegalSourceRegisterRow[]> {
  const res = await client.query<Record<string, unknown>>(
    `with referenced as (
       select distinct unnest(legal_source_ids) as id from public.rules where enabled_in_v1
     ), cited as (
       select unnest(r.legal_source_ids) as id, r.code from public.rules r where r.enabled_in_v1
     )
     select ref.id,
            ls.title, ls.url, ls.storage_path, ls.sha256, ls.archived_at,
            (select array_agg(c.code order by c.code) from cited c where c.id = ref.id) as cited_by
       from referenced ref
       left join public.legal_sources ls on ls.id = ref.id
      order by ref.id`,
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    title: str(r.title),
    url: str(r.url),
    storagePath: str(r.storage_path),
    sha256: str(r.sha256),
    archived: r.archived_at != null,
    archivedAt: iso(r.archived_at),
    citedBy: (r.cited_by as string[] | null) ?? [],
  }));
}

/** The rule catalogue as the packs need it (names, basis, citations, flags). */
export async function loadRuleCatalogue(client: pg.PoolClient): Promise<Map<string, RuleCatalogEntry>> {
  const res = await client.query<Record<string, unknown>>(
    `select code, family, version, name_es, name_en, description, legal_basis_kind::text as legal_basis_kind,
            attribution::text as attribution, article_refs, legal_source_ids, never_t1t2, worklist_eligible,
            enabled_in_v1, milestone, specificity_prior
       from public.rules order by code`,
  );
  const out = new Map<string, RuleCatalogEntry>();
  for (const r of res.rows) {
    out.set(String(r.code), {
      code: String(r.code),
      family: String(r.family),
      version: Number(r.version),
      nameEs: String(r.name_es),
      nameEn: String(r.name_en),
      description: str(r.description),
      legalBasisKind: String(r.legal_basis_kind) as LegalBasisKind,
      attribution: String(r.attribution),
      articleRefs: (r.article_refs as string[] | null) ?? [],
      legalSourceIds: (r.legal_source_ids as string[] | null) ?? [],
      neverT1T2: Boolean(r.never_t1t2),
      worklistEligible: Boolean(r.worklist_eligible),
      enabledInV1: Boolean(r.enabled_in_v1),
      milestone: str(r.milestone),
      specificity: Number(r.specificity_prior ?? 0.7),
    });
  }
  return out;
}

/**
 * Findings of a community with their rule metadata, review history (including the verbatim
 * reply and its attachments by hash) and evidence rows.
 */
export async function loadGateFindings(client: pg.PoolClient, cid: string): Promise<GateFinding[]> {
  const catalogue = await loadRuleCatalogue(client);
  const res = await client.query<Record<string, unknown>>(
    `select f.id, f.fingerprint, f.rule_code, f.rule_version, f.tier::text as tier, f.severity, f.status::text as status,
            f.explanation_requested_on, f.explanation_received_on, f.four_eyes_ok,
            f.extraction_quality, f.independence, f.specificity, f.confidence, f.hit_score,
            f.amount_at_stake, f.fiscal_year, f.act_date_first, f.act_date_last,
            f.summary_es, f.summary_en, f.innocent_explanations, f.next_check, f.resolving_document,
            f.computed, f.entity_type, f.entity_id, f.works_package_id
       from public.findings f
      where f.community_id = $1
      order by coalesce(f.fiscal_year, 9999), f.rule_code, f.fingerprint`,
    [cid],
  );
  const ids = res.rows.map((r) => String(r.id));
  const reviewsByFinding = new Map<string, FindingReview[]>();
  const evidenceByFinding = new Map<string, FindingEvidenceRow[]>();
  if (ids.length > 0) {
    const rev = await client.query<Record<string, unknown>>(
      `select fr.finding_id, fr.from_status::text as from_status, fr.to_status::text as to_status, fr.reason,
              fr.attachment_file_ids, fr.created_at
         from public.finding_reviews fr where fr.finding_id = any($1::uuid[])
        order by fr.created_at, fr.id`,
      [ids],
    );
    const attachmentIds = new Set<string>();
    for (const r of rev.rows) for (const a of ((r.attachment_file_ids as string[] | null) ?? [])) attachmentIds.add(a);
    const files = new Map<string, ReplyAttachment>();
    if (attachmentIds.size > 0) {
      const fr = await client.query<Record<string, unknown>>(
        'select id, sha256, original_name from public.files where id = any($1::uuid[])',
        [[...attachmentIds]],
      );
      for (const f of fr.rows) files.set(String(f.id), { fileId: String(f.id), sha256: str(f.sha256), originalName: str(f.original_name) });
    }
    for (const r of rev.rows) {
      const fid = String(r.finding_id);
      const list = reviewsByFinding.get(fid) ?? [];
      list.push({
        fromStatus: r.from_status == null ? null : (String(r.from_status) as FindingStatus),
        toStatus: String(r.to_status) as FindingStatus,
        reason: str(r.reason),
        createdAt: iso(r.created_at) ?? '',
        attachments: ((r.attachment_file_ids as string[] | null) ?? []).map(
          (a) => files.get(a) ?? { fileId: a, sha256: null, originalName: null },
        ),
      });
      reviewsByFinding.set(fid, list);
    }

    const ev = await client.query<Record<string, unknown>>(
      `select fe.finding_id, fe.label, fe.document_id, fe.page_id, fe.crop_status::text as crop_status, fe.quote,
              coalesce(fe.file_sha256, fi.sha256) as file_sha256, p.page_no, fe.run_id, fe.parameter_version,
              fe.benchmark_record_id, fe.bank_transaction_id, fe.resolution_id, fe.computed
         from public.finding_evidence fe
         left join public.pages p on p.id = fe.page_id
         left join public.files fi on fi.id = p.file_id
        where fe.finding_id = any($1::uuid[])
        order by fe.finding_id, fe.label, fe.id`,
      [ids],
    );
    for (const r of ev.rows) {
      const fid = String(r.finding_id);
      const list = evidenceByFinding.get(fid) ?? [];
      list.push({
        label: String(r.label),
        documentId: str(r.document_id),
        pageId: str(r.page_id),
        pageNo: r.page_no == null ? null : Number(r.page_no),
        fileSha256: str(r.file_sha256),
        cropStatus: str(r.crop_status),
        quote: str(r.quote),
        runId: str(r.run_id),
        parameterVersion: r.parameter_version == null ? null : Number(r.parameter_version),
        benchmarkRecordId: str(r.benchmark_record_id),
        bankTransactionId: str(r.bank_transaction_id),
        resolutionId: str(r.resolution_id),
        computed: (r.computed as Record<string, unknown> | null) ?? {},
      });
      evidenceByFinding.set(fid, list);
    }
  }

  return res.rows.map((r) => {
    const code = String(r.rule_code);
    const rule = catalogue.get(code);
    if (!rule) throw new Error(`finding ${String(r.id)} cites rule ${code}, which is not in the catalogue`);
    const explanations = r.innocent_explanations;
    return {
      id: String(r.id),
      fingerprint: String(r.fingerprint),
      ruleCode: code,
      ruleVersion: Number(r.rule_version),
      tier: (str(r.tier) ?? 'T3') as Tier,
      severity: Number(r.severity),
      status: String(r.status) as FindingStatus,
      explanationRequestedOn: r.explanation_requested_on == null ? null : String(r.explanation_requested_on).slice(0, 10),
      explanationReceivedOn: r.explanation_received_on == null ? null : String(r.explanation_received_on).slice(0, 10),
      fourEyesOk: Boolean(r.four_eyes_ok),
      extractionQuality: numOrNull(r.extraction_quality),
      independence: numOrNull(r.independence),
      specificity: numOrNull(r.specificity),
      confidence: numOrNull(r.confidence),
      hitScore: numOrNull(r.hit_score),
      amountAtStake: numOrNull(r.amount_at_stake),
      fiscalYear: r.fiscal_year == null ? null : Number(r.fiscal_year),
      actDateFirst: r.act_date_first == null ? null : String(r.act_date_first).slice(0, 10),
      actDateLast: r.act_date_last == null ? null : String(r.act_date_last).slice(0, 10),
      summaryEs: String(r.summary_es ?? ''),
      summaryEn: String(r.summary_en ?? ''),
      innocentExplanations: Array.isArray(explanations) ? (explanations as string[]) : [],
      nextCheck: str(r.next_check),
      resolvingDocument: str(r.resolving_document),
      computed: (r.computed as Record<string, unknown> | null) ?? {},
      entityType: str(r.entity_type),
      entityId: str(r.entity_id),
      worksPackageId: str(r.works_package_id),
      rule,
      reviews: reviewsByFinding.get(String(r.id)) ?? [],
      evidence: evidenceByFinding.get(String(r.id)) ?? [],
    };
  });
}
