/**
 * Rules that run on seeded governance data and whatever bank data exists (M0/M3 subset):
 * D0 funding gap, D5 derrama reconciliation (bank basis only), D6 reserve fund, E5 missing
 * documents, E6 formal deadlines, E7 challenge windows, E8 resolution majority validity.
 * Every hit is a discrepancy to verify with innocent explanations and a next check.
 */
import { fmtEur, fp, money, type Rule, type RuleHit } from './engine.ts';

const SEED_INDEPENDENCE = 0.7; // figures transcribed from documents supplied by the administrator/president side
const SEED_QUALITY = 0.9; // hand-transcribed, page-referenced, not yet second-person verified

export const D0_fundingGap: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select f.*, w.label from public.v_works_funding f join public.works_packages w on w.id = f.works_package_id where f.community_id = $1`,
    [cid],
  );
  const bank = await client.query<{ n: string }>(`select count(*)::text as n from public.bank_transactions where community_id = $1 and tx_kind = 'quota_in'`, [cid]);
  const hasBank = Number(bank.rows[0]?.n ?? 0) > 0;
  let totalCommitted = 0;
  let totalAvailable = 0;
  const packages: Array<Record<string, unknown>> = [];
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const committed = money(r.committed);
    const collected = money(r.derrama_collected);
    const expected = money(r.derrama_expected);
    const available = (hasBank ? collected : Math.max(collected, expected)) + money(r.subsidy_received) + money(r.loan_received);
    if (committed <= 0) continue;
    totalCommitted += committed;
    totalAvailable += available;
    packages.push({ code: r.code, label: r.label, committed, available, basis: hasBank ? 'bank' : 'expected (seed)' });
  }
  if (totalCommitted <= 0) return hits;
  const gap = Math.round((totalCommitted - totalAvailable) * 100) / 100;
  const minGap = Math.max((await param('funding_gap_min')) ?? 5000, 0.1 * totalCommitted);
  if (gap > minGap) {
    hits.push({
      ruleCode: 'D0',
      severity: 3,
      eventKey: `community:${cid}:funding`,
      fingerprint: fp('D0', cid, 'overall'),
      entityType: 'community',
      entityId: cid,
      amountAtStake: gap,
      computed: { committed: totalCommitted, available: totalAvailable, gap, min_gap: minGap, basis: hasBank ? 'bank' : 'expected (seed)', packages },
      summaryEs: `Las obras comprometidas (${fmtEur(totalCommitted)}) superan la financiación identificada (${fmtEur(totalAvailable)}, base: ${hasBank ? 'movimientos bancarios' : 'cuotas previstas según actas'}) en ${fmtEur(gap)}. Verificar con qué fuentes se financia la diferencia.`,
      summaryEn: `Committed works (${fmtEur(totalCommitted)}) exceed the financing identified (${fmtEur(totalAvailable)}, basis: ${hasBank ? 'bank movements' : 'expected quotas per minutes'}) by ${fmtEur(gap)}. Verify which sources fund the difference.`,
      innocentExplanations: [
        'Additional derramas approved in later meetings not yet in the corpus.',
        'A bank loan or a subsidy credited to the community account.',
        'Contractor balances still unpaid at the reference date.',
        'Contract prices include items not yet executed.',
      ],
      nextCheck: 'Request the derrama application statement, the loan contract (if any), the subsidy resolution (if any) and the works contracts with their payment schedules.',
      resolvingDocument: 'Estado de aplicación de derramas; contrato de préstamo; resolución de subvención; contratos de obra',
      independence: SEED_INDEPENDENCE,
      extractionQuality: SEED_QUALITY,
      evidence: packages.map((p) => ({ label: `works package ${String(p.code)}`, computed: p })),
    });
  }
  return hits;
};

export const D5_derrama: Rule = async ({ cid, client, param }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select dl.derrama_id, d.objeto, dl.unit_id, u.label as unit_label, u.holder_role,
            sum(dl.expected) as expected, sum(dl.paid) as paid, min(dl.period) as first_period, max(dl.period) as last_period
       from public.derrama_ledger dl join public.derramas d on d.id = dl.derrama_id join public.units u on u.id = dl.unit_id
      where dl.community_id = $1 and dl.basis = 'bank'
      group by 1,2,3,4,5`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const expected = money(r.expected);
    const paid = money(r.paid);
    const residual = Math.round((expected - paid) * 100) / 100;
    const threshold = Math.max(1000, 0.05 * expected);
    if (Math.abs(residual) <= threshold) continue;
    const role = String(r.holder_role);
    hits.push({
      ruleCode: 'D5',
      severity: 3,
      eventKey: `derrama:${String(r.derrama_id)}:unit:${String(r.unit_id)}`,
      fingerprint: fp('D5', String(r.derrama_id), String(r.unit_id)),
      entityType: 'unit',
      entityId: String(r.unit_id),
      amountAtStake: Math.abs(residual),
      actDateFirst: String(r.first_period),
      actDateLast: String(r.last_period),
      computed: { objeto: r.objeto, unit: r.unit_label, holder_role: role, expected, paid, residual },
      summaryEs: `Unidad ${String(r.unit_label)}${role === 'president' ? ' (unidad del rol de presidencia)' : ''}: cuotas extraordinarias esperadas ${fmtEur(expected)} frente a ${fmtEur(paid)} identificadas en el banco (diferencia ${fmtEur(residual)}). Verificar.`,
      summaryEn: `Unit ${String(r.unit_label)}${role === 'president' ? ' (unit held by the presidency role)' : ''}: expected extraordinary quotas ${fmtEur(expected)} vs ${fmtEur(paid)} identified in bank credits (difference ${fmtEur(residual)}). Verify.`,
      innocentExplanations: ['Payments made from an account not yet attributed to the unit.', 'Instalment plan or arrears agreed with the administrator.', 'Quota netted against documented expenses advanced by the owner.'],
      nextCheck: 'Compare with the administrator\'s per-unit statement and the receipts issued to the unit.',
      resolvingDocument: 'Estado de cuotas por entidad; recibos',
      independence: 1.0,
      extractionQuality: 0.9,
      evidence: [{ label: 'derrama ledger', computed: { derrama_id: r.derrama_id, unit_id: r.unit_id } }],
    });
    void param; // thresholds fixed by the plan for this rule
  }
  return hits;
};

