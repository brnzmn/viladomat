/**
 * The lawyer annex.
 *
 * Same items as the auditor pack, arranged the way counsel needs them: what the item rests on
 * in law (only when the primary text is archived), the amount, the bank movements, the
 * resolution that authorised the spend or the statement that none was located, the document
 * that would resolve it, the challenge and limitation dates — printed as *periods to verify*,
 * never as expired deadlines — and the chain of custody with its timestamp status.
 *
 * This is also the only pack that carries the related-party detail from `party_links`, because
 * the sharing policy sends that material to counsel and the independent reviewer alone. The
 * header states the audience so a forwarded copy still says who it was written for.
 */
import type pg from 'pg';
import { m6Strings, type Lang } from './i18n.ts';
import {
  applyGates,
  loadArchivedLegalSources,
  loadGateFindings,
  type GateOutcome,
  type GatedFinding,
} from './gates.ts';
import { loadRedactionContext, redactBankRow, redactText, type RedactionContext } from './redact.ts';
import { dl, esc, evidenceRef, fmtDate, fmtInt, fmtMoney, gateStatsBlock, h2, h3, muted, note, packDocument, table } from './sections.ts';
import { findingRef } from './auditor.ts';

type Row = Record<string, unknown>;

export interface LawyerData {
  community: { id: string; name: string; nif: string | null };
  today: string;
  findingRunId: string | null;
  pipelineVersion: string | null;
  gates: GateOutcome;
  /** bank movements cited by each finding, keyed by finding id */
  bankByFinding: Map<string, Row[]>;
  /** resolutions cited by each finding, keyed by finding id */
  resolutionsByFinding: Map<string, Row[]>;
  limitation: Map<string, Row>;
  challenge: Row[];
  custody: Row[];
  partyLinks: Row[];
  redaction: RedactionContext;
}

export async function loadLawyerData(client: pg.PoolClient, cid: string, today: string, lang: Lang): Promise<LawyerData> {
  const q = async (sql: string, params: unknown[] = [cid]): Promise<Row[]> => (await client.query(sql, params)).rows as Row[];
  const [community] = await q('select id, name, nif from public.communities where id = $1');
  if (!community) throw new Error(`community ${cid} not found`);
  const [run] = await q('select id, pipeline_version from public.finding_runs where community_id = $1 order by started_at desc limit 1');

  const findings = await loadGateFindings(client, cid);
  const archived = await loadArchivedLegalSources(client);
  const gates = applyGates(findings, archived, lang);

  const bankByFinding = new Map<string, Row[]>();
  const resolutionsByFinding = new Map<string, Row[]>();
  const ids = findings.map((f) => f.id);
  if (ids.length > 0) {
    const bank = await q(
      `select fe.finding_id, t.fecha_operacion, t.importe, t.tx_kind::text as tx_kind, t.counterparty_name_norm,
              t.counterparty_iban_last4, t.counterparty_iban_hmac, t.concepto_text, t.flags, t.unit_id,
              p.kind::text as counterparty_kind
         from public.finding_evidence fe
         join public.bank_transactions t on t.id = fe.bank_transaction_id
         left join public.parties p on p.id = t.counterparty_party_id
        where fe.finding_id = any($1::uuid[])
        order by fe.finding_id, t.fecha_operacion, t.id`,
      [ids],
    );
    for (const r of bank) {
      const list = bankByFinding.get(String(r.finding_id)) ?? [];
      list.push(r);
      bankByFinding.set(String(r.finding_id), list);
    }
    const res = await q(
      `select fe.finding_id, r.id as resolution_id, r.punto, r.kind::text as kind, r.texto_literal, r.importe_aprobado,
              r.delegation_to_role, r.delegation_cap, r.cap_explicit, r.challenge_3m_until, r.challenge_12m_until,
              m.fecha as meeting_fecha, m.fecha_notificacion
         from public.finding_evidence fe
         join public.resolutions r on r.id = fe.resolution_id
         join public.meetings m on m.id = r.meeting_id
        where fe.finding_id = any($1::uuid[])
        order by fe.finding_id, m.fecha, r.punto, r.id`,
      [ids],
    );
    for (const r of res) {
      const list = resolutionsByFinding.get(String(r.finding_id)) ?? [];
      list.push(r);
      resolutionsByFinding.set(String(r.finding_id), list);
    }
  }

  const limitationRows = await q('select * from public.v_limitation_clocks where community_id = $1 order by finding_id');
  const limitation = new Map<string, Row>();
  for (const r of limitationRows) limitation.set(String(r.finding_id), r);

  return {
    community: { id: String(community.id), name: String(community.name), nif: community.nif == null ? null : String(community.nif) },
    today,
    findingRunId: run ? String(run.id) : null,
    pipelineVersion: run?.pipeline_version == null ? null : String(run.pipeline_version),
    gates,
    bankByFinding,
    resolutionsByFinding,
    limitation,
    challenge: await q(
      `select * from public.v_challengeable_resolutions where community_id = $1 and (open_3m or open_12m)
        order by meeting_date, punto, resolution_id`,
    ),
    custody: await q(
      `select batch_label, manifest_path, manifest_sha256, file_count, generated_at, generated_on_device,
              timestamp_token_path, timestamp_provider, timestamped_at, notary_ref
         from public.custody_manifests where community_id = $1 order by batch_label, generated_at`,
    ),
    partyLinks: await q(
      `select pl.tier, pl.signal, pl.points, pl.rarity_weight, pl.expected_collisions, pl.to_role, pl.status, pl.explanation,
              p.display_name, p.nif
         from public.party_links pl join public.parties p on p.id = pl.from_party_id
        where pl.community_id = $1 order by pl.tier, p.display_name, pl.signal`,
    ),
    redaction: await loadRedactionContext(client, cid, lang),
  };
}

