'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { fail, type ActionResult } from '@/lib/actions';
import { logAccess } from '@/lib/audit';
import { createClient } from '@/lib/supabase/server';

const schema = z.object({
  email: z.string().trim().email('Enter a valid e-mail address'),
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
});

function safeNext(value: string | undefined): string {
  // Only same-origin paths; never an absolute URL.
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export async function signIn(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => i.message).join('; '));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return fail('Sign-in failed. Check the e-mail address and password.');
  }

  // Record the login against every community the user belongs to (RPC refuses non-members).
  const { data: memberships } = await supabase
    .from('community_members')
    .select('community_id')
    .eq('user_id', data.user.id);
  for (const m of memberships ?? []) {
    try {
      await logAccess(supabase, m.community_id, 'login', 'user', data.user.id, null, null, 'password sign-in');
    } catch {
      // A failed audit entry must not block access; the proxy re-validates the session anyway.
    }
  }

  redirect(safeNext(parsed.data.next));
}
