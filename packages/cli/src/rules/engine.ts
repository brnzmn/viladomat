import { createHash } from 'node:crypto';
import type pg from 'pg';

/** A hit produced by a rule. Wording is template-locked: discrepancies to verify, roles not names. */
export interface RuleHit {
  ruleCode: string;
  severity: 1 | 2 | 3 | 4;
  /** identifies the underlying event so correlated rules collapse to one finding */
  eventKey: string;
  /** stable identity of this finding across runs */
  fingerprint: string;
  entityType: string;
  entityId?: string | null;
  worksPackageId?: string | null;
  fiscalYear?: number | null;
  amountAtStake?: number | null;
  actDateFirst?: string | null;
  actDateLast?: string | null;
  computed: Record<string, unknown>;
  summaryEs: string;
  summaryEn: string;
  innocentExplanations: string[];
  nextCheck: string;
  resolvingDocument?: string;
  /** provenance of the legs this hit rests on */
  independence: number;
  extractionQuality: number;
  evidence: Array<{
    label: string;
    documentId?: string | null;
    pageId?: string | null;
    resolutionId?: string | null;
    bankTransactionId?: string | null;
    computed?: Record<string, unknown>;
  }>;
}

export interface RuleContext {
  cid: string;
  client: pg.PoolClient;
  today: string;
  param: (key: string, onDate?: string) => Promise<number | null>;
}

export type Rule = (ctx: RuleContext) => Promise<RuleHit[]>;

export interface RuleMeta {
  code: string;
  version: number;
  specificity: number;
  worklistEligible: boolean;
  neverT1T2: boolean;
  family: string;
}

export function fp(...parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 32);
}

export function money(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : (n as number);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

export function fmtEur(n: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
}

/** Collapse hits that share an event key: keep the highest severity, record the others. */
export function collapse(hits: RuleHit[]): Array<RuleHit & { collapsedFrom: string[] }> {
  const byKey = new Map<string, RuleHit[]>();
  for (const h of hits) {
    const list = byKey.get(h.eventKey) ?? [];
    list.push(h);
    byKey.set(h.eventKey, list);
  }
  const out: Array<RuleHit & { collapsedFrom: string[] }> = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => b.severity - a.severity || b.independence - a.independence);
    const top = list[0]!;
    out.push({ ...top, collapsedFrom: list.slice(1).map((h) => h.ruleCode) });
  }
  return out;
}

export function tierFor(hit: RuleHit, meta: RuleMeta, confidence: number): 'T1' | 'T2' | 'T3' {
  if (meta.neverT1T2) return 'T3';
  // T1 needs machine two-source fields and an issuer-direct leg — never satisfiable by seeded figures.
  if (hit.extractionQuality >= 0.99 && hit.independence >= 1 && hit.severity >= 4 && confidence >= 0.8) return 'T1';
  if (hit.severity >= 2 && confidence >= 0.5) return 'T2';
  return 'T3';
}
