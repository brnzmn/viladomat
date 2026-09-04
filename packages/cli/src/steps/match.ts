import { transaction } from '../lib/db.ts';
import { runMatch, formatMatchResult } from '../recon/match.ts';
import type { StepHandler } from './types.ts';

/**
 * `match` job `{ community_id }`: run the reconciliation pass (links, ledger, works timeline,
 * residual counts) inside one transaction. Idempotent: decisions on links are never rewritten and
 * proposals are upserted by their natural key.
 */
export const matchStep: StepHandler = async (payload, job) => {
  const cid = typeof payload.community_id === 'string' ? payload.community_id : job.community_id;
  const result = await transaction((client) => runMatch(client, cid, {}));
  const summary = formatMatchResult(result);
  for (const line of summary) console.log(`  ${line}`);
  return {
    community_id: cid,
    engine_version: result.engineVersion,
    links: Object.fromEntries([...result.linkCounts.entries()].map(([k, v]) => [k, v])),
    residuals: result.residuals,
    milestones_updated: result.milestonesUpdated,
  };
};
