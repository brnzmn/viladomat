import type { ReactNode } from 'react';

/** Plain form primitives (server-component friendly). */

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={className ?? 'block'}>
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

type Option = { value: string; label: string };

export function Select({
  name,
  options,
  defaultValue,
  allowEmpty,
  emptyLabel = '—',
  required,
}: {
  name: string;
  options: readonly (Option | string)[];
  defaultValue?: string | null;
  allowEmpty?: boolean;
  emptyLabel?: string;
  required?: boolean;
}) {
  return (
    <select name={name} defaultValue={defaultValue ?? ''} className="input" required={required}>
      {allowEmpty ? <option value="">{emptyLabel}</option> : null}
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ') } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

/** Tri-state boolean select: unknown / yes / no. Parsed by `nbool` in the action schemas. */
export function TriState({ name, defaultValue }: { name: string; defaultValue: boolean | null | undefined }) {
  const v = defaultValue === true ? 'true' : defaultValue === false ? 'false' : '';
  return (
    <select name={name} defaultValue={v} className="input">
      <option value="">unknown</option>
      <option value="true">yes</option>
      <option value="false">no</option>
    </select>
  );
}

export function Grid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 6 }) {
  const cls =
    cols === 2
      ? 'grid gap-3 md:grid-cols-2'
      : cols === 3
        ? 'grid gap-3 md:grid-cols-3'
        : cols === 6
          ? 'grid gap-3 md:grid-cols-3 lg:grid-cols-6'
          : 'grid gap-3 md:grid-cols-2 lg:grid-cols-4';
  return <div className={cls}>{children}</div>;
}

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="card space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {note ? <p className="text-xs text-neutral-600">{note}</p> : null}
      {children}
    </section>
  );
}