export const D6_reserveFund: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const liq = await client.query(
    `select l.id, l.ejercicio, l.fondo_reserva_final, l.saldo_en_poder_administrador,
            coalesce((select m.presupuesto_aprobado from public.meetings m where m.community_id = l.community_id and extract(year from m.fecha) = l.ejercicio + 1 order by m.fecha limit 1),
                     (select ordinary_budget_default from public.communities where id = l.community_id)) as budget
       from public.liquidations l where l.community_id = $1 and l.fondo_reserva_final is not null`,
    [cid],
  );
  for (const r of liq.rows as Array<Record<string, unknown>>) {
    const fund = money(r.fondo_reserva_final);
    const budget = money(r.budget);
    if (budget > 0 && fund < 0.05 * budget) {
      hits.push({
        ruleCode: 'D6',
        severity: 1,
        eventKey: `liquidation:${String(r.id)}:reserve`,
        fingerprint: fp('D6', String(r.id), 'minimum'),
        entityType: 'liquidation',
        entityId: String(r.id),
        fiscalYear: Number(r.ejercicio),
        amountAtStake: Math.round((0.05 * budget - fund) * 100) / 100,
        computed: { fund, budget, minimum: 0.05 * budget },
        summaryEs: `Fondo de reserva al cierre de ${String(r.ejercicio)}: ${fmtEur(fund)}, por debajo del 5% del presupuesto ordinario (${fmtEur(0.05 * budget)}). Verificar.`,
        summaryEn: `Reserve fund at the close of ${String(r.ejercicio)}: ${fmtEur(fund)}, below 5% of the ordinary budget (${fmtEur(0.05 * budget)}). Verify.`,
        innocentExplanations: ['The minimum is frequently unmet in small communities; the assembly may have agreed a replenishment schedule.'],
        nextCheck: 'Check the budget approved for the following year and the reserve-fund account statement.',
        independence: SEED_INDEPENDENCE,
        extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'liquidation', computed: { liquidation_id: r.id } }],
      });
    }
    const held = money(r.saldo_en_poder_administrador);
    if (held > 0) {
      hits.push({
        ruleCode: 'D7',
        severity: 3,
        eventKey: `liquidation:${String(r.id)}:funds_held`,
        fingerprint: fp('D7', String(r.id), 'held'),
        entityType: 'liquidation',
        entityId: String(r.id),
        fiscalYear: Number(r.ejercicio),
        amountAtStake: held,
        computed: { held },
        summaryEs: `La liquidación de ${String(r.ejercicio)} declara ${fmtEur(held)} en poder de la administración, fuera de una cuenta titularidad de la comunidad. Verificar.`,
        summaryEn: `The ${String(r.ejercicio)} accounts report ${fmtEur(held)} held by the administration outside an account titled to the community. Verify.`,
        innocentExplanations: ['A client sub-ledger reconciled monthly; the amount may be timing of transfers.'],
        nextCheck: 'Request the bank certificate of account holder and signatories and the sub-ledger statement.',
        resolvingDocument: 'Certificado bancario de titularidad; extracto de la cuenta de clientes',
        independence: SEED_INDEPENDENCE,
        extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'liquidation', computed: { liquidation_id: r.id } }],
      });
    }
  }
  const accounts = await client.query<{ n: string; reserve: string }>(
    `select count(*)::text as n, count(*) filter (where purpose = 'reserve')::text as reserve from public.bank_accounts where community_id = $1`,
    [cid],
  );
  if (Number(accounts.rows[0]?.n ?? 0) > 0 && Number(accounts.rows[0]?.reserve ?? 0) === 0) {
    hits.push({
      ruleCode: 'D6',
      severity: 2,
      eventKey: `community:${cid}:reserve_account`,
      fingerprint: fp('D6', cid, 'no_reserve_account'),
      entityType: 'community',
      entityId: cid,
      computed: { accounts: Number(accounts.rows[0]?.n) },
      summaryEs: 'No se ha identificado una cuenta bancaria separada para el fondo de reserva a nombre de la comunidad. Verificar.',
      summaryEn: 'No separate bank account for the reserve fund in the community\'s name has been identified. Verify.',
      innocentExplanations: ['The reserve fund may be held in a sub-account or deposit not yet in the corpus.'],
      nextCheck: 'Ask the administrator for the reserve-fund account statements.',
      resolvingDocument: 'Extractos de la cuenta del fondo de reserva',
      independence: SEED_INDEPENDENCE,
      extractionQuality: 1,
      evidence: [{ label: 'bank accounts on file', computed: { count: Number(accounts.rows[0]?.n) } }],
    });
  }
  return hits;
};

