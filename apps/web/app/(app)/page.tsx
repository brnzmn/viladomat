import Link from 'next/link';
import { withCommunity } from '@/lib/community';
import type { Enums } from '@/lib/database.types';
import { countBy, date, label, money, pct } from '@/lib/format';
import { DaysSince } from './DaysSince';

export const dynamic = 'force-dynamic';

const DOC_STATUS_ORDER: readonly Enums<'doc_status'>[] = [
  'grouped',
  'classified',
  'extracted',
  'verified',
  'reviewed',
  'rejected',
];
const FINDING_STATUS_ORDER: readonly Enums<'finding_status'>[] = [
  'new',
  'in_review',
  'sent_for_explanation',
  'explained',
  'confirmed_discrepancy',
  'needs_document',
  'dismissed_fp',
];
const TIER_ORDER: readonly Enums<'finding_tier'>[] = ['T1', 'T2', 'T3'];
const REQUEST_STATUS_ORDER: readonly Enums<'request_status'>[] = [
  'planned',
  'requested',
  'partial',
  'received',
  'inspected_only',
  'refused',
];

function Counter({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-neutral-500">{hint}</div> : null}
    </div>
  );
}

function CountList({ entries, empty }: { entries: Array<[string, number]>; empty: string }) {
  if (entries.length === 0) return <p className="text-sm text-neutral-500">{empty}</p>;
  return (
    <ul className="space-y-0.5 text-sm">
      {entries.map(([k, n]) => (
        <li key={k} className="flex justify-between gap-2">
          <span>{label(k)}</span>
          <span className="tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function OverviewPage() {
  const { ctx, supabase } = await withCommunity();
  const cid = ctx.id;

  const [files, documents, findings, funding, clock, matrix, r7] = await Promise.all([
    supabase.from('files').select('id', { count: 'exact', head: true }).eq('community_id', cid),
    supabase.from('documents').select('status').eq('community_id', cid),
    supabase.from('findings').select('status, tier').eq('community_id', cid).is('superseded_by', null),
    supabase.from('v_works_funding').select('*').eq('community_id', cid).order('code'),
    supabase.from('request_clock').select('*').eq('community_id', cid).order('created_at').limit(1).maybeSingle(),
    supabase.from('v_document_matrix').select('status').eq('community_id', cid),
    supabase
      .from('v_r7_statement_months_missing')
      .select('month_start', { count: 'exact', head: true })
      .eq('community_id', cid),
  ]);

  const errors = [files, documents, findings, funding, clock, matrix, r7]
    .map((r) => r.error?.message)
    .filter((m): m is string => Boolean(m));

  const docRows = documents.data ?? [];
  const findingRows = findings.data ?? [];
  const fundingRows = funding.data ?? [];
  const matrixRows = matrix.data ?? [];
  const requestClock = clock.data;

  const docsByStatus = countBy(docRows, (d) => d.status, DOC_STATUS_ORDER);
  const findingsByStatus = countBy(findingRows, (f) => f.status, FINDING_STATUS_ORDER);
  const findingsByTier = countBy(findingRows, (f) => f.tier, TIER_ORDER);
  const matrixByStatus = countBy(matrixRows, (m) => m.status, REQUEST_STATUS_ORDER);

  const totals = fundingRows.reduce(
    (acc, r) => {
      acc.contract += r.contract_price ?? 0;
      acc.committed += r.committed ?? 0;
      acc.available += r.available ?? 0;
      acc.gap += r.funding_gap ?? 0;
      return acc;
    },
    { contract: 0, committed: 0, available: 0, gap: 0 },
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-neutral-600">
          {ctx.community.name}
          {ctx.community.nif ? ` · NIF ${ctx.community.nif}` : ''}
          {ctx.community.address ? ` · ${ctx.community.address}` : ''} · fiscal year starts in month{' '}
          {ctx.community.fy_start_month}
          {ctx.community.ordinary_budget_default
            ? ` · ordinary budget (default) ${money(ctx.community.ordinary_budget_default)}`
            : ''}
        </p>
      </div>

      {errors.length > 0 ? (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Some data could not be loaded: {errors.join('; ')}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Counter title="Files stored" value={files.count ?? 0} hint="originals bucket, hashed client-side" />
        <Counter title="Documents" value={docRows.length} hint="grouped pages" />
        <Counter title="Findings" value={findingRows.length} hint="discrepancies to verify (current)" />
        <Counter
          title="Statement months missing"
          value={r7.count ?? 0}
          hint="bank statement coverage gaps (R7)"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Documents by status</h2>
          <CountList entries={docsByStatus} empty="No documents yet." />
        </div>
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Findings by status</h2>
          <CountList entries={findingsByStatus} empty="No findings yet." />
        </div>
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Findings by tier</h2>
          <CountList entries={findingsByTier} empty="No tiered findings yet." />
          <p className="mt-2 text-xs text-neutral-500">
            Untiered: {findingRows.filter((f) => !f.tier).length}. Absence of a hit is non-exculpatory.
          </p>
        </div>
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Document matrix</h2>
          <CountList entries={matrixByStatus} empty="No document requests recorded." />
          <p className="mt-2 text-xs text-neutral-500">requests by class × year (status)</p>
        </div>
      </div>

      <section className="card space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Works funding (v_works_funding)</h2>
          <Link href="/seed?tab=works_packages" className="text-xs underline">
            edit packages
          </Link>
        </div>
        {fundingRows.length === 0 ? (
          <p className="text-sm text-neutral-500">No works packages seeded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th className="num">Contract price</th>
                  <th className="num">Committed</th>
                  <th className="num">Available</th>
                  <th className="num">Funding gap</th>
                  <th>Suspension</th>
                </tr>
              </thead>
              <tbody>
                {fundingRows.map((r) => (
                  <tr key={r.works_package_id ?? r.code ?? ''}>
                    <td className="font-mono text-xs">{r.code}</td>
                    <td>{r.label ?? '—'}</td>
                    <td>{label(r.status)}</td>
                    <td className="num">{money(r.contract_price)}</td>
                    <td className="num">{money(r.committed)}</td>
                    <td className="num">{money(r.available)}</td>
                    <td className={'num ' + ((r.funding_gap ?? 0) > 0 ? 'font-semibold' : '')}>
                      {money(r.funding_gap)}
                    </td>
                    <td className="text-xs">
                      {r.suspension_date ? `${date(r.suspension_date)} (${label(r.suspension_reason)})` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3}>Total</td>
                  <td className="num">{money(totals.contract)}</td>
                  <td className="num">{money(totals.committed)}</td>
                  <td className="num">{money(totals.available)}</td>
                  <td className="num">{money(totals.gap)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="text-xs text-neutral-500">
          committed = max(contract price, Σ invoices); available = derramas collected + subsidies + loans received;
          funding gap = committed − available. Figures transcribed from seed inputs are pending documentary
          verification.
        </p>
      </section>

      <section className="card space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Request clock</h2>
          <Link href="/seed?tab=request_clock" className="text-xs underline">
            edit
          </Link>
        </div>
        {!requestClock ? (
          <p className="text-sm text-neutral-500">No request recorded yet.</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2 lg:grid-cols-3">
            <dt className="text-neutral-500">Request date</dt>
            <dd>{date(requestClock.request_date)}</dd>
            <dt className="text-neutral-500">Days elapsed since request</dt>
            <dd>
              <DaysSince date={requestClock.request_date} />
            </dd>
            <dt className="text-neutral-500">Quotas requesting</dt>
            <dd>
              {pct(requestClock.quotas_pct_requesting)} · {requestClock.units_requesting ?? '—'} units
            </dd>
            <dt className="text-neutral-500">Convocation date</dt>
            <dd>{date(requestClock.convocation_date)}</dd>
            <dt className="text-neutral-500">Junta date</dt>
            <dd>{date(requestClock.junta_date)}</dd>
            <dt className="text-neutral-500">Notice days</dt>
            <dd>{requestClock.notice_days ?? '—'}</dd>
            <dt className="text-neutral-500">Documents available from</dt>
            <dd>{date(requestClock.docs_available_from)}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd>{requestClock.status ?? '—'}</dd>
            {requestClock.notes ? (
              <>
                <dt className="text-neutral-500">Notes</dt>
                <dd className="md:col-span-1 lg:col-span-5">{requestClock.notes}</dd>
              </>
            ) : null}
          </dl>
        )}
      </section>
    </div>
  );
}
