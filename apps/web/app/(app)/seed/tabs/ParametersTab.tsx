import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date } from '@/lib/format';
import { appendParameter } from '../actions';
import { PARAMETER_KEYS } from '../constants';

export function ParametersTab({ rows, canWrite }: { rows: Tables<'parameters'>[]; canWrite: boolean }) {
  // rows arrive ordered by key, version desc: the first row per key is the current version.
  const current = new Map<string, Tables<'parameters'>>();
  for (const r of rows) if (!current.has(r.key)) current.set(r.key, r);
  const currentRows = [...current.values()];

  return (
    <div className="space-y-4">
      <Section
        title={`Parameters (${currentRows.length} keys, ${rows.length} versions)`}
        note="Materiality and thresholds are versioned: saving appends a new version and never alters an earlier one. Rules pick the latest version valid on the date of the tested event."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th className="num">Value</th>
                <th>Unit</th>
                <th>Valid from</th>
                <th className="num">Version</th>
                <th>Basis</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {currentRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-neutral-500">
                    No parameters yet.
                  </td>
                </tr>
              ) : (
                currentRows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.key}</td>
                    <td className="num">{r.value_num ?? r.value_text ?? '—'}</td>
                    <td>{r.unit ?? '—'}</td>
                    <td className="whitespace-nowrap">{date(r.valid_from)}</td>
                    <td className="num">{r.version}</td>
                    <td className="text-xs">{r.basis_text ?? '—'}</td>
                    <td className="whitespace-nowrap text-xs">{date(r.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {rows.length > currentRows.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-neutral-600">All versions ({rows.length})</summary>
            <table className="table mt-2">
              <thead>
                <tr>
                  <th>Key</th>
                  <th className="num">Version</th>
                  <th className="num">Value</th>
                  <th>Unit</th>
                  <th>Valid from</th>
                  <th>Basis</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.key}</td>
                    <td className="num">{r.version}</td>
                    <td className="num">{r.value_num ?? r.value_text ?? '—'}</td>
                    <td>{r.unit ?? '—'}</td>
                    <td>{date(r.valid_from)}</td>
                    <td className="text-xs">{r.basis_text ?? '—'}</td>
                    <td className="text-xs">{date(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </Section>

      {canWrite ? (
        <Section title="Append a parameter version">
          <ActionForm action={appendParameter} submitLabel="Append version">
            <Grid cols={4}>
              <Field label="Key *" hint="known keys are suggested; any lower-case key is accepted">
                <input name="key" list="parameter-keys" required pattern="[a-z][a-z0-9_]*" className="input" />
                <datalist id="parameter-keys">
                  {PARAMETER_KEYS.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </Field>
              <Field label="Value *">
                <input name="value_num" type="number" step="any" required className="input" />
              </Field>
              <Field label="Unit">
                <input name="unit" className="input" placeholder="EUR / pct / days" />
              </Field>
              <Field label="Valid from" hint="blank = 1900-01-01 (always)">
                <input name="valid_from" type="date" className="input" />
              </Field>
            </Grid>
            <Grid cols={2}>
              <Field label="Basis (how the value was derived)">
                <input name="basis_text" className="input" placeholder="e.g. 1 % of works spend under review" />
              </Field>
              <Field label="Reason / source">
                <input name="reason" className="input" />
              </Field>
            </Grid>
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
