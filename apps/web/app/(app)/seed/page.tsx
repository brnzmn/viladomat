import Link from 'next/link';
import type { ReactNode } from 'react';
import { withCommunity } from '@/lib/community';
import { SEED_TABS, type SeedTab } from './constants';
import { UnitsTab } from './tabs/UnitsTab';
import { MeetingsTab } from './tabs/MeetingsTab';
import { ResolutionsTab } from './tabs/ResolutionsTab';
import { WorksPackagesTab } from './tabs/WorksPackagesTab';
import { DerramasTab } from './tabs/DerramasTab';
import { BankAccountsTab } from './tabs/BankAccountsTab';
import { RequestClockTab } from './tabs/RequestClockTab';
import { ParametersTab } from './tabs/ParametersTab';
import { CommunityRulesTab } from './tabs/CommunityRulesTab';
import { CommunityTab } from './tabs/CommunityTab';

export const dynamic = 'force-dynamic';

function isTab(v: string | undefined): v is SeedTab {
  return SEED_TABS.some((t) => t.key === v);
}

export default async function SeedPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams;
  const tab: SeedTab = isTab(rawTab) ? rawTab : 'community';
  const { ctx, supabase } = await withCommunity();
  const cid = ctx.id;
  const canWrite = ctx.canWrite;

  let body: ReactNode;
  switch (tab) {
    case 'community': {
      body = <CommunityTab community={ctx.community} canWrite={canWrite} />;
      break;
    }
    case 'units': {
      const { data } = await supabase.from('units').select('*').eq('community_id', cid).order('label');
      body = <UnitsTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
    case 'meetings': {
      const { data } = await supabase.from('meetings').select('*').eq('community_id', cid).order('fecha', { ascending: false });
      body = <MeetingsTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
    case 'resolutions': {
      const [res, meetings, packages] = await Promise.all([
        supabase.from('resolutions').select('*').eq('community_id', cid).order('created_at', { ascending: false }),
        supabase.from('meetings').select('id, fecha, tipo').eq('community_id', cid).order('fecha', { ascending: false }),
        supabase.from('works_packages').select('id, code, label').eq('community_id', cid).order('code'),
      ]);
      body = (
        <ResolutionsTab rows={res.data ?? []} meetings={meetings.data ?? []} packages={packages.data ?? []} canWrite={canWrite} />
      );
      break;
    }
    case 'works_packages': {
      const { data } = await supabase.from('works_packages').select('*').eq('community_id', cid).order('code');
      body = <WorksPackagesTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
    case 'derramas': {
      const [rows, resolutions, packages] = await Promise.all([
        supabase.from('derramas').select('*').eq('community_id', cid).order('starts_on', { ascending: false, nullsFirst: false }),
        supabase.from('resolutions').select('id, punto, kind, texto_literal, meeting_id').eq('community_id', cid),
        supabase.from('works_packages').select('id, code, label').eq('community_id', cid).order('code'),
      ]);
      body = (
        <DerramasTab rows={rows.data ?? []} resolutions={resolutions.data ?? []} packages={packages.data ?? []} canWrite={canWrite} />
      );
      break;
    }
    case 'bank_accounts': {
      const { data } = await supabase.from('bank_accounts').select('*').eq('community_id', cid).order('label');
      body = <BankAccountsTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
    case 'request_clock': {
      const { data } = await supabase
        .from('request_clock')
        .select('*')
        .eq('community_id', cid)
        .order('created_at')
        .limit(1)
        .maybeSingle();
      body = <RequestClockTab row={data} canWrite={canWrite} />;
      break;
    }
    case 'parameters': {
      const { data } = await supabase
        .from('parameters')
        .select('*')
        .eq('community_id', cid)
        .order('key')
        .order('version', { ascending: false });
      body = <ParametersTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
    case 'community_rules': {
      const { data } = await supabase.from('community_rules').select('*').eq('community_id', cid).order('topic');
      body = <CommunityRulesTab rows={data ?? []} canWrite={canWrite} />;
      break;
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Seed & governance</h1>
        <p className="text-sm text-neutral-600">
          Figures transcribed by hand from the minutes and other papers. Every save is written to the audit log with
          the row before and after. Cite the page in the reason field; mark a meeting as verified only after
          re-reading the page.
        </p>
        {!canWrite ? (
          <p className="mt-1 text-sm text-amber-800">Your role is read-only; forms are shown for reference.</p>
        ) : null}
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-neutral-200 text-sm" aria-label="Seed tabs">
        {SEED_TABS.map((t) => (
          <Link
            key={t.key}
            href={`/seed?tab=${t.key}`}
            aria-current={t.key === tab ? 'page' : undefined}
            className={
              'rounded-t px-3 py-1 ' +
              (t.key === tab ? 'border border-b-0 border-neutral-300 bg-white font-medium' : 'text-neutral-600 hover:bg-neutral-200')
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
