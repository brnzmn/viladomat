import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { supabaseEnv } from '@/lib/env';

let browserClient: SupabaseClient<Database> | undefined;

/**
 * Browser-side client (anon key + the user's session cookies). Created lazily so that importing
 * a client component never runs during server prerendering without environment variables.
 */
export function getBrowserClient(): SupabaseClient<Database> {
  if (!browserClient) {
    const { url, anonKey } = supabaseEnv();
    browserClient = createBrowserClient<Database>(url, anonKey);
  }
  return browserClient;
}
