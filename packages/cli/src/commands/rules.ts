import { createHash } from 'node:crypto';
import { transaction } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import { collapse, tierFor, type RuleContext, type RuleMeta } from '../rules/engine.ts';
import { ALL_RULES } from '../rules/index.ts';

const ENGINE_VERSION = 'm3.1';

export async function rulesCommand(opts: { community?: string; only?: string; dryRun?: boolean }): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const today = new Date().toISOString().slice(0, 10);
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;

  const result = await transaction(async (client) => {
    const rulesRes = await client.query(
      `select code, family, version, specificity_prior, worklist_eligible, never_t1t2, enabled_in_v1 from public.rules order by code`,
    );
    const metas = new Map<string, RuleMeta>();
    for (const r of rulesRes.rows as Array<Record<string, unknown>>) {
      metas.set(String(r.code), {
        code: String(r.code), family: String(r.family), version: Number(r.version), specificity: Number(r.specificity_prior),
        worklistEligible: Boolean(r.worklist_eligible), neverT1T2: Boolean(r.never_t1t2),
      });
    }
    const paramsRes = await client.query(
      `select distinct on (key) key, value_num, unit, version, valid_from from public.parameters where community_id = $1 order by key, valid_from desc, version desc`,
      [community.id],
    );
    const ctx: RuleContext = {
      cid: community.id,
      client,
      today,
      param: async (key, onDate) => {
        const r = await client.query<{ v: string | null }>('select public.param($1, $2, $3)::text as v', [community.id, key, onDate ?? today]);
        const v = r.rows[0]?.v;
        return v == null ? null : Number(v);
      },
    };

    const allHits = [];
    const ran: string[] = [];
    for (const [code, rule] of Object.entries(ALL_RULES)) {
      if (only && !only.has(code)) continue;
      const hits = await rule(ctx);
      ran.push(`${code}:${hits.length}`);
      allHits.push(...hits);
    }
    const collapsed = collapse(allHits);

    if (opts.dryRun) {
      for (const h of collapsed) console.log(`${h.ruleCode} S${h.severity} ${h.summaryEn}`);
      return { runId: null, ran, count: collapsed.length, stored: 0 };
    }

    // inputs hash: coarse fingerprint of the tables the rules read
    const counts = await client.query(
      `select (select count(*) from public.meetings where community_id = $1) as meetings,
              (select count(*) from public.resolutions where community_id = $1) as resolutions,
              (select count(*) from public.derrama_ledger where community_id = $1) as ledger,
              (select count(*) from public.bank_transactions where community_id = $1) as tx,
              (select count(*) from public.document_requests where community_id = $1) as requests,
              (select count(*) from public.works_packages where community_id = $1) as works,
              (select coalesce(max(updated_at)::text, '') from public.documents where community_id = $1) as docs_updated`,
      [community.id],
    );
    const inputsHash = createHash('sha256').update(JSON.stringify(counts.rows[0])).digest('hex');
    const runIns = await client.query<{ id: string }>(
      `insert into public.finding_runs (community_id, pipeline_version, engine_version, parameters_snapshot, rules_snapshot, inputs_hash)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id`,
      [community.id, PIPELINE_VERSION(), ENGINE_VERSION, JSON.stringify(paramsRes.rows), JSON.stringify([...metas.values()].map((m) => ({ code: m.code, version: m.version }))), inputsHash],
    );
    const runId = runIns.rows[0]!.id;

    let stored = 0;
    for (const h of collapsed) {
      const meta = metas.get(h.ruleCode);
      if (!meta) throw new Error(`rule ${h.ruleCode} missing from the catalogue`);
      const confidence = Math.round(h.extractionQuality * meta.specificity * h.independence * 1000) / 1000;
      const hitScore = Math.round(h.severity * confidence * 1000) / 1000;
      const tier = tierFor(h, meta, confidence);
      const computed = { ...h.computed, collapsed_from: h.collapsedFrom };
      const up = await client.query<{ id: string; status: string }>(
        `insert into public.findings (community_id, rule_code, rule_version, fingerprint, event_key, severity, extraction_quality, specificity, independence, confidence, hit_score,
            entity_type, entity_id, works_package_id, fiscal_year, amount_at_stake, act_date_first, act_date_last, computed, summary_es, summary_en, innocent_explanations, next_check, resolving_document, tier, first_seen_run_id, last_seen_run_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22::jsonb,$23,$24,$25,$26,$26)
         on conflict (community_id, fingerprint) do update set
           rule_version = excluded.rule_version, event_key = excluded.event_key, severity = excluded.severity,
           extraction_quality = excluded.extraction_quality, specificity = excluded.specificity, independence = excluded.independence,
           confidence = excluded.confidence, hit_score = excluded.hit_score, amount_at_stake = excluded.amount_at_stake,
           act_date_first = excluded.act_date_first, act_date_last = excluded.act_date_last, computed = excluded.computed,
           summary_es = excluded.summary_es, summary_en = excluded.summary_en, innocent_explanations = excluded.innocent_explanations,
           next_check = excluded.next_check, resolving_document = excluded.resolving_document, tier = excluded.tier, last_seen_run_id = excluded.last_seen_run_id
         returning id, status`,
        [community.id, h.ruleCode, meta.version, h.fingerprint, h.eventKey, h.severity, h.extractionQuality, meta.specificity, h.independence, confidence, hitScore,
          h.entityType, h.entityId ?? null, h.worksPackageId ?? null, h.fiscalYear ?? null, h.amountAtStake ?? null, h.actDateFirst ?? null, h.actDateLast ?? null,
          JSON.stringify(computed), h.summaryEs, h.summaryEn, JSON.stringify(h.innocentExplanations), h.nextCheck, h.resolvingDocument ?? null, tier, runId],
      );
      const fid = up.rows[0]!.id;
      await client.query('delete from public.finding_evidence where finding_id = $1', [fid]);
      for (const e of h.evidence) {
        await client.query(
          `insert into public.finding_evidence (finding_id, label, document_id, resolution_id, bank_transaction_id, computed) values ($1,$2,$3,$4,$5,$6::jsonb)`,
          [fid, e.label, e.documentId ?? null, e.resolutionId ?? null, e.bankTransactionId ?? null, JSON.stringify(e.computed ?? {})],
        );
      }
      stored++;
    }
    await client.query('update public.finding_runs set finished_at = now(), stats = $2::jsonb where id = $1', [runId, JSON.stringify({ ran, findings: stored })]);
    await client.query("select public.log_access($1, 'rule_run', 'finding_run', $2, null, $3::jsonb, 'vx rules')", [community.id, runId, JSON.stringify({ ran, findings: stored })]);
    return { runId, ran, count: collapsed.length, stored };
  });

  console.log(`rules run ${result.runId ?? '(dry run)'}: ${result.ran.join(' ')}`);
  console.log(`findings: ${result.count} (${result.stored} stored)`);
}
