/**
 * `vx report --reproduce <report_export_id>`.
 *
 * A pack may not be distributed until it can be rebuilt from the same inputs and shown to be
 * the same document. This module does three independent comparisons and reports each:
 *
 *  1. **Parameters.** The run stored its parameter snapshot. Parameters are versioned and
 *     append-only, so reading the current rows is equivalent as long as no newer version has
 *     been inserted since; a newer version is reported rather than silently used.
 *  2. **Findings.** The rule engine runs again in dry mode, inside a transaction that is rolled
 *     back, and the set of `(fingerprint, severity, tier, amount_at_stake, computed)` is
 *     compared with what the run stored.
 *  3. **Document.** The pack is rendered again and the SHA-256 of its canonical body — the part
 *     without timestamps — is compared with `report_exports.canonical_sha256`.
 *
 * Any non-empty difference is printed and makes the command exit non-zero, which is the gate
 * the sharing policy relies on.
 */
import type pg from 'pg';
import { transaction } from '../lib/db.ts';
import { collapse, tierFor, type RuleContext, type RuleHit, type RuleMeta } from '../rules/engine.ts';
import { ALL_RULES } from '../rules/index.ts';
import type { Lang } from './i18n.ts';
import { loadAuditorData, renderAuditor } from './auditor.ts';
import { loadLawyerData, renderLawyer } from './lawyer.ts';
import { buildDataRoom } from './dataroom.ts';
import { loadPreJuntaData, renderPreJunta } from './prejunta.ts';
import { canonicalSha256, sha256 } from './sections.ts';

export type PackKind = 'pre-junta' | 'auditor' | 'lawyer' | 'data-room';

export interface FindingSignature {
  fingerprint: string;
  severity: number;
  tier: string | null;
  amountAtStake: number | null;
  computed: Record<string, unknown>;
}

export type DiffKind = 'missing' | 'unexpected' | 'changed';

export interface FindingDiff {
  kind: DiffKind;
  fingerprint: string;
  field?: string;
  stored?: unknown;
  recomputed?: unknown;
}

/** Deterministic JSON: object keys sorted, so two equal structures compare equal as text. */
export function stableJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function money(v: number | null): number | null {
  if (v == null) return null;
  return Math.round(v * 100) / 100;
}

/**
 * Compare two finding sets by fingerprint. A fingerprint present on one side only is reported
 * as missing or unexpected; a fingerprint on both sides is compared field by field.
 */
export function diffFindingSets(stored: readonly FindingSignature[], recomputed: readonly FindingSignature[]): FindingDiff[] {
  const byFingerprint = (list: readonly FindingSignature[]): Map<string, FindingSignature> => {
    const m = new Map<string, FindingSignature>();
    for (const f of list) m.set(f.fingerprint, f);
    return m;
  };
  const a = byFingerprint(stored);
  const b = byFingerprint(recomputed);
  const diffs: FindingDiff[] = [];
  for (const fp of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const s = a.get(fp);
    const r = b.get(fp);
    if (s && !r) {
      diffs.push({ kind: 'missing', fingerprint: fp, stored: s.severity });
      continue;
    }
    if (!s && r) {
      diffs.push({ kind: 'unexpected', fingerprint: fp, recomputed: r.severity });
      continue;
    }
    if (!s || !r) continue;
    if (s.severity !== r.severity) diffs.push({ kind: 'changed', fingerprint: fp, field: 'severity', stored: s.severity, recomputed: r.severity });
    if ((s.tier ?? null) !== (r.tier ?? null)) diffs.push({ kind: 'changed', fingerprint: fp, field: 'tier', stored: s.tier, recomputed: r.tier });
    if (money(s.amountAtStake) !== money(r.amountAtStake)) {
      diffs.push({ kind: 'changed', fingerprint: fp, field: 'amount_at_stake', stored: s.amountAtStake, recomputed: r.amountAtStake });
    }
    const sc = stableJson(s.computed);
    const rc = stableJson(r.computed);
    if (sc !== rc) diffs.push({ kind: 'changed', fingerprint: fp, field: 'computed', stored: sc, recomputed: rc });
  }
  return diffs;
}

export interface ParameterDrift {
  key: string;
  snapshotVersion: number | null;
  currentVersion: number | null;
  snapshotValue: string | null;
  currentValue: string | null;
}

/**
 * Keys whose current version is newer than the one the run recorded, or whose value changed.
 * Parameters are append-only, so this is an addition to the table, never an edit.
 */
