/**
 * `vx report` — render a pack.
 *
 *   --pack pre-junta     the assembly working document (M0, unchanged)
 *   --pack auditor       the report on the verification of amounts
 *   --pack lawyer        the annex for counsel
 *   --pack data-room     the hashed ledgers and their manifest
 *   --reproduce <id>     rebuild a stored export and diff it
 *
 * Every export writes a `report_exports` row carrying the storage path, the hash of the
 * distributed artefact, the hash of the canonical body (what `--reproduce` compares) and a
 * manifest that states how many items were included, how many were withheld pending the right
 * of reply and how many legal citations were withheld pending an archived source. Every export
 * is logged through `public.log_access`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { transaction, query } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { REPO_ROOT, envOptional, PIPELINE_VERSION } from '../lib/env.ts';
import { uploadObject, storageMode } from '../lib/storage.ts';
import { loadPreJuntaData, renderPreJunta } from '../report/prejunta.ts';
import type { Lang } from '../report/i18n.ts';
import { loadAuditorData, renderAuditor } from '../report/auditor.ts';
import { loadLawyerData, renderLawyer } from '../report/lawyer.ts';
import { buildDataRoom, writeDataRoom } from '../report/dataroom.ts';
import { canonicalSha256 } from '../report/sections.ts';
import { formatReproduceResult, recordReproduction, reproduceReport } from '../report/reproduce.ts';

export type PackName = 'pre-junta' | 'auditor' | 'lawyer' | 'data-room';

const PACKS: readonly PackName[] = ['pre-junta', 'auditor', 'lawyer', 'data-room'];

export interface ReportOptions {
  community?: string;
  pack?: string;
  lang?: string;
  out?: string;
  /** report_exports id to rebuild and diff */
  reproduce?: string;
  /** withhold, rather than refuse, when T1/T2 items have not been through the right of reply */
  allowPending?: boolean;
}

