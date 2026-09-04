import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { resolveCommunity } from '../lib/community.ts';
import { maybeOne, query } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import {
  DEFAULT_LONG_EDGE,
  HIRES_LONG_EDGE,
  exifCaptureTime,
  extensionFor,
  readExif,
  readPdfMeta,
  sniffMime,
  type ExifData,
  type PdfMeta,
} from '../lib/images.ts';
import { ObjectExistsError, putObject, storageMode } from '../lib/storage.ts';

/**
 * `vx ingest` — take a delivery of originals into custody.
 *
 * The order of operations is the chain of custody: the SHA-256 is computed by streaming the file on
 * the machine that received it, **before** any copy is made; the untouched bytes then go to the
 * immutable `originals` key derived from that hash; only then is the `files` row written, carrying
 * who supplied the batch (by role), when, and how it travelled. The server re-hash happens later, in
 * the `ingest` step, so a transport error between the two shows up as a mismatch instead of being
 * silently absorbed.
 */

/** Sources accepted on the command line (subset of the `file_source` enum used by the operator). */
export const INGEST_SOURCES = ['local', 'admin_delivery', 'bank_export', 'phone_transfer', 'onsite', 'drive'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/** Roles a batch may be attributed to. Roles only — never a person's name. */
export const SUPPLIER_ROLES = [
  'administrator',
  'president',
  'requesting_owner',
  'other_owner',
  'vendor_via_administrator',
  'bank',
  'public_body',
  'operator',
] as const;

/** Extensions walked into a batch. Anything else is left where it is and reported as skipped. */
export const INGESTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.pdf', '.eml', '.txt', '.csv'];

export interface IngestOptions {
  source: string;
  suppliedBy: string;
  suppliedOn: string;
  batch: string;
  transport?: string;
  community?: string;
  hires?: boolean;
  dryRun?: boolean;
}

export interface IngestedFile {
  path: string;
  name: string;
  sha256: string;
  bytes: number;
  mime: string;
  fileId?: string;
  captureTime: string | null;
}

export interface IngestSummary {
  communityId: string;
  batch: string;
  longEdge: number;
  stored: IngestedFile[];
  duplicates: { path: string; sha256: string; batch: string | null }[];
  skipped: { path: string; reason: string }[];
  bytes: number;
  dryRun: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

/** SHA-256 of the file as it lies on the source machine, streamed so large originals never load whole. */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Walk a directory into a deterministic list of candidate files; hidden entries are never followed. */
export async function walkBatch(target: string): Promise<{ files: string[]; skipped: { path: string; reason: string }[] }> {
  const info = await stat(target).catch(() => fail(`path not found: ${target}`));
  if (info.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (!INGESTED_EXTENSIONS.includes(ext)) return { files: [], skipped: [{ path: target, reason: `extension ${ext || '(none)'} not ingested` }] };
    return { files: [target], skipped: [] };
  }
  const files: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // hidden files and directories are never ingested
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (INGESTED_EXTENSIONS.includes(ext)) files.push(full);
        else skipped.push({ path: full, reason: `extension ${ext || '(none)'} not ingested` });
      }
    }
  };
  await walk(target);
  return { files, skipped };
}

