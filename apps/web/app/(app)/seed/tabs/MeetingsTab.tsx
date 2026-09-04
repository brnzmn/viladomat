import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select, TriState } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date, money } from '@/lib/format';
import { saveMeeting } from '../actions';
import { MEETING_KINDS } from '../constants';

function MeetingFields({ row }: { row?: Tables<'meetings'> }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={6}>
        <Field label="Type *">
          <Select name="tipo" options={MEETING_KINDS} defaultValue={row?.tipo ?? 'ordinaria'} />
        </Field>
        <Field label="Meeting date *">
          <input name="fecha" type="date" defaultValue={row?.fecha ?? ''} required className="input" />
        </Field>
        <Field label="Convocation date">
          <input name="convocatoria_fecha" type="date" defaultValue={row?.convocatoria_fecha ?? ''} className="input" />
        </Field>
        <Field label="Minutes signed on">
          <input name="fecha_firma" type="date" defaultValue={row?.fecha_firma ?? ''} className="input" />
        </Field>
        <Field label="Minutes sent on">
          <input name="fecha_notificacion" type="date" defaultValue={row?.fecha_notificacion ?? ''} className="input" />
        </Field>
        <Field label="Budget approved (EUR)">
          <input name="presupuesto_aprobado" type="number" step="0.01" defaultValue={row?.presupuesto_aprobado ?? ''} className="input" />
        </Field>
      </Grid>
      <Grid cols={4}>
        <Field label="Accounts approved">
          <TriState name="cuentas_aprobadas" defaultValue={row?.cuentas_aprobadas} />
        </Field>
        <Field label="Notes">
          <input name="notes" defaultValue={row?.notes ?? ''} className="input" />
        </Field>
        <Field label="Reason / source (page)">
          <input name="reason" className="input" placeholder="e.g. acta p.1" />
        </Field>
        <label className="flex items-end gap-2 pb-1 text-sm">
          <input type="checkbox" name="seed_verified" defaultChecked={Boolean(row?.seed_verified_at)} />
          <span>Verified against the page</span>
        </label>
      </Grid>
    </>
  );
}

export function MeetingsTab({ rows, canWrite }: { rows: Tables<'meetings'>[]; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title={`Meetings (${rows.length})`}
        note="Notice days, signed-within-5-days and sent-within-10-days are computed by the database from the dates entered (periods to verify against the archived text)."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Convocation</th>
                <th className="num">Notice days</th>
                <th>Signed</th>
                <th>Sent</th>
                <th className="num">Budget approved</th>
                <th>Accounts approved</th>
                <th>Source</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-neutral-500">
                    No meetings yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{date(r.fecha)}</td>
                    <td>{r.tipo}</td>
                    <td className="whitespace-nowrap">{date(r.convocatoria_fecha)}</td>
                    <td className="num">{r.notice_days ?? '—'}</td>
                    <td className="whitespace-nowrap">
                      {date(r.fecha_firma)}
                      {r.signed_within_5d === false ? <span className="ml-1 text-xs text-amber-700">(&gt; 5 d)</span> : null}
                    </td>
                    <td className="whitespace-nowrap">
                      {date(r.fecha_notificacion)}
                      {r.sent_within_10d === false ? <span className="ml-1 text-xs text-amber-700">(&gt; 10 d)</span> : null}
                    </td>
                    <td className="num">{money(r.presupuesto_aprobado)}</td>
                    <td>{r.cuentas_aprobadas === null ? '—' : r.cuentas_aprobadas ? 'yes' : 'no'}</td>
                    <td>{r.entry_source}</td>
                    <td className="text-xs">{r.seed_verified_at ? date(r.seed_verified_at) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add meeting">
            <ActionForm action={saveMeeting} submitLabel="Create meeting">
              <MeetingFields />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit meetings">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {date(r.fecha)} · {r.tipo}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveMeeting} submitLabel="Save changes">
                        <MeetingFields row={r} />
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
