import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { envOptional } from './env.ts';

let client: SupabaseClient | undefined | null;

/** Service-role client for Storage (operator machine only). Returns null when not configured. */
export function storageClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = envOptional('SUPABASE_URL');
  const key = envOptional('SUPABASE_SERVICE_ROLE_KEY');
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

export async function uploadObject(bucket: string, objectPath: string, body: Buffer, contentType: string): Promise<boolean> {
  const c = storageClient();
  if (!c) return false;
  const { error } = await c.storage.from(bucket).upload(objectPath, body, { contentType, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`storage upload failed: ${error.message}`);
  return true;
}

export async function downloadObject(bucket: string, objectPath: string): Promise<Buffer> {
  const c = storageClient();
  if (!c) throw new Error('storage not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const { data, error } = await c.storage.from(bucket).download(objectPath);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}
