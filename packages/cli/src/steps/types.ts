import { DEFAULT_LONG_EDGE } from '../lib/images.ts';

/** The job row a step handler receives (structural subset of `public.jobs`). */
export interface StepJob {
  id: string;
  community_id: string;
  idempotency_key: string;
  step: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
}

export type StepResult = Record<string, unknown>;

export type StepHandler = (payload: Record<string, unknown>, job: StepJob) => Promise<StepResult>;

/** Registration callback handed in by `vx process` (`registerStep`). */
export type RegisterStep = (step: string, handler: StepHandler) => void;

/**
 * Render long edge carried by a job payload. `vx ingest --hires` puts it on the `ingest` job, which
 * passes it to `render`; anything else falls back to the pipeline default.
 */
export function longEdgeFrom(payload: Record<string, unknown>, fallback: number = DEFAULT_LONG_EDGE): number {
  const raw = payload.long_edge;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 320 && n <= 6000 ? Math.round(n) : fallback;
}
