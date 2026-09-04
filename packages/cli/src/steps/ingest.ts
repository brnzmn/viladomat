import { maybeOne, query } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import { pdfPageCount, sha256 } from '../lib/images.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import type { StepJob, StepResult } from './types.ts';
import { longEdgeFrom } from './types.ts';

/**
 * Step `ingest` — server-side verification of a stored original.
 *
 * Re-hashes the bytes as they came back out of the object store and compares them with the hash
 * computed on the machine that received the file. Equality is the only thing this step claims: it
 * establishes that the stored object is the file that was hashed at intake, not that the underlying
 * document is authentic. A mismatch quarantines the row and stops the pipeline for that file.
 *
 * Idempotent: `files` allows exactly one verification update, so a re-run only re-enqueues the render.
 */
type FileRow = {
  id: string;
  community_id: string;
  sha256: string;
  client_sha256: string | null;
  server_sha256: string | null;
  hash_verified: boolean | null;
  storage_path: string;
  mime: string | null;
  original_name: string;
  status: string;
  page_count: number | null;
};

export async function enqueueRender(file: { id: string; community_id: string; sha256: string }, longEdge: number): Promise<void> {
  await query(
    `insert into public.jobs (community_id, idempotency_key, step, payload)
     values ($1, $2, 'render', $3::jsonb) on conflict (idempotency_key) do nothing`,
    [file.community_id, `${file.sha256}:render:${PIPELINE_VERSION()}`, JSON.stringify({ file_id: file.id, long_edge: longEdge })],
  );
}

export async function ingestStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const fileId = typeof payload.file_id === 'string' ? payload.file_id : '';
  if (!fileId) throw new Error('ingest: payload.file_id is required');
  const longEdge = longEdgeFrom(payload);

  const file = await maybeOne<FileRow>(
    `select id, community_id, sha256, client_sha256, server_sha256, hash_verified, storage_path, mime, original_name, status, page_count
       from public.files where id = $1`,
    [fileId],
  );
  if (!file) throw new Error(`ingest: file ${fileId} not found`);

  if (file.server_sha256) {
    if (file.status === 'stored' && file.hash_verified) await enqueueRender(file, longEdge);
    console.log(`ingest ${file.original_name}: already verified (${file.status}), render re-queued as needed`);
    return { file_id: file.id, skipped: 'already verified', status: file.status, hash_verified: file.hash_verified };
  }

  const { bucket, key } = parseStoragePath(file.storage_path);
  const bytes = await getObject(bucket, key);
  const serverSha = sha256(bytes);
  const clientSha = file.client_sha256 ?? file.sha256;
  const verified = serverSha === clientSha;

  let pageCount: number | null = null;
  if (verified) {
    if (file.mime === 'application/pdf') {
      pageCount = await pdfPageCount(bytes).catch(() => null);
    } else {
      pageCount = 1;
    }
  }

  // one update only: the files guard allows server_sha256 / hash_verified / status / page_count once
  await query(
    `update public.files set server_sha256 = $2, hash_verified = $3, status = $4::public.file_status, page_count = $5 where id = $1`,
    [file.id, serverSha, verified, verified ? file.status : 'quarantined', pageCount],
  );

  if (!verified) {
    console.log(`ingest ${file.original_name}: hash mismatch, quarantined (intake ${clientSha.slice(0, 12)} vs stored ${serverSha.slice(0, 12)})`);
    return { file_id: file.id, hash_verified: false, status: 'quarantined', client_sha256: clientSha, server_sha256: serverSha };
  }

  await enqueueRender(file, longEdge);
  console.log(`ingest ${file.original_name}: hash verified, ${pageCount ?? '?'} page(s), render queued`);
  return { file_id: file.id, hash_verified: true, status: file.status, server_sha256: serverSha, page_count: pageCount };
}