export const E5_missingDocuments: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const reqs = await client.query(
    `select id, class, fiscal_year, description, requested_on, requested_via, status, request_evidence_file_id
       from public.document_requests where community_id = $1 and status in ('planned', 'requested', 'partial', 'refused', 'inspected_only') order by class, fiscal_year`,
    [cid],
  );
  for (const r of reqs.rows as Array<Record<string, unknown>>) {
    const status = String(r.status);
    const year = r.fiscal_year == null ? '' : ` ${String(r.fiscal_year)}`;
    const requested = r.requested_on ? String(r.requested_on).slice(0, 10) : null;
    const es =
      status === 'planned'
        ? `Documentación "${String(r.class)}${year}" pendiente de solicitar.`
        : status === 'refused'
          ? `Documentación "${String(r.class)}${year}" solicitada el ${requested ?? '(fecha por registrar)'} por ${String(r.requested_via ?? '—')}; entrega denegada. Verificar.`
          : status === 'inspected_only'
            ? `Documentación "${String(r.class)}${year}" consultada sin copia. Verificar si procede solicitar copia.`
            : `Documentación "${String(r.class)}${year}" solicitada el ${requested ?? '(fecha por registrar)'} por ${String(r.requested_via ?? '—')}; no recibida a ${today}.`;
    const en =
      status === 'planned'
        ? `Document class "${String(r.class)}${year}" not yet requested.`
        : status === 'refused'
          ? `Document class "${String(r.class)}${year}" requested on ${requested ?? '(date to record)'} via ${String(r.requested_via ?? '—')}; delivery refused. Verify.`
          : status === 'inspected_only'
            ? `Document class "${String(r.class)}${year}" inspected without a copy. Verify whether a copy should be requested.`
            : `Document class "${String(r.class)}${year}" requested on ${requested ?? '(date to record)'} via ${String(r.requested_via ?? '—')}; not received as of ${today}.`;
    hits.push({
      ruleCode: 'E5',
      severity: status === 'planned' ? 1 : 2,
      eventKey: `request:${String(r.id)}`,
      fingerprint: fp('E5', String(r.id)),
      entityType: 'document_request',
      entityId: String(r.id),
      fiscalYear: r.fiscal_year == null ? null : Number(r.fiscal_year),
      actDateFirst: requested,
      computed: { class: r.class, status, requested_on: requested, requested_via: r.requested_via, request_evidenced: r.request_evidence_file_id != null },
      summaryEs: es,
      summaryEn: en,
      innocentExplanations: ['Documents may be available for consultation at the administrator\'s office without copies being provided.', 'Delivery may be scheduled with the convocation of the meeting.'],
      nextCheck: 'Record the request evidence (letter, e-mail headers, receipt) and the delivery or refusal date.',
      independence: 1,
      extractionQuality: 1,
      evidence: [{ label: 'document request', computed: { id: r.id, class: r.class, fiscal_year: r.fiscal_year } }],
    });
  }
  const gaps = await client.query(
    `select bank_account_id, array_agg(to_char(month_start, 'YYYY-MM') order by month_start) as months from public.v_r7_statement_months_missing where community_id = $1 group by 1`,
    [cid],
  );
  for (const g of gaps.rows as Array<{ bank_account_id: string; months: string[] }>) {
    hits.push({
      ruleCode: 'E5',
      severity: 2,
      eventKey: `account:${g.bank_account_id}:statement_gaps`,
      fingerprint: fp('E5', 'R7', g.bank_account_id),
      entityType: 'bank_account',
      entityId: g.bank_account_id,
      computed: { months_missing: g.months },
      summaryEs: `Extractos bancarios no localizados para ${g.months.length} mes(es): ${g.months.join(', ')}.`,
      summaryEn: `Bank statements not located for ${g.months.length} month(s): ${g.months.join(', ')}.`,
      innocentExplanations: ['Statements are issued quarterly by some banks; a single statement may cover several months.'],
      nextCheck: 'Request the missing months (ideally as a Norma 43 / CSV export).',
      resolvingDocument: 'Extractos bancarios de los meses indicados',
      independence: 1,
      extractionQuality: 1,
      evidence: [{ label: 'statement coverage', computed: { months: g.months } }],
    });
  }
  return hits;
};

