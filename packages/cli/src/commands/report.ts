import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { transaction, query } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { REPO_ROOT, envOptional } from '../lib/env.ts';
import { uploadObject } from '../lib/storage.ts';
import { loadPreJuntaData, renderPreJunta } from '../report/prejunta.ts';
import type { Lang } from '../report/i18n.ts';

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

export async function reportCommand(opts: { community?: string; pack: string; lang: string; out: string }): Promise<void> {
  if (opts.pack !== 'pre-junta') throw new Error(`pack "${opts.pack}" is not available yet (M0 ships pre-junta v0)`);
  const lang = (opts.lang === 'en' ? 'en' : 'es') as Lang;
  const community = await resolveCommunity(opts.community);
  const today = new Date().toISOString().slice(0, 10);
  const data = await transaction((client) => loadPreJuntaData(client, community.id, today));
  const html = renderPreJunta(data, lang);
  const canonicalSha = createHash('sha256').update(html).digest('hex');

  const outDir = path.isAbsolute(opts.out) ? opts.out : path.join(REPO_ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const base = `pre-junta-v0-${lang}-${today}`;
  const htmlPath = path.join(outDir, `${base}.html`);
  writeFileSync(htmlPath, html);
  const pdfPath = path.join(outDir, `${base}.pdf`);
  const pdfOk = htmlToPdf(htmlPath, pdfPath);
  const pdfSha = pdfOk ? createHash('sha256').update(readFileSync(pdfPath)).digest('hex') : null;

  const objectBase = `${community.id}/packs/${base}`;
  const uploadedHtml = await uploadObject('exports', `${objectBase}.html`, Buffer.from(html), 'text/html');
  if (pdfOk) await uploadObject('exports', `${objectBase}.pdf`, readFileSync(pdfPath), 'application/pdf');

  await query(
    `insert into public.report_exports (community_id, kind, storage_path, sha256, canonical_sha256, manifest, finding_run_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [community.id, lang === 'es' ? 'pre_junta_es' : 'en_twin', uploadedHtml ? `${objectBase}.html` : htmlPath, pdfSha ?? canonicalSha, canonicalSha,
      JSON.stringify({ html_sha256: canonicalSha, pdf_sha256: pdfSha, generated_on: today, lang, sections: 8 }), data.findingRunId],
  );
  await query("select public.log_access($1, 'export', 'report', null, null, $2::jsonb, 'vx report --pack pre-junta')", [community.id, JSON.stringify({ lang, canonicalSha })]);

  console.log(`pack written: ${htmlPath}`);
  console.log(pdfOk ? `pdf written:  ${pdfPath}` : 'pdf skipped: no Chromium found (set CHROMIUM_PATH)');
  console.log(`canonical html sha256: ${canonicalSha}`);
  if (pdfSha) console.log(`pdf sha256: ${pdfSha}`);
}
