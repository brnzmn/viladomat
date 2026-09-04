import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { getCommunity } from '@/lib/community';
import { label } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getCommunity();
  return (
    <div className="flex min-h-screen flex-col">
      <div className="border-b border-amber-300 bg-amber-100 px-4 py-1 text-center text-xs font-medium text-amber-900">
        Internal verification material — do not forward
      </div>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-2">
        <div>
          <div className="text-sm font-semibold">{ctx.name}</div>
          <div className="text-xs text-neutral-600">
            {ctx.community.address ?? ''}
            {ctx.community.address ? ' · ' : ''}role: {label(ctx.role)}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/communities" className="text-neutral-600 underline">
            Switch community
          </Link>
          <form action="/logout" method="post">
            <button type="submit" className="btn-secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {!ctx.mfaEnrolled ? (
        <div className="border-b border-red-300 bg-red-50 px-4 py-1 text-xs text-red-900">
          No second factor is enrolled for this account.{' '}
          <Link href="/mfa" className="underline">
            Enrol an authenticator app
          </Link>{' '}
          before working with originals.
        </div>
      ) : null}
      <div className="flex flex-1">
        <aside className="w-52 shrink-0 border-r border-neutral-200 bg-neutral-100 p-3">
          <Nav />
        </aside>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
      <footer className="border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-500">
        Every screen lists discrepancies to verify, never conclusions. Persons are referred to by role.
      </footer>
    </div>
  );
}
