/**
 * Environment access. Values are read lazily so that `next build` can prerender the static shell
 * without Supabase credentials; every page that touches data is `force-dynamic`.
 */
export function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see apps/web/.env.example)',
    );
  }
  return { url, anonKey };
}

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** Pipeline version recorded in job idempotency keys; keep in step with the worker. */
export const PIPELINE_VERSION: string = process.env.NEXT_PUBLIC_PIPELINE_VERSION ?? '1';
