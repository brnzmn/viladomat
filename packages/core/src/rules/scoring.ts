/**
 * Scoring of rule hits: confidence, event-key collapse, entity aggregation, tier
 * assignment and independence from provenance. Scores never print in narratives; they
 * order the worklist and gate tiers.
 */

/** Severity of a rule hit, 1 (observation) to 4. */
export type Severity = 1 | 2 | 3 | 4;

/** Tier label of a finding. */
export type Tier = 'T1' | 'T2' | 'T3';

/** One rule hit before aggregation. */
export interface Hit {
  /** Rule code, e.g. `D2`. */
  ruleCode: string;
  /** Rule family, e.g. `D` (payments) or `C` (invoice content). */
  family: string;
  severity: Severity;
  /** Field-level extraction quality in [0, 1] (Wilson lower bound of the audit sample). */
  extractionQuality: number;
  /** How specific the test is to the event in [0, 1]. */
  specificity: number;
  /** Independence of the evidence in [0, 1]; see {@link independenceFromProvenance}. */
  independence: number;
  /** Key of the underlying event; hits sharing it collapse to one. */
  eventKey: string;
  /** Entity the hit is attached to (vendor, payment, resolution, …). */
  entityType: string;
  entityId: string;
  /** Documents the hit rests on. */
  documentIds: string[];
  /** Money at stake, EUR. */
  amountAtStake?: number;
  /** Whether the hit may enter the review worklist. */
  worklistEligible: boolean;
  /** Base-rate or pattern rules that never support Tier 1 or Tier 2. */
  neverT1T2: boolean;
}

