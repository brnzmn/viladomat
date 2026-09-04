/**
 * `vx letters --finding <id>` — render the "Solicitud de aclaraciones" letter for one
 * finding, from the template archived in `docs/legal/retention-and-sharing.md` §4.
 *
 * The letter is the right-of-reply step: it lists the item as a discrepancy to verify,
 * names the documents that would close it, gives at least ten calendar days to answer and
 * states that any written reply will be reproduced in full next to the item. It carries no
 * scores, no tier labels and no rule names, and refers to people by role.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { query, transaction } from '../lib/db.ts';
import { REPO_ROOT, envOptional } from '../lib/env.ts';
import { uploadObject } from '../lib/storage.ts';

/** At least ten calendar days from delivery, per the retention and sharing policy. */
export const REPLY_WINDOW_DAYS = 10;

type Lang = 'es' | 'en';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function findChromium(): string | null {
  const fromEnv = envOptional('CHROMIUM_PATH');
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
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

/** Same Chromium invocation as the pack renderer. */
function htmlToPdf(htmlPath: string, pdfPath: string): boolean {
  const chromium = findChromium();
  if (!chromium) return false;
  const r = spawnSync(
    chromium,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
    { stdio: 'ignore', timeout: 120000 },
  );
  return r.status === 0 && existsSync(pdfPath);
}

export interface LetterFinding {
  id: string;
  ref: string;
  summaryEs: string;
  summaryEn: string;
  amountAtStake: number | null;
  actDateFirst: string | null;
  actDateLast: string | null;
  nextCheck: string | null;
  resolvingDocument: string | null;
  status: string;
  evidence: Array<{ label: string; ref: string }>;
}

export interface LetterData {
  community: { id: string; name: string; address: string | null };
  finding: LetterFinding;
  today: string;
  deadline: string;
  requestDate: string | null;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function eur(v: number | null, lang: Lang): string {
  if (v == null) return '—';
  return new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-GB', { style: 'currency', currency: 'EUR' }).format(v);
}

/** Load everything the letter prints for one finding. */
export async function loadLetterData(findingId: string, today: string): Promise<LetterData> {
  const rows = await query<Record<string, unknown>>(
    `select f.id, f.community_id, f.summary_es, f.summary_en, f.amount_at_stake, f.act_date_first, f.act_date_last,
            f.next_check, f.resolving_document, f.status::text as status,
            c.name as community_name, c.address as community_address
       from public.findings f join public.communities c on c.id = f.community_id
      where f.id = $1`,
    [findingId],
  );
  const f = rows[0];
  if (!f) throw new Error(`finding ${findingId} not found`);
  const evidenceRows = await query<Record<string, unknown>>(
    `select fe.label, fe.document_id, p.page_no, fi.sha256
       from public.finding_evidence fe
       left join public.pages p on p.id = fe.page_id
       left join public.files fi on fi.id = p.file_id
      where fe.finding_id = $1 order by fe.created_at, fe.id`,
    [findingId],
  );
  const evidence = evidenceRows.map((e) => {
    const parts: string[] = [];
    if (e.document_id != null) parts.push(`D-${String(e.document_id).slice(0, 8)}`);
    if (e.page_no != null) parts.push(`p. ${String(e.page_no)}`);
    if (e.sha256 != null) parts.push(`sha256 ${String(e.sha256).slice(0, 8)}`);
    return { label: String(e.label), ref: parts.join(' · ') };
  });
  const clock = await query<{ request_date: unknown }>(
    'select request_date from public.request_clock where community_id = $1 and request_date is not null order by request_date limit 1',
    [String(f.community_id)],
  );
  return {
    community: {
      id: String(f.community_id),
      name: String(f.community_name),
      address: f.community_address == null ? null : String(f.community_address),
    },
    finding: {
      id: String(f.id),
      ref: `F-${String(f.id).slice(0, 8)}`,
      summaryEs: String(f.summary_es ?? ''),
      summaryEn: String(f.summary_en ?? ''),
      amountAtStake: f.amount_at_stake == null ? null : Number(f.amount_at_stake),
      actDateFirst: f.act_date_first == null ? null : String(f.act_date_first).slice(0, 10),
      actDateLast: f.act_date_last == null ? null : String(f.act_date_last).slice(0, 10),
      nextCheck: f.next_check == null ? null : String(f.next_check),
      resolvingDocument: f.resolving_document == null ? null : String(f.resolving_document),
      status: String(f.status),
      evidence,
    },
    today,
    deadline: addDays(today, REPLY_WINDOW_DAYS),
    requestDate: clock[0]?.request_date == null ? null : String(clock[0]!.request_date).slice(0, 10),
  };
}

const GENERAL_REQUESTS_ES = [
  'Cuentas anuales y presupuestos de los ejercicios objeto de revisión.',
  'Estado de aplicación de las derramas por entidad y período.',
  'Facturas, justificantes de pago y extractos bancarios (preferiblemente en formato Norma 43 o CSV) de todas las cuentas de la Comunidad, y certificado bancario de titularidad y personas autorizadas.',
  'Contratos de obra y de ascensor, certificaciones de obra y certificado final de obra.',
  'Expedientes de licencia o comunicado de obras y autoliquidaciones del ICIO; expedientes de subvención, si los hubiera.',
  'Declaración sobre cualquier relación entre cargos de la Comunidad y las empresas contratadas.',
];

const GENERAL_REQUESTS_EN = [
  'Annual accounts and budgets for the fiscal years under review.',
  'Statement of application of the extraordinary contributions by unit and period.',
  'Invoices, proofs of payment and bank statements (preferably in Norma 43 or CSV format) of all the Community\'s accounts, and the bank\'s certificate of account holder and authorised persons.',
  'Works and lift contracts, work certifications and the final works certificate.',
  'Building-permit files and ICIO self-assessments; subsidy files, if any.',
  'Declaration of any relationship between the Community\'s office-holders and the contracted companies.',
];

/** Render the letter. Wording follows the archived template; only the item row varies. */
export function renderLetter(data: LetterData, lang: Lang): string {
  const f = data.finding;
  const es = lang === 'es';
  const openingSentence = data.requestDate
    ? es
      ? `Los propietarios abajo indicados, que solicitaron la convocatoria de junta extraordinaria el ${data.requestDate}, están revisando la documentación de la Comunidad para preparar dicha junta.`
      : `The owners listed below, who requested the convening of an extraordinary meeting on ${data.requestDate}, are reviewing the Community's records in order to prepare that meeting.`
    : es
      ? 'Los propietarios abajo indicados están revisando la documentación de la Comunidad en ejercicio de su derecho de información sobre las cuentas.'
      : "The owners listed below are reviewing the Community's records in exercise of their right to information on the accounts.";
  const dates = [f.actDateFirst, f.actDateLast].filter(Boolean).join(' / ') || '—';
  const evidence = f.evidence.length > 0 ? f.evidence.map((e) => `${e.label}${e.ref ? ` (${e.ref})` : ''}`).join('; ') : '—';
  const requested = f.resolvingDocument ?? f.nextCheck ?? (es ? 'documento que permita cerrar el punto' : 'the document that would close the item');

  const title = es
    ? 'Solicitud de aclaraciones sobre determinados apuntes de las cuentas de la Comunidad'
    : 'Request for clarifications on certain entries in the Community\'s accounts';

  const body = es
    ? `
<p><strong>Asunto:</strong> ${esc(title)}</p>
<p>A la atención de la administración de la finca y, en lo que le concierna, de la presidencia<br>
${esc(data.community.name)}${data.community.address ? `<br>${esc(data.community.address)}` : ''}</p>
<p>Barcelona, ${esc(data.today)}</p>
<p>${esc(openingSentence)}</p>
<p>En el curso de esa revisión se ha identificado el punto que se relaciona a continuación, respecto del cual no hemos localizado en la documentación disponible el soporte o la conciliación correspondiente. Se trata de una discrepancia a verificar: no prejuzgamos su explicación y agradeceremos cualquier aclaración o documento que permita cerrarla.</p>
<table>
  <thead><tr><th>Ref.</th><th>Descripción del punto</th><th>Importe</th><th>Fecha</th><th>Documentos de referencia (huella / página)</th><th>Documento que se solicita</th></tr></thead>
  <tbody><tr><td>${esc(f.ref)}</td><td>${esc(f.summaryEs)}</td><td>${esc(eur(f.amountAtStake, 'es'))}</td><td>${esc(dates)}</td><td>${esc(evidence)}</td><td>${esc(requested)}</td></tr></tbody>
</table>
<p>Les rogamos que, en el plazo de diez días naturales desde la recepción de esta carta (hasta el ${esc(data.deadline)}), nos remitan las aclaraciones y los documentos indicados a la dirección de contacto facilitada. Cualquier respuesta escrita se reproducirá íntegramente junto a este punto en la documentación que se ponga a disposición de la junta o del revisor independiente.</p>
<p>Transcurrido el plazo sin respuesta, el punto se hará constar como «aclaraciones solicitadas el ${esc(data.today)}; sin respuesta a ${esc(data.deadline)}».</p>
<p>Documentos solicitados con carácter general (documentación disponible desde la convocatoria, art. 553-21 CCCat, artículo a verificar):</p>
<ol>${GENERAL_REQUESTS_ES.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
<p>Atentamente,</p>
<p>Los propietarios solicitantes (entidades indicadas en la solicitud de junta)</p>`
    : `
<p><strong>Subject:</strong> ${esc(title)}</p>
<p>For the attention of the property administrator and, as far as it concerns them, the presidency<br>
${esc(data.community.name)}${data.community.address ? `<br>${esc(data.community.address)}` : ''}</p>
<p>Barcelona, ${esc(data.today)}</p>
<p>${esc(openingSentence)}</p>
<p>In the course of that review the item listed below was identified, for which we have not located in the available records the corresponding supporting document or reconciliation. This is a discrepancy to verify: we do not prejudge its explanation and would be grateful for any clarification or document that allows it to be closed.</p>
<table>
  <thead><tr><th>Ref.</th><th>Description of the item</th><th>Amount</th><th>Date</th><th>Reference documents (hash / page)</th><th>Document requested</th></tr></thead>
  <tbody><tr><td>${esc(f.ref)}</td><td>${esc(f.summaryEn)}</td><td>${esc(eur(f.amountAtStake, 'en'))}</td><td>${esc(dates)}</td><td>${esc(evidence)}</td><td>${esc(requested)}</td></tr></tbody>
</table>
<p>We ask that, within ten calendar days of receipt of this letter (by ${esc(data.deadline)}), you send the clarifications and documents indicated to the contact address provided. Any written reply will be reproduced in full next to this item in the material made available to the assembly or to the independent reviewer.</p>
<p>If the period elapses without a reply, the item will be recorded as "clarifications requested on ${esc(data.today)}; no reply as of ${esc(data.deadline)}".</p>
<p>Documents requested generally (records available from the convocation, CCCat art. 553-21, article to be verified):</p>
<ol>${GENERAL_REQUESTS_EN.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
<p>Yours faithfully,</p>
<p>The requesting owners (units named in the meeting request)</p>`;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(title)} — ${esc(f.ref)}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;font-size:11pt;line-height:1.45;color:#111;margin:0}
  table{border-collapse:collapse;width:100%;margin:1em 0;font-size:9.5pt}
  th,td{border:1px solid #999;padding:.4em .5em;text-align:left;vertical-align:top}
  th{background:#f2f2f2;font-family:Helvetica,Arial,sans-serif}
  ol{padding-left:1.2em}
  .foot{margin-top:2em;border-top:1px solid #ccc;padding-top:.6em;font-family:Helvetica,Arial,sans-serif;font-size:8.5pt;color:#555}
  @page{size:A4;margin:2cm}
</style>
</head>
<body>
${body}
<p class="foot">${esc(f.ref)} · ${esc(data.today)} · ${es ? 'discrepancia a verificar; no constituye imputación alguna' : 'discrepancy to verify; it states no allegation'}</p>
</body>
</html>`;
}

export async function lettersCommand(opts: { finding: string; lang?: string; out?: string }): Promise<void> {
  const lang: Lang = opts.lang === 'en' ? 'en' : 'es';
  const today = new Date().toISOString().slice(0, 10);
  const data = await loadLetterData(opts.finding, today);
  const html = renderLetter(data, lang);
  const canonicalSha = createHash('sha256').update(html).digest('hex');

  const outDir = path.isAbsolute(opts.out ?? '') ? opts.out! : path.join(REPO_ROOT, opts.out ?? 'exports/letters');
  mkdirSync(outDir, { recursive: true });
  const base = `aclaraciones-${data.finding.ref}-${lang}-${today}`;
  const htmlPath = path.join(outDir, `${base}.html`);
  writeFileSync(htmlPath, html);
  const pdfPath = path.join(outDir, `${base}.pdf`);
  const pdfOk = htmlToPdf(htmlPath, pdfPath);
  const pdfSha = pdfOk ? createHash('sha256').update(readFileSync(pdfPath)).digest('hex') : null;

  const objectBase = `${data.community.id}/letters/${base}`;
  const uploaded = await uploadObject('exports', `${objectBase}.html`, Buffer.from(html), 'text/html');
  if (pdfOk) await uploadObject('exports', `${objectBase}.pdf`, readFileSync(pdfPath), 'application/pdf');

  await transaction(async (client) => {
    await client.query(
      `insert into public.report_exports (community_id, kind, storage_path, sha256, canonical_sha256, manifest)
       values ($1, 'explanation_letter', $2, $3, $4, $5::jsonb)`,
      [
        data.community.id,
        uploaded ? `${objectBase}.html` : htmlPath,
        pdfSha ?? canonicalSha,
        canonicalSha,
        JSON.stringify({
          finding_id: data.finding.id,
          finding_ref: data.finding.ref,
          lang,
          generated_on: today,
          reply_by: data.deadline,
          reply_window_days: REPLY_WINDOW_DAYS,
          html_sha256: canonicalSha,
          pdf_sha256: pdfSha,
        }),
      ],
    );
    await client.query(
      `insert into public.finding_reviews (finding_id, from_status, to_status, reason)
       values ($1, $2::public.finding_status, 'sent_for_explanation', $3)`,
      [data.finding.id, data.finding.status, `letter generated ${today}; reply requested by ${data.deadline}`],
    );
    await client.query(
      "select public.log_access($1, 'export', 'finding', $2, null, $3::jsonb, 'vx letters')",
      [data.community.id, data.finding.id, JSON.stringify({ lang, canonical_sha256: canonicalSha, reply_by: data.deadline })],
    );
  });

  console.log(`letter written: ${htmlPath}`);
  console.log(pdfOk ? `pdf written:   ${pdfPath}` : 'pdf skipped: no Chromium found (set CHROMIUM_PATH)');
  console.log(`canonical html sha256: ${canonicalSha}`);
  if (pdfSha) console.log(`pdf sha256: ${pdfSha}`);
  console.log(`reply requested by ${data.deadline} (${REPLY_WINDOW_DAYS} calendar days)`);
}
