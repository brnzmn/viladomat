import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select, TriState } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { date, label, money, pct } from '@/lib/format';
import { saveResolution } from '../actions';
import { DELEGATION_ROLES, RESOLUTION_KINDS, RESOLUTION_RESULTS } from '../constants';

type MeetingOpt = Pick<Tables<'meetings'>, 'id' | 'fecha' | 'tipo'>;
type PackageOpt = Pick<Tables<'works_packages'>, 'id' | 'code' | 'label'>;

function ResolutionFields({ row, meetings, packages }: { row?: Tables<'resolutions'>; meetings: MeetingOpt[]; packages: PackageOpt[] }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={4}>
        <Field label="Meeting *">
          <Select
            name="meeting_id"
            options={meetings.map((m) => ({ value: m.id, label: `${m.fecha} · ${m.tipo}` }))}
            defaultValue={row?.meeting_id ?? meetings[0]?.id ?? ''}
            required
          />
        </Field>
        <Field label="Item (punto)">
          <input name="punto" defaultValue={row?.punto ?? ''} className="input" placeholder="e.g. 3" />
        </Field>
        <Field label="Kind">
          <Select name="kind" options={RESOLUTION_KINDS} defaultValue={row?.kind ?? 'other'} />
        </Field>
        <Field label="Result">
          <Select name="resultado" options={RESOLUTION_RESULTS} defaultValue={row?.resultado ?? 'aprobado'} />
        </Field>
      </Grid>
      <Field label="Literal text * (transcribe verbatim; do not paraphrase)">
        <textarea name="texto_literal" defaultValue={row?.texto_literal ?? ''} required rows={3} className="input" />
      </Field>
      <Grid cols={4}>
        <Field label="Amount approved (EUR)">
          <input name="importe_aprobado" type="number" step="0.01" defaultValue={row?.importe_aprobado ?? ''} className="input" />
        </Field>
        <Field label="Tolerance %">
          <input name="tolerance_pct" type="number" step="0.001" defaultValue={row?.tolerance_pct ?? ''} className="input" placeholder="default 10" />
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
        <Field label="Page no.">
          <input name="page_no" type="number" min="1" defaultValue={row?.page_no ?? ''} className="input" />
        </Field>
      </Grid>
      <Grid cols={4}>
        <Field label="Delegation to role">
          <Select name="delegation_to_role" options={DELEGATION_ROLES} defaultValue={row?.delegation_to_role ?? ''} allowEmpty emptyLabel="none" />
        </Field>
        <Field label="Delegation scope">
          <input name="delegation_scope" defaultValue={row?.delegation_scope ?? ''} className="input" placeholder="e.g. choose contractor among the quotes presented" />
        </Field>
        <Field label="Delegation cap (EUR)">
          <input name="delegation_cap" type="number" step="0.01" defaultValue={row?.delegation_cap ?? ''} className="input" />
        </Field>
        <Field label="Cap explicit in text">
          <TriState name="cap_explicit" defaultValue={row?.cap_explicit} />
        </Field>
      </Grid>
      <Field label="Reason / source (page)">
        <input name="reason" className="input" placeholder="e.g. acta p.3 §3" />
      </Field>
    </>
  );
}

export function ResolutionsTab({
  rows,
  meetings,
  packages,
  canWrite,
}: {
  rows: Tables<'resolutions'>[];
  meetings: MeetingOpt[];
  packages: PackageOpt[];
  canWrite: boolean;
}) {
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const packageById = new Map(packages.map((p) => [p.id, p]));
  return (
    <div className="space-y-4">
      <Section
        title={`Resolutions (${rows.length})`}
        note="Challenge windows (+3 m / +12 m) are computed from the notification date, or the meeting date when unknown; periods to verify."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Meeting</th>
                <th>Item</th>
                <th>Kind</th>
                <th>Result</th>
                <th className="num">Amount</th>
                <th>Package</th>
                <th>Delegation</th>
                <th>Challenge until</th>
                <th>Page</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-neutral-500">
                    No resolutions yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const m = meetingById.get(r.meeting_id);
                  const p = r.works_package_id ? packageById.get(r.works_package_id) : undefined;
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{m ? `${date(m.fecha)} ${m.tipo}` : '—'}</td>
                      <td>{r.punto ?? '—'}</td>
                      <td>{label(r.kind)}</td>
                      <td>{r.resultado}</td>
                      <td className="num">
                        {money(r.importe_aprobado)}
                        {r.tolerance_pct !== null ? <div className="text-xs text-neutral-500">± {pct(r.tolerance_pct, 1)}</div> : null}
                      </td>
                      <td className="font-mono text-xs">{p?.code ?? '—'}</td>
                      <td className="text-xs">
                        {r.delegation_to_role
                          ? `${label(r.delegation_to_role)}${r.delegation_cap !== null ? ` · cap ${money(r.delegation_cap)}` : ' · no cap'}${r.cap_explicit === false ? ' (not explicit)' : ''}`
                          : '—'}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {date(r.challenge_3m_until)} / {date(r.challenge_12m_until)}
                      </td>
                      <td>{r.page_no ?? '—'}</td>
                      <td className="max-w-md text-xs">{r.texto_literal}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        meetings.length === 0 ? (
          <p className="text-sm text-amber-800">Enter a meeting first; resolutions belong to a meeting.</p>
        ) : (
          <>
            <Section title="Add resolution">
              <ActionForm action={saveResolution} submitLabel="Create resolution">
                <ResolutionFields meetings={meetings} packages={packages} />
              </ActionForm>
            </Section>
            {rows.length > 0 ? (
              <Section title="Edit resolutions">
                <div className="space-y-2">
                  {rows.map((r) => (
                    <details key={r.id} className="rounded border border-neutral-200 p-2">
                      <summary className="cursor-pointer text-sm">
                        {meetingById.get(r.meeting_id)?.fecha ?? '?'} · item {r.punto ?? '—'} · {label(r.kind)} · {money(r.importe_aprobado)}
                      </summary>
                      <div className="mt-3">
                        <ActionForm action={saveResolution} submitLabel="Save changes">
                          <ResolutionFields row={r} meetings={meetings} packages={packages} />
                        </ActionForm>
                      </div>
                    </details>
                  ))}
                </div>
              </Section>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
