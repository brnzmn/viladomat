/**
 * Materialised timeline of a works package (`works_events`).
 *
 * The expected order is: approval in the minutes ≤ quote acceptance / contract ≤ permit ≤
 * start of works ≤ certifications and invoices ≤ final certification ≤ payment. Quotes
 * gathered up to 15 days before the approving meeting are normal and are not violations,
 * and a `seasonal` suspension is neutral. A violation is a discrepancy to verify, never a
 * conclusion: dates are frequently transcribed from photographs of printouts.
 */
import type pg from 'pg';
import { RECON_ENGINE_VERSION } from './version.ts';

export type WorksEventType =
  | 'acta_approval'
  | 'quote_received'
  | 'quote_accepted'
  | 'contract_signed'
  | 'permit_filed'
  | 'permit_granted'
  | 'icio_paid'
  | 'start_of_works'
  | 'certification'
  | 'invoice'
  | 'payment'
  | 'final_certification'
  | 'retention_release'
  | 'suspension'
  | 'resumption'
  | 'subsidy_application'
  | 'subsidy_resolution'
  | 'subsidy_payment'
  | 'loan_disbursement'
  | 'site_photo';

export interface WorksEventDraft {
  eventType: WorksEventType;
  eventDate: string | null;
  refType: string | null;
  refId: string | null;
  amount: number | null;
  suspensionReason?: string | null;
}

export interface SequenceViolation {
  predecessorType: WorksEventType;
  predecessorDate: string;
  predecessorRefId: string | null;
  days: number;
}

export interface SequencedEvent extends WorksEventDraft {
  seqOk: boolean | null;
  violationText: string | null;
  violations: SequenceViolation[];
}

/** Stages that must precede each event type in the expected order. */
const PREDECESSORS: Partial<Record<WorksEventType, WorksEventType[]>> = {
  quote_accepted: ['acta_approval'],
  contract_signed: ['acta_approval'],
  permit_filed: ['contract_signed'],
  permit_granted: ['permit_filed'],
  start_of_works: ['contract_signed', 'permit_granted'],
  certification: ['contract_signed', 'start_of_works'],
  invoice: ['contract_signed'],
  final_certification: ['certification'],
  // payment is tested against the authorising acta and the contract; a payment before its
  // own invoice is an advance and is left to the payment-timing rule.
  payment: ['acta_approval', 'contract_signed'],
  retention_release: ['final_certification'],
};

/** Tolerance in days for quotes gathered before the meeting that approved the works. */
export const QUOTE_TOLERANCE_DAYS = 15;

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function toleranceFor(type: WorksEventType, predecessor: WorksEventType): number {
  if (predecessor === 'acta_approval' && (type === 'quote_accepted' || type === 'quote_received')) {
    return QUOTE_TOLERANCE_DAYS;
  }
  return 0;
}

/**
 * Compute `seq_ok` and `violation_text` for every event of one package. Events without a
 * date, and `quote_received`/`suspension`/informational events, carry `seq_ok = null`
 * (nothing to test) rather than a false.
 */
export function sequenceEvents(events: readonly WorksEventDraft[]): SequencedEvent[] {
  const earliest = new Map<WorksEventType, { date: string; refId: string | null }>();
  for (const e of events) {
    if (!e.eventDate) continue;
    const prev = earliest.get(e.eventType);
    if (!prev || e.eventDate < prev.date) earliest.set(e.eventType, { date: e.eventDate, refId: e.refId });
  }
  return events.map((e) => {
    const preds = PREDECESSORS[e.eventType];
    if (!e.eventDate || !preds || preds.length === 0) {
      return { ...e, seqOk: null, violationText: null, violations: [] };
    }
    const violations: SequenceViolation[] = [];
    for (const p of preds) {
      const first = earliest.get(p);
      if (!first) continue;
      const gap = days(first.date, e.eventDate);
      if (gap < -toleranceFor(e.eventType, p)) {
        violations.push({ predecessorType: p, predecessorDate: first.date, predecessorRefId: first.refId, days: -gap });
      }
    }
    if (violations.length === 0) return { ...e, seqOk: true, violationText: null, violations: [] };
    const text = violations
      .map((v) => `${e.eventType} on ${e.eventDate} precedes ${v.predecessorType} on ${v.predecessorDate} by ${v.days} day(s)`)
      .join('; ');
    return { ...e, seqOk: false, violationText: text, violations };
  });
}

async function tableExists(client: pg.PoolClient, qualified: string): Promise<boolean> {
  const r = await client.query<{ reg: string | null }>('select to_regclass($1)::text as reg', [qualified]);
  return r.rows[0]?.reg != null;
}