export const E6_formalDeadlines: Rule = async ({ cid, client, today }) => {
  const hits: RuleHit[] = [];
  const meetings = await client.query(
    `select id, tipo, fecha, convocatoria_fecha, notice_days, fecha_firma, signed_within_5d, fecha_notificacion, sent_within_10d, document_id from public.meetings where community_id = $1`,
    [cid],
  );
  for (const m of meetings.rows as Array<Record<string, unknown>>) {
    const fecha = String(m.fecha).slice(0, 10);
    if (m.notice_days != null && Number(m.notice_days) < 8) {
      hits.push({
        ruleCode: 'E6', severity: 2, eventKey: `meeting:${String(m.id)}:notice`, fingerprint: fp('E6', String(m.id), 'notice'),
        entityType: 'meeting', entityId: String(m.id), actDateFirst: fecha,
        computed: { notice_days: Number(m.notice_days) },
        summaryEs: `Junta del ${fecha}: convocatoria con ${String(m.notice_days)} días de antelación (mínimo legal a verificar: 8 días naturales).`,
        summaryEn: `Meeting of ${fecha}: convened with ${String(m.notice_days)} days' notice (statutory minimum to verify: 8 calendar days).`,
        innocentExplanations: ['The convocation date recorded may be the posting date, not the sending date.'],
        nextCheck: 'Check the convocation and its delivery proof.',
        independence: SEED_INDEPENDENCE, extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { meeting_id: m.id } }],
      });
    }
    if (m.signed_within_5d === false) {
      hits.push({
        ruleCode: 'E6', severity: 1, eventKey: `meeting:${String(m.id)}:signature`, fingerprint: fp('E6', String(m.id), 'signed'),
        entityType: 'meeting', entityId: String(m.id), actDateFirst: fecha,
        computed: { fecha_firma: m.fecha_firma },
        summaryEs: `Junta del ${fecha}: acta firmada más de 5 días después de la reunión (plazo a verificar).`,
        summaryEn: `Meeting of ${fecha}: minutes signed more than 5 days after the meeting (period to verify).`,
        innocentExplanations: ['The signature date on the copy may be the date of a later certification.'],
        nextCheck: 'Check the signed original in the minutes book.',
        independence: SEED_INDEPENDENCE, extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { meeting_id: m.id } }],
      });
    }
    if (m.sent_within_10d === false) {
      hits.push({
        ruleCode: 'E6', severity: 1, eventKey: `meeting:${String(m.id)}:notification`, fingerprint: fp('E6', String(m.id), 'sent'),
        entityType: 'meeting', entityId: String(m.id), actDateFirst: fecha,
        computed: { fecha_notificacion: m.fecha_notificacion },
        summaryEs: `Junta del ${fecha}: acta notificada más de 10 días después de la reunión (plazo a verificar).`,
        summaryEn: `Meeting of ${fecha}: minutes sent more than 10 days after the meeting (period to verify).`,
        innocentExplanations: ['Notification may have been made by another channel earlier than the date recorded.'],
        nextCheck: 'Check the delivery record of the minutes.',
        independence: SEED_INDEPENDENCE, extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'meeting', documentId: (m.document_id as string | null) ?? null, computed: { meeting_id: m.id } }],
      });
    }
  }
  const rc = await client.query(
    `select id, request_date, convocation_date, junta_date, notice_days, docs_available_from, status from public.request_clock where community_id = $1 and request_date is not null`,
    [cid],
  );
  for (const r of rc.rows as Array<Record<string, unknown>>) {
    const requestDate = String(r.request_date).slice(0, 10);
    const elapsed = Math.floor((Date.parse(today) - Date.parse(requestDate)) / 86400000);
    if (!r.convocation_date) {
      hits.push({
        ruleCode: 'E6', severity: 1, eventKey: `request_clock:${String(r.id)}:convocation`, fingerprint: fp('E6', String(r.id), 'not_convened'),
        entityType: 'request_clock', entityId: String(r.id), actDateFirst: requestDate,
        computed: { request_date: requestDate, days_elapsed: elapsed, statutory_period: 'none' },
        summaryEs: `${elapsed} días transcurridos desde la solicitud de junta extraordinaria por propietarios con ≥1/4 de cuotas (${requestDate}); sin convocatoria registrada. Sin plazo legal fijado; información.`,
        summaryEn: `${elapsed} days elapsed since the owners' request for an extraordinary meeting (${requestDate}); no convocation recorded. No statutory period; informational.`,
        innocentExplanations: ['The convocation may have been sent by a channel not yet recorded here.'],
        nextCheck: 'Record the convocation date and its delivery proof when received.',
        independence: 1, extractionQuality: 1,
        evidence: [{ label: 'request clock', computed: { request_date: requestDate } }],
      });
    } else if (r.notice_days != null && Number(r.notice_days) < 8) {
      hits.push({
        ruleCode: 'E6', severity: 2, eventKey: `request_clock:${String(r.id)}:notice`, fingerprint: fp('E6', String(r.id), 'notice'),
        entityType: 'request_clock', entityId: String(r.id), actDateFirst: String(r.convocation_date).slice(0, 10),
        computed: { notice_days: Number(r.notice_days) },
        summaryEs: `Junta extraordinaria convocada con ${String(r.notice_days)} días de antelación (mínimo a verificar: 8 días naturales).`,
        summaryEn: `Extraordinary meeting convened with ${String(r.notice_days)} days' notice (minimum to verify: 8 calendar days).`,
        innocentExplanations: ['Dates may reflect posting rather than delivery.'],
        nextCheck: 'Check the convocation and its delivery proof.',
        independence: 1, extractionQuality: 1,
        evidence: [{ label: 'request clock', computed: { convocation_date: r.convocation_date, junta_date: r.junta_date } }],
      });
    }
  }
  return hits;
};

