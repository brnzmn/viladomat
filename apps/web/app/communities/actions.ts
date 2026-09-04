'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { COMMUNITY_COOKIE, getMemberships } from '@/lib/community';

const schema = z.object({ community_id: z.string().uuid() });

/** Stores the chosen community id in the `vx_community` cookie after checking membership. */
export async function selectCommunity(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({ community_id: formData.get('community_id') });
  if (!parsed.success) redirect('/communities');
  const { memberships } = await getMemberships();
  const allowed = memberships.some((m) => m.community_id === parsed.data.community_id);
  if (!allowed) redirect('/communities');
  const cookieStore = await cookies();
  cookieStore.set(COMMUNITY_COOKIE, parsed.data.community_id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect('/');
}
