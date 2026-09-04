/**
 * The auditor pack — an *informe de comprobación de cantidades*.
 *
 * Structure follows the plan: what was examined and how (with the honest statement of what
 * these records can and cannot show), governance, control totals with the cut-off bridge,
 * income, then the headline that comes **before** any discrepancy — the share of outflows that
 * is fully supported — and only then the items that are not reconciled, one per section, each
 * with its innocent explanations, the document that would close it and the counterparty's reply
 * verbatim. Annexes carry the observations, the whole rule catalogue including rules that
 * produced nothing, the price references, the cited pages and the revision log.
 *
 * Ordering is fixed (fiscal year, rule code, fingerprint) and no timestamp appears in the body,
 * so `vx report --reproduce` can compare hashes rather than prose.
 */
import type pg from 'pg';
import { m6Strings, type Lang } from './i18n.ts';
import {
  applyGates,
  loadArchivedLegalSources,
  loadGateFindings,
  loadLegalSourceRegister,
  loadRuleCatalogue,
  type GateOutcome,
  type GatedFinding,
  type LegalSourceRegisterRow,
  type RuleCatalogEntry,
} from './gates.ts';
import { loadRedactionContext, redactText, type RedactionContext } from './redact.ts';
import {
  dl,
  esc,
  evidenceRef,
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtPct,
  gateStatsBlock,
  h2,
  h3,
  muted,
  note,
  packDocument,
  scopeAndLimits,
  table,
} from './sections.ts';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};

export interface SupportedSpend {
  outflowCount: number;
  outflowAmount: number;
  withInvoiceCount: number;
  withInvoiceAmount: number;
  withResolutionCount: number;
  withResolutionAmount: number;
}

export interface AuditorData {
  community: { id: string; name: string; nif: string | null };
  today: string;
  findingRunId: string | null;
  runStats: Record<string, unknown> | null;
  pipelineVersion: string | null;
  engineVersion: string | null;
  parametersVersion: number | null;
  corpus: {
    files: number;
    filesVerified: number;
    filesQuarantined: number;
    pages: number;
    documents: number;
    documentsDuplicate: number;
    invoices: number;
    bankTx: number;
    distinctHashes: number;
  };
  batches: Row[];
  parameters: Row[];
  ruleVersions: Array<{ code: string; version: number }>;
  confirmation: { auto: number; twoPerson: number; onePerson: number; pending: number };
  calibration: Row[];
  goldenSet: number;
  requestClock: Row | null;
  meetings: Row[];
  resolutions: Row[];
  challengeable: Row[];
  controlTotals: Row[];
  continuity: Row[];
  derramaByUnit: Row[];
  subsidies: Row[];
  loans: Row[];
  supported: SupportedSpend;
  gates: GateOutcome;
  works: Row[];
  suspension: Row[];
  worksEvents: Row[];
  vendors: Row[];
  externalChecks: Row[];
  partyLinks: Row[];
  matrix: Row[];
  ruleCatalogue: RuleCatalogEntry[];
  hitsByRule: Map<string, number>;
  benchmarks: Row[];
  citedPages: Row[];
  revisionsBySource: Row[];
  reviewsByStatus: Row[];
  legalRegister: LegalSourceRegisterRow[];
  redaction: RedactionContext;
}

