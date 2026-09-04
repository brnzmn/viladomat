import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { label } from '@/lib/format';
import { saveCommunityRule } from '../actions';
import { RULE_TOPICS } from '../constants';

function RuleFields({ row }: { row?: Tables<'community_rules'> }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={3}>
        <Field label="Topic *">
          <Select name="topic" options={RULE_TOPICS} defaultValue={row?.topic ?? 'other'} />
        </Field>
        <Field label="Page no.">
          <input name="page_no" type="number" min="1" defaultValue={row?.page_no ?? ''} className="input" />
        </Field>
        <Field label="Reason / source">
          <input name="reason" className="input" placeholder="e.g. statutes p.4" />
        </Field>
      </Grid>
      <Field label="Literal text * (transcribe verbatim)">
        <textarea name="text_literal" rows={3} required defaultValue={row?.text_literal ?? ''} className="input" />
      </Field>
    </>
  );
}

export function CommunityRulesTab({ rows, canWrite }: { rows: Tables<'community_rules'>[]; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title={`Community rules (${rows.length})`}
        note="Clauses of the statutes or constitutive title that override the statutory defaults (quota criterion, works threshold, delegation limits, reserve fund, meetings)."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Page</th>
                <th>Literal text</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-neutral-500">
                    No rules yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{label(r.topic)}</td>
                    <td>{r.page_no ?? '—'}</td>
                    <td className="text-xs">{r.text_literal}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add rule">
            <ActionForm action={saveCommunityRule} submitLabel="Create rule">
              <RuleFields />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit rules">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {label(r.topic)} · p.{r.page_no ?? '—'}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveCommunityRule} submitLabel="Save changes">
                        <RuleFields row={r} />
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
