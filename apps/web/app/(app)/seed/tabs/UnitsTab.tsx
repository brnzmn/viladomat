import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { label, pct } from '@/lib/format';
import { saveUnit } from '../actions';
import { HOLDER_ROLES } from '../constants';

function UnitFields({ row }: { row?: Tables<'units'> }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={6}>
        <Field label="Label *">
          <input name="label" defaultValue={row?.label ?? ''} required className="input" placeholder="e.g. Pral 1a" />
        </Field>
        <Field label="Floor">
          <input name="floor" defaultValue={row?.floor ?? ''} className="input" />
        </Field>
        <Field label="Door">
          <input name="door" defaultValue={row?.door ?? ''} className="input" />
        </Field>
        <Field label="Use">
          <input name="use" defaultValue={row?.use ?? ''} className="input" placeholder="residential / storage / commercial" />
        </Field>
        <Field label="Quota %">
          <input name="quota_pct" type="number" step="0.0001" min="0" max="100" defaultValue={row?.quota_pct ?? ''} className="input" />
        </Field>
        <Field label="Holder role">
          <Select name="holder_role" options={HOLDER_ROLES} defaultValue={row?.holder_role ?? 'unknown'} />
        </Field>
      </Grid>
      <Grid cols={2}>
        <Field label="Notes">
          <input name="notes" defaultValue={row?.notes ?? ''} className="input" />
        </Field>
        <Field label="Reason / source (page)">
          <input name="reason" className="input" placeholder="e.g. acta 2023-03-15 p.2" />
        </Field>
      </Grid>
    </>
  );
}

export function UnitsTab({ rows, canWrite }: { rows: Tables<'units'>[]; canWrite: boolean }) {
  const totalQuota = rows.reduce((s, r) => s + (r.quota_pct ?? 0), 0);
  return (
    <div className="space-y-4">
      <Section title={`Units (${rows.length})`} note={`Σ quota = ${pct(totalQuota, 4)} — should reach 100 % once every unit is entered.`}>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Floor</th>
                <th>Door</th>
                <th>Use</th>
                <th className="num">Quota %</th>
                <th>Holder role</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-neutral-500">
                    No units yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>{r.floor ?? '—'}</td>
                    <td>{r.door ?? '—'}</td>
                    <td>{r.use ?? '—'}</td>
                    <td className="num">{pct(r.quota_pct, 4)}</td>
                    <td>{label(r.holder_role)}</td>
                    <td className="text-xs">{r.notes ?? ''}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add unit">
            <ActionForm action={saveUnit} submitLabel="Create unit">
              <UnitFields />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit units">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {r.label} · {pct(r.quota_pct, 4)} · {label(r.holder_role)}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveUnit} submitLabel="Save changes">
                        <UnitFields row={r} />
                      </ActionForm>
                    </div>
                  </details>
                ))}
              </div>
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
