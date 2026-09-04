import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date, label, money } from '@/lib/format';
import { saveWorksPackage } from '../actions';
import { SUSPENSION_REASONS, WORKS_CODES, WORKS_STATUSES } from '../constants';

function PackageFields({ row }: { row?: Tables<'works_packages'> }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={4}>
        <Field label="Code *">
          <Select name="code" options={WORKS_CODES} defaultValue={row?.code ?? 'OTHER'} />
        </Field>
        <Field label="Label">
          <input name="label" defaultValue={row?.label ?? ''} className="input" placeholder="e.g. rear facade and balconies" />
        </Field>
        <Field label="Status">
          <Select name="status" options={WORKS_STATUSES} defaultValue={row?.status ?? 'unknown'} />
        </Field>
        <Field label="Contract price (EUR)">
          <input name="contract_price" type="number" step="0.01" defaultValue={row?.contract_price ?? ''} className="input" />
        </Field>
      </Grid>
      <Grid cols={4}>
        <Field label="Architect PEM (EUR)">
          <input name="architect_pem" type="number" step="0.01" defaultValue={row?.architect_pem ?? ''} className="input" />
        </Field>
        <Field label="Permit PEM (EUR)">
          <input name="permit_pem" type="number" step="0.01" defaultValue={row?.permit_pem ?? ''} className="input" />
        </Field>
        <Field label="Subsidy protegible (EUR)">
          <input name="subsidy_protegible" type="number" step="0.01" defaultValue={row?.subsidy_protegible ?? ''} className="input" />
        </Field>
        <Field label="Suspension date">
          <input name="suspension_date" type="date" defaultValue={row?.suspension_date ?? ''} className="input" />
        </Field>
      </Grid>
      <Grid cols={3}>
        <Field label="Suspension reason">
          <Select name="suspension_reason" options={SUSPENSION_REASONS} defaultValue={row?.suspension_reason ?? ''} allowEmpty emptyLabel="none" />
        </Field>
        <Field label="Notes">
          <input name="notes" defaultValue={row?.notes ?? ''} className="input" />
        </Field>
        <Field label="Reason / source (page)">
          <input name="reason" className="input" />
        </Field>
      </Grid>
    </>
  );
}

export function WorksPackagesTab({ rows, canWrite }: { rows: Tables<'works_packages'>[]; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title={`Works packages (${rows.length})`}
        note="Five-number triangulation per package: architect PEM, permit PEM, subsidy protegible, contract price and, later, the invoices and certifications extracted from documents."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Status</th>
                <th className="num">Architect PEM</th>
                <th className="num">Permit PEM</th>
                <th className="num">Subsidy protegible</th>
                <th className="num">Contract price</th>
                <th>Suspension</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-neutral-500">
                    No works packages yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.code}</td>
                    <td>{r.label ?? '—'}</td>
                    <td>{label(r.status)}</td>
                    <td className="num">{money(r.architect_pem)}</td>
                    <td className="num">{money(r.permit_pem)}</td>
                    <td className="num">{money(r.subsidy_protegible)}</td>
                    <td className="num">{money(r.contract_price)}</td>
                    <td className="text-xs">{r.suspension_date ? `${date(r.suspension_date)} (${label(r.suspension_reason)})` : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add works package">
            <ActionForm action={saveWorksPackage} submitLabel="Create package">
              <PackageFields />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit works packages">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {r.code}
                      {r.label ? ` · ${r.label}` : ''} · {label(r.status)} · {money(r.contract_price)}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveWorksPackage} submitLabel="Save changes">
                        <PackageFields row={r} />
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
