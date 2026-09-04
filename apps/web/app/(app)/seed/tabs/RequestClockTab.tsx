import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date } from '@/lib/format';
import { saveRequestClock } from '../actions';
import { REQUEST_CLOCK_STATUSES } from '../constants';

export function RequestClockTab({ row, canWrite }: { row: Tables<'request_clock'> | null; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title="Request clock"
        note="Date and evidence of the owners' request for an extraordinary meeting, the convocation and the meeting. Notice days are computed by the database. No statutory period runs from the request date; days elapsed are informational."
      >
        {row ? (
          <dl className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2 lg:grid-cols-4">
            <dt className="text-neutral-500">Request date</dt>
            <dd>{date(row.request_date)}</dd>
            <dt className="text-neutral-500">Quotas / units requesting</dt>
            <dd>
              {row.quotas_pct_requesting ?? '—'} % / {row.units_requesting ?? '—'}
            </dd>
            <dt className="text-neutral-500">Convocation date</dt>
            <dd>{date(row.convocation_date)}</dd>
            <dt className="text-neutral-500">Junta date</dt>
            <dd>{date(row.junta_date)}</dd>
            <dt className="text-neutral-500">Notice days</dt>
            <dd>{row.notice_days ?? '—'}</dd>
            <dt className="text-neutral-500">Documents available from</dt>
            <dd>{date(row.docs_available_from)}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd>{row.status ?? '—'}</dd>
            <dt className="text-neutral-500">Last updated</dt>
            <dd>{date(row.updated_at)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500">No request recorded yet.</p>
        )}
      </Section>

      {canWrite ? (
        <Section title={row ? 'Update request clock' : 'Record the request'}>
          <ActionForm action={saveRequestClock} submitLabel={row ? 'Save changes' : 'Create'}>
            <Grid cols={4}>
              <Field label="Request date">
                <input name="request_date" type="date" defaultValue={row?.request_date ?? ''} className="input" />
              </Field>
              <Field label="Quotas requesting (%)">
                <input name="quotas_pct_requesting" type="number" step="0.0001" min="0" max="100" defaultValue={row?.quotas_pct_requesting ?? ''} className="input" />
              </Field>
              <Field label="Units requesting">
                <input name="units_requesting" type="number" min="0" defaultValue={row?.units_requesting ?? ''} className="input" />
              </Field>
              <Field label="Status">
                <Select name="status" options={REQUEST_CLOCK_STATUSES} defaultValue={row?.status ?? ''} allowEmpty emptyLabel="—" />
              </Field>
            </Grid>
            <Grid cols={4}>
              <Field label="Convocation date">
                <input name="convocation_date" type="date" defaultValue={row?.convocation_date ?? ''} className="input" />
              </Field>
              <Field label="Junta date">
                <input name="junta_date" type="date" defaultValue={row?.junta_date ?? ''} className="input" />
              </Field>
              <Field label="Documents available from">
                <input name="docs_available_from" type="date" defaultValue={row?.docs_available_from ?? ''} className="input" />
              </Field>
              <Field label="Reason / source">
                <input name="reason" className="input" placeholder="e.g. burofax receipt" />
              </Field>
            </Grid>
            <Field label="Notes">
              <textarea name="notes" rows={2} defaultValue={row?.notes ?? ''} className="input" />
            </Field>
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