/** Everything the auditor pack prints, in one pass over the database. */
export async function loadAuditorData(client: pg.PoolClient, cid: string, today: string, lang: Lang): Promise<AuditorData> {
  const q = async (sql: string, params: unknown[] = [cid]): Promise<Row[]> => (await client.query(sql, params)).rows as Row[];
  const [community] = await q('select id, name, nif from public.communities where id = $1');
  if (!community) throw new Error(`community ${cid} not found`);

  const [run] = await q(
    `select id, pipeline_version, engine_version, parameters_snapshot, stats
       from public.finding_runs where community_id = $1 order by started_at desc limit 1`,
  );

  const [corpusRow] = await q(
    `select (select count(*) from public.files where community_id = $1) as files,
            (select count(*) from public.files where community_id = $1 and hash_verified) as files_verified,
            (select count(*) from public.files where community_id = $1 and status = 'quarantined') as files_quarantined,
            (select count(distinct sha256) from public.files where community_id = $1) as distinct_hashes,
            (select count(*) from public.pages where community_id = $1) as pages,
            (select count(*) from public.documents where community_id = $1) as documents,
            (select count(*) from public.documents where community_id = $1 and duplicate_of_document_id is not null) as documents_duplicate,
            (select count(*) from public.invoices where community_id = $1) as invoices,
            (select count(*) from public.bank_transactions where community_id = $1) as bank_tx`,
  );

  const [confirmRow] = await q(
    `select count(*) filter (where status = 'auto_accepted') as auto,
            count(*) filter (where second_confirmation_at is not null) as two_person,
            count(*) filter (where status in ('human_confirmed', 'corrected') and second_confirmation_at is null) as one_person,
            count(*) filter (where status = 'needs_review') as pending
       from public.field_values where community_id = $1`,
  );

  const [goldenRow] = await q('select count(*) as n from public.golden_set where community_id = $1');

  const findings = await loadGateFindings(client, cid);
  const archived = await loadArchivedLegalSources(client);
  const gates = applyGates(findings, archived, lang);
  const catalogue = await loadRuleCatalogue(client);
  const hitsByRule = new Map<string, number>();
  for (const f of findings) hitsByRule.set(f.ruleCode, (hitsByRule.get(f.ruleCode) ?? 0) + 1);

  const [supportedRow] = await q(
    `with outflows as (
       select t.id, (-t.importe)::numeric as amount
         from public.bank_transactions t
        where t.community_id = $1 and t.importe < 0 and t.tx_kind <> 'internal'
     ), classified as (
       select o.id, o.amount,
              exists (select 1 from public.recon_links rl
                       where rl.to_type = 'bank_transaction' and rl.to_id = o.id
                         and rl.link_type = 'paid_by' and rl.status = 'accepted') as has_invoice,
              exists (select 1 from public.recon_links rl
                        join public.invoices i on rl.from_type = 'invoice' and rl.from_id = i.id
                       where rl.to_type = 'bank_transaction' and rl.to_id = o.id
                         and rl.link_type = 'paid_by' and rl.status = 'accepted'
                         and (exists (select 1 from public.recon_links a
                                       where a.from_type = 'invoice' and a.from_id = i.id
                                         and a.link_type = 'authorised_by' and a.status = 'accepted')
                           or exists (select 1 from public.recon_links u
                                        join public.contracts c on u.to_type = 'contract' and u.to_id = c.id
                                       where u.from_type = 'invoice' and u.from_id = i.id
                                         and u.link_type = 'under_contract' and u.status = 'accepted'
                                         and c.authorised_by_resolution_id is not null))) as has_resolution
         from outflows o
     )
     select count(*) as n_all, coalesce(sum(amount), 0) as amt_all,
            count(*) filter (where has_invoice) as n_inv, coalesce(sum(amount) filter (where has_invoice), 0) as amt_inv,
            count(*) filter (where has_resolution) as n_res, coalesce(sum(amount) filter (where has_resolution), 0) as amt_res
       from classified`,
  );

  return {
    community: { id: String(community.id), name: String(community.name), nif: str(community.nif) },
    today,
    findingRunId: run ? String(run.id) : null,
    runStats: (run?.stats as Record<string, unknown> | undefined) ?? null,
    pipelineVersion: run ? str(run.pipeline_version) : null,
    engineVersion: run ? str(run.engine_version) : null,
    parametersVersion: null,
    corpus: {
      files: Number(corpusRow?.files ?? 0),
      filesVerified: Number(corpusRow?.files_verified ?? 0),
      filesQuarantined: Number(corpusRow?.files_quarantined ?? 0),
      pages: Number(corpusRow?.pages ?? 0),
      documents: Number(corpusRow?.documents ?? 0),
      documentsDuplicate: Number(corpusRow?.documents_duplicate ?? 0),
      invoices: Number(corpusRow?.invoices ?? 0),
      bankTx: Number(corpusRow?.bank_tx ?? 0),
      distinctHashes: Number(corpusRow?.distinct_hashes ?? 0),
    },
    batches: await q(
      `select batch_label, supplied_by_role, min(supplied_on) as supplied_on, count(*) as files,
              string_agg(distinct coalesce(transport_note, ''), '; ') as transport
         from public.files where community_id = $1 group by batch_label, supplied_by_role
        order by batch_label, supplied_by_role`,
    ),
    parameters: await q(
      `select distinct on (key) key, value_num, value_text, unit, version, valid_from, basis_text
         from public.parameters where community_id = $1
        order by key, valid_from desc, version desc`,
    ),
    ruleVersions: [...catalogue.values()].map((r) => ({ code: r.code, version: r.version })),
    confirmation: {
      auto: Number(confirmRow?.auto ?? 0),
      twoPerson: Number(confirmRow?.two_person ?? 0),
      onePerson: Number(confirmRow?.one_person ?? 0),
      pending: Number(confirmRow?.pending ?? 0),
    },
    calibration: await q(
      `select engine, field_type, conf_bucket, sample_kind, n, correct, accuracy, wilson_low
         from public.calibration where community_id = $1 order by engine, field_type, conf_bucket, computed_at desc`,
    ),
    goldenSet: Number(goldenRow?.n ?? 0),
    requestClock: (await q('select * from public.request_clock where community_id = $1'))[0] ?? null,
    meetings: await q('select * from public.meetings where community_id = $1 order by fecha, tipo'),
    resolutions: await q(
      `select r.punto, r.kind::text as kind, r.texto_literal, r.importe_aprobado, r.delegation_to_role, r.delegation_scope,
              r.cap_explicit, r.page_no, m.fecha as meeting_fecha
         from public.resolutions r join public.meetings m on m.id = r.meeting_id
        where r.community_id = $1 order by m.fecha, r.punto, r.id`,
    ),
    challengeable: await q(
      `select * from public.v_challengeable_resolutions
        where community_id = $1 and (open_3m or open_12m) order by meeting_date, punto, resolution_id`,
    ),
    controlTotals: await q('select * from public.v_control_totals where community_id = $1 order by fiscal_year'),
    continuity: await q('select * from public.v_year_balance_continuity where community_id = $1 order by fiscal_year'),
    derramaByUnit: await q(
      `select u.id as unit_id, u.label, count(*) as periods, sum(dl.expected) as expected, sum(dl.paid) as paid,
              string_agg(distinct dl.basis::text, ', ' order by dl.basis::text) as basis
         from public.derrama_ledger dl join public.units u on u.id = dl.unit_id
        where dl.community_id = $1 group by u.id, u.label order by u.label`,
    ),
    subsidies: await q(
      `select programa, expedient, estat::text as estat, pressupost_protegible, pct, import_atorgat, import_pagat, paid_to_is_community
         from public.subsidies where community_id = $1 order by programa, expedient, id`,
    ),
    loans: await q(
      `select p.display_name as lender, l.principal, l.disbursed_on, l.paid_to_is_community, l.resolution_id, w.label as works_label
         from public.loans l
         left join public.parties p on p.id = l.lender_party_id
         left join public.works_packages w on w.id = l.works_package_id
        where l.community_id = $1 order by l.disbursed_on, l.id`,
    ),
    supported: {
      outflowCount: Number(supportedRow?.n_all ?? 0),
      outflowAmount: num(supportedRow?.amt_all) ?? 0,
      withInvoiceCount: Number(supportedRow?.n_inv ?? 0),
      withInvoiceAmount: num(supportedRow?.amt_inv) ?? 0,
      withResolutionCount: Number(supportedRow?.n_res ?? 0),
      withResolutionAmount: num(supportedRow?.amt_res) ?? 0,
    },
    gates,
    works: await q(
      `select f.*, w.code as pkg_code from public.v_works_funding f
         join public.works_packages w on w.id = f.works_package_id
        where f.community_id = $1 order by w.code, w.label`,
    ),
    suspension: await q('select * from public.v_suspension_status where community_id = $1 order by code'),
    worksEvents: await q(
      `select w.code as pkg_code, w.label as pkg_label, e.event_type::text as event_type, e.event_date, e.amount, e.seq_ok, e.violation_text
         from public.works_events e join public.works_packages w on w.id = e.works_package_id
        where e.community_id = $1 order by w.code, e.event_date, e.event_type, e.id`,
    ),
    vendors: await q(
      `select p.display_name, p.nif, p.nif_valid, p.kind::text as kind, p.origin_class::text as origin_class, d.doc_date as first_doc_date
         from public.parties p left join public.documents d on d.id = p.first_seen_document_id
        where p.community_id = $1 and p.kind in ('vendor', 'architect', 'administrator', 'insurer')
        order by p.display_name`,
    ),
    externalChecks: await q(
      `select check_type, count(*) as lookups,
              count(*) filter (where status = 'ok') as ok,
              count(*) filter (where status = 'not_found') as not_found,
              count(*) filter (where status in ('error', 'manual_pending')) as pending
         from public.external_checks where community_id = $1 group by check_type order by check_type`,
    ),
    partyLinks: await q(
      `select tier, count(*) as n from public.party_links
        where community_id = $1 and status <> 'dismissed' group by tier order by tier`,
    ),
    matrix: await q('select * from public.v_document_matrix where community_id = $1 order by class, fiscal_year'),
    ruleCatalogue: [...catalogue.values()],
    hitsByRule,
    benchmarks: await q(
      `select distinct b.category_code, b.source_id, b.source_ref, b.region, b.valid_from, b.price_low, b.price_median, b.price_high, b.hash
         from public.benchmark_records b
         join public.finding_evidence fe on fe.benchmark_record_id = b.id
         join public.findings f on f.id = fe.finding_id
        where f.community_id = $1
        order by b.category_code, b.source_id, b.valid_from`,
    ),
    citedPages: await q(
      `select distinct fe.document_id, p.page_no, coalesce(fe.file_sha256, fi.sha256) as file_sha256,
              fe.crop_status::text as crop_status, f.fingerprint
         from public.finding_evidence fe
         join public.findings f on f.id = fe.finding_id
         left join public.pages p on p.id = fe.page_id
         left join public.files fi on fi.id = p.file_id
        where f.community_id = $1 and (fe.document_id is not null or fe.page_id is not null)
        order by fe.document_id, p.page_no, f.fingerprint`,
    ),
    revisionsBySource: await q(
      `select source::text as source, count(*) as n from public.field_revisions where community_id = $1 group by source order by source`,
    ),
    reviewsByStatus: await q(
      `select fr.to_status::text as to_status, count(*) as n
         from public.finding_reviews fr join public.findings f on f.id = fr.finding_id
        where f.community_id = $1 group by fr.to_status order by fr.to_status`,
    ),
    legalRegister: await loadLegalSourceRegister(client),
    redaction: await loadRedactionContext(client, cid, lang),
  };
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return (part / whole) * 100;
}

