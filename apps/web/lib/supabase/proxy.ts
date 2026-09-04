import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';

const LOGIN_PATH = '/login';
const MFA_PATH = '/mfa';
const LOGOUT_PATH = '/logout';

/**
 * Refreshes the Supabase session cookies on every request and enforces the access gates:
 *   unauthenticated                                    -> /login
 *   authenticated, no verified TOTP factor             -> /mfa (enrol)
 *   authenticated, TOTP factor enrolled, session aal1  -> /mfa (challenge and verify)
 * MFA is mandatory: nothing but /mfa and /logout is reachable until the session is at aal2.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfigured deployment: let the page render its configuration error.
    return response;
  }

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser() validates the token against Supabase Auth and refreshes it when needed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isLogin = path === LOGIN_PATH;
  const isMfa = path === MFA_PATH;
  const isLogout = path === LOGOUT_PATH;

  const redirectTo = (pathname: string, search = ''): NextResponse => {
    const target = request.nextUrl.clone();
    target.pathname = pathname;
    target.search = search;
    const redirect = NextResponse.redirect(target);
    // Carry refreshed auth cookies over to the redirect response.
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  };

  if (!user) {
    if (isLogin || isLogout) return response;
    const next = path !== '/' ? `?next=${encodeURIComponent(path + request.nextUrl.search)}` : '';
    return redirectTo(LOGIN_PATH, next);
  }

  const hasVerifiedFactor = (user.factors ?? []).some((f) => f.status === 'verified');
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const needsEnrol = !hasVerifiedFactor;
  const needsStepUp = hasVerifiedFactor && aal?.currentLevel === 'aal1';
  const mfaPending = needsEnrol || needsStepUp;

  if (mfaPending && !isMfa && !isLogout) {
    return redirectTo(MFA_PATH);
  }
  if (isLogin) {
    return redirectTo(mfaPending ? MFA_PATH : '/');
  }
  return response;
}