function findChromium(): string | null {
  const fromEnv = envOptional('CHROMIUM_PATH');
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const base = '/opt/pw-browsers';
    if (existsSync(base)) {
      for (const dir of readdirSync(base)) {
        if (!dir.startsWith('chromium')) continue;
        for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
          const p = path.join(base, dir, sub);
          if (existsSync(p)) return p;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function htmlToPdf(htmlPath: string, pdfPath: string): boolean {
  const chromium = findChromium();
  if (!chromium) return false;
  const r = spawnSync(chromium, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: 'ignore', timeout: 120000 });
  return r.status === 0 && existsSync(pdfPath);
}

function reportKind(pack: PackName, lang: Lang): string {
  if (pack === 'data-room') return 'data_room';
  if (lang === 'en') return 'en_twin';
  if (pack === 'auditor') return 'auditor_es';
  if (pack === 'lawyer') return 'lawyer_es';
  return 'pre_junta_es';
}

/** Write the HTML, try the PDF, upload both, and return the paths and hashes. */
async function emitHtmlPack(opts: {
  cid: string;
  outDir: string;
  base: string;
  html: string;
  canonicalSha: string;
}): Promise<{ htmlPath: string; pdfPath: string | null; pdfSha: string | null; storagePath: string; htmlSha: string }> {
  mkdirSync(opts.outDir, { recursive: true });
  const htmlPath = path.join(opts.outDir, `${opts.base}.html`);
  writeFileSync(htmlPath, opts.html);
  const htmlSha = createHash('sha256').update(opts.html).digest('hex');
  const pdfPath = path.join(opts.outDir, `${opts.base}.pdf`);
  const pdfOk = htmlToPdf(htmlPath, pdfPath);
  const pdfSha = pdfOk ? createHash('sha256').update(readFileSync(pdfPath)).digest('hex') : null;

  const objectBase = `${opts.cid}/packs/${opts.base}`;
  const uploaded = await uploadObject('exports', `${objectBase}.html`, Buffer.from(opts.html), 'text/html');
  if (pdfOk) await uploadObject('exports', `${objectBase}.pdf`, readFileSync(pdfPath), 'application/pdf');
  return { htmlPath, pdfPath: pdfOk ? pdfPath : null, pdfSha, storagePath: uploaded ? `${objectBase}.html` : htmlPath, htmlSha };
}

export async function reportCommand(opts: ReportOptions): Promise<void> {
  if (opts.reproduce) {
    const result = await reproduceReport(opts.reproduce);
    await transaction(async (client) => recordReproduction(client, result));
    for (const line of formatReproduceResult(result)) console.log(line);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const pack = (opts.pack ?? 'pre-junta') as PackName;
  if (!PACKS.includes(pack)) throw new Error(`unknown pack "${pack}"; expected one of ${PACKS.join(', ')}`);
  const lang: Lang = opts.lang === 'en' ? 'en' : 'es';
  const community = await resolveCommunity(opts.community);
  const today = new Date().toISOString().slice(0, 10);
  const outRoot = path.isAbsolute(opts.out ?? '') ? opts.out! : path.join(REPO_ROOT, opts.out ?? 'exports/packs');

  if (pack === 'pre-junta') {
    const data = await transaction((client) => loadPreJuntaData(client, community.id, today));
    const html = renderPreJunta(data, lang);
    const canonicalSha = createHash('sha256').update(html).digest('hex');
    const base = `pre-junta-v0-${lang}-${today}`;
    const emitted = await emitHtmlPack({ cid: community.id, outDir: outRoot, base, html, canonicalSha });
    await query(
      `insert into public.report_exports (community_id, kind, storage_path, sha256, canonical_sha256, manifest, finding_run_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [community.id, reportKind('pre-junta', lang), emitted.storagePath, emitted.pdfSha ?? canonicalSha, canonicalSha,
        JSON.stringify({ pack: 'pre-junta', html_sha256: canonicalSha, pdf_sha256: emitted.pdfSha, generated_on: today, lang, sections: 8 }), data.findingRunId],
    );
    await query("select public.log_access($1, 'export', 'report', null, null, $2::jsonb, 'vx report --pack pre-junta')", [community.id, JSON.stringify({ lang, canonicalSha })]);
    console.log(`pack written: ${emitted.htmlPath}`);
    console.log(emitted.pdfPath ? `pdf written:  ${emitted.pdfPath}` : 'pdf skipped: no Chromium found (set CHROMIUM_PATH)');
    console.log(`canonical html sha256: ${canonicalSha}`);
    if (emitted.pdfSha) console.log(`pdf sha256: ${emitted.pdfSha}`);
    return;
  }

  if (pack === 'data-room') {
    const bundle = await transaction((client) => buildDataRoom(client, community.id, today, lang));
    const dir = path.join(outRoot, today, 'data-room');
    const written = writeDataRoom(bundle, dir);
    const objectPrefix = `${community.id}/packs/${today}/data-room`;
    for (const f of bundle.files) await uploadObject('exports', `${objectPrefix}/${f.name}`, f.content, f.name.endsWith('.json') ? 'application/json' : 'text/csv');
    await uploadObject('exports', `${objectPrefix}/manifest.json`, Buffer.from(bundle.manifestJson), 'application/json');
    await query(
      `insert into public.report_exports (community_id, kind, storage_path, sha256, canonical_sha256, manifest, finding_run_id)
       values ($1, 'data_room', $2, $3, $4, $5::jsonb, $6)`,
      [community.id, `${objectPrefix}/manifest.json`, bundle.manifestSha256, bundle.bundleSha256,
        JSON.stringify({ ...bundle.manifest, pack: 'data-room', lang }), bundle.manifest.finding_run_id],
    );
    await query("select public.log_access($1, 'export', 'report', null, null, $2::jsonb, 'vx report --pack data-room')", [
      community.id,
      JSON.stringify({ lang, files: bundle.files.length, bundle_sha256: bundle.bundleSha256, storage: storageMode() }),
    ]);
    console.log(`data room written: ${dir} (${written.length} files)`);
    console.log(`manifest sha256: ${bundle.manifestSha256}`);
    console.log(`bundle sha256:   ${bundle.bundleSha256}`);
    return;
  }

  // auditor and lawyer share the gate check and the emit path
  const built = await transaction(async (client) => {
    if (pack === 'auditor') {
      const data = await loadAuditorData(client, community.id, today, lang);
      if (data.gates.stats.unreviewed_t1t2 > 0 && !opts.allowPending) {
        throw new Error(
          `${data.gates.stats.unreviewed_t1t2} tier-1/tier-2 item(s) are still "new" or "in_review": the right of reply is not complete. ` +
            'Run `vx letters --finding <id>` for each, or pass --allow-pending to withhold and count them.',
        );
      }
      return { html: renderAuditor(data, lang), stats: data.gates.stats, runId: data.findingRunId };
    }
    const data = await loadLawyerData(client, community.id, today, lang);
    return { html: renderLawyer(data, lang), stats: data.gates.stats, runId: data.findingRunId };
  });

  const canonicalSha = canonicalSha256(built.html);
  const base = `${pack}-v1-${lang}-${today}`;
  const emitted = await emitHtmlPack({ cid: community.id, outDir: outRoot, base, html: built.html, canonicalSha });
  await query(
    `insert into public.report_exports (community_id, kind, storage_path, sha256, canonical_sha256, manifest, finding_run_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [community.id, reportKind(pack, lang), emitted.storagePath, emitted.pdfSha ?? emitted.htmlSha, canonicalSha,
      JSON.stringify({
        pack,
        lang,
        generated_on: today,
        html_sha256: emitted.htmlSha,
        pdf_sha256: emitted.pdfSha,
        canonical_sha256: canonicalSha,
        pipeline_version: PIPELINE_VERSION(),
        allow_pending: Boolean(opts.allowPending),
        gates: built.stats,
      }),
      built.runId],
  );
  await query("select public.log_access($1, 'export', 'report', null, null, $2::jsonb, $3)", [
    community.id,
    JSON.stringify({ pack, lang, canonical_sha256: canonicalSha, gates: built.stats }),
    `vx report --pack ${pack}`,
  ]);

  console.log(`pack written: ${emitted.htmlPath}`);
  console.log(emitted.pdfPath ? `pdf written:  ${emitted.pdfPath}` : 'pdf skipped: no Chromium found (set CHROMIUM_PATH)');
  console.log(`canonical body sha256: ${canonicalSha}`);
  if (emitted.pdfSha) console.log(`pdf sha256: ${emitted.pdfSha}`);
  console.log(
    `gates: ${built.stats.findings_distributed} included · ${built.stats.withheld_pending_reply} withheld pending right of reply · ` +
      `${built.stats.withheld_pending_legal_source} legal citation(s) withheld pending archive · ${built.stats.annex_only} in the annex`,
  );
}