/** A hit that stands for one event, with the rule codes it absorbed. */
export interface CollapsedHit extends Hit {
  /** Rule codes of the other hits on the same event key (input order, deduplicated). */
  collapsedFrom: string[];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Confidence = extractionQuality × specificity × independence, each clamped to [0, 1]. */
export function confidence(
  hit: Pick<Hit, 'extractionQuality' | 'specificity' | 'independence'>,
): number {
  return clamp01(hit.extractionQuality) * clamp01(hit.specificity) * clamp01(hit.independence);
}

/** Hit score = severity × confidence. */
export function hitScore(hit: Hit): number {
  return hit.severity * confidence(hit);
}

/**
 * Collapse hits that share an `eventKey`: the hit with the highest severity survives
 * (ties → higher confidence, then input order) and records the rule codes it absorbed in
 * `collapsedFrom`. Hits with an empty event key are kept as they are. Output preserves the
 * input order of the surviving hits.
 */
export function collapseByEventKey(hits: readonly Hit[]): CollapsedHit[] {
  const groups = new Map<string, Hit[]>();
  const order: string[] = [];
  hits.forEach((hit, index) => {
    const key = hit.eventKey ? hit.eventKey : `#single-${index}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)?.push(hit);
  });
  const out: CollapsedHit[] = [];
  for (const key of order) {
    const group = groups.get(key) ?? [];
    let winner = group[0];
    if (!winner) continue;
    for (const candidate of group.slice(1)) {
      if (
        candidate.severity > winner.severity ||
        (candidate.severity === winner.severity && confidence(candidate) > confidence(winner))
      ) {
        winner = candidate;
      }
    }
    const absorbed: string[] = [];
    for (const h of group) {
      if (h === winner) continue;
      if (!absorbed.includes(h.ruleCode)) absorbed.push(h.ruleCode);
    }
    out.push({ ...winner, documentIds: [...winner.documentIds], collapsedFrom: absorbed });
  }
  return out;
}

/** Result of {@link aggregateEntity}. */
export interface EntityAggregate {
  /** Final score, capped at 8. */
  score: number;
  /** Weighted sum of the top four collapsed hit scores before the family multiplier. */
  baseScore: number;
  /** 1, 1.5 or 2. */
  familyMultiplier: number;
  /** Distinct families among the collapsed hits. */
  families: string[];
  /** Distinct documents among the collapsed hits. */
  distinctDocuments: number;
  /** Number of distinct events (collapsed hits). */
  distinctEvents: number;
  /** Sum of `amountAtStake` over collapsed hits with severity ≥ 3. */
  eurAtStake: number;
  /** The collapsed hits, sorted by hit score descending. */
  hits: CollapsedHit[];
}

/** Maximum entity score. */
export const ENTITY_SCORE_CAP = 8;

/**
 * Aggregate the hits of one entity: collapse by event key, then
 * `score = max + 0.5·2nd + 0.25·3rd + 0.125·4th` of the hit scores, multiplied by 1.5 when
 * the hits span ≥ 2 families or 2.0 when ≥ 3 families — in both cases only when the
 * collapsed hits rest on ≥ 2 distinct documents — and capped at {@link ENTITY_SCORE_CAP}.
 */
export function aggregateEntity(hits: readonly Hit[]): EntityAggregate {
  const collapsed = collapseByEventKey(hits).sort((a, b) => hitScore(b) - hitScore(a));
  const weights = [1, 0.5, 0.25, 0.125];
  let base = 0;
  collapsed.slice(0, 4).forEach((h, i) => {
    base += hitScore(h) * (weights[i] ?? 0);
  });
  const families = [...new Set(collapsed.map((h) => h.family))];
  const documents = new Set<string>();
  for (const h of collapsed) for (const d of h.documentIds) if (d) documents.add(d);
  let multiplier = 1;
  if (documents.size >= 2) {
    if (families.length >= 3) multiplier = 2;
    else if (families.length >= 2) multiplier = 1.5;
  }
  const eurAtStake = collapsed
    .filter((h) => h.severity >= 3)
    .reduce((acc, h) => acc + (h.amountAtStake ?? 0), 0);
  return {
    score: Math.min(ENTITY_SCORE_CAP, base * multiplier),
    baseScore: base,
    familyMultiplier: multiplier,
    families,
    distinctDocuments: documents.size,
    distinctEvents: collapsed.length,
    eurAtStake,
    hits: collapsed,
  };
}

/** Options for {@link assignTier}. */
export interface TierOptions {
  /** True when the supporting fields were confirmed by a single person rather than two readers. */
  humanConfirmedOnly?: boolean;
  /** True when at least one evidence leg is issuer-direct (independence 1.0). */
  issuerDirectLeg: boolean;
}

/**
 * Assign a tier to a set of hits on one finding/entity.
 *
 * - **T1**: one severity-4 hit with confidence ≥ 0.8, or two severity-≥3 hits from different
 *   families each with confidence ≥ 0.7; additionally requires an issuer-direct leg, machine
 *   two-source fields (`humanConfirmedOnly` false) and hits not marked `neverT1T2`.
 * - **T2**: any eligible (not `neverT1T2`) hit with severity ≥ 2 and confidence ≥ 0.5.
 * - **T3**: otherwise.
 *
 * Hits are collapsed by event key first, so one event firing several rules cannot count
 * as two independent hits.
 */
export function assignTier(hits: readonly Hit[], options: TierOptions): Tier {
  const eligible = collapseByEventKey(hits).filter((h) => !h.neverT1T2);
  if (eligible.length === 0) return 'T3';

  const strongS4 = eligible.some((h) => h.severity === 4 && confidence(h) >= 0.8);
  const s3Families = new Set(
    eligible.filter((h) => h.severity >= 3 && confidence(h) >= 0.7).map((h) => h.family),
  );
  const t1Evidence = strongS4 || s3Families.size >= 2;
  if (t1Evidence && options.issuerDirectLeg && !options.humanConfirmedOnly) return 'T1';

  const t2Evidence = eligible.some((h) => h.severity >= 2 && confidence(h) >= 0.5);
  return t2Evidence ? 'T2' : 'T3';
}

/** Independence values by provenance. */
export const INDEPENDENCE = Object.freeze({
  issuerDirect: 1.0,
  bankViaAdministrator: 0.85,
  singleDocument: 0.7,
});

/** Provenance steps recognised by {@link independenceFromProvenance}. */
export type ProvenanceStep =
  | 'bank'
  | 'public_registry'
  | 'vendor_direct'
  | 'administrator'
  | 'president'
  | 'owner'
  | 'lawyer'
  | 'photo'
  | 'printout'
  | 'photo_of_printout'
  | 'scan'
  | 'email'
  | (string & {});

/** Options for {@link independenceFromProvenance}. */
export interface IndependenceOptions {
  /** True when the vendor supplying the document has an open link finding (parameter). */
  vendorHasOpenLinkFinding?: boolean;
}

const ISSUER_ORIGINS: ReadonlySet<string> = new Set(['bank', 'public_registry', 'vendor_direct']);
const DEGRADING_STEPS: ReadonlySet<string> = new Set(['photo', 'printout', 'photo_of_printout']);

/**
 * Independence of an evidence leg from its provenance chain.
 *
 * - 1.0 issuer-direct: chain is just `bank`, `public_registry` or `vendor_direct` and the
 *   document was obtained directly by the system/reviewer (`obtainedDirectly`). A bank export
 *   whose `holderKind` is not the community (e.g. an administrator's pooled account) is
 *   0.85; a vendor-direct document is 0.7 while the vendor has an open link finding.
 * - 0.85 bank-issued via the administrator: origin `bank`, at least one intermediary and no
 *   photo/printout step.
 * - 0.7 otherwise: photos of printouts, single documents, administrator-origin material,
 *   unknown chains.
 */
export function independenceFromProvenance(
  chain: readonly ProvenanceStep[],
  obtainedDirectly: boolean,
  holderKind?: string,
  options: IndependenceOptions = {},
): number {
  const origin = chain[0];
  if (!origin) return INDEPENDENCE.singleDocument;
  const hasDegradingStep = chain.some((s) => DEGRADING_STEPS.has(s));
  const intermediaries = chain.slice(1).filter((s) => !DEGRADING_STEPS.has(s) && s !== 'scan');

  if (
    ISSUER_ORIGINS.has(origin) &&
    obtainedDirectly &&
    intermediaries.length === 0 &&
    !hasDegradingStep
  ) {
    if (origin === 'vendor_direct' && options.vendorHasOpenLinkFinding)
      return INDEPENDENCE.singleDocument;
    if (origin === 'bank' && holderKind && holderKind !== 'community')
      return INDEPENDENCE.bankViaAdministrator;
    return INDEPENDENCE.issuerDirect;
  }
  if (origin === 'bank' && !hasDegradingStep) return INDEPENDENCE.bankViaAdministrator;
  return INDEPENDENCE.singleDocument;
}
