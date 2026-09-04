import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/database.types';
import { supabaseEnv } from '@/lib/env';

export type ServerClient = SupabaseClient<Database>;

/**
 * Server-side client bound to the request's cookie store (Server Components, Server Actions,
 * Route Handlers). Row-level security applies: the client carries the user's JWT, never a
 * service key.
 */
export async function createClient(): Promise<ServerClient> {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. The request proxy
          // refreshes sessions, so this can be ignored.
        }
      },
    },
  });
}

/** Authenticated user for the current request, or null. Validates the token with Supabase Auth. */
export async function getUser(supabase?: ServerClient) {
  const client = supabase ?? (await createClient());
  const {
    data: { user },
  } = await client.auth.getUser();
  return user;
}
