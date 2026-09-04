import { ActionForm } from '@/components/ActionForm';
import { Field, Grid, Section, Select, TriState } from '@/components/form';
import type { Tables } from '@/lib/database.types';
import { label } from '@/lib/format';
import { saveBankAccount } from '../actions';
import { ACCOUNT_PURPOSES, HOLDER_KINDS } from '../constants';

function AccountFields({ row }: { row?: Tables<'bank_accounts'> }) {
  return (
    <>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <Grid cols={4}>
        <Field label="Label *">
          <input name="label" defaultValue={row?.label ?? ''} required className="input" placeholder="e.g. ordinary account" />
        </Field>
        <Field label="IBAN last 4 digits" hint="Only the last four digits are entered here; the full IBAN is never stored in clear.">
          <input name="iban_last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={row?.iban_last4 ?? ''} className="input" />
        </Field>
        <Field label="Bank name">
          <input name="bank_name" defaultValue={row?.bank_name ?? ''} className="input" />
        </Field>
        <Field label="Holder kind">
          <Select name="holder_kind" options={HOLDER_KINDS} defaultValue={row?.holder_kind ?? 'unknown'} />
        </Field>
      </Grid>
      <Grid cols={4}>
        <Field label="Purpose">
          <Select name="purpose" options={ACCOUNT_PURPOSES} defaultValue={row?.purpose ?? 'unknown'} />
        </Field>
        <Field label="Titled to the community">
          <TriState name="titled_to_community" defaultValue={row?.titled_to_community} />
        </Field>
        <Field label="Signatory roles" hint="comma-separated roles, e.g. president, administrator">
          <input name="signatory_roles" defaultValue={row?.signatory_roles?.join(', ') ?? ''} className="input" />
        </Field>
        <Field label="Reason / source (page)">
          <input name="reason" className="input" />
        </Field>
      </Grid>
    </>
  );
}

export function BankAccountsTab({ rows, canWrite }: { rows: Tables<'bank_accounts'>[]; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <Section
        title={`Bank accounts (${rows.length})`}
        note="An account held by the administrator on behalf of several communities (pooled) drops the bank leg to administrator provenance; the holder certificate becomes a document request."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>IBAN (last 4)</th>
                <th>Bank</th>
                <th>Holder kind</th>
                <th>Purpose</th>
                <th>Titled to community</th>
                <th>Signatory roles</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-neutral-500">
                    No bank accounts yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td className="font-mono">{r.iban_last4 ? `···· ${r.iban_last4}` : '—'}</td>
                    <td>{r.bank_name ?? '—'}</td>
                    <td>{label(r.holder_kind)}</td>
                    <td>{label(r.purpose)}</td>
                    <td>{r.titled_to_community === null ? '—' : r.titled_to_community ? 'yes' : 'no'}</td>
                    <td className="text-xs">{r.signatory_roles?.join(', ') || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {canWrite ? (
        <>
          <Section title="Add bank account">
            <ActionForm action={saveBankAccount} submitLabel="Create account">
              <AccountFields />
            </ActionForm>
          </Section>
          {rows.length > 0 ? (
            <Section title="Edit bank accounts">
              <div className="space-y-2">
                {rows.map((r) => (
                  <details key={r.id} className="rounded border border-neutral-200 p-2">
                    <summary className="cursor-pointer text-sm">
                      {r.label} · {label(r.holder_kind)} · {label(r.purpose)}
                    </summary>
                    <div className="mt-3">
                      <ActionForm action={saveBankAccount} submitLabel="Save changes">
                        <AccountFields row={r} />
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
