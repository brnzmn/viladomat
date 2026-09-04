import { crosscheckStep } from './crosscheck.ts';
import { extractStep } from './extract.ts';
import { groupStep } from './group.ts';
import { ingestStep } from './ingest.ts';
import { matchStep } from './match.ts';
import { ocrStep } from './ocr.ts';
import { renderStep } from './render.ts';
import { verifyStep } from './verify.ts';
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
 * M2 adds the four steps that turn pages into cited values:
 *
 *   group       `{ batch_label }`  ordered pages + Sonnet page pass + union-find → `documents`
 *   extract     `{ document_id }`  Opus reading → `extraction_runs`, `field_revisions`, domain rows
 *   crosscheck  `{ document_id }`  the OCR words as second reader → `ocr_agrees`, `crop_status`, status
 *   verify      `{ document_id }`  Sonnet third opinion, which may only demote
 *
 * `group` is enqueued once per batch by the render step and waits for a person to confirm the
 * grouping; `extract` is scheduled by `vx extract`, and enqueues `crosscheck` when it succeeds.
 * `verify` is scheduled deliberately, on the documents whose figures carry weight.
 * M3 adds `match` `{ community_id }`: the reconciliation pass (links, ledger, timeline, residuals).
 *
 * Every handler is idempotent: re-running a job with the same idempotency key changes nothing.
 */
export function registerAll(register: RegisterStep): void {
  register('ingest', ingestStep);
  register('render', renderStep);
  register('ocr', ocrStep);
  register('group', groupStep);
  register('extract', extractStep);
  register('crosscheck', crosscheckStep);
  register('verify', verifyStep);
  register('match', matchStep);
}

export { ingestStep } from './ingest.ts';
export { ocrStep } from './ocr.ts';
export { renderStep } from './render.ts';
export { groupStep } from './group.ts';
export { extractStep } from './extract.ts';
export { crosscheckStep } from './crosscheck.ts';
export { verifyStep } from './verify.ts';
export { matchStep } from './match.ts';
export type { RegisterStep, StepHandler, StepJob, StepResult } from './types.ts';
