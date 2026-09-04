import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date, label, money } from '@/lib/format';
import { saveDerrama } from '../actions';
import { DERRAMA_CRITERIOS } from '../constants';

type ResolutionOpt = Pick<Tables<'resolutions'>, 'id' | 'punto' | 'kind' | 'texto_literal' | 'meeting_id'>;
type PackageOpt = Pick<Tables<'works_packages'>, 'id' | 'code' | 'label'>;

function resolutionLabel(r: ResolutionOpt): string {
  const text = r.texto_literal.length > 60 ? r.texto_literal.slice(0, 60) + '…' : r.texto_literal;
  return `${r.punto ? `item ${r.punto} · ` : ''}${label(r.kind)} · ${text}`;
}

function DerramaFields({ row, resolutions, packages }: { row?: Tables<'derramas'>; resolutions: ResolutionOpt[]; packages: PackageOpt[] }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={3}>
        <Field label="Purpose (objeto) *">
          <input name="objeto" defaultValue={row?.objeto ?? ''} required className="input" placeholder="e.g. works derrama 60 EUR/unit/month" />
        </Field>
        <Field label="Approving resolution">
          <Select
            name="resolution_id"
            options={resolutions.map((r) => ({ value: r.id, label: resolutionLabel(r) }))}
            defaultValue={row?.resolution_id ?? ''}
            allowEmpty
            emptyLabel="none / not located"
          />
        </Field>
        <Field label="Works package">
          <Select
            name="works_package_id"
            options={packages.map((p) => ({ value: p.id, label: `${p.code}${p.label ? ` · ${p.label}` : ''}` }))}
            defaultValue={row?.works_package_id ?? ''}
            allowEmpty
            emptyLabel="none"
          />
        </Field>
      </Grid>
      <Grid cols={6}>
        <Field label="Total amount (EUR)">
          <input name="importe_total" type="number" step="0.01" defaultValue={row?.importe_total ?? ''} className="input" />
        </Field>
        <Field label="Criterion">
          <Select name="criterio" options={DERRAMA_CRITERIOS} defaultValue={row?.criterio ?? 'coeficiente'} />
        </Field>
        <Field label="Per-unit amount (EUR)">
          <input name="per_unit_amount" type="number" step="0.01" defaultValue={row?.per_unit_amount ?? ''} className="input" />
        </Field>
        <Field label="Starts on">
          <input name="starts_on" type="date" defaultValue={row?.starts_on ?? ''} className="input" />
        </Field>
        <Field label="Ends on">
          <input name="ends_on" type="date" defaultValue={row?.ends_on ?? ''} className="input" />
        </Field>
        <Field label="Months">
          <input name="months" type="number" min="1" defaultValue={row?.months ?? ''} className="input" />
        </Field>
      </Grid>
      <Field label="Reason / source (page)">
        <input name="reason" className="input" />
      </Field>
    </>
  );
}

export function DerramasTab({
  rows,
  resolutions,
  packages,
  canWrite,
}: {
  rows: Tables<'derramas'>[];
  resolutions: ResolutionOpt[];
  packages: PackageOpt[];
  canWrite: boolean;
}) {
  const packageById = new Map(packages.map((p) => [p.id, p]));
  const resolutionById = new Map(resolutions.map((r) => [r.id, r]));
  return (
    <div className="space-y-4">
      <Section
        title={`Derramas (${rows.length})`}
        note="Expected collections per unit and period are derived later from these rows and the unit table; whether the derrama is flat or quota-based is recorded in the criterion."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Resolution</th>
                <th>Package</th>
                <th className="num">Total</th>
                <th>Criterion</th>
                <th className="num">Per unit</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Months</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-neutral-500">
                    No derramas yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.objeto}</td>
                    <td className="text-xs">{r.resolution_id ? (resolutionById.get(r.resolution_id) ? resolutionLabel(resolutionById.get(r.resolution_id)!) : r.resolution_id) : '—'}</td>
                    <td className="font-mono text-xs">{r.works_package_id ? (packageById.get(r.works_package_id)?.code ?? '?') : '—'}</td>
                    <td className="num">{money(r.importe_total)}</td>
                    <td>{label(r.criterio)}</td>
                    <td className="num">{money(r.per_unit_amount)}</td>
                    <td className="whitespace-nowrap">{date(r.starts_on)}</td>
                    <td className="whitespace-nowrap">{date(r.ends_on)}</td>
                    <td className="num">{r.months ?? '—'}</td>
                    <td>{r.entry_source}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add derrama">
            <ActionForm action={saveDerrama} submitLabel="Create derrama">
              <DerramaFields resolutions={resolutions} packages={packages} />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit derramas">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {r.objeto} · {money(r.per_unit_amount)} per unit · from {date(r.starts_on)}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveDerrama} submitLabel="Save changes">
                        <DerramaFields row={r} resolutions={resolutions} packages={packages} />
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
