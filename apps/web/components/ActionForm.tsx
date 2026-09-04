'use client';

import { useActionState, type ReactNode } from 'react';
import type { ActionFn, ActionResult } from '@/lib/actions';

type Props = {
  action: ActionFn;
  children: ReactNode;
  submitLabel?: string;
  className?: string;
  /** Renders the submit button inline with the fields (row layout) instead of below them. */
  inline?: boolean;
};

/**
 * Thin wrapper around a server action: shows the pending state and the action's message.
 * Fields are plain uncontrolled inputs so the form works without client JavaScript too.
 */
export function ActionForm({ action, children, submitLabel = 'Save', className, inline }: Props) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  return (
    <form action={formAction} className={className ?? (inline ? 'flex flex-wrap items-end gap-2' : 'space-y-3')}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        {state ? (
          <span role="status" className={state.ok ? 'text-sm text-green-700' : 'text-sm text-red-700'}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
