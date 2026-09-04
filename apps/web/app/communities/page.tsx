import { redirect } from 'next/navigation';
import { getMemberships } from '@/lib/community';
import { createClient } from '@/lib/supabase/server';
import { label } from '@/lib/format';
import { selectCommunity } from './actions';

export const dynamic = 'force-dynamic';

export default async function CommunitiesPage() {
  const { userId, memberships } = await getMemberships();
  if (!userId) redirect('/login');

  const supabase = await createClient();
  const ids = memberships.map((m) => m.community_id);
  const { data: communities } =
    ids.length > 0
      ? await supabase.from('communities').select('id, name, address').in('id', ids).order('name')
      : { data: [] };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Choose a community</h1>
        <p className="mt-1 text-sm text-neutral-600">The selection is kept for this browser until you sign out.</p>
      </div>
      {memberships.length === 0 ? (
        <div className="card space-y-2">
          <p className="text-sm">
            No community is assigned to this account yet. Ask the operator to add your membership.
          </p>
          <form action="/logout" method="post">
            <button type="submit" className="btn-secondary">
              Sign out
            </button>
          </form>
        </div>
      ) : (
        <ul className="space-y-2">
          {(communities ?? []).map((c) => {
            const m = memberships.find((x) => x.community_id === c.id);
            return (
              <li key={c.id} className="card">
                <form action={selectCommunity} className="flex items-center justify-between gap-3">
                  <input type="hidden" name="community_id" value={c.id} />
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-neutral-600">
                      {c.address ?? '—'} · role: {label(m?.role)}
                    </div>
                  </div>
                  <button type="submit" className="btn">
                    Open
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
      <form action="/logout" method="post" className="text-xs text-neutral-500">
        <button type="submit" className="underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