export const E7_challengeWindows: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select resolution_id, meeting_date, fecha_notificacion, punto, kind, texto_resumen, importe_aprobado, challenge_3m_until, challenge_12m_until, open_3m, open_12m, notification_date_unknown
       from public.v_challengeable_resolutions where community_id = $1 and (open_3m or open_12m)
        and kind in ('works_approval', 'contractor_choice', 'delegation', 'derrama', 'accounts', 'budget', 'loan', 'subsidy', 'election')`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    hits.push({
      ruleCode: 'E7', severity: 1, eventKey: `resolution:${String(r.resolution_id)}:challenge`, fingerprint: fp('E7', String(r.resolution_id)),
      entityType: 'resolution', entityId: String(r.resolution_id), actDateFirst: String(r.meeting_date).slice(0, 10),
      computed: { punto: r.punto, kind: r.kind, challenge_3m_until: r.challenge_3m_until, challenge_12m_until: r.challenge_12m_until, open_3m: r.open_3m, open_12m: r.open_12m, notification_date_unknown: r.notification_date_unknown },
      summaryEs: `Acuerdo ${String(r.punto ?? '')} de la junta del ${String(r.meeting_date).slice(0, 10)} (${String(r.kind)}): plazo de impugnación ${r.open_3m ? 'de 3 meses abierto hasta ' + String(r.challenge_3m_until).slice(0, 10) : 'de 3 meses vencido'}; plazo de 1 año ${r.open_12m ? 'abierto hasta ' + String(r.challenge_12m_until).slice(0, 10) : 'vencido'}${r.notification_date_unknown ? ' (fecha de notificación desconocida: computado desde la junta)' : ''}. Información; artículo a verificar.`,
      summaryEn: `Resolution ${String(r.punto ?? '')} of the meeting of ${String(r.meeting_date).slice(0, 10)} (${String(r.kind)}): 3-month challenge window ${r.open_3m ? 'open until ' + String(r.challenge_3m_until).slice(0, 10) : 'closed'}; 12-month window ${r.open_12m ? 'open until ' + String(r.challenge_12m_until).slice(0, 10) : 'closed'}${r.notification_date_unknown ? ' (notification date unknown: computed from the meeting date)' : ''}. Informational; article to verify.`,
      innocentExplanations: ['Informational only.'],
      nextCheck: 'Confirm the notification date of the minutes to fix the windows.',
      independence: 1, extractionQuality: 1,
      evidence: [{ label: 'resolution', resolutionId: String(r.resolution_id), computed: { texto_resumen: r.texto_resumen } }],
    });
  }
  return hits;
};

export const E8_majorityValidity: Rule = async ({ cid, client }) => {
  const hits: RuleHit[] = [];
  const res = await client.query(
    `select r.id, r.punto, r.kind, r.voters_favor, r.voters_total, r.quotas_favor_pct, m.fecha, w.code
       from public.resolutions r join public.meetings m on m.id = r.meeting_id left join public.works_packages w on w.id = r.works_package_id
      where r.community_id = $1 and r.resultado = 'aprobado' and r.kind in ('works_approval', 'delegation', 'derrama', 'loan')
        and (r.voters_favor is not null or r.quotas_favor_pct is not null)`,
    [cid],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const votersOk = r.voters_favor == null || r.voters_total == null ? null : Number(r.voters_favor) > Number(r.voters_total) / 2;
    const quotasOk = r.quotas_favor_pct == null ? null : Number(r.quotas_favor_pct) > 50;
    if (votersOk === false || quotasOk === false) {
      hits.push({
        ruleCode: 'E8', severity: 2, eventKey: `resolution:${String(r.id)}:majority`, fingerprint: fp('E8', String(r.id)),
        entityType: 'resolution', entityId: String(r.id), actDateFirst: String(r.fecha).slice(0, 10),
        computed: { voters_favor: r.voters_favor, voters_total: r.voters_total, quotas_favor_pct: r.quotas_favor_pct, voters_ok: votersOk, quotas_ok: quotasOk },
        summaryEs: `Acuerdo ${String(r.punto ?? '')} (${String(r.kind)}) de la junta del ${String(r.fecha).slice(0, 10)}: los votos registrados no alcanzan la doble mayoría (propietarios votantes y cuotas totales) que exige el régimen a verificar.`,
        summaryEn: `Resolution ${String(r.punto ?? '')} (${String(r.kind)}) of the meeting of ${String(r.fecha).slice(0, 10)}: the recorded votes do not reach the double majority (voting owners and total quotas) required under the regime to verify.`,
        innocentExplanations: ['Silent owners may be counted in favour after notification under the applicable rule.', 'Vote counts in the minutes may be incomplete.'],
        nextCheck: 'Check the attendance list, proxies and the count in the minutes book.',
        independence: SEED_INDEPENDENCE, extractionQuality: SEED_QUALITY,
        evidence: [{ label: 'resolution', resolutionId: String(r.id) }],
      });
    }
  }
  return hits;
};

export const M0_RULES: Record<string, Rule> = {
  D0: D0_fundingGap,
  D5: D5_derrama,
  D6: D6_reserveFund,
  E5: E5_missingDocuments,
  E6: E6_formalDeadlines,
  E7: E7_challengeWindows,
  E8: E8_majorityValidity,
};
