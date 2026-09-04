'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '@/lib/nav';

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Screens" className="text-sm">
      <ol className="space-y-0.5">
        {NAV_ITEMS.map((item, i) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'flex items-center gap-2 rounded px-2 py-1 ' +
                  (active ? 'bg-neutral-800 text-white' : 'text-neutral-700 hover:bg-neutral-200') +
                  (item.available ? '' : ' opacity-60')
                }
              >
                <span className="w-4 text-right text-xs tabular-nums opacity-70">{i + 1}</span>
                <span>{item.label}</span>
                {!item.available ? (
                  <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70">{item.milestone}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