async function columnsOf(client: pg.PoolClient, table: string): Promise<Set<string>> {
  const r = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function firstPresent(cols: Set<string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10);
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export interface WorksEventsResult {
  packages: number;
  events: number;
  violations: number;
  /** Tables the timeline would use that are not in the schema yet. */
  missingTables: string[];
}

/**
 * Rebuild `works_events` for every works package of the community: rows written by this
 * engine version are replaced, rows from other versions are left untouched.
 */
export async function materialiseWorksEvents(client: pg.PoolClient, cid: string): Promise<WorksEventsResult> {
  const missingTables: string[] = [];
  const hasPermits = await tableExists(client, 'public.permits');
  const hasCertifications = await tableExists(client, 'public.work_certifications');
  if (!hasPermits) missingTables.push('public.permits');
  if (!hasCertifications) missingTables.push('public.work_certifications');

  const pkgs = await client.query<{ id: string; suspension_date: unknown; suspension_reason: string | null }>(
    `select id, suspension_date, suspension_reason from public.works_packages where community_id = $1 order by code, id`,
    [cid],
  );

  const resolutions = await client.query(
    `select r.id, r.works_package_id, r.kind, r.importe_aprobado, m.fecha
       from public.resolutions r join public.meetings m on m.id = r.meeting_id
      where r.community_id = $1 and r.works_package_id is not null
        and r.kind in ('works_approval', 'contractor_choice', 'delegation')`,
    [cid],
  );
  const quotes = await client.query(
    `select d.id, d.works_package_id, d.doc_date,
            exists (select 1 from public.contracts c where c.quote_document_id = d.id) as accepted
       from public.documents d
      where d.community_id = $1 and d.doc_type = 'presupuesto' and d.works_package_id is not null`,
    [cid],
  );
  const contracts = await client.query(
    `select id, works_package_id, fecha_firma, inicio, precio_con_iva from public.contracts
      where community_id = $1 and works_package_id is not null`,
    [cid],
  );
  const invoices = await client.query(
    `select i.id, i.works_package_id, i.fecha_expedicion, i.total
       from public.invoices i join public.documents d on d.id = i.document_id
      where i.community_id = $1 and i.works_package_id is not null and d.duplicate_of_document_id is null`,
    [cid],
  );
  const payments = await client.query(
    `select t.id, i.works_package_id, t.fecha_operacion, coalesce(rl.amount_matched, -t.importe) as amount
       from public.recon_links rl
       join public.invoices i on rl.from_type = 'invoice' and rl.from_id = i.id
       join public.bank_transactions t on rl.to_type = 'bank_transaction' and rl.to_id = t.id
      where rl.community_id = $1 and rl.link_type = 'paid_by' and rl.status = 'accepted'
        and i.works_package_id is not null`,
    [cid],
  );
  const subsidies = await client.query(
    `select s.id, s.works_package_id, s.estat,
            coalesce(m.fecha, d.doc_date) as resolution_date,
            t.fecha_operacion as payment_date, s.import_pagat, s.import_atorgat
       from public.subsidies s
       left join public.resolutions r on r.id = s.resolution_id
       left join public.meetings m on m.id = r.meeting_id
       left join public.documents d on d.id = s.document_id
       left join public.bank_transactions t on t.id = s.received_bank_tx_id
      where s.community_id = $1 and s.works_package_id is not null`,
    [cid],
  );
  const loans = await client.query(
    `select id, works_package_id, disbursed_on, principal from public.loans
      where community_id = $1 and works_package_id is not null`,
    [cid],
  );

  let permitRows: Array<Record<string, unknown>> = [];
  if (hasPermits) {
    const cols = await columnsOf(client, 'permits');
    const filed = firstPresent(cols, ['filed_on', 'fecha_solicitud', 'data_presentacio', 'presented_on']);
    const granted = firstPresent(cols, ['granted_on', 'fecha_concesion', 'data_atorgament', 'issued_on']);
    if (cols.has('works_package_id') && (filed || granted)) {
      const select = ['id', 'works_package_id', filed ? `${filed} as filed_on` : 'null::date as filed_on', granted ? `${granted} as granted_on` : 'null::date as granted_on'];
      const res = await client.query(
        `select ${select.join(', ')} from public.permits where community_id = $1 and works_package_id is not null`,
        [cid],
      );
      permitRows = res.rows as Array<Record<string, unknown>>;
    }
  }

  let certificationRows: Array<Record<string, unknown>> = [];
  if (hasCertifications) {
    const cols = await columnsOf(client, 'work_certifications');
    const dateCol = firstPresent(cols, ['fecha', 'fecha_emision', 'data', 'issued_on', 'certified_on']);
    const amountCol = firstPresent(cols, ['importe', 'importe_total', 'amount', 'total']);
    const finalCol = firstPresent(cols, ['es_final', 'is_final', 'final']);
    if (cols.has('works_package_id') && dateCol) {
      const select = [
        'id',
        'works_package_id',
        `${dateCol} as event_date`,
        amountCol ? `${amountCol} as amount` : 'null::numeric as amount',
        finalCol ? `${finalCol} as is_final` : 'false as is_final',
      ];
      const res = await client.query(
        `select ${select.join(', ')} from public.work_certifications where community_id = $1 and works_package_id is not null`,
        [cid],
      );
      certificationRows = res.rows as Array<Record<string, unknown>>;
    }
  }

  const byPackage = new Map<string, WorksEventDraft[]>();
  const push = (pkg: unknown, draft: WorksEventDraft): void => {
    if (pkg == null) return;
    const key = String(pkg);
    const list = byPackage.get(key) ?? [];
    list.push(draft);
    byPackage.set(key, list);
  };

  for (const r of resolutions.rows as Array<Record<string, unknown>>) {
    push(r.works_package_id, { eventType: 'acta_approval', eventDate: iso(r.fecha), refType: 'resolution', refId: String(r.id), amount: num(r.importe_aprobado) });
  }
  for (const q of quotes.rows as Array<Record<string, unknown>>) {
    push(q.works_package_id, { eventType: 'quote_received', eventDate: iso(q.doc_date), refType: 'document', refId: String(q.id), amount: null });
    if (q.accepted === true) {
      push(q.works_package_id, { eventType: 'quote_accepted', eventDate: iso(q.doc_date), refType: 'document', refId: String(q.id), amount: null });
    }
  }
  for (const c of contracts.rows as Array<Record<string, unknown>>) {
    if (c.fecha_firma != null) {
      push(c.works_package_id, { eventType: 'contract_signed', eventDate: iso(c.fecha_firma), refType: 'contract', refId: String(c.id), amount: num(c.precio_con_iva) });
    }
    if (c.inicio != null) {
      push(c.works_package_id, { eventType: 'start_of_works', eventDate: iso(c.inicio), refType: 'contract', refId: String(c.id), amount: null });
    }
  }
  for (const p of permitRows) {
    if (p.filed_on != null) push(p.works_package_id, { eventType: 'permit_filed', eventDate: iso(p.filed_on), refType: 'permit', refId: String(p.id), amount: null });
    if (p.granted_on != null) push(p.works_package_id, { eventType: 'permit_granted', eventDate: iso(p.granted_on), refType: 'permit', refId: String(p.id), amount: null });
  }
  for (const c of certificationRows) {
    push(c.works_package_id, {
      eventType: c.is_final === true ? 'final_certification' : 'certification',
      eventDate: iso(c.event_date),
      refType: 'work_certification',
      refId: String(c.id),
      amount: num(c.amount),
    });
  }
  for (const i of invoices.rows as Array<Record<string, unknown>>) {
    push(i.works_package_id, { eventType: 'invoice', eventDate: iso(i.fecha_expedicion), refType: 'invoice', refId: String(i.id), amount: num(i.total) });
  }
  for (const p of payments.rows as Array<Record<string, unknown>>) {
    push(p.works_package_id, { eventType: 'payment', eventDate: iso(p.fecha_operacion), refType: 'bank_transaction', refId: String(p.id), amount: num(p.amount) });
  }
  for (const s of subsidies.rows as Array<Record<string, unknown>>) {
    if (s.resolution_date != null) {
      push(s.works_package_id, { eventType: 'subsidy_resolution', eventDate: iso(s.resolution_date), refType: 'subsidy', refId: String(s.id), amount: num(s.import_atorgat) });
    }
    if (s.payment_date != null) {
      push(s.works_package_id, { eventType: 'subsidy_payment', eventDate: iso(s.payment_date), refType: 'subsidy', refId: String(s.id), amount: num(s.import_pagat) });
    }
  }
  for (const l of loans.rows as Array<Record<string, unknown>>) {
    if (l.disbursed_on != null) {
      push(l.works_package_id, { eventType: 'loan_disbursement', eventDate: iso(l.disbursed_on), refType: 'loan', refId: String(l.id), amount: num(l.principal) });
    }
  }
  for (const p of pkgs.rows) {
    if (p.suspension_date != null) {
      push(p.id, {
        eventType: 'suspension',
        eventDate: iso(p.suspension_date),
        refType: 'works_package',
        refId: p.id,
        amount: null,
        suspensionReason: p.suspension_reason,
      });
    }
  }

  let events = 0;
  let violations = 0;
  for (const pkg of pkgs.rows) {
    const drafts = (byPackage.get(pkg.id) ?? []).sort(
      (a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999') || a.eventType.localeCompare(b.eventType),
    );
    await client.query('delete from public.works_events where community_id = $1 and works_package_id = $2 and engine_version = $3', [
      cid,
      pkg.id,
      RECON_ENGINE_VERSION,
    ]);
    for (const e of sequenceEvents(drafts)) {
      await client.query(
        `insert into public.works_events
           (community_id, works_package_id, event_type, event_date, ref_type, ref_id, amount, seq_ok, violation_text, suspension_reason, engine_version)
         values ($1, $2, $3::public.works_event_type, $4, $5, $6, $7, $8, $9, $10::public.suspension_reason, $11)`,
        [
          cid,
          pkg.id,
          e.eventType,
          e.eventDate,
          e.refType,
          e.refId,
          e.amount,
          e.seqOk,
          e.violationText,
          e.suspensionReason ?? null,
          RECON_ENGINE_VERSION,
        ],
      );
      events++;
      if (e.seqOk === false) violations++;
    }
  }
  return { packages: pkgs.rows.length, events, violations, missingTables };
}