function itemBlock(g: GatedFinding, data: LawyerData, lang: Lang): string {
  const t = m6Strings(lang);
  const ctx = data.redaction;
  const f = g.finding;
  const basis = g.legal.printable ? g.legal.articles.join('; ') : (g.legal.placeholder ?? (lang === 'es' ? 'control interno' : 'internal control'));
  const bank = data.bankByFinding.get(f.id) ?? [];
  const bankTable =
    bank.length === 0
      ? muted('—')
      : table(
          t.lBankCols,
          bank.map((raw) => {
            const r = redactBankRow(raw, ctx, raw.counterparty_kind == null ? null : String(raw.counterparty_kind));
            return [
              fmtDate(raw.fecha_operacion),
              fmtMoney(raw.importe, lang),
              String(raw.tx_kind ?? ''),
              String(r.counterparty_name_norm ?? ''),
              String(r.counterparty_iban_last4 ?? ''),
              String(r.concepto_text ?? ''),
            ];
          }),
          t.none,
        );
  const resolutions = data.resolutionsByFinding.get(f.id) ?? [];
  const resolutionBlock =
    resolutions.length === 0
      ? note(t.lResolutionAbsent)
      : resolutions
          .map(
            (r) =>
              `<p><strong>${esc(t.lResolution)}</strong> · ${esc(fmtDate(r.meeting_fecha))} · ${esc(String(r.punto ?? ''))} · ${esc(String(r.kind ?? ''))} · ${esc(fmtMoney(r.importe_aprobado, lang))}</p>` +
              `<blockquote>${esc(redactText(String(r.texto_literal ?? ''), ctx))}</blockquote>` +
              `<p class="ref">${esc(`${t.lChallenge}: 3m ${fmtDate(r.challenge_3m_until)} · 12m ${fmtDate(r.challenge_12m_until)}${r.fecha_notificacion == null ? (lang === 'es' ? ' (fecha de notificación desconocida)' : ' (notification date unknown)') : ''}`)}</p>`,
          )
          .join('');
  const lim = data.limitation.get(f.id);
  const limitationTable = lim
    ? table(
        t.lLimitationCols,
        [
          [
            findingRef(f.id),
            fmtDate(lim.act_date_last),
            fmtDate(lim.civil_general_until),
            fmtDate(lim.civil_periodic_until),
            fmtDate(lim.criminal_base_until),
            fmtDate(lim.criminal_aggravated_until),
          ],
        ],
        t.none,
      )
    : muted(t.notComputable);
  const references = f.evidence
    .map((e) =>
      evidenceRef({
        documentId: e.documentId,
        pageNo: e.pageNo,
        fileSha256: e.fileSha256,
        runId: e.runId ?? data.findingRunId,
        ruleCode: f.ruleCode,
        ruleVersion: f.ruleVersion,
        benchmarkRecordId: e.benchmarkRecordId,
        parameterVersion: e.parameterVersion,
      }),
    )
    .filter((s) => s.length > 0);

  return `<div class="finding">
<h4>${esc(`${t.findingHeadingPrefix} ${findingRef(f.id)} · ${f.ruleCode}@v${f.ruleVersion} · ${t.fTier} ${g.effectiveTier}`)}</h4>
${dl([
  [t.fSummary, esc(redactText(lang === 'es' ? f.summaryEs : f.summaryEn, ctx))],
  [t.fLegalBasis, esc(basis)],
  [t.fAmount, esc(fmtMoney(f.amountAtStake, lang))],
  [t.fDates, esc([f.actDateFirst, f.actDateLast].filter(Boolean).join(' / ') || '—')],
  [t.fResolving, esc(redactText(f.resolvingDocument ?? '—', ctx))],
  [t.fStatus, esc(f.status)],
  [t.fRequested, esc(f.explanationRequestedOn ?? t.notRecorded)],
])}
${bankTable}
${resolutionBlock}
${h3(t.lLimitation)}${limitationTable}
<p class="ref">${esc(references.join(' '))}</p>
${h3(t.fReply)}${g.replyText ? `<blockquote>${esc(redactText(g.replyText, ctx))}</blockquote>` : muted(t.fReplyNone)}
</div>`;
}

