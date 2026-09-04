/**
 * `vx match` — run the reconciliation pass: propose `recon_links`, keep the derrama ledger
 * on a bank basis, update contract milestones and rebuild the works timeline, then print
 * the control totals and the residual sets R1–R7.
 */
import { transaction } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { formatControlTotals, loadControlTotals } from '../recon/control-totals.ts';
import { formatMatchResult, runMatch, type MatchResult } from '../recon/match.ts';
import type { ControlTotals } from '../recon/control-totals.ts';

class DryRun extends Error {
  constructor(readonly payload: { result: MatchResult; controlTotals: ControlTotals }) {
    super('dry run');
  }
}

export async function matchCommand(opts: { community?: string; dryRun?: boolean }): Promise<void> {
  const community = await resolveCommunity(opts.community);
  let payload: { result: MatchResult; controlTotals: ControlTotals };
  try {
    payload = await transaction(async (client) => {
      const result = await runMatch(client, community.id);
      const controlTotals = await loadControlTotals(client, community.id);
      if (opts.dryRun) throw new DryRun({ result, controlTotals });
      await client.query(
        "select public.log_access($1, 'rule_run', 'recon', null, null, $2::jsonb, 'vx match')",
        [
          community.id,
          JSON.stringify({
            engine_version: result.engineVersion,
            links: Object.fromEntries([...result.linkCounts].map(([k, v]) => [k, v])),
            residuals: result.residuals,
            derrama: result.derrama,
            works_events: result.worksEvents,
          }),
        ],
      );
      return { result, controlTotals };
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    payload = e.payload;
  }

  for (const line of formatControlTotals(payload.controlTotals)) console.log(line);
  for (const line of formatMatchResult(payload.result)) console.log(line);
  if (opts.dryRun) console.log('dry run: nothing was written');
}