function validate(opts: IngestOptions): void {
  if (!INGEST_SOURCES.includes(opts.source as IngestSource)) fail(`--source must be one of: ${INGEST_SOURCES.join(', ')}`);
  if (!SUPPLIER_ROLES.includes(opts.suppliedBy as (typeof SUPPLIER_ROLES)[number])) {
    fail(`--supplied-by must be a role, one of: ${SUPPLIER_ROLES.join(', ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.suppliedOn) || Number.isNaN(Date.parse(opts.suppliedOn))) fail('--supplied-on must be a date, YYYY-MM-DD');
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(opts.batch)) fail('--batch must be 3-80 characters of letters, digits, dot, underscore or hyphen');
}

export async function ingestCommand(target: string, opts: IngestOptions): Promise<IngestSummary> {
  validate(opts);
  const community = await resolveCommunity(opts.community);
  const longEdge = opts.hires ? HIRES_LONG_EDGE : DEFAULT_LONG_EDGE;
  const { files, skipped } = await walkBatch(path.resolve(target));
  const summary: IngestSummary = {
    communityId: community.id,
    batch: opts.batch,
    longEdge,
    stored: [],
    duplicates: [],
    skipped,
    bytes: 0,
    dryRun: Boolean(opts.dryRun),
  };
  if (files.length === 0) {
    console.log(`no ingestible files under ${target}`);
    return summary;
  }

  console.log(`batch ${opts.batch}: ${files.length} candidate file(s), storage ${storageMode()}, render long edge ${longEdge} px`);
  const seen = new Map<string, string>(); // sha256 -> first path in this run

  for (const file of files) {
    const name = path.basename(file);
    // 1. hash first, on the bytes as they lie here, before any copy
    const sha = await hashFile(file);
    const size = (await stat(file)).size;

    const duplicateInRun = seen.get(sha);
    if (duplicateInRun) {
      summary.duplicates.push({ path: file, sha256: sha, batch: opts.batch });
      console.log(`dup   ${name}  ${sha.slice(0, 12)}  same bytes as ${path.basename(duplicateInRun)} in this batch`);
      continue;
    }
    const existing = await maybeOne<{ id: string; batch_label: string | null; original_name: string }>(
      'select id, batch_label, original_name from public.files where community_id = $1 and sha256 = $2',
      [community.id, sha],
    );
    if (existing) {
      summary.duplicates.push({ path: file, sha256: sha, batch: existing.batch_label });
      console.log(`dup   ${name}  ${sha.slice(0, 12)}  already held as "${existing.original_name}" (batch ${existing.batch_label ?? '-'})`);
      continue;
    }
    seen.set(sha, file);

    const bytes = await readFile(file);
    const mime = sniffMime(bytes, name);
    const ext = extensionFor(mime, name);
    let exif: ExifData | null = null;
    let pdfMeta: PdfMeta | null = null;
    if (mime.startsWith('image/')) exif = await readExif(bytes);
    else if (mime === 'application/pdf') pdfMeta = await readPdfMeta(bytes);
    const captureTime = exifCaptureTime(exif);
    const key = `${community.id}/${sha.slice(0, 2)}/${sha}.${ext}`;
    const storagePath = `originals/${key}`;

    if (opts.dryRun) {
      summary.stored.push({ path: file, name, sha256: sha, bytes: size, mime, captureTime });
      summary.bytes += size;
      console.log(`plan  ${name}  ${sha.slice(0, 12)}  ${mime}  ${size} B  -> ${storagePath}`);
      continue;
    }

    // 2. the untouched bytes, under a key derived from the hash; never overwritten
    try {
      await putObject('originals', key, bytes, mime, { immutable: true });
    } catch (e) {
      if (!(e instanceof ObjectExistsError)) throw e;
      // the same content is already stored (a `files` row was never written, or was rolled back)
      console.log(`note  ${name}  original already present at ${storagePath}`);
    }

    // 3. the custody row: who supplied it, in which role, when, and how it travelled
    const inserted = await maybeOne<{ id: string }>(
      `insert into public.files (community_id, sha256, client_sha256, storage_path, original_name, mime, bytes, source,
                                 supplied_by_role, supplied_on, batch_label, transport_note, exif, pdf_meta, capture_time, uploaded_by)
       values ($1, $2, $2, $3, $4, $5, $6, $7::public.file_source, $8, $9::date, $10, $11, $12::jsonb, $13::jsonb, $14::timestamptz, null)
       on conflict (community_id, sha256) do nothing
       returning id`,
      [
        community.id,
        sha,
        storagePath,
        name,
        mime,
        size,
        opts.source,
        opts.suppliedBy,
        opts.suppliedOn,
        opts.batch,
        opts.transport ?? null,
        exif ? JSON.stringify(exif) : null,
        pdfMeta ? JSON.stringify(pdfMeta) : null,
        captureTime,
      ],
    );
    const fileId =
      inserted?.id ??
      (await maybeOne<{ id: string }>('select id from public.files where community_id = $1 and sha256 = $2', [community.id, sha]))?.id;
    if (!fileId) fail(`could not record ${name} (sha ${sha.slice(0, 12)})`);

    // 4. hand the file to the worker: server re-hash, then render and OCR
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'ingest', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [community.id, `${sha}:ingest:${PIPELINE_VERSION()}`, JSON.stringify({ file_id: fileId, long_edge: longEdge })],
    );

    summary.stored.push({ path: file, name, sha256: sha, bytes: size, mime, fileId, captureTime });
    summary.bytes += size;
    console.log(`store ${name}  ${sha.slice(0, 12)}  ${mime}  ${size} B${captureTime ? `  captured ${captureTime}` : ''}`);
  }

  for (const s of summary.skipped) console.log(`skip  ${path.basename(s.path)}  ${s.reason}`);

  if (!opts.dryRun && summary.stored.length > 0) {
    await query("select public.log_access($1, 'ingest', 'files', null, null, $2::jsonb, $3)", [
      community.id,
      JSON.stringify({
        batch: opts.batch,
        source: opts.source,
        supplied_by_role: opts.suppliedBy,
        supplied_on: opts.suppliedOn,
        stored: summary.stored.length,
        duplicates: summary.duplicates.length,
        bytes: summary.bytes,
      }),
      'vx ingest',
    ]);
  }

  console.log('');
  console.log(`batch ${opts.batch}: ${summary.stored.length} ${opts.dryRun ? 'to store' : 'stored'}, ${summary.duplicates.length} duplicate(s), ${summary.skipped.length} skipped, ${summary.bytes} B`);
  if (opts.dryRun) {
    console.log('dry run: nothing was written to storage or the database.');
    return summary;
  }
  console.log('next:');
  console.log(`  vx manifest --batch ${opts.batch}   # custody manifest (CSV + its own SHA-256) for this delivery`);
  console.log('  vx process --watch                 # server re-hash, renders, OCR');
  return summary;
}
