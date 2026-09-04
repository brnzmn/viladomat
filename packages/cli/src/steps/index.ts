import { ingestStep } from './ingest.ts';
import { ocrStep } from './ocr.ts';
import { renderStep } from './render.ts';
import type { RegisterStep } from './types.ts';

/**
 * Step registry for `vx process`.
 *
 * M1 registers the three custody/preparation steps. They form one chain per file:
 *
 *   ingest  server re-hash → `files.server_sha256` / `hash_verified` / `page_count`; enqueues `render`
 *   render  page images + thumbnails + pHash + text layer → `pages`; enqueues `ocr` and `group`
 *   ocr     Tesseract word boxes → `ocr_words`
 *
 * `group` is deliberately **not** registered here. `vx process` claims only the steps it has
 * handlers for, so the one `group` job the render step enqueues per batch stays `queued` — with no
 * failed attempts and no dead-lettering — until the grouping step of the next milestone registers
 * itself. Passing `--steps group` before that exists simply finds no handler and fails the job, so
 * do not.
 *
 * Every handler is idempotent: re-running a job with the same idempotency key changes nothing.
 */
export function registerAll(register: RegisterStep): void {
  register('ingest', ingestStep);
  register('render', renderStep);
  register('ocr', ocrStep);
}

export { ingestStep } from './ingest.ts';
export { ocrStep } from './ocr.ts';
export { renderStep } from './render.ts';
export type { RegisterStep, StepHandler, StepJob, StepResult } from './types.ts';
