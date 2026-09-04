import { query } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';

export async function statusCommand(opts: { community?: string }): Promise<void> {
  const c = await resolveCommunity(opts.community);
  const [counts] = await query(
    `select
       (select count(*) from public.files where community_id = $1) as files,
       (select count(*) from public.files where community_id = $1 and status = 'quarantined') as quarantined,
       (select count(*) from public.pages where community_id = $1) as pages,
       (select count(*) from public.documents where community_id = $1) as documents,
       (select count(*) from public.jobs where community_id = $1 and status = 'queued') as jobs_queued,
       (select count(*) from public.jobs where community_id = $1 and status = 'running') as jobs_running,
       (select count(*) from public.jobs where community_id = $1 and status in ('failed', 'dead')) as jobs_failed,
       (select count(*) from public.findings where community_id = $1) as findings,
       (select count(*) from public.findings where community_id = $1 and tier in ('T1', 'T2') and status not in ('dismissed_fp', 'explained')) as findings_open_t12,
       (select count(*) from public.document_requests where community_id = $1 and status in ('planned', 'requested', 'partial')) as requests_open`,
    [c.id],
  );
  console.log(`community: ${c.name} (${c.id})`);
  for (const [k, v] of Object.entries(counts ?? {})) console.log(`  ${k.padEnd(20)} ${String(v)}`);
}
