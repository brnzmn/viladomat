'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

function daysSince(date: string): number | null {
  const start = new Date(date + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return null;
  return Math.floor((Date.now() - start.getTime()) / 86_400_000);
}

/**
 * Days elapsed since a date, computed in the browser so the figure reflects the viewer's clock
 * (informational only: no statutory period runs from the request date). The server snapshot is
 * null so hydration never disagrees with the server-rendered markup.
 */
export function DaysSince({ date }: { date: string | null }) {
  const days = useSyncExternalStore(
    subscribe,
    () => (date ? daysSince(date) : null),
    () => null,
  );
  if (!date) return <span>—</span>;
  if (days === null) return <span>…</span>;
  return (
    <span>
      {days} day{days === 1 ? '' : 's'} <span className="text-xs text-neutral-500">(informational)</span>
    </span>
  );
}
