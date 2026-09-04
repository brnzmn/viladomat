/**
 * Writing side of the reconciliation links.
 *
 * A link is a proposal until a reviewer decides it. `accepted` and `rejected` rows are
 * never rewritten by the engine: re-running the matcher may refresh a `proposed` row, and
 * leaves every human decision exactly as it was.
 */
import type pg from 'pg';
import type { LinkMethod, LinkStatus } from './scoring.ts';

export type LinkType =
  | 'paid_by'
  | 'reported_as'
  | 'authorised_by'
  | 'under_contract'
  | 'certifies'
  | 'quotes_for'
  | 'funds'
  | 'declares_pem_for'
  | 'subsidises'
  | 'same_scope_as'
  | 'refunds'
  | 'returns';

export interface LinkInput {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: LinkType;
  method: LinkMethod;
  score: number;
  amountMatched?: number | null;
  status?: LinkStatus;
}

export type LinkOutcome = 'inserted' | 'updated' | 'kept_decision';

export interface LinkCounts {
  inserted: number;
  updated: number;
  keptDecision: number;
}

export function emptyCounts(): LinkCounts {
  return { inserted: 0, updated: 0, keptDecision: 0 };
}

/**
 * Upsert one link by its natural key. Returns what happened so the command can report
 * counts; `kept_decision` means a reviewer had already accepted or rejected this link.
 */
export async function upsertLink(
  client: pg.PoolClient,
  cid: string,
  engineVersion: string,
  link: LinkInput,
): Promise<LinkOutcome> {
  const res = await client.query<{ inserted: boolean }>(
    `insert into public.recon_links
       (community_id, from_type, from_id, to_type, to_id, link_type, method, score, amount_matched, status, engine_version)
     values ($1, $2, $3, $4, $5, $6::public.link_type, $7::public.link_method, $8, $9, $10::public.link_status, $11)
     on conflict (from_type, from_id, to_type, to_id, link_type) do update
        set method = excluded.method,
            score = excluded.score,
            amount_matched = excluded.amount_matched,
            status = excluded.status,
            engine_version = excluded.engine_version
      where recon_links.status = 'proposed'
     returning (xmax = 0) as inserted`,
    [
      cid,
      link.fromType,
      link.fromId,
      link.toType,
      link.toId,
      link.linkType,
      link.method,
      link.score,
      link.amountMatched ?? null,
      link.status ?? 'proposed',
      engineVersion,
    ],
  );
  const row = res.rows[0];
  if (!row) return 'kept_decision';
  return row.inserted ? 'inserted' : 'updated';
}
