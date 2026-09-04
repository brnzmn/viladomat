import { logAccess } from '@/lib/audit';
import { withCommunity } from '@/lib/community';
import type { Enums } from '@/lib/database.types';
import { date, label, money } from '@/lib/format';
import { Select } from '@/components/form';

export const dynamic = 'force-dynamic';

const STATUSES: readonly Enums<'finding_status'>[] = [
  'new',
  'in_review',
  'sent_for_explanation',
  'explained',
  'confirmed_discrepancy',
  'needs_document',
  'dismissed_fp',
];
const TIERS: readonly Enums<'finding_tier'>[] = ['T1', 'T2', 'T3'];

type Search = { rule_code?: string; tier?: string; status?: string; fiscal_year?: string };

const LIMIT = 500;

export default async function FindingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const { ctx, supabase } = await withCommunity();

  const { data: rules } = await supabase.from('rules').select('code, name_en').order('code');
  const ruleCodes = (rules ?? []).map((r) => r.code);
  const ruleNames = new Map((rules ?? []).map((r) => [r.code, r.name_en]));

  const ruleCode = ruleCodes.find((c) => c === sp.rule_code);
  const tier = TIERS.find((t) => t === sp.tier);
  const status = STATUSES.find((s) => s === sp.status);
  const fiscalYear = sp.fiscal_year && /^\d{4}$/.test(sp.fiscal_year) ? Number(sp.fiscal_year) : undefined;

  let query = supabase
    .from('findings')
    .select(
      'id, rule_code, rule_version, tier, status, severity, amount_at_stake, fiscal_year, entity_type, act_date_first, act_date_last, explanation_requested_on, superseded_by, summary_en',
    )
    .eq('community_id', ctx.id)
    .is('superseded_by', null)
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (ruleCode) query = query.eq('rule_code', ruleCode);
  if (tier) query = query.eq('tier', tier);
  if (status) query = query.eq('status', status);
  if (fiscalYear) query = query.eq('fiscal_year', fiscalYear);

  const { data, error } = await query;
  const rows = data ?? [];

  try {
    await logAccess(supabase, ctx.id, 'view', 'findings', null, null, {
      filters: { rule_code: ruleCode ?? null, tier: tier ?? null, status: status ?? null, fiscal_year: fiscalYear ?? null },
      rows: rows.length,
    }, 'findings list');
  } catch {
    // Read-only list; a failed audit entry is not fatal for viewing.
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Findings</h1>
        <p className="text-sm text-neutral-600">
          Discrepancies to verify, produced by versioned rules. Presence of a hit is unverified; absence of a hit is
          non-exculpatory. Status changes with reason and right-of-reply letters arrive with the findings workflow.
        </p>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <label className="block min-w-56">
          <span className="label">Rule</span>
          <Select
            name="rule_code"
            options={ruleCodes.map((c) => ({ value: c, label: `${c} — ${ruleNames.get(c) ?? ''}` }))}
            defaultValue={ruleCode}
            allowEmpty
            emptyLabel="any"
          />
        </label>
        <label className="block w-24">
          <span className="label">Tier</span>
          <Select name="tier" options={TIERS} defaultValue={tier} allowEmpty emptyLabel="any" />
        </label>
        <label className="block min-w-40">
          <span className="label">Status</span>
          <Select name="status" options={STATUSES} defaultValue={status} allowEmpty emptyLabel="any" />
        </label>
        <label className="block w-28">
          <span className="label">Fiscal year</span>
          <input type="number" name="fiscal_year" defaultValue={fiscalYear ?? ''} className="input" min={2000} max={2100} />
        </label>
        <button type="submit" className="btn-secondary">
          Filter
        </button>
      </form>

      {error ? <p className="text-sm text-red-700">{error.message}</p> : null}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Severity</th>
              <th className="num">Amount at stake</th>
              <th>FY</th>
              <th>Entity</th>
              <th>Act dates</th>
              <th>Explanation requested</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-neutral-500">
                  No findings match.
                </td>
              </tr>
            ) : (
              rows.map((f) => (
                <tr key={f.id}>
                  <td className="whitespace-nowrap">
                    <span className="font-mono text-xs">
                      {f.rule_code}@v{f.rule_version}
                    </span>
                    <div className="text-xs text-neutral-500">{ruleNames.get(f.rule_code) ?? ''}</div>
                  </td>
                  <td>{f.tier ?? '—'}</td>
                  <td>{label(f.status)}</td>
                  <td>{f.severity}</td>
                  <td className="num">{money(f.amount_at_stake)}</td>
                  <td>{f.fiscal_year ?? '—'}</td>
                  <td className="text-xs">{f.entity_type ?? '—'}</td>
                  <td className="whitespace-nowrap text-xs">
                    {f.act_date_first || f.act_date_last ? `${date(f.act_date_first)} – ${date(f.act_date_last)}` : '—'}
                  </td>
                  <td className="whitespace-nowrap text-xs">{date(f.explanation_requested_on)}</td>
                  <td className="max-w-md text-xs">{f.summary_en ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {rows.length >= LIMIT ? (
          <p className="mt-2 text-xs text-neutral-500">Showing the first {LIMIT} rows; narrow the filters.</p>
        ) : null}
      </div>
    </div>
  );
}
