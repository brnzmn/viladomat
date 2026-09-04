import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { envOptional, REPO_ROOT } from './env.ts';

/**
 * Object store for the three private buckets (`originals`, `derived`, `exports`).
 *
 * Two backends, one API:
 *  - `supabase`   service-role Storage, used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set;
 *  - `filesystem` a local mirror under `<REPO_ROOT>/data/<bucket>/<key>` (git-ignored), used otherwise.
 *
 * The filesystem backend keeps the M1 pipeline runnable on the operator machine before the Supabase
 * project holds any bytes; keys are identical in both modes, so a later copy is a plain sync.
 * `originals` objects are written with `immutable: true`: re-writing an existing key is refused, which
 * is the storage-side half of the custody rule that originals are never updated or deleted.
 */
export type StorageMode = 'supabase' | 'filesystem';

let client: SupabaseClient | undefined | null;

/** Service-role client for Storage (operator machine only). Returns null when not configured. */
export function storageClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = envOptional('SUPABASE_URL');
  const key = envOptional('SUPABASE_SERVICE_ROLE_KEY');
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

/** Which backend `putObject`/`getObject` currently use. */
export function storageMode(): StorageMode {
  return storageClient() ? 'supabase' : 'filesystem';
}

/** Root of the local mirror. Only meaningful in `filesystem` mode. */
export function filesystemRoot(): string {
  return envOptional('VX_STORAGE_DIR') ?? path.join(REPO_ROOT, 'data');
}

/** Reset the cached client (tests switch modes by changing the environment). */
export function resetStorageClient(): void {
  client = undefined;
}

function localPath(bucket: string, key: string): string {
  const clean = key.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error(`invalid object key: ${key}`);
  return path.join(filesystemRoot(), bucket, clean);
}

/**
 * Split a stored path (`<bucket>/<key>`, as kept in `files.storage_path` and `pages.render_path`)
 * into its bucket and key.
 */
export function parseStoragePath(storagePath: string): { bucket: string; key: string } {
  const clean = storagePath.replace(/^\/+/, '');
  const slash = clean.indexOf('/');
  if (slash <= 0) throw new Error(`storage path without a bucket: ${storagePath}`);
  return { bucket: clean.slice(0, slash), key: clean.slice(slash + 1) };
}

export class ObjectExistsError extends Error {
  constructor(bucket: string, key: string) {
    super(`object already exists and is immutable: ${bucket}/${key}`);
    this.name = 'ObjectExistsError';
  }
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  const c = storageClient();
  if (!c) {
    try {
      await access(localPath(bucket, key), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
  const name = key.slice(key.lastIndexOf('/') + 1);
  const { data, error } = await c.storage.from(bucket).list(dir, { limit: 1, search: name });
  if (error) throw new Error(`storage list failed: ${error.message}`);
  return (data ?? []).some((o) => o.name === name);
}

/**
 * Store bytes under `<bucket>/<key>`.
 *
 * `immutable` refuses to replace an existing object (originals); without it an existing key is
 * overwritten, which is what makes the render step re-runnable.
 * Returns whether this call wrote the bytes (`false` = the key already held them).
 */
export async function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
  opts: { immutable?: boolean } = {},
): Promise<boolean> {
  const c = storageClient();
  if (!c) {
    const file = localPath(bucket, key);
    if (opts.immutable && (await objectExists(bucket, key))) throw new ObjectExistsError(bucket, key);
    await mkdir(path.dirname(file), { recursive: true });
    // write to a sibling temp name first so a crash never leaves a truncated object behind
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
    return true;
  }
  const { error } = await c.storage.from(bucket).upload(key, body, { contentType, upsert: !opts.immutable });
  if (!error) return true;
  if (/already exists|duplicate|resource already exists/i.test(error.message)) {
    if (opts.immutable) throw new ObjectExistsError(bucket, key);
    return false;
  }
  throw new Error(`storage upload failed: ${error.message}`);
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const c = storageClient();
  if (!c) {
    try {
      return await readFile(localPath(bucket, key));
    } catch (e) {
      throw new Error(`object not found: ${bucket}/${key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const { data, error } = await c.storage.from(bucket).download(key);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Back-compatible name: upload and report whether the object store took the bytes. */
export async function uploadObject(bucket: string, objectPath: string, body: Buffer, contentType: string): Promise<boolean> {
  await putObject(bucket, objectPath, body, contentType);
  return true;
}

/** Back-compatible name for `getObject`. */
export async function downloadObject(bucket: string, objectPath: string): Promise<Buffer> {
  return getObject(bucket, objectPath);
}