export function parameterDrift(snapshot: ReadonlyArray<Record<string, unknown>>, current: ReadonlyArray<Record<string, unknown>>): ParameterDrift[] {
  const snap = new Map<string, Record<string, unknown>>();
  for (const p of snapshot) snap.set(String(p.key), p);
  const drift: ParameterDrift[] = [];
  for (const c of current) {
    const key = String(c.key);
    const s = snap.get(key);
    const cv = c.value_num == null ? null : String(c.value_num);
    const cver = c.version == null ? null : Number(c.version);
    if (!s) {
      drift.push({ key, snapshotVersion: null, currentVersion: cver, snapshotValue: null, currentValue: cv });
      continue;
    }
    const sv = s.value_num == null ? null : String(s.value_num);
    const sver = s.version == null ? null : Number(s.version);
    if (sver !== cver || Number(sv) !== Number(cv)) {
      drift.push({ key, snapshotVersion: sver, currentVersion: cver, snapshotValue: sv, currentValue: cv });
    }
  }
  return drift.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** Re-run every rule in dry mode and produce the signatures the diff compares. */
export async function recomputeSignatures(client: pg.PoolClient, cid: string, today: string): Promise<FindingSignature[]> {
  const rulesRes = await client.query<Record<string, unknown>>(
    'select code, family, version, specificity_prior, worklist_eligible, never_t1t2 from public.rules order by code',
  );
  const metas = new Map<string, RuleMeta>();
  for (const r of rulesRes.rows) {
    metas.set(String(r.code), {
      code: String(r.code),
      family: String(r.family),
      version: Number(r.version),
      specificity: Number(r.specificity_prior),
      worklistEligible: Boolean(r.worklist_eligible),
      neverT1T2: Boolean(r.never_t1t2),
    });
  }
  const ctx: RuleContext = {
    cid,
    client,
    today,
    param: async (key, onDate) => {
      const r = await client.query<{ v: string | null }>('select public.param($1, $2, $3)::text as v', [cid, key, onDate ?? today]);
      const v = r.rows[0]?.v;
      return v == null ? null : Number(v);
    },
  };
  const hits: RuleHit[] = [];
  for (const rule of Object.values(ALL_RULES)) hits.push(...(await rule(ctx)));
  const collapsed = collapse(hits);
  return collapsed
    .map((h) => {
      const meta = metas.get(h.ruleCode);
      if (!meta) throw new Error(`rule ${h.ruleCode} missing from the catalogue`);
      const confidence = Math.round(h.extractionQuality * meta.specificity * h.independence * 1000) / 1000;
      return {
        fingerprint: h.fingerprint,
        severity: h.severity,
        tier: tierFor(h, meta, confidence),
        amountAtStake: h.amountAtStake ?? null,
        computed: { ...h.computed, collapsed_from: h.collapsedFrom },
      };
    })
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

/** Signatures as the run stored them. */
export async function storedSignatures(client: pg.PoolClient, cid: string, runId: string | null): Promise<FindingSignature[]> {
  const res = await client.query<Record<string, unknown>>(
    `select fingerprint, severity, tier::text as tier, amount_at_stake, computed
       from public.findings
      where community_id = $1 and ($2::uuid is null or last_seen_run_id = $2::uuid)
      order by fingerprint`,
    [cid, runId],
  );
  return res.rows.map((r) => ({
    fingerprint: String(r.fingerprint),
    severity: Number(r.severity),
    tier: r.tier == null ? null : String(r.tier),
    amountAtStake: r.amount_at_stake == null ? null : Number(r.amount_at_stake),
    computed: (r.computed as Record<string, unknown> | null) ?? {},
  }));
}

export interface ReproduceResult {
  reportId: string;
  kind: string;
  pack: PackKind;
  lang: Lang;
  communityId: string;
  findingRunId: string | null;
  generatedOn: string;
  canonicalExpected: string | null;
  canonicalActual: string;
  canonicalMatches: boolean;
  parameterDrift: ParameterDrift[];
  findingDiffs: FindingDiff[];
  ok: boolean;
}

function packOfKind(manifestPack: unknown, kind: string): PackKind {
  const p = manifestPack == null ? null : String(manifestPack);
  if (p === 'pre-junta' || p === 'auditor' || p === 'lawyer' || p === 'data-room') return p;
  if (kind === 'auditor_es') return 'auditor';
  if (kind === 'lawyer_es') return 'lawyer';
  if (kind === 'data_room') return 'data-room';
  return 'pre-junta';
}

/**
 * Rebuild a stored export and compare it with what was recorded. The whole comparison runs in
 * one transaction that is rolled back, so reproducing never changes the data it reads; only the
 * `reproduced_ok` flag is written afterwards.
 */
export async function reproduceReport(reportId: string): Promise<ReproduceResult> {
  const result = await transaction(async (client) => {
    const rows = (
      await client.query<Record<string, unknown>>(
        `select id, community_id, kind::text as kind, canonical_sha256, manifest, finding_run_id, generated_at
           from public.report_exports where id = $1`,
        [reportId],
      )
    ).rows;
    const report = rows[0];
    if (!report) throw new Error(`report export ${reportId} not found`);
    const cid = String(report.community_id);
    const manifest = (report.manifest as Record<string, unknown> | null) ?? {};
    const pack = packOfKind(manifest.pack, String(report.kind));
    const lang: Lang = manifest.lang === 'en' ? 'en' : 'es';
    const generatedOn = manifest.generated_on == null ? String(report.generated_at).slice(0, 10) : String(manifest.generated_on).slice(0, 10);
    const runId = report.finding_run_id == null ? null : String(report.finding_run_id);

    // 1. parameters
    const snapshotRes = runId
      ? await client.query<{ parameters_snapshot: unknown }>('select parameters_snapshot from public.finding_runs where id = $1', [runId])
      : { rows: [] as Array<{ parameters_snapshot: unknown }> };
    const snapshot = (snapshotRes.rows[0]?.parameters_snapshot as Array<Record<string, unknown>> | undefined) ?? [];
    const current = (
      await client.query<Record<string, unknown>>(
        `select distinct on (key) key, value_num, unit, version, valid_from from public.parameters
          where community_id = $1 order by key, valid_from desc, version desc`,
        [cid],
      )
    ).rows;
    const drift = parameterDrift(snapshot, current);

    // 2. findings
    const recomputed = await recomputeSignatures(client, cid, generatedOn);
    const stored = await storedSignatures(client, cid, runId);
    const findingDiffs = diffFindingSets(stored, recomputed);

    // 3. document
    let canonicalActual: string;
    if (pack === 'auditor') {
      const data = await loadAuditorData(client, cid, generatedOn, lang);
      canonicalActual = canonicalSha256(renderAuditor(data, lang));
    } else if (pack === 'lawyer') {
      const data = await loadLawyerData(client, cid, generatedOn, lang);
      canonicalActual = canonicalSha256(renderLawyer(data, lang));
    } else if (pack === 'data-room') {
      const bundle = await buildDataRoom(client, cid, generatedOn, lang);
      canonicalActual = bundle.bundleSha256;
    } else {
      const data = await loadPreJuntaData(client, cid, generatedOn);
      canonicalActual = sha256(renderPreJunta(data, lang));
    }
    const canonicalExpected = report.canonical_sha256 == null ? null : String(report.canonical_sha256);
    const canonicalMatches = canonicalExpected != null && canonicalExpected === canonicalActual;

    return {
      reportId,
      kind: String(report.kind),
      pack,
      lang,
      communityId: cid,
      findingRunId: runId,
      generatedOn,
      canonicalExpected,
      canonicalActual,
      canonicalMatches,
      parameterDrift: drift,
      findingDiffs,
      ok: canonicalMatches && findingDiffs.length === 0 && drift.length === 0,
    } satisfies ReproduceResult;
  });

  return result;
}

/** Record the outcome on the export row. Kept outside the read transaction on purpose. */
export async function recordReproduction(client: pg.PoolClient, r: ReproduceResult): Promise<void> {
  await client.query('update public.report_exports set reproduced_ok = $2, reproduced_at = now() where id = $1', [r.reportId, r.ok]);
  await client.query("select public.log_access($1, 'export', 'report', $2, null, $3::jsonb, 'vx report --reproduce')", [
    r.communityId,
    r.reportId,
    JSON.stringify({
      pack: r.pack,
      lang: r.lang,
      reproduced_ok: r.ok,
      canonical_expected: r.canonicalExpected,
      canonical_actual: r.canonicalActual,
      finding_diffs: r.findingDiffs.length,
      parameter_drift: r.parameterDrift.length,
    }),
  ]);
}

/** Human-readable diff, one line per difference. */
export function formatReproduceResult(r: ReproduceResult): string[] {
  const lines: string[] = [];
  lines.push(`report ${r.reportId} · pack ${r.pack} · ${r.lang} · generated on ${r.generatedOn}`);
  lines.push(`canonical body sha256 expected ${r.canonicalExpected ?? '(none recorded)'}`);
  lines.push(`canonical body sha256 actual   ${r.canonicalActual}`);
  lines.push(r.canonicalMatches ? 'document: identical' : 'document: DIFFERS');
  if (r.parameterDrift.length === 0) lines.push('parameters: unchanged since the run');
  for (const d of r.parameterDrift) {
    lines.push(`parameters: ${d.key} snapshot v${d.snapshotVersion ?? '—'} = ${d.snapshotValue ?? '—'} · current v${d.currentVersion ?? '—'} = ${d.currentValue ?? '—'}`);
  }
  if (r.findingDiffs.length === 0) lines.push('findings: identical');
  for (const d of r.findingDiffs) {
    if (d.kind === 'changed') lines.push(`findings: ${d.fingerprint.slice(0, 12)} ${d.field} stored=${String(d.stored)} recomputed=${String(d.recomputed)}`);
    else lines.push(`findings: ${d.fingerprint.slice(0, 12)} ${d.kind}`);
  }
  lines.push(r.ok ? 'reproduce: empty diff' : 'reproduce: NON-EMPTY DIFF — do not distribute');
  return lines;
}
