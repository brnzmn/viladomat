import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, type ServerClient } from '@/lib/supabase/server';
import type { Enums, Tables } from '@/lib/database.types';

export const COMMUNITY_COOKIE = 'vx_community';

export type Membership = {
  community_id: string;
  role: Enums<'member_role'>;
  valid_until: string | null;
};

export type CommunityContext = {
  id: string;
  name: string;
  role: Enums<'member_role'>;
  community: Tables<'communities'>;
  userId: string;
  /** Verified TOTP factor enrolled for this user. */
  mfaEnrolled: boolean;
  /** Reviewer roles may write; viewers and the read-only auditor role only read. */
  canWrite: boolean;
};

export function isReviewer(role: Enums<'member_role'>): boolean {
  return role === 'owner_reviewer' || role === 'second_reviewer';
}

function activeMemberships(rows: Membership[]): Membership[] {
  const now = Date.now();
  return rows.filter((m) => !m.valid_until || new Date(m.valid_until).getTime() > now);
}

/**
 * All current memberships of the signed-in user (empty when signed out), plus whether a verified
 * second factor is enrolled. One token validation per request.
 */
export const getMemberships = cache(
  async (): Promise<{ userId: string | null; memberships: Membership[]; mfaEnrolled: boolean }> => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { userId: null, memberships: [], mfaEnrolled: false };
    const { data, error } = await supabase
      .from('community_members')
      .select('community_id, role, valid_until')
      .eq('user_id', user.id);
    if (error) throw new Error(`community_members: ${error.message}`);
    return {
      userId: user.id,
      memberships: activeMemberships(data ?? []),
      mfaEnrolled: (user.factors ?? []).some((f) => f.status === 'verified'),
    };
  },
);

/**
 * Resolves the community the current request works on: the `vx_community` cookie when it
 * matches a membership, otherwise the only membership, otherwise the picker at /communities.
 * Redirects to /login when signed out. Memoised per request.
 */
export const getCommunity = cache(async (): Promise<CommunityContext> => {
  const { userId, memberships, mfaEnrolled } = await getMemberships();
  if (!userId) redirect('/login');

  const supabase = await createClient();
  const cookieStore = await cookies();
  const selected = cookieStore.get(COMMUNITY_COOKIE)?.value;

  let membership = memberships.find((m) => m.community_id === selected);
  if (!membership && memberships.length === 1) membership = memberships[0];
  if (!membership) redirect('/communities');

  const { data: community, error } = await supabase
    .from('communities')
    .select('*')
    .eq('id', membership.community_id)
    .maybeSingle();
  if (error) throw new Error(`communities: ${error.message}`);
  if (!community) redirect('/communities');

  return {
    id: community.id,
    name: community.name,
    role: membership.role,
    community,
    userId,
    mfaEnrolled,
    canWrite: isReviewer(membership.role),
  };
});

/** Convenience: community context plus a request-bound client. */
export async function withCommunity(): Promise<{ ctx: CommunityContext; supabase: ServerClient }> {
  const [ctx, supabase] = await Promise.all([getCommunity(), createClient()]);
  return { ctx, supabase };
}
