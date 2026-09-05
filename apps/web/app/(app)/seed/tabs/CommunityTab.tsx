import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date } from '@/lib/format';
import { saveCommunity } from '../actions';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function CommunityTab({ community, canWrite }: { community: Tables<'communities'>; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title="Community"
        note="Identity of the community as it appears on invoices, bank statements and the minutes. The NIF (starts with H) is what the recipient check on every invoice compares against; the fiscal year start and the ordinary budget feed the control totals and the materiality parameters."
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2 lg:grid-cols-4">
          <dt className="text-neutral-500">Name</dt>
          <dd>{community.name}</dd>
          <dt className="text-neutral-500">NIF</dt>
          <dd>{community.nif ?? <span className="text-amber-800">not entered</span>}</dd>
          <dt className="text-neutral-500">Address</dt>
          <dd>{community.address ?? '—'}</dd>
          <dt className="text-neutral-500">Cadastral reference</dt>
          <dd>{community.catastro_rc ?? '—'}</dd>
          <dt className="text-neutral-500">Fiscal year starts</dt>
          <dd>{MONTHS[community.fy_start_month - 1] ?? community.fy_start_month}</dd>
          <dt className="text-neutral-500">Ordinary budget (default)</dt>
          <dd>{community.ordinary_budget_default != null ? `${community.ordinary_budget_default} €` : '—'}</dd>
          <dt className="text-neutral-500">Last updated</dt>
          <dd>{date(community.updated_at)}</dd>
        </dl>
      </Section>

      {canWrite ? (
        <Section title="Update community details">
          <ActionForm action={saveCommunity} submitLabel="Save changes">
            <Grid cols={2}>
              <Field label="Name">
                <input name="name" defaultValue={community.name} className="input" required />
              </Field>
              <Field label="NIF" hint="Community of owners: letter H followed by seven digits and a control character.">
                <input name="nif" defaultValue={community.nif ?? ''} className="input" placeholder="H12345678" />
              </Field>
            </Grid>
            <Grid cols={2}>
              <Field label="Address">
                <input name="address" defaultValue={community.address ?? ''} className="input" />
              </Field>
              <Field label="Cadastral reference" hint="Building-level reference from the Catastro, if known.">
                <input name="catastro_rc" defaultValue={community.catastro_rc ?? ''} className="input" />
              </Field>
            </Grid>
            <Grid cols={3}>
              <Field label="Fiscal year starts in">
                <select name="fy_start_month" defaultValue={String(community.fy_start_month)} className="input">
                  {MONTHS.map((m, i) => (
                    <option key={m} value={String(i + 1)}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ordinary budget (default, €)">
                <input
                  name="ordinary_budget_default"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={community.ordinary_budget_default ?? ''}
                  className="input"
                />
              </Field>
              <Field label="Reason / source">
                <input name="reason" className="input" placeholder="e.g. NIF from the 2023 minutes header" />
              </Field>
            </Grid>
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
