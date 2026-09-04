import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { uploadObject } from '../lib/storage.ts';
import { REPO_ROOT } from '../lib/env.ts';

interface FileRow {
  original_name: string;
  sha256: string;
  bytes: string | null;
  mime: string | null;
  supplied_by_role: string | null;
  supplied_on: string | null;
  uploaded_at: string;
  transport_note: string | null;
  status: string;
  hash_verified: boolean | null;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Custody manifest: one CSV per delivery batch listing every original with its SHA-256, plus the
 * manifest's own SHA-256. The hash is what gets an external timestamp (RFC 3161) or a notarial
 * deposit before any figure derived from the batch is circulated.
 */
export async function manifestCommand(opts: { batch: string; community?: string; out: string }): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const rows = await query<FileRow>(
    `select original_name, sha256, bytes, mime, supplied_by_role, to_char(supplied_on, 'YYYY-MM-DD') as supplied_on,
            to_char(uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as uploaded_at, transport_note, status, hash_verified
       from public.files where community_id = $1 and batch_label = $2 order by uploaded_at, original_name`,
    [community.id, opts.batch],
  );
  if (rows.length === 0) throw new Error(`no files in batch "${opts.batch}"`);

  const header = ['original_name', 'sha256', 'bytes', 'mime', 'supplied_by_role', 'supplied_on', 'uploaded_at_utc', 'transport_note', 'status', 'hash_verified'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.original_name, r.sha256, r.bytes, r.mime, r.supplied_by_role, r.supplied_on, r.uploaded_at, r.transport_note, r.status, r.hash_verified].map(csvEscape).join(','));
  }
  const csv = lines.join('\n') + '\n';
  const sha = createHash('sha256').update(csv).digest('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `manifest-${opts.batch.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}`;
  const outDir = path.isAbsolute(opts.out) ? opts.out : path.join(REPO_ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${base}.csv`);
  writeFileSync(csvPath, csv);
  writeFileSync(path.join(outDir, `${base}.sha256`), `${sha}  ${base}.csv\n`);

  const objectPath = `${community.id}/manifests/${base}.csv`;
  const uploaded = await uploadObject('exports', objectPath, Buffer.from(csv), 'text/csv');

  await query(
    `insert into public.custody_manifests (community_id, batch_label, manifest_path, manifest_sha256, file_count, generated_on_device)
     values ($1, $2, $3, $4, $5, $6)`,
    [community.id, opts.batch, uploaded ? objectPath : csvPath, sha, rows.length, os.hostname()],
  );
  await query("select public.log_access($1, 'export', 'custody_manifest', null, null, $2::jsonb, $3)", [
    community.id, JSON.stringify({ batch: opts.batch, files: rows.length, sha256: sha }), 'vx manifest',
  ]);

  console.log(`manifest written: ${csvPath}`);
  console.log(`files: ${rows.length}`);
  console.log(`manifest sha256: ${sha}`);
  console.log(uploaded ? `uploaded to exports/${objectPath}` : 'storage not configured: manifest kept locally only');
  console.log('next: obtain an RFC 3161 timestamp token or a notarial deposit for this hash and record it with the manifest.');
}