export function renderLawyer(data: LawyerData, lang: Lang): string {
  const t = m6Strings(lang);

  const s1 =
    h2('l1', t.lS1) +
    `<div class="audience"><strong>${esc(t.audience)}:</strong> ${esc(t.audienceLawyer)}</div>` +
    note(t.noConclusions) +
    note(t.lStandingNote) +
    gateStatsBlock(lang, data.gates.stats);

  const s2 =
    h2('l2', t.lS2) +
    (data.gates.distributed.length === 0 ? muted(t.none) : data.gates.distributed.map((g) => itemBlock(g, data, lang)).join('')) +
    note(t.lLimitationNote);

  const s3 =
    h2('l3', t.lS3) +
    table(
      t.lCustodyCols,
      data.custody.map((c) => [
        c.batch_label,
        c.manifest_path,
        String(c.manifest_sha256 ?? '').slice(0, 16),
        fmtInt(c.file_count, lang),
        fmtDate(c.generated_at),
        c.generated_on_device ?? '',
        c.timestamp_token_path
          ? `${String(c.timestamp_provider ?? '')} ${fmtDate(c.timestamped_at)}`.trim()
          : (c.notary_ref ? String(c.notary_ref) : t.lCustodyNoToken),
      ]),
      t.none,
    );

  const s4 =
    h2('l4', t.lS4) +
    note(t.linksDetailNote) +
    table(
      t.lLinkCols,
      data.partyLinks.map((l) => [
        l.display_name,
        l.to_role,
        l.signal,
        String(l.points ?? ''),
        l.rarity_weight == null ? '' : String(l.rarity_weight),
        l.expected_collisions == null ? '' : String(l.expected_collisions),
        l.tier,
        l.status,
        l.explanation ?? '',
      ]),
      t.none,
    );

  const body = [
    `<h1>${esc(t.lawyerTitle)}</h1>`,
    `<p>${esc(t.lawyerSubtitle)}</p>`,
    `<div class="banner">${esc(t.confidential)}</div>`,
    s1,
    s2,
    s3,
    s4,
  ].join('\n');

  return packDocument({
    lang,
    title: `${t.lawyerTitle} — ${data.community.name}`,
    headerLines: [
      [t.community, `${data.community.name}${data.community.nif ? ` (${data.community.nif})` : ''}`],
      [t.generatedOn, data.today],
      [t.pack, 'lawyer v1'],
      [t.lang, lang],
      [t.audience, t.audienceLawyer],
      [t.run, data.findingRunId ? data.findingRunId.slice(0, 8) : t.notRecorded],
      [t.pipelineVersion, data.pipelineVersion ?? t.notRecorded],
    ],
    body,
  });
}