/** Reference used everywhere for one item: `F-<id8>`. */
export function findingRef(id: string): string {
  return `F-${id.slice(0, 8)}`;
}

/** The evidence lines of one item, each already carrying its reproducibility reference. */
function evidenceList(g: GatedFinding, ctx: RedactionContext, runId: string | null): string {
  const f = g.finding;
  if (f.evidence.length === 0) return muted('—');
  const items = f.evidence.map((e) => {
    const ref = evidenceRef({
      documentId: e.documentId,
      pageNo: e.pageNo,
      fileSha256: e.fileSha256,
      runId: e.runId ?? runId,
      ruleCode: f.ruleCode,
      ruleVersion: f.ruleVersion,
      benchmarkRecordId: e.benchmarkRecordId,
      parameterVersion: e.parameterVersion,
    });
    const quote = e.quote ? `<blockquote>${esc(redactText(e.quote, ctx))}</blockquote>` : '';
    return `<li>${esc(redactText(e.label, ctx))} <span class="ref">${esc(ref)}</span>${quote}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

/** One item: neutral summary, figures, references, explanations, and the reply verbatim. */
function findingBlock(g: GatedFinding, lang: Lang, ctx: RedactionContext, runId: string | null): string {
  const t = m6Strings(lang);
  const f = g.finding;
  const summary = redactText(lang === 'es' ? f.summaryEs : f.summaryEn, ctx);
  const dates = [f.actDateFirst, f.actDateLast].filter(Boolean).join(' / ') || '—';
  const basis = g.legal.printable
    ? g.legal.articles.join('; ')
    : (g.legal.placeholder ?? (lang === 'es' ? 'control interno' : 'internal control'));
  const reply = g.replyText
    ? `<blockquote>${esc(redactText(g.replyText, ctx))}</blockquote>`
    : `<p class="muted">${esc(t.fReplyNone)}</p>`;
  const attachments =
    g.replyAttachments.length > 0
      ? `<p>${esc(t.fAttachments)}: ${esc(g.replyAttachments.map((a) => `${a.originalName ?? a.fileId.slice(0, 8)} (sha ${(a.sha256 ?? '').slice(0, 12)})`).join('; '))}</p>`
      : '';
  const explanations =
    f.innocentExplanations.length > 0 ? `<ul>${f.innocentExplanations.map((e) => `<li>${esc(redactText(e, ctx))}</li>`).join('')}</ul>` : muted('—');

  return `<div class="finding">
${`<h4>${esc(`${t.findingHeadingPrefix} ${findingRef(f.id)} · ${f.ruleCode}@v${f.ruleVersion} · ${t.fTier} ${g.effectiveTier}`)}</h4>`}
${dl([
  [t.fSummary, esc(summary)],
  [t.fAmount, esc(fmtMoney(f.amountAtStake, lang))],
  [t.fDates, esc(dates)],
  [t.fLegalBasis, esc(basis)],
  [t.fStatus, esc(f.status)],
  [t.fRequested, esc(f.explanationRequestedOn ?? t.notRecorded)],
])}
${h3(t.fEvidence)}${evidenceList(g, ctx, runId)}
${h3(t.fInnocent)}${explanations}
${dl([
  [t.fNextCheck, esc(redactText(f.nextCheck ?? '—', ctx))],
  [t.fResolving, esc(redactText(f.resolvingDocument ?? '—', ctx))],
])}
${h3(t.fReply)}${reply}${attachments}
</div>`;
}

/** Render the auditor pack. `data` is the only input; nothing is read at render time. */
export function renderAuditor(data: AuditorData, lang: Lang): string {
  const t = m6Strings(lang);
  const ctx = data.redaction;
  const yn = (v: unknown) => (v == null ? '' : v ? t.yes : t.no);

  // 1. scope, method, sources
  const corpus = table(
    t.corpusCols,
    [
      [t.corpusFiles, fmtInt(data.corpus.files, lang)],
      [t.corpusFilesVerified, fmtInt(data.corpus.filesVerified, lang)],
      [t.corpusFilesQuarantined, fmtInt(data.corpus.filesQuarantined, lang)],
      [t.corpusPages, fmtInt(data.corpus.pages, lang)],
      [t.corpusDocuments, fmtInt(data.corpus.documents, lang)],
      [t.corpusDocumentsDup, fmtInt(data.corpus.documentsDuplicate, lang)],
      [t.corpusInvoices, fmtInt(data.corpus.invoices, lang)],
      [t.corpusBankTx, fmtInt(data.corpus.bankTx, lang)],
      [lang === 'es' ? 'Huellas SHA-256 distintas' : 'Distinct SHA-256 hashes', fmtInt(data.corpus.distinctHashes, lang)],
    ],
    t.none,
  );
  const batches = table(
    t.batchCols,
    data.batches.map((b) => [
      b.batch_label ?? '—',
      b.supplied_by_role ?? '—',
      fmtDate(b.supplied_on),
      fmtInt(b.files, lang),
      b.transport ?? '',
    ]),
    t.none,
  );
  const params = table(
    t.paramCols,
    data.parameters.map((p) => [
      p.key,
      p.value_num == null ? (p.value_text ?? '') : fmtInt(p.value_num, lang) === '—' ? '' : String(p.value_num),
      p.unit ?? '',
      `v${String(p.version)}`,
      fmtDate(p.valid_from),
      p.basis_text ?? '',
    ]),
    t.none,
  );
  const ruleVersions = data.ruleVersions.map((r) => `${r.code}@v${r.version}`).join(' · ');
  const confirmation = table(
    t.confirmCols,
    [
      [t.confirmAuto, fmtInt(data.confirmation.auto, lang)],
      [t.confirmTwoPerson, fmtInt(data.confirmation.twoPerson, lang)],
      [t.confirmOnePerson, fmtInt(data.confirmation.onePerson, lang)],
      [t.confirmPending, fmtInt(data.confirmation.pending, lang)],
    ],
    t.none,
  );
  const calibration =
    data.calibration.length > 0
      ? table(
          t.calibrationCols,
          data.calibration.map((c) => [
            c.engine,
            c.field_type ?? '',
            c.sample_kind,
            fmtInt(c.n, lang),
            fmtInt(c.correct, lang),
            c.accuracy == null ? '' : fmtPct(Number(c.accuracy) * 100, lang, 2),
            c.wilson_low == null ? '' : fmtPct(Number(c.wilson_low) * 100, lang, 2),
          ]),
          t.none,
        ) + `<p>${esc(t.goldenSetLine)}: ${esc(fmtInt(data.goldenSet, lang))}</p>`
      : note(t.calibrationAbsent);

  const s1 =
    h2('s1', t.aS1) +
    scopeAndLimits(lang) +
    h3(t.corpusHeading) +
    corpus +
    h3(t.batchesHeading) +
    batches +
    h3(t.paramsHeading) +
    params +
    h3(t.rulesVersionHeading) +
    `<p class="ref">${esc(ruleVersions)}</p>` +
    h3(t.confirmHeading) +
    confirmation +
    h3(t.calibrationHeading) +
    calibration +
    gateStatsBlock(lang, data.gates.stats);

  // 2. governance
  const rc = data.requestClock;
  const clock = dl([
    [lang === 'es' ? 'Fecha de la solicitud (≥ 1/4 de cuotas)' : 'Request date (≥ 1/4 of quotas)', fmtDate(rc?.request_date) || t.notRecorded],
    [lang === 'es' ? 'Convocatoria' : 'Convocation', fmtDate(rc?.convocation_date) || t.notRecorded],
    [lang === 'es' ? 'Junta' : 'Meeting', fmtDate(rc?.junta_date) || t.notRecorded],
    [lang === 'es' ? 'Días de antelación' : "Days' notice", rc?.notice_days == null ? t.notRecorded : String(rc.notice_days)],
    [lang === 'es' ? 'Documentación disponible desde' : 'Documents available from', fmtDate(rc?.docs_available_from) || t.notRecorded],
  ]);
  const meetings = table(
    lang === 'es'
      ? ['Fecha', 'Tipo', 'Convocatoria', 'Antelación', 'Acta firmada', 'Acta notificada', 'Cuentas aprobadas', 'Presupuesto aprobado']
      : ['Date', 'Kind', 'Convocation', 'Notice', 'Minutes signed', 'Minutes sent', 'Accounts approved', 'Budget approved'],
    data.meetings.map((m) => [
      fmtDate(m.fecha),
      m.tipo,
      fmtDate(m.convocatoria_fecha),
      m.notice_days ?? '',
      fmtDate(m.fecha_firma),
      fmtDate(m.fecha_notificacion),
      yn(m.cuentas_aprobadas),
      fmtMoney(m.presupuesto_aprobado, lang),
    ]),
    t.none,
  );
  const resolutions = table(
    t.resolutionCols,
    data.resolutions.map((r) => [
      fmtDate(r.meeting_fecha),
      r.punto ?? '',
      r.kind,
      `<blockquote>${esc(redactText(String(r.texto_literal ?? ''), ctx))}</blockquote>`,
      fmtMoney(r.importe_aprobado, lang),
      r.delegation_to_role
        ? `${String(r.delegation_to_role)}: ${String(r.delegation_scope ?? '')}${r.cap_explicit === false ? (lang === 'es' ? ' (sin límite explícito)' : ' (no explicit cap)') : ''}`
        : '',
      r.page_no ?? '',
    ]),
    t.none,
  );
  const challenge = table(
    lang === 'es'
      ? ['Junta', 'Punto', 'Tipo', 'Resumen', 'Plazo 3 meses hasta', 'Plazo 12 meses hasta', 'Nota']
      : ['Meeting', 'Item', 'Kind', 'Summary', '3-month window until', '12-month window until', 'Note'],
    data.challengeable.map((c) => [
      fmtDate(c.meeting_date),
      c.punto ?? '',
      c.kind,
      c.texto_resumen ?? '',
      c.open_3m ? fmtDate(c.challenge_3m_until) : '—',
      c.open_12m ? fmtDate(c.challenge_12m_until) : '—',
      c.notification_date_unknown ? (lang === 'es' ? 'fecha de notificación desconocida' : 'notification date unknown') : '',
    ]),
    t.none,
  );
  const s2 =
    h2('s2', t.aS2) + h3(t.requestClockHeading) + clock + h3(t.meetingsHeading) + meetings + resolutions + h3(t.challengeHeading) + challenge;

  // 3. control totals and continuity
  const controls = table(
    t.controlCols,
    data.controlTotals.map((c) => [
      c.fiscal_year,
      c.basis ?? '',
      fmtMoney(c.liq_expenses, lang),
      fmtMoney(c.bank_debits, lang),
      fmtMoney(c.invoices_total, lang),
      fmtMoney(c.opening_payables, lang),
      fmtMoney(c.closing_payables, lang),
      fmtMoney(c.retentions_held, lang),
      fmtMoney(c.bridged_difference, lang),
      fmtMoney(c.pm_ordinary, lang),
    ]),
    t.none,
  );
  const continuity = table(
    t.continuityCols,
    data.continuity.map((c) => [
      c.fiscal_year,
      fmtMoney(c.saldo_inicial, lang),
      fmtMoney(c.prev_saldo_final, lang),
      fmtMoney(c.opening_gap, lang),
      fmtMoney(c.saldo_final, lang),
      fmtMoney(c.bank_saldo_at_close, lang),
      fmtMoney(c.saldo_en_poder_administrador, lang),
      fmtMoney(c.fondo_reserva_final, lang),
    ]),
    t.none,
  );
  const s3 = h2('s3', t.aS3) + h3(t.controlTotalsHeading) + controls + h3(t.continuityHeading) + continuity;

  // 4. income
  const derrama = table(
    t.derramaCols,
    data.derramaByUnit.map((d) => {
      const expected = num(d.expected) ?? 0;
      const paid = num(d.paid) ?? 0;
      return [
        esc(
          (() => {
            const id = str(d.unit_id);
            const label = str(d.label);
            return ctx.presidentUnitIds.has(id ?? '') ? (lang === 'es' ? 'unidad del rol de presidencia' : 'unit of the presidency role') : (label ?? '');
          })(),
        ),
        fmtInt(d.periods, lang),
        fmtMoney(expected, lang),
        fmtMoney(paid, lang),
        fmtMoney(expected - paid, lang),
        d.basis ?? '',
      ];
    }),
    t.none,
  );
  const subsidies = table(
    t.subsidyCols,
    data.subsidies.map((s) => [
      s.programa ?? '',
      s.expedient ?? '',
      s.estat,
      fmtMoney(s.pressupost_protegible, lang),
      s.pct == null ? '' : fmtPct(s.pct, lang),
      fmtMoney(s.import_atorgat, lang),
      fmtMoney(s.import_pagat, lang),
      yn(s.paid_to_is_community),
    ]),
    t.none,
  );
  const loans = table(
    t.loanCols,
    data.loans.map((l) => [
      l.lender ?? '',
      fmtMoney(l.principal, lang),
      fmtDate(l.disbursed_on),
      yn(l.paid_to_is_community),
      l.resolution_id ? `R-${String(l.resolution_id).slice(0, 8)}` : (lang === 'es' ? 'no localizado' : 'not located'),
      l.works_label ?? '',
    ]),
    t.none,
  );
  const s4 = h2('s4', t.aS4) + h3(t.derramaHeading) + derrama + note(t.derramaBasisNote) + h3(t.subsidiesHeading) + subsidies + loans;

  // 5. supported spending — the headline comes before any discrepancy
  const sp = data.supported;
  const headline =
    sp.outflowCount === 0
      ? note(t.supportedNoData)
      : `<p class="headline">${esc(t.supportedHeadline)}: ${esc(fmtPct(pct(sp.withResolutionAmount, sp.outflowAmount), lang))}</p>`;
  const supported = table(
    t.supportedCols,
    [
      [t.supportedOutflows, fmtInt(sp.outflowCount, lang), fmtMoney(sp.outflowAmount, lang)],
      [t.supportedInvoice, fmtInt(sp.withInvoiceCount, lang), fmtMoney(sp.withInvoiceAmount, lang)],
      [t.supportedResolution, fmtInt(sp.withResolutionCount, lang), fmtMoney(sp.withResolutionAmount, lang)],
    ],
    t.none,
  );
  const s5 = h2('s5', t.aS5) + headline + supported;

  // 6. items not reconciled
  const distributed = data.gates.distributed;
  const s6 =
    h2('s6', t.aS6) +
    note(t.noConclusions) +
    (distributed.length === 0
      ? muted(t.none)
      : distributed.map((g) => findingBlock(g, lang, ctx, data.findingRunId)).join('')) +
    `<p>${esc(`${t.gateStatsWithheldReply} (${t.gatePendingReply}): ${fmtInt(data.gates.stats.withheld_pending_reply, lang)}`)}</p>`;

  // 7. works
  const works = table(
    t.worksFundCols,
    data.works.map((w) => [
      w.label ?? w.pkg_code,
      w.status,
      fmtMoney(w.contract_price, lang),
      fmtMoney(w.certified_total, lang),
      fmtMoney(w.invoiced_total, lang),
      fmtMoney(w.paid_total, lang),
      fmtMoney(w.derrama_collected, lang),
      fmtMoney(w.subsidy_received, lang),
      fmtMoney(w.loan_received, lang),
      fmtMoney(w.funding_gap, lang),
    ]),
    t.none,
  );
  const suspension = table(
    t.suspensionCols,
    data.suspension.map((s) => [
      s.code,
      fmtDate(s.suspension_date),
      s.suspension_reason ?? '',
      fmtMoney(s.certified_at_suspension, lang),
      fmtMoney(s.invoiced_at_suspension, lang),
      fmtMoney(s.paid_at_suspension, lang),
      fmtMoney(s.contractual_advances, lang),
      fmtInt(s.invoices_after_suspension, lang),
    ]),
    t.none,
  );
  const timeline = table(
    t.timelineCols,
    data.worksEvents.map((e) => [
      e.pkg_label ?? e.pkg_code,
      fmtDate(e.event_date),
      e.event_type,
      fmtMoney(e.amount, lang),
      yn(e.seq_ok),
      e.violation_text ?? '',
    ]),
    t.none,
  );
  const s7 = h2('s7', t.aS7) + h3(t.worksHeading) + works + h3(t.suspensionHeading) + suspension + h3(t.timelineHeading) + timeline;

  // 8. vendor checks — registry facts only
  const vendors = table(
    t.vendorCols,
    data.vendors.map((v) => [v.display_name, v.nif ?? '', yn(v.nif_valid), v.kind, v.origin_class, fmtDate(v.first_doc_date)]),
    t.none,
  );
  const checks = table(
    t.externalChecksCols,
    data.externalChecks.map((c) => [c.check_type, fmtInt(c.lookups, lang), fmtInt(c.ok, lang), fmtInt(c.not_found, lang), fmtInt(c.pending, lang)]),
    t.none,
  );
  const links = table(
    t.linksCols,
    data.partyLinks.map((l) => [l.tier, fmtInt(l.n, lang)]),
    t.none,
  );
  const s8 = h2('s8', t.aS8) + h3(t.vendorHeading) + vendors + h3(t.externalChecksHeading) + checks + h3(t.linksHeading) + links + note(t.linksDetailNote);

  // 9. document requests
  const matrix = table(
    t.matrixCols,
    data.matrix.map((m) => [
      m.class,
      m.fiscal_year ?? '',
      m.status,
      fmtDate(m.requested_on),
      fmtDate(m.received_on),
      fmtInt(m.files_received ?? 0, lang),
      yn(m.request_evidenced),
    ]),
    t.none,
  );
  const s9 = h2('s9', t.aS9) + matrix;

  // annexes
  const annexA =
    h2('a1', t.aA1) +
    (data.gates.annex.length === 0
      ? muted(t.none)
      : table(
          lang === 'es' ? ['Ref.', 'Regla', 'Nivel', 'Descripción', 'Nota'] : ['Ref.', 'Rule', 'Tier', 'Description', 'Note'],
          data.gates.annex.map((g) => [
            findingRef(g.finding.id),
            `${g.finding.ruleCode}@v${g.finding.ruleVersion}`,
            g.effectiveTier,
            esc(redactText(lang === 'es' ? g.finding.summaryEs : g.finding.summaryEn, ctx)),
            g.finding.rule.neverT1T2 ? t.gateBaseRate : g.tierCapped ? t.gateTierCapped : '',
          ]),
          t.none,
        ));

  const annexB =
    h2('a2', t.aA2) +
    note(t.ruleZeroNote) +
    table(
      t.ruleCatalogueCols,
      data.ruleCatalogue.map((r) => {
        const cited = r.articleRefs.length === 0 ? '—' : data.legalRegister.filter((l) => r.legalSourceIds.includes(l.id)).every((l) => l.archived) && r.legalSourceIds.length > 0 && (r.legalBasisKind === 'statutory' || r.legalBasisKind === 'subsidy_bases') ? r.articleRefs.join('; ') : t.gateLegalPending;
        return [
          r.code,
          r.family,
          lang === 'es' ? r.nameEs : r.nameEn,
          `v${r.version}`,
          r.legalBasisKind,
          r.attribution,
          fmtInt(data.hitsByRule.get(r.code) ?? 0, lang),
          cited,
        ];
      }),
      t.none,
    );

  const annexC =
    h2('a3', t.aA3) +
    table(
      t.benchmarkCols,
      data.benchmarks.map((b) => [
        b.category_code,
        b.source_id,
        b.source_ref ?? '',
        b.region,
        fmtDate(b.valid_from),
        fmtMoney(b.price_low, lang),
        fmtMoney(b.price_median, lang),
        fmtMoney(b.price_high, lang),
        String(b.hash ?? '').slice(0, 12),
      ]),
      t.none,
    );

  const annexD =
    h2('a4', t.aA4) +
    table(
      t.citedPagesCols,
      data.citedPages.map((p) => [
        p.document_id ? `D-${String(p.document_id).slice(0, 8)}` : '',
        p.page_no ?? '',
        String(p.file_sha256 ?? '').slice(0, 16),
        p.crop_status ?? '',
        String(p.fingerprint ?? '').slice(0, 8),
      ]),
      t.none,
    );

  const annexE =
    h2('a5', t.aA5) +
    table(
      t.revisionCols,
      data.revisionsBySource.map((r) => [r.source, fmtInt(r.n, lang)]),
      t.none,
    ) +
    table(
      t.reviewCols,
      data.reviewsByStatus.map((r) => [r.to_status, fmtInt(r.n, lang)]),
      t.none,
    );

  const annexF =
    h2('a6', t.aA6) +
    table(
      t.legalRegisterCols,
      data.legalRegister.map((l) => [l.id, l.citedBy.join(', '), l.archived ? t.yes : t.no, fmtDate(l.archivedAt), String(l.sha256 ?? '').slice(0, 16)]),
      t.none,
    );

  const body = [
    `<h1>${esc(t.auditorTitle)}</h1>`,
    `<p>${esc(t.auditorSubtitle)}</p>`,
    `<div class="banner">${esc(t.confidential)}</div>`,
    `<div class="audience"><strong>${esc(t.audience)}:</strong> ${esc(t.audienceAuditor)}</div>`,
    s1,
    s2,
    s3,
    s4,
    s5,
    s6,
    s7,
    s8,
    s9,
    annexA,
    annexB,
    annexC,
    annexD,
    annexE,
    annexF,
  ].join('\n');

  return packDocument({
    lang,
    title: `${t.auditorTitle} — ${data.community.name}`,
    headerLines: [
      [t.community, `${data.community.name}${data.community.nif ? ` (${data.community.nif})` : ''}`],
      [t.generatedOn, data.today],
      [t.pack, 'auditor v1'],
      [t.lang, lang],
      [t.run, data.findingRunId ? data.findingRunId.slice(0, 8) : t.notRecorded],
      [t.pipelineVersion, data.pipelineVersion ?? t.notRecorded],
    ],
    body,
  });
}
