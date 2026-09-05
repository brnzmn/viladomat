/**
 * Public configuration. The project URL and the publishable key are not secrets: every browser
 * receives them in the bundle, and row-level security decides what a signed-in user may read or
 * write. They are fixed here so the hosted app works regardless of how the platform handles env
 * files; the NEXT_PUBLIC_* variables still win when set (local development against another
 * project). Secrets are never read from this module.
 */
const DEFAULT_SUPABASE_URL = 'https://rfjulnhozroglglrittw.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_SoEirz_G6sh-7EIGhO8ACw_jyvVEKKF';

export function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  return { url, anonKey };
}

export function hasSupabaseEnv(): boolean {
  const { url, anonKey } = supabaseEnv();
  return Boolean(url && anonKey);
}

/** Pipeline version recorded in job idempotency keys; keep in step with the worker. */
export const PIPELINE_VERSION: string = process.env.NEXT_PUBLIC_PIPELINE_VERSION || '1';
