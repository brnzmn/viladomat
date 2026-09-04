import type pg from 'pg';
import { strings, type Lang } from './i18n.ts';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const d = (v: unknown): string => (v == null ? '' : String(v).slice(0, 10));
const eur = (v: unknown, lang: Lang): string =>
  v == null || v === '' ? '' : new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-GB', { style: 'currency', currency: 'EUR' }).format(Number(v));

function table(cols: readonly string[], rows: unknown[][], none: string): string {
  if (rows.length === 0) return `<p class="muted">${esc(none)}</p>`;
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${typeof c === 'string' && c.startsWith('<') ? c : esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export interface PreJuntaData {
  community: { id: string; name: string; nif: string | null };
  today: string;
  requestClock: Record<string, unknown> | null;
  meetings: Array<Record<string, unknown>>;
  resolutions: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  challengeable: Array<Record<string, unknown>>;
  works: Array<Record<string, unknown>>;
  openRequestFindings: Array<Record<string, unknown>>;
  vendors: Array<Record<string, unknown>>;
  findingRunId: string | null;
}

export async function loadPreJuntaData(client: pg.PoolClient, cid: string, today: string): Promise<PreJuntaData> {
  const q = async (sql: string) => (await client.query(sql, [cid])).rows as Array<Record<string, unknown>>;
  const [community] = await q('select id, name, nif from public.communities where id = $1');
  const [requestClock] = await q('select * from public.request_clock where community_id = $1');
  const meetings = await q('select * from public.meetings where community_id = $1 order by fecha');
  const resolutions = await q(
    `select r.*, m.fecha as meeting_fecha, m.tipo as meeting_tipo, w.label as works_label from public.resolutions r
       join public.meetings m on m.id = r.meeting_id left join public.works_packages w on w.id = r.works_package_id
      where r.community_id = $1 order by m.fecha, r.punto`,
  );
  const requests = await q('select * from public.document_requests where community_id = $1 order by class, fiscal_year');
  const challengeable = await q(
    `select * from public.v_challengeable_resolutions where community_id = $1 and (open_3m or open_12m) order by meeting_date, punto`,
  );
  const works = await q(
    `select f.*, w.label, w.status from public.v_works_funding f join public.works_packages w on w.id = f.works_package_id where f.community_id = $1 order by w.code`,
  );
  const openRequestFindings = await q(
    `select summary_es, summary_en, computed from public.findings where community_id = $1 and rule_code in ('E5', 'E6') and status not in ('dismissed_fp', 'explained') order by severity desc, created_at`,
  );
  const vendors = await q(
    `select p.display_name, p.nif, p.nif_valid, p.kind, p.origin_class, d.doc_date as first_doc_date from public.parties p
       left join public.documents d on d.id = p.first_seen_document_id where p.community_id = $1 and p.kind in ('vendor', 'architect') order by p.display_name`,
  );
  const [run] = await q('select id from public.finding_runs where community_id = $1 order by started_at desc limit 1');
  return {
    community: community as PreJuntaData['community'],
    today,
    requestClock: requestClock ?? null,
    meetings, resolutions, requests, challengeable, works, openRequestFindings, vendors,
    findingRunId: (run?.id as string | undefined) ?? null,
  };
}

export function renderPreJunta(data: PreJuntaData, lang: Lang): string {
  const t = strings(lang);
  const rc = data.requestClock;
  const elapsed = rc?.request_date ? Math.floor((Date.parse(data.today) - Date.parse(d(rc.request_date))) / 86400000) : null;
  const yn = (v: unknown) => (v == null ? '' : v ? t.yes : t.no);

  const calendar = `
    <dl>
      <dt>${esc(t.requestDate)}</dt><dd>${esc(d(rc?.request_date) || t.notRecorded)}</dd>
      <dt>${esc(t.daysElapsed)}</dt><dd>${elapsed == null ? esc(t.notRecorded) : elapsed}</dd>
      <dt>${esc(t.convocation)}</dt><dd>${esc(d(rc?.convocation_date) || t.notRecorded)}</dd>
      <dt>${esc(t.juntaDate)}</dt><dd>${esc(d(rc?.junta_date) || t.notRecorded)}</dd>
      <dt>${esc(t.noticeDays)}</dt><dd>${rc?.notice_days == null ? esc(t.notRecorded) : esc(rc.notice_days)}</dd>
      <dt>${esc(t.docsAvailable)}</dt><dd>${esc(d(rc?.docs_available_from) || t.notRecorded)}</dd>
    </dl>
    <h3>${esc(t.meetings)}</h3>
    ${table(
      t.meetingCols,
      data.meetings.map((m) => [d(m.fecha), m.tipo, d(m.convocatoria_fecha), m.notice_days ?? '', m.fecha_firma ? `${d(m.fecha_firma)} (${yn(m.signed_within_5d)})` : '', m.fecha_notificacion ? `${d(m.fecha_notificacion)} (${yn(m.sent_within_10d)})` : '', yn(m.cuentas_aprobadas), eur(m.presupuesto_aprobado, lang), m.seed_verified_at ? t.verified : t.pending]),
      t.none,
    )}`;

  const requests = table(
    t.requestCols,
    data.requests.map((r) => [r.class, r.fiscal_year ?? '', r.description ?? '', r.status, d(r.requested_on), r.requested_via ?? '', d(r.received_on), Array.isArray(r.received_file_ids) ? (r.received_file_ids as unknown[]).length : 0]),
    t.none,
  );

  const byMeeting = new Map<string, Array<Record<string, unknown>>>();
  for (const r of data.resolutions) {
    const key = `${d(r.meeting_fecha)} · ${String(r.meeting_tipo)}`;
    byMeeting.set(key, [...(byMeeting.get(key) ?? []), r]);
  }
  const quotes = [...byMeeting.entries()]
    .map(
      ([k, rows]) =>
        `<h3>${esc(k)}</h3>${table(
          t.resolutionCols,
          rows.map((r) => [r.punto ?? '', r.kind, `<blockquote>${esc(r.texto_literal)}</blockquote>`, eur(r.importe_aprobado, lang), r.delegation_to_role ? `${esc(r.delegation_to_role)}: ${esc(r.delegation_scope ?? '')}${r.cap_explicit === false ? ' (sin límite explícito / no explicit cap)' : ''}` : '', r.page_no ?? '']),
          t.none,
        )}`,
    )
    .join('') || `<p class="muted">${esc(t.none)}</p>`;

  const challenge = table(
    t.challengeCols,
    data.challengeable.map((c) => [d(c.meeting_date), c.punto ?? '', c.kind, c.texto_resumen, c.open_3m ? d(c.challenge_3m_until) : '—', c.open_12m ? d(c.challenge_12m_until) : '—', c.notification_date_unknown ? (lang === 'es' ? 'fecha de notificación desconocida' : 'notification date unknown') : '']),
    t.none,
  );

  const works = `<p class="note">${esc(t.figuresNote)}</p>${table(
    t.worksCols,
    data.works.map((w) => [w.label, w.status, eur(w.contract_price, lang), eur(w.architect_pem, lang), eur(w.permit_pem, lang), eur(w.subsidy_protegible, lang), eur(w.derrama_expected, lang), eur(w.subsidy_received, lang), eur(w.loan_received, lang), w.suspension_date ? `${d(w.suspension_date)} (${String(w.suspension_reason ?? '')})` : '']),
    t.none,
  )}`;

  const questions = `<p>${esc(t.questionsIntro)}</p><ol>${t.standardQuestions.map((qtxt) => `<li>${esc(qtxt)}</li>`).join('')}${data.openRequestFindings
    .map((f) => `<li>${esc(lang === 'es' ? f.summary_es : f.summary_en)}</li>`)
    .join('')}</ol>`;

  const drafts = `<p>${esc(t.draftsIntro)}</p>${t.drafts.map(([h, body]) => `<h3>${esc(h)}</h3><p class="draft">${esc(body)}</p>`).join('')}`;

  const vendors = table(
    t.vendorCols,
    data.vendors.map((v) => [v.display_name, v.nif ?? '', yn(v.nif_valid), v.kind, v.origin_class, d(v.first_doc_date)]),
    t.none,
  );

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t.title)} — ${esc(data.community.name)}</title>
<style>
  body{font-family:Georgia,serif;font-size:11pt;line-height:1.4;margin:2cm;color:#111}
  h1{font-size:18pt;margin:0 0 .2em} h2{font-size:14pt;margin:1.6em 0 .4em;border-bottom:1px solid #999;padding-bottom:.2em} h3{font-size:12pt;margin:1em 0 .3em}
  .banner{border:1px solid #b00;color:#b00;padding:.5em .8em;margin:1em 0;font-family:Helvetica,Arial,sans-serif;font-size:9.5pt}
  .method,.note{background:#f4f4f4;padding:.6em .8em;font-size:9.5pt}
  table{border-collapse:collapse;width:100%;margin:.4em 0;font-size:9.5pt} th,td{border:1px solid #bbb;padding:.3em .4em;vertical-align:top;text-align:left}
  th{background:#eee} blockquote{margin:0;font-style:italic} dl{display:grid;grid-template-columns:max-content 1fr;gap:.2em 1em} dt{font-weight:bold}
  .muted{color:#666;font-style:italic} .draft{border-left:3px solid #999;padding-left:.8em} footer{margin-top:2em;font-size:8.5pt;color:#555;font-family:Helvetica,Arial,sans-serif}
  @page{size:A4;margin:1.5cm}
</style></head><body>
<h1>${esc(t.title)}</h1>
<p><strong>${esc(t.community)}:</strong> ${esc(data.community.name)}${data.community.nif ? ` (${esc(data.community.nif)})` : ''} · ${esc(t.generated)} ${esc(data.today)}</p>
<p>${esc(t.subtitle)}</p>
<div class="banner">${esc(t.banner)}</div>
<div class="method">${esc(t.method)}</div>
<h2>${esc(t.s1)}</h2>${calendar}
<h2>${esc(t.s2)}</h2>${requests}
<h2>${esc(t.s3)}</h2>${quotes}
<h2>${esc(t.s4)}</h2>${challenge}
<h2>${esc(t.s5)}</h2>${works}
<h2>${esc(t.s6)}</h2>${questions}
<h2>${esc(t.s7)}</h2>${drafts}
<h2>${esc(t.s8)}</h2>${vendors}
<footer>${esc(t.reference)} community ${esc(data.community.id)}${data.findingRunId ? ` · run ${esc(data.findingRunId.slice(0, 8))}` : ''} · pack pre-junta v0 · ${esc(lang)}</footer>
</body></html>`;
}
