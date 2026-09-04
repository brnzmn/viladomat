import { db, query } from '../lib/db.ts';

/**
 * Worker loop. Steps are registered in ./steps; each is a pure function over a job payload.
 * M0 ships the queue mechanics; the ingest/render/ocr steps arrive with M1.
 */
type StepHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<Record<string, unknown>>;

interface JobRow {
  id: string;
  community_id: string;
  idempotency_key: string;
  step: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
}

const handlers: Record<string, StepHandler> = {};

export function registerStep(step: string, handler: StepHandler): void {
  handlers[step] = handler;
}

async function loadSteps(): Promise<void> {
  try {
    const mod = (await import('../steps/index.ts')) as { registerAll?: (r: typeof registerStep) => void };
    mod.registerAll?.(registerStep);
  } catch (e) {
    if (!(e instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message))) throw e;
  }
}

export async function processCommand(opts: { watch?: boolean; steps?: string; worker: string }): Promise<void> {
  await loadSteps();
  const steps = opts.steps ? opts.steps.split(',').map((s) => s.trim()) : Object.keys(handlers);
  if (steps.length === 0) {
    console.log('no step handlers registered yet (M1 adds ingest/render/ocr); showing queue');
    const rows = await query(`select step, status, count(*)::int as n from public.jobs group by 1, 2 order by 1, 2`);
    for (const r of rows) console.log(`  ${String(r.step).padEnd(12)} ${String(r.status).padEnd(10)} ${String(r.n)}`);
    return;
  }
  let idle = 0;
  for (;;) {
    const claimed = await db().query<JobRow>('select * from public.claim_job($1, $2)', [opts.worker, steps]);
    const job = claimed.rows[0];
    if (!job || !job.id) {
      if (!opts.watch) break;
      idle++;
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * idle)));
      continue;
    }
    idle = 0;
    const handler = handlers[job.step];
    try {
      if (!handler) throw new Error(`no handler for step ${job.step}`);
      const result = await handler(job.payload ?? {}, job);
      await query(`update public.jobs set status = 'succeeded', result = $2::jsonb, locked_by = null, locked_at = null where id = $1`, [job.id, JSON.stringify(result)]);
      console.log(`ok   ${job.step} ${job.idempotency_key}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const dead = job.attempts >= job.max_attempts;
      await query(
        `update public.jobs set status = $2, last_error = $3, locked_by = null, locked_at = null, run_after = now() + make_interval(secs => $4) where id = $1`,
        [job.id, dead ? 'dead' : 'queued', msg.slice(0, 2000), dead ? 0 : Math.min(3600, 30 * 2 ** job.attempts)],
      );
      console.error(`fail ${job.step} ${job.idempotency_key}: ${msg}${dead ? ' (dead)' : ''}`);
    }
  }
}
