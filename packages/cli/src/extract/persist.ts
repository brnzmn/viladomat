import {
  classifyTransaction,
  dedupeKey,
  detectRecurringDirectDebits,
  hmacIban,
  ibanLast4,
  normaliseCompanyName,
  normaliseInvoiceNumber,
  normaliseIban,
  normaliseNif,
  normaliseValue,
  parseDateEs,
  validateIban,
  validateNif,
  type ValueKind,
} from '@viladomat/core';
import { createHash } from 'node:crypto';
import { envOptional } from '../lib/env.ts';
import { hmacNif } from '../vendors/links.ts';
import {
  isCriticalPath,
  validateParsed,
  type Acta,
  type Contrato,
  type Derrama,
  type DocType,
  type Extracto,
  type Factura,
  type FieldValueKind,
  type FieldValueSeed,
  type Liquidacion,
  type ValidatorResult,
} from './adapter.ts';

/**
 * Turn one parsed document into rows.
 *
 * Three layers are written, and only the first two are common to every document type:
 *
 *  1. **`field_revisions`** (source `model`), one per monetary/identity field. The database trigger
 *     materialises `field_values`; this module then fills in the provenance the trigger cannot know
 *     (page, bbox, quote, model confidence) and re-writes `value_norm` with `normaliseValue`, so the
 *     comparison string of the two-source rule is the canonical one and not the raw JSON text.
 *  2. **`validator_results`**, the versioned arithmetic/identity checks of the core module, plus the
 *     per-field `validator_ok` flag the two-source rule reads.
 *  3. **Domain rows** for the five unlocking classes and invoices. Nothing here interprets: an acta
 *     becomes meetings and resolutions, a liquidación becomes the administrator's own figures
 *     (`entry_source = 'extraction'`, always the assertion of the party under review), a statement
 *     becomes movements, a contract becomes milestones, a levy notice becomes an expected ledger,
 *     an invoice becomes its lines and its dedupe key.
 *
 * Two rules hold across all of it. A field a human has confirmed or corrected is never overwritten
 * by a model run — the revision is skipped and counted. And people are rows only as roles or unit
 * labels: attendee names, owner names and payer names never reach a column.
 *
 * Idempotent: every writer either upserts on a natural key or replaces the child rows of the
 * document it owns, so running the same extraction twice leaves the same rows.
 */

// ---------------------------------------------------------------------------
// A minimal query surface, so the same code runs on a pool and inside a transaction
// ---------------------------------------------------------------------------

/** Structural subset of `pg.Pool` / `pg.PoolClient` used here. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

async function rows<T>(client: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await client.query(sql, params);
  return r.rows as T[];
}

async function first<T>(client: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(client, sql, params))[0];
}

async function firstId(client: Queryable, sql: string, params: unknown[] = []): Promise<string | null> {
  const row = await first<{ id: string }>(client, sql, params);
  return row ? String(row.id) : null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One page of the document, as the parsed object refers to it. */
export interface PersistPage {
  /** The `page_index` the model used for this page (the index sent in the request). */
  index: number;
  page_id: string;
  /** Mime of the file the page came from. */
  mime?: string | null;
  /** Whether the page carries a PDF text layer (decides `pdf_native` vs `pdf_scan`). */
  has_text_layer?: boolean | null;
  file_id?: string | null;
}

/** The document the parsed object belongs to. */
export interface PersistDocument {
  id: string;
  community_id: string;
  pages: PersistPage[];
  /** Community NIF, used to test whether an invoice is addressed to the community. */
  community_nif?: string | null;
}

export interface PersistInput {
  document: PersistDocument;
  parsed: unknown;
  docType: DocType;
  flattened: FieldValueSeed[];
  /** `extraction_runs.id` of the run that produced `parsed`; null for a run-less replay. */
  runId: string | null;
  /** Reference date for the date-sanity validators (tests pin it). */
  now?: Date;
}

export interface PersistResult {
  document_id: string;
  field_revisions: number;
  fields_kept_human: number;
  validators: { total: number; failed: string[] };
  domain: Record<string, unknown>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Validator families
// ---------------------------------------------------------------------------

/** The group of checks a validator belongs to; a field is only judged by its own family. */
export type ValidatorFamily = 'amount' | 'date' | 'nif' | 'iban' | 'none';

/** Family a validator code belongs to, from its name (`*.nif_*`, `*.iban_*`, `*.fechas_*`, else arithmetic). */
export function validatorFamily(code: string): ValidatorFamily {
  if (/nif/.test(code)) return 'nif';
  if (/iban/.test(code)) return 'iban';
  if (/fecha/.test(code)) return 'date';
  return 'amount';
}

/**
 * Family a field belongs to. Free text and booleans belong to no family: no validator inspects a
 * vendor name, so nothing about them can fail — for those fields the OCR agreement is the whole
 * test.
 */
export function familyOfKind(kind: FieldValueKind): ValidatorFamily {
  switch (kind) {
    case 'amount':
    case 'int':
      return 'amount';
    case 'date':
      return 'date';
    case 'nif':
      return 'nif';
    case 'iban':
      return 'iban';
    default:
      return 'none';
  }
}

/** `field_values.validator_ok`: every validator of the field's family passed. */
export function validatorOkFor(kind: FieldValueKind, results: readonly ValidatorResult[]): boolean {
  const family = familyOfKind(kind);
  if (family === 'none') return true;
  return results.filter((r) => validatorFamily(r.code) === family).every((r) => r.passed);
}

/** `normaliseValue` kind for a flattened field kind (`int` compares as an amount, `bool` as text). */
export function valueKindOf(kind: FieldValueKind): ValueKind {
  switch (kind) {
    case 'int':
      return 'amount';
    case 'bool':
      return 'text';
    case 'amount':
    case 'date':
    case 'nif':
    case 'iban':
      return kind;
    default:
      return 'text';
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const iso = (v: unknown): string | null => (typeof v === 'string' ? parseDateEs(v) : null);

/** First day of the month a date falls in, as an ISO date. */
export function monthStart(date: string | null): string | null {
  const d = iso(date);
  return d ? `${d.slice(0, 7)}-01` : null;
}

/** Statement key of one movement: account, date, signed amount and concept, hashed. */
export function transactionDedupeKey(accountKey: string, fecha: string, importe: number, concepto: string): string {
  const canonical = [accountKey, fecha, importe.toFixed(2), normaliseValue('text', concepto) ?? ''].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** HMAC of an IBAN with `IBAN_HMAC_KEY`; null when no key is configured or the text is not an IBAN. */
export function ibanPseudonym(raw: string | null | undefined): { hmac: string | null; last4: string | null } {
  const normalised = normaliseIban(raw);
  if (!normalised) return { hmac: null, last4: null };
  const last4 = ibanLast4(normalised) || null;
  const key = envOptional('IBAN_HMAC_KEY');
  if (!key) return { hmac: null, last4 };
  return { hmac: hmacIban(normalised, key), last4 };
}

interface PageLookup {
  byIndex: Map<number, string>;
  firstMime: string | null;
  firstHasTextLayer: boolean | null;
}

function pageLookup(document: PersistDocument): PageLookup {
  const byIndex = new Map<number, string>();
  for (const p of document.pages) byIndex.set(p.index, p.page_id);
  const firstPage = document.pages[0];
  return {
    byIndex,
    firstMime: firstPage?.mime ?? null,
    firstHasTextLayer: firstPage?.has_text_layer ?? null,
  };
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export interface UpsertPartyInput {
  communityId: string;
  documentId: string;
  kind: string;
  /** Legal entity name as printed. Never a natural person's name. */
  displayName: string | null;
  nif: string | null;
  address?: string | null;
  originClass?: string;
}

/**
 * Find or create a party. The identity key is the NIF when one is printed, the normalised legal
 * name otherwise; a later document that carries the NIF fills it in on the existing row rather than
 * creating a second party.
 */
export async function upsertParty(client: Queryable, input: UpsertPartyInput): Promise<string | null> {
  const nif = normaliseNif(input.nif) || null;
  const display = str(input.displayName);
  if (!nif && !display) return null;
  const nameNorm = display ? normaliseCompanyName(display) || normaliseValue('text', display) : null;
  const nifHmac = nifPseudonym(nif);

  const existing = nif
    ? await first<{ id: string }>(client, 'select id from public.parties where community_id = $1 and nif = $2 limit 1', [input.communityId, nif])
    : await first<{ id: string }>(
        client,
        'select id from public.parties where community_id = $1 and legal_name_norm = $2 and nif is null limit 1',
        [input.communityId, nameNorm],
      );
  if (existing) {
    await client.query(
      `update public.parties
          set display_name = coalesce(display_name, $2),
              legal_name_norm = coalesce(legal_name_norm, $3),
              nif = coalesce(nif, $4),
              nif_valid = coalesce(nif_valid, $5),
              nif_kind = coalesce(nif_kind, $6),
              entity_letter = coalesce(entity_letter, $7),
              address_norm = coalesce(address_norm, $8),
              first_seen_document_id = coalesce(first_seen_document_id, $9),
              nif_hmac = coalesce(nif_hmac, $10)
        where id = $1`,
      [
        existing.id,
        display,
        nameNorm,
        nif,
        nif ? validateNif(nif).valid : null,
        nif ? validateNif(nif).kind : null,
        nif ? (validateNif(nif).entityLetter ?? null) : null,
        input.address ? normaliseValue('text', input.address) : null,
        input.documentId,
        nifHmac,
      ],
    );
    return String(existing.id);
  }

  const validation = nif ? validateNif(nif) : null;
  return firstId(
    client,
    `insert into public.parties (community_id, kind, display_name, legal_name_norm, nif, nif_valid, nif_kind, entity_letter,
                                 address_norm, origin_class, first_seen_document_id, nif_hmac)
     values ($1, $2::public.party_kind, $3, $4, $5, $6, $7, $8, $9, $10::public.issuer_class, $11, $12)
     returning id`,
    [
      input.communityId,
      input.kind,
      display ?? nif ?? 'sense nom',
      nameNorm,
      nif,
      validation ? validation.valid : null,
      validation ? validation.kind : null,
      validation?.entityLetter ?? null,
      input.address ? normaliseValue('text', input.address) : null,
      input.originClass ?? 'unknown',
      input.documentId,
      nifHmac,
    ],
  );
}

/**
 * Keyed digest of a party identifier (`parties.nif_hmac`, 0013) with the same server secret as
 * the IBAN digests; null when no key is configured or there is no identifier. The digest is what
 * the related-party equality tests compare (`vendors/links.ts`); the identifier itself stays in
 * `parties.nif` as business data of the counterparty.
 */
export function nifPseudonym(nif: string | null | undefined): string | null {
  const n = normaliseNif(nif);
  if (!n) return null;
  const key = envOptional('IBAN_HMAC_KEY');
  if (!key) return null;
  try {
    return hmacNif(n, key);
  } catch {
    return null;
  }
}

/**
 * Record an IBAN seen on a document as a pseudonym (HMAC + last four). `iban_enc` stays null: the
 * ciphertext of a full IBAN is written by the review screen, never by the worker.
 */
export async function upsertPartyIban(
  client: Queryable,
  input: { communityId: string; partyId: string; iban: string | null; documentId: string; seenOn: string | null },
): Promise<'written' | 'no_key' | 'no_iban'> {
  const { hmac, last4 } = ibanPseudonym(input.iban);
  if (!last4) return 'no_iban';
  if (!hmac) return 'no_key';
  const v = validateIban(input.iban);
  await client.query(
    `insert into public.party_ibans (community_id, party_id, iban_hmac, iban_last4, bank_code, bank_name, country,
                                     iban_valid, ccc_dc_valid, seen_on, first_seen_document_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11)
     on conflict (party_id, iban_hmac) do update
        set seen_on = least(public.party_ibans.seen_on, excluded.seen_on),
            bank_name = coalesce(public.party_ibans.bank_name, excluded.bank_name)`,
    [
      input.communityId,
      input.partyId,
      hmac,
      last4,
      v.bankCode ?? null,
      v.bankName ?? null,
      v.country || null,
      v.valid,
      v.cccDcOk ?? null,
      input.seenOn,
      input.documentId,
    ],
  );
  return 'written';
}

/** Unit whose label matches, compared with the database's own text normalisation. */
export async function unitIdByLabel(client: Queryable, communityId: string, label: string | null): Promise<string | null> {
  const text = str(label);
  if (!text) return null;
  return firstId(client, 'select id from public.units where community_id = $1 and public.norm_text(label) = public.norm_text($2) limit 1', [
    communityId,
    text,
  ]);
}

// ---------------------------------------------------------------------------
// Field revisions + validators
// ---------------------------------------------------------------------------

/** Statuses a model run must not overwrite. */
export const HUMAN_STATUSES: ReadonlySet<string> = new Set(['human_confirmed', 'corrected']);

async function writeFields(
  client: Queryable,
  input: PersistInput,
  validators: readonly ValidatorResult[],
  pages: PageLookup,
): Promise<{ written: number; keptHuman: number }> {
  const { document, docType, flattened, runId } = input;
  let written = 0;
  let keptHuman = 0;

  for (const seed of flattened) {
    if (!seed.is_critical && !isCriticalPath(docType, seed.field_path)) continue;
    const current = await first<{ value: unknown; status: string }>(
      client,
      'select value, status from public.field_values where document_id = $1 and field_path = $2',
      [document.id, seed.field_path],
    );
    if (current && HUMAN_STATUSES.has(current.status)) {
      keptHuman += 1;
      continue;
    }
    await client.query(
      `insert into public.field_revisions (community_id, document_id, run_id, field_path, old_value, new_value, source, reason)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'model', $7)`,
      [
        document.community_id,
        document.id,
        runId,
        seed.field_path,
        current ? JSON.stringify(current.value ?? null) : null,
        JSON.stringify(seed.value ?? null),
        `extraction of ${docType}`,
      ],
    );
    const kind = seed.value_kind;
    await client.query(
      `update public.field_values
          set value_norm = $3,
              page_id = $4,
              bbox = $5::int[],
              quote = $6,
              model_conf = $7,
              crop_status = 'page_only',
              validator_ok = $8,
              ocr_value_norm = null,
              ocr_agrees = null,
              sonnet_value_norm = null,
              sonnet_agrees = null
        where document_id = $1 and field_path = $2`,
      [
        document.id,
        seed.field_path,
        normaliseValue(valueKindOf(kind), seed.value as string | number | null),
        seed.page_index === null ? null : (pages.byIndex.get(seed.page_index) ?? null),
        seed.bbox ? seed.bbox.map((n) => Math.round(n)) : null,
        seed.quote,
        seed.model_conf,
        validatorOkFor(kind, validators),
      ],
    );
    written += 1;
  }
  return { written, keptHuman };
}

// ---------------------------------------------------------------------------
// acta → meetings + resolutions
// ---------------------------------------------------------------------------

const MEETING_KIND: Readonly<Record<string, string>> = Object.freeze({
  ordinaria: 'ordinaria',
  extraordinaria: 'extraordinaria',
  universal: 'extraordinaria',
  no_consta: 'ordinaria',
});

const RESOLUTION_RESULT: Readonly<Record<string, string>> = Object.freeze({
  aprobado: 'aprobado',
  rechazado: 'rechazado',
  informado: 'informado',
  pendiente: 'pendiente',
  no_consta: 'pendiente',
});

/**
 * Classify a resolution from what it says it does; `other` when nothing matches.
 *
 * The order matters where a resolution does two things at once. "S'aprova contractar la
 * instal·lació de l'ascensor … per un import de 52.800 €" both approves works and names a company:
 * it is recorded as a works approval, because that is the fact the authority and funding checks
 * need. `contractor_choice` is kept for a decision whose subject is the award itself (adjudicar,
 * escollir, seleccionar the company).
 */
export function resolutionKind(text: string, hasDelegation: boolean): string {
  const t = normaliseValue('text', text) ?? '';
  if (/derrama|quota extraordinaria|cuota extraordinaria/.test(t)) return 'derrama';
  if (/prestec|prestamo|credit bancari|poliza de credito|hipotec/.test(t)) return 'loan';
  if (/subvenci/.test(t)) return 'subsidy';
  if (/auditor/.test(t)) return 'audit';
  if (/adjudic|escollir (l'|la |el )?empresa|seleccionar (la |el )?empresa|triar (l'|la |el )?empresa|elegir (la |el )?empresa/.test(t)) {
    return 'contractor_choice';
  }
  if (/obra|ascensor|reforma|rehabilitaci|instal.?laci|instalaci|façana|fachada|bastida|andami/.test(t)) return 'works_approval';
  if (/pressupost|presupuesto/.test(t)) return 'budget';
  if (/comptes|cuentas|liquidaci|balanc|balance/.test(t)) return 'accounts';
  // the structured delegation block outranks a keyword: "el titular del càrrec" appears in both
  if (hasDelegation) return 'delegation';
  if (/elecci|es nomena|se nombra|nomenament|nombramiento|es designa|se designa|renovacio? de/.test(t)) return 'election';
  if (/delega|faculta|autoritza|autoriza|apodera/.test(t)) return 'delegation';
  return 'other';
}

/** Amount a resolution approves: the single amount mentioned, or the largest when several are. */
export function approvedAmount(amounts: ReadonlyArray<{ importe: number | null }>): number | null {
  const values = amounts.map((a) => num(a.importe)).filter((n): n is number => n !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}

async function persistActa(client: Queryable, input: PersistInput, pages: PageLookup): Promise<Record<string, unknown>> {
  const doc = input.parsed as Acta;
  const { document } = input;
  const fecha = iso(doc.fecha);
  if (!fecha) return { skipped: 'the minutes print no meeting date; meetings needs one' };
  const tipo = MEETING_KIND[doc.tipo] ?? 'ordinaria';

  // attendees are stored as unit labels and a presence flag; owner names never enter a column
  const attendees = (doc.asistentes ?? []).map((a) => ({
    unit_label: a.entidad_label,
    presence: a.presente_o_representado,
    quota_pct: num(a.coeficiente_pct),
  }));

  const values = {
    convocatoria_fecha: iso(doc.fecha_convocatoria),
    convened_by_role: str(doc.convocada_por_rol),
    lugar: str(doc.lugar),
    quorum_pct: num(doc.quorum_pct),
    attendees: JSON.stringify(attendees),
    cuentas_aprobadas: doc.cuentas_aprobadas,
    presupuesto_aprobado: num(doc.presupuesto_aprobado),
    firma_presidente: doc.firmas?.presidente ?? null,
    firma_secretario: doc.firmas?.secretario ?? null,
    fecha_firma: iso(doc.fecha_cierre_acta),
  };

  const existing = await first<{ id: string; entry_source: string }>(
    client,
    'select id, entry_source from public.meetings where community_id = $1 and fecha = $2::date and tipo = $3::public.meeting_kind',
    [document.community_id, fecha, tipo],
  );

  let meetingId: string;
  let seedKept = false;
  if (!existing) {
    meetingId = String(
      await firstId(
        client,
        `insert into public.meetings (community_id, document_id, tipo, fecha, convocatoria_fecha, convened_by_role, lugar,
                                      quorum_pct, attendees, cuentas_aprobadas, presupuesto_aprobado,
                                      firma_presidente, firma_secretario, fecha_firma, entry_source)
         values ($1, $2, $3::public.meeting_kind, $4::date, $5::date, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::date, 'extraction')
         returning id`,
        [
          document.community_id,
          document.id,
          tipo,
          fecha,
          values.convocatoria_fecha,
          values.convened_by_role,
          values.lugar,
          values.quorum_pct,
          values.attendees,
          values.cuentas_aprobadas,
          values.presupuesto_aprobado,
          values.firma_presidente,
          values.firma_secretario,
          values.fecha_firma,
        ],
      ),
    );
  } else if (existing.entry_source === 'seed') {
    // the seed row is the figure a person transcribed from the paper: it stays, and the model's
    // reading lives in field_revisions where the two can be compared
    seedKept = true;
    meetingId = String(existing.id);
    await client.query(
      `update public.meetings
          set document_id = coalesce(document_id, $2),
              convocatoria_fecha = coalesce(convocatoria_fecha, $3::date),
              convened_by_role = coalesce(convened_by_role, $4),
              lugar = coalesce(lugar, $5),
              quorum_pct = coalesce(quorum_pct, $6),
              attendees = coalesce(attendees, $7::jsonb),
              cuentas_aprobadas = coalesce(cuentas_aprobadas, $8),
              presupuesto_aprobado = coalesce(presupuesto_aprobado, $9),
              firma_presidente = coalesce(firma_presidente, $10),
              firma_secretario = coalesce(firma_secretario, $11),
              fecha_firma = coalesce(fecha_firma, $12::date)
        where id = $1`,
      [
        meetingId,
        document.id,
        values.convocatoria_fecha,
        values.convened_by_role,
        values.lugar,
        values.quorum_pct,
        values.attendees,
        values.cuentas_aprobadas,
        values.presupuesto_aprobado,
        values.firma_presidente,
        values.firma_secretario,
        values.fecha_firma,
      ],
    );
  } else {
    meetingId = String(existing.id);
    await client.query(
      `update public.meetings
          set document_id = $2, convocatoria_fecha = $3::date, convened_by_role = $4, lugar = $5, quorum_pct = $6,
              attendees = $7::jsonb, cuentas_aprobadas = $8, presupuesto_aprobado = $9,
              firma_presidente = $10, firma_secretario = $11, fecha_firma = $12::date
        where id = $1`,
      [
        meetingId,
        document.id,
        values.convocatoria_fecha,
        values.convened_by_role,
        values.lugar,
        values.quorum_pct,
        values.attendees,
        values.cuentas_aprobadas,
        values.presupuesto_aprobado,
        values.firma_presidente,
        values.firma_secretario,
        values.fecha_firma,
      ],
    );
  }

  let resolutions = 0;
  for (const acuerdo of doc.acuerdos ?? []) {
    const votes = acuerdo.votos;
    const votesJson = votes
      ? JSON.stringify({
          favor: votes.favor,
          contra: votes.contra,
          abstencion: votes.abstencion,
          quotas_favor_pct: num(acuerdo.coeficientes_favor_pct),
          unanimity_declared: acuerdo.unanimidad_declarada,
        })
      : JSON.stringify({ unanimity_declared: acuerdo.unanimidad_declarada });
    const votersFavor = votes ? votes.favor : null;
    const votersTotal = votes ? (votes.favor ?? 0) + (votes.contra ?? 0) + (votes.abstencion ?? 0) : null;
    const pageId = pages.byIndex.get(acuerdo.page_index) ?? null;
    const params = [
      document.community_id,
      meetingId,
      acuerdo.punto,
      acuerdo.texto_literal,
      resolutionKind(`${acuerdo.titulo ?? ''} ${acuerdo.texto_literal}`, acuerdo.delegacion !== null),
      RESOLUTION_RESULT[acuerdo.resultado] ?? 'pendiente',
      votesJson,
      num(acuerdo.coeficientes_favor_pct),
      votersFavor,
      votersTotal,
      approvedAmount(acuerdo.importes_mencionados ?? []),
      acuerdo.delegacion?.a_quien_rol ?? null,
      acuerdo.delegacion?.alcance ?? null,
      acuerdo.delegacion ? num(acuerdo.delegacion.limite_importe) : null,
      acuerdo.delegacion ? num(acuerdo.delegacion.limite_importe) !== null : null,
      pageId,
      acuerdo.page_index + 1,
    ];
    const existingRes = await first<{ id: string }>(
      client,
      'select id from public.resolutions where meeting_id = $1 and punto is not distinct from $2',
      [meetingId, acuerdo.punto],
    );
    if (existingRes) {
      await client.query(
        `update public.resolutions
            set texto_literal = $4, kind = $5::public.resolution_kind, resultado = $6::public.resolution_result,
                votos = $7::jsonb, quotas_favor_pct = $8, voters_favor = $9, voters_total = $10, importe_aprobado = $11,
                delegation_to_role = $12, delegation_scope = $13, delegation_cap = $14, cap_explicit = $15,
                page_id = $16, page_no = $17, entry_source = 'extraction'
          where id = $18`,
        [...params, existingRes.id],
      );
    } else {
      await client.query(
        `insert into public.resolutions (community_id, meeting_id, punto, texto_literal, kind, resultado, votos,
                                         quotas_favor_pct, voters_favor, voters_total, importe_aprobado,
                                         delegation_to_role, delegation_scope, delegation_cap, cap_explicit,
                                         page_id, page_no, entry_source)
         values ($1, $2, $3, $4, $5::public.resolution_kind, $6::public.resolution_result, $7::jsonb, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, 'extraction')`,
        params,
      );
    }
    resolutions += 1;
  }

  return { meeting_id: meetingId, resolutions, seed_row_kept: seedKept };
}

// ---------------------------------------------------------------------------
// liquidación → liquidations + lines + unit rows
// ---------------------------------------------------------------------------

async function persistLiquidacion(client: Queryable, input: PersistInput, pages: PageLookup): Promise<Record<string, unknown>> {
  const doc = input.parsed as Liquidacion;
  const { document } = input;
  const ejercicio =
    num(doc.ejercicio) ??
    (iso(doc.periodo?.desde) ? Number(iso(doc.periodo?.desde)?.slice(0, 4)) : null) ??
    (iso(doc.periodo?.hasta) ? Number(iso(doc.periodo?.hasta)?.slice(0, 4)) : null);
  if (ejercicio === null) return { skipped: 'no fiscal year printed; liquidations needs one' };

  const administratorId = doc.administrador_es_persona_fisica
    ? null
    : await upsertParty(client, {
        communityId: document.community_id,
        documentId: document.id,
        kind: 'administrator',
        displayName: doc.administrador_nombre,
        nif: null,
        originClass: 'administrator',
      });

  const liquidationId = String(
    await firstId(
      client,
      `insert into public.liquidations (community_id, document_id, ejercicio, periodo_desde, periodo_hasta, administrator_party_id,
                                        basis, total_ingresos, total_gastos, resultado, saldo_inicial, saldo_final,
                                        fondo_reserva_inicial, fondo_reserva_dotacion, fondo_reserva_disposiciones, fondo_reserva_final,
                                        saldo_en_poder_administrador, deudores_total, acreedores_pendientes,
                                        facturas_pendientes_pago, retenciones_pendientes, entry_source)
       values ($1, $2, $3, $4::date, $5::date, $6, $7::public.liq_basis, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'extraction')
       on conflict (community_id, ejercicio, document_id) do update
          set periodo_desde = excluded.periodo_desde, periodo_hasta = excluded.periodo_hasta,
              administrator_party_id = excluded.administrator_party_id, basis = excluded.basis,
              total_ingresos = excluded.total_ingresos, total_gastos = excluded.total_gastos, resultado = excluded.resultado,
              saldo_inicial = excluded.saldo_inicial, saldo_final = excluded.saldo_final,
              fondo_reserva_inicial = excluded.fondo_reserva_inicial, fondo_reserva_dotacion = excluded.fondo_reserva_dotacion,
              fondo_reserva_disposiciones = excluded.fondo_reserva_disposiciones, fondo_reserva_final = excluded.fondo_reserva_final,
              saldo_en_poder_administrador = excluded.saldo_en_poder_administrador,
              deudores_total = excluded.deudores_total, acreedores_pendientes = excluded.acreedores_pendientes,
              facturas_pendientes_pago = excluded.facturas_pendientes_pago, retenciones_pendientes = excluded.retenciones_pendientes
       returning id`,
      [
        document.community_id,
        document.id,
        ejercicio,
        iso(doc.periodo?.desde),
        iso(doc.periodo?.hasta),
        administratorId,
        doc.criterio_contable ?? 'unknown',
        num(doc.totales?.total_ingresos),
        num(doc.totales?.total_gastos),
        num(doc.totales?.resultado),
        num(doc.saldos?.inicial),
        num(doc.saldos?.final),
        num(doc.fondo_reserva?.inicial),
        num(doc.fondo_reserva?.dotacion),
        num(doc.fondo_reserva?.disposiciones),
        num(doc.fondo_reserva?.final),
        num(doc.saldo_en_poder_administrador),
        num(doc.pendientes?.deudores_total),
        num(doc.pendientes?.acreedores_total),
        num(doc.pendientes?.facturas_pendientes_pago),
        num(doc.pendientes?.retenciones_pendientes),
      ],
    ),
  );

  await client.query('delete from public.liquidation_lines where liquidation_id = $1', [liquidationId]);
  let lines = 0;
  for (const row of doc.ingresos ?? []) {
    await client.query(
      `insert into public.liquidation_lines (community_id, liquidation_id, side, concepto, importe, presupuestado, capitulo, page_id)
       values ($1, $2, 'ingreso', $3, $4, $5, $6, $7)`,
      [document.community_id, liquidationId, row.concepto, num(row.importe) ?? 0, num(row.presupuestado), str(row.capitulo), pages.byIndex.get(row.page_index) ?? null],
    );
    lines += 1;
  }
  for (const row of doc.gastos ?? []) {
    const vendorId = row.proveedor
      ? await upsertParty(client, {
          communityId: document.community_id,
          documentId: document.id,
          kind: 'vendor',
          displayName: row.proveedor,
          nif: null,
          originClass: 'administrator',
        })
      : null;
    await client.query(
      `insert into public.liquidation_lines (community_id, liquidation_id, side, concepto, proveedor_text, vendor_party_id,
                                             importe, presupuestado, capitulo, page_id)
       values ($1, $2, 'gasto', $3, $4, $5, $6, $7, $8, $9)`,
      [
        document.community_id,
        liquidationId,
        row.concepto,
        str(row.proveedor),
        vendorId,
        num(row.importe) ?? 0,
        num(row.presupuestado),
        str(row.capitulo),
        pages.byIndex.get(row.page_index) ?? null,
      ],
    );
    lines += 1;
  }

  await client.query('delete from public.liquidation_unit_rows where liquidation_id = $1', [liquidationId]);
  let unitRows = 0;
  let unmatchedUnits = 0;
  for (const row of doc.cuotas_por_unidad ?? []) {
    const unitId = await unitIdByLabel(client, document.community_id, row.entidad_label);
    if (!unitId) unmatchedUnits += 1;
    await client.query(
      `insert into public.liquidation_unit_rows (community_id, liquidation_id, unit_id, unit_label_as_shown, coeficiente_pct,
                                                 cuota_ordinaria, cuota_extraordinaria, deuda_pendiente)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [document.community_id, liquidationId, unitId, row.entidad_label, num(row.coeficiente_pct), num(row.cuota_ordinaria), num(row.cuota_extraordinaria), num(row.deuda_pendiente)],
    );
    unitRows += 1;
  }

  return { liquidation_id: liquidationId, ejercicio, lines, unit_rows: unitRows, unit_labels_without_unit: unmatchedUnits };
}

// ---------------------------------------------------------------------------
// extracto bancario → bank_statements + bank_transactions
// ---------------------------------------------------------------------------

/** Statement provenance from the file it was read out of. */
export function statementSource(mime: string | null, hasTextLayer: boolean | null): string {
  if (mime === 'application/pdf') return hasTextLayer === true ? 'pdf_native' : 'pdf_scan';
  return 'photo';
}

/** A photographed or scanned row is read once; a native PDF row twice (text layer and pixels). */
export function statementConfidence(source: string): number {
  return source === 'pdf_native' ? 0.85 : 0.7;
}

/**
 * Resolve the account a statement belongs to: the account whose last four digits match what the
 * statement prints, else the only account of the community, else a new account with an unknown
 * holder — a statement never establishes who the account is titled to.
 */
export async function resolveBankAccount(
  client: Queryable,
  input: { communityId: string; documentId: string | null; ibanShown: string | null; bankName: string | null; holder: string | null },
): Promise<{ id: string; created: boolean; how: string }> {
  const last4 = ibanLast4(input.ibanShown) || (str(input.ibanShown)?.replace(/[^0-9]/g, '').slice(-4) ?? '');
  if (last4) {
    const match = await first<{ id: string }>(client, 'select id from public.bank_accounts where community_id = $1 and iban_last4 = $2 limit 1', [
      input.communityId,
      last4,
    ]);
    if (match) return { id: String(match.id), created: false, how: `last four digits ${last4}` };
  }
  const all = await rows<{ id: string }>(client, 'select id from public.bank_accounts where community_id = $1', [input.communityId]);
  if (all.length === 1 && all[0]) return { id: String(all[0].id), created: false, how: 'the only account on file' };

  const label = str(input.bankName) ? `${str(input.bankName)}${last4 ? ` ····${last4}` : ''}` : `Compte ····${last4 || '????'}`;
  const { hmac } = ibanPseudonym(input.ibanShown);
  const created = await firstId(
    client,
    `insert into public.bank_accounts (community_id, label, iban_hmac, iban_last4, bank_name, holder_as_shown, holder_kind, purpose)
     values ($1, $2, $3, $4, $5, $6, 'unknown', 'unknown')
     on conflict (community_id, label) do update set bank_name = coalesce(public.bank_accounts.bank_name, excluded.bank_name)
     returning id`,
    [input.communityId, label, hmac, last4 || null, str(input.bankName), str(input.holder)],
  );
  return { id: String(created), created: true, how: 'created with an unknown holder' };
}

async function persistExtracto(
  client: Queryable,
  input: PersistInput,
  pages: PageLookup,
  validators: readonly ValidatorResult[],
): Promise<Record<string, unknown>> {
  const doc = input.parsed as Extracto;
  const { document } = input;
  const source = statementSource(pages.firstMime, pages.firstHasTextLayer);
  const confidence = statementConfidence(source);

  const account = await resolveBankAccount(client, {
    communityId: document.community_id,
    documentId: document.id,
    ibanShown: doc.iban_o_cuenta_mostrada,
    bankName: doc.banco,
    holder: doc.titular_es_persona_fisica === true ? null : doc.titular,
  });

  const continuity = validators.find((v) => v.code === 'extracto.continuidad_saldo');
  const continuityOk = continuity && continuity.details['checked'] === true ? continuity.passed : null;
  const checks = doc.self_checks as Record<string, boolean | null | number> | undefined;
  const checkValues = checks ? Object.entries(checks).filter(([k]) => k !== 'discrepancia_eur').map(([, v]) => v) : [];
  const selfCheckOk = checkValues.some((v) => v === false) ? false : checkValues.some((v) => v === true) ? true : null;
  const discrepancy =
    num(checks?.['discrepancia_eur']) ??
    (continuity && typeof continuity.details['difference'] === 'number' ? (continuity.details['difference'] as number) : null);

  const existing = await first<{ id: string }>(client, 'select id from public.bank_statements where document_id = $1 limit 1', [document.id]);
  let statementId: string;
  if (existing) {
    statementId = String(existing.id);
    await client.query(
      `update public.bank_statements
          set bank_account_id = $2, source = $3::public.statement_source, periodo_desde = $4::date, periodo_hasta = $5::date,
              saldo_inicial = $6, saldo_final = $7, continuity_ok = $8, self_check_ok = $9, discrepancy_eur = $10, parser_version = $11
        where id = $1`,
      [statementId, account.id, source, iso(doc.periodo?.desde), iso(doc.periodo?.hasta), num(doc.saldo_inicial), num(doc.saldo_final), continuityOk, selfCheckOk, discrepancy, 'extraction'],
    );
    await client.query('delete from public.bank_transactions where statement_id = $1', [statementId]);
  } else {
    statementId = String(
      await firstId(
        client,
        `insert into public.bank_statements (community_id, bank_account_id, document_id, source, periodo_desde, periodo_hasta,
                                             saldo_inicial, saldo_final, continuity_ok, self_check_ok, discrepancy_eur, parser_version)
         values ($1, $2, $3, $4::public.statement_source, $5::date, $6::date, $7, $8, $9, $10, $11, 'extraction')
         returning id`,
        [document.community_id, account.id, document.id, source, iso(doc.periodo?.desde), iso(doc.periodo?.hasta), num(doc.saldo_inicial), num(doc.saldo_final), continuityOk, selfCheckOk, discrepancy],
      ),
    );
  }

  const classified = (doc.movimientos ?? []).map((m) => {
    const c = classifyTransaction({
      amount: m.importe,
      conceptText: m.concepto,
      counterpartyText: m.contraparte_nombre ?? undefined,
      counterpartyIban: m.contraparte_iban ?? undefined,
    });
    return { movement: m, amount: m.importe, counterpartyText: m.contraparte_nombre ?? undefined, txKind: c.txKind, flags: c.flags };
  });
  const withRecurring = detectRecurringDirectDebits(classified);

  let inserted = 0;
  for (const row of withRecurring) {
    const m = row.movement;
    const fecha = iso(m.fecha_operacion);
    if (!fecha) continue;
    const kind = row.flags.includes('direct_debit_recurring') && row.txKind === 'direct_debit' ? 'direct_debit_recurring' : row.txKind;
    const { hmac, last4 } = ibanPseudonym(m.contraparte_iban);
    await client.query(
      `insert into public.bank_transactions (community_id, bank_account_id, statement_id, fecha_operacion, fecha_valor, importe,
                                             concepto_text, counterparty_name_norm, counterparty_iban_hmac, counterparty_iban_last4,
                                             ref1, saldo_tras, tx_kind, flags, page_id, confidence, dedupe_key)
       values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, $13::public.tx_kind, $14::text[], $15, $16, $17)
       on conflict (bank_account_id, dedupe_key) do update
          set statement_id = excluded.statement_id, tx_kind = excluded.tx_kind, flags = excluded.flags,
              page_id = excluded.page_id, confidence = greatest(public.bank_transactions.confidence, excluded.confidence)`,
      [
        document.community_id,
        account.id,
        statementId,
        fecha,
        iso(m.fecha_valor),
        m.importe,
        m.concepto,
        m.contraparte_es_persona_fisica === true ? null : normaliseCompanyName(m.contraparte_nombre) || null,
        hmac,
        last4,
        str(m.referencia),
        num(m.saldo_tras),
        kind,
        row.flags,
        pages.byIndex.get(m.page_index) ?? null,
        confidence,
        transactionDedupeKey(account.id, fecha, m.importe, m.concepto),
      ],
    );
    inserted += 1;
  }

  return {
    statement_id: statementId,
    bank_account_id: account.id,
    bank_account_resolved_by: account.how,
    bank_account_created: account.created,
    source,
    transactions: inserted,
    continuity_ok: continuityOk,
    self_check_ok: selfCheckOk,
  };
}

// ---------------------------------------------------------------------------
// contrato → contracts + contract_milestones
// ---------------------------------------------------------------------------

/** Advance payments above this share of the price are what A6/A7 later test; 60 % for a lift. */
export function upfrontMaxPct(kind: string): number {
  return kind === 'ascensor_instalacion' ? 60 : 40;
}

async function persistContrato(client: Queryable, input: PersistInput): Promise<Record<string, unknown>> {
  const doc = input.parsed as Contrato;
  const { document } = input;
  const communityNif = normaliseNif(document.community_nif ?? null);
  const counterparty = (doc.partes ?? []).find((p) => {
    const nif = normaliseNif(p.nif);
    if (nif && communityNif && nif === communityNif) return false;
    return !/comunidad|comunitat|propietaris|propietarios|prestatario|prestatari/i.test(p.rol);
  });
  const vendorId = counterparty
    ? await upsertParty(client, {
        communityId: document.community_id,
        documentId: document.id,
        kind: 'vendor',
        displayName: counterparty.nombre,
        nif: counterparty.nif,
        address: counterparty.domicilio,
        originClass: 'vendor_direct',
      })
    : null;

  const communityParty = (doc.partes ?? []).find((p) => /comunidad|comunitat|propietaris|propietarios/i.test(p.rol));
  const signerRole = communityParty?.representante_rol ?? (doc.firmas ?? []).find((f) => f.presente)?.rol ?? null;

  const params = [
    document.community_id,
    document.id,
    doc.kind,
    vendorId,
    iso(doc.fecha_firma),
    str(signerRole),
    num(doc.precio?.sin_iva),
    num(doc.precio?.iva_pct),
    num(doc.precio?.con_iva),
    doc.es_precio_cerrado,
    iso(doc.plazo?.inicio),
    str(doc.plazo?.duracion),
    iso(doc.plazo?.fin_previsto),
    JSON.stringify(doc.penalizaciones ?? []),
    doc.retencion_garantia ? num(doc.retencion_garantia.pct) : null,
    num(doc.garantia_meses),
    num(doc.permanencia_meses),
    str(doc.revision_precios),
    str(doc.licencia_a_cargo_de),
    doc.prl_cae_mencion,
    upfrontMaxPct(doc.kind),
    doc.elevator_spec ? JSON.stringify(doc.elevator_spec) : null,
  ];

  const existing = await first<{ id: string }>(client, 'select id from public.contracts where document_id = $1 limit 1', [document.id]);
  let contractId: string;
  if (existing) {
    contractId = String(existing.id);
    await client.query(
      `update public.contracts
          set kind = $3::public.contract_kind, vendor_party_id = $4, fecha_firma = $5::date, community_signer_role = $6,
              precio_sin_iva = $7, iva_pct = $8, precio_con_iva = $9, es_precio_cerrado = $10, inicio = $11::date,
              duracion = $12, fin_previsto = $13::date, penalizaciones = $14::jsonb, retencion_pct = $15,
              garantia_meses = $16, permanencia_meses = $17, revision_precios = $18, licencia_a_cargo_de = $19,
              prl_cae_mencion = $20, upfront_max_pct = $21, elevator_spec = $22::jsonb, entry_source = 'extraction'
        where id = $23`,
      [...params, contractId],
    );
  } else {
    contractId = String(
      await firstId(
        client,
        `insert into public.contracts (community_id, document_id, kind, vendor_party_id, fecha_firma, community_signer_role,
                                       precio_sin_iva, iva_pct, precio_con_iva, es_precio_cerrado, inicio, duracion, fin_previsto,
                                       penalizaciones, retencion_pct, garantia_meses, permanencia_meses, revision_precios,
                                       licencia_a_cargo_de, prl_cae_mencion, upfront_max_pct, elevator_spec, entry_source)
         values ($1, $2, $3::public.contract_kind, $4, $5::date, $6, $7, $8, $9, $10, $11::date, $12, $13::date, $14::jsonb,
                 $15, $16, $17, $18, $19, $20, $21, $22::jsonb, 'extraction')
         returning id`,
        params,
      ),
    );
  }

  await client.query('delete from public.contract_milestones where contract_id = $1', [contractId]);
  let milestones = 0;
  for (const [i, hito] of (doc.calendario_pagos ?? []).entries()) {
    await client.query(
      `insert into public.contract_milestones (community_id, contract_id, seq, hito, pct, importe, condicion, is_advance)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [document.community_id, contractId, i + 1, hito.hito, num(hito.pct), num(hito.importe), str(hito.condicion), hito.es_anticipo],
    );
    milestones += 1;
  }

  return { contract_id: contractId, kind: doc.kind, milestones, upfront_max_pct: upfrontMaxPct(doc.kind), vendor_party_id: vendorId };
}

// ---------------------------------------------------------------------------
// aviso de derrama / recibo → derramas + derrama_ledger
// ---------------------------------------------------------------------------

const DERRAMA_CRITERIO: Readonly<Record<string, string>> = Object.freeze({
  coeficiente: 'coeficiente',
  partes_iguales: 'partes_iguales',
  otro: 'otro',
});

async function persistDerrama(client: Queryable, input: PersistInput): Promise<Record<string, unknown>> {
  const doc = input.parsed as Derrama;
  const { document } = input;
  const objeto = str(doc.objeto) ?? str(doc.junta_que_aprueba) ?? str(doc.recibo?.periodo) ?? 'derrama sense objecte imprès';

  const targetAccountId = doc.cuenta_destino_iban
    ? (
        await resolveBankAccount(client, {
          communityId: document.community_id,
          documentId: document.id,
          ibanShown: doc.cuenta_destino_iban,
          bankName: null,
          holder: null,
        })
      ).id
    : null;

  const existing = await first<{ id: string }>(
    client,
    'select id from public.derramas where community_id = $1 and public.norm_text(objeto) = public.norm_text($2) limit 1',
    [document.community_id, objeto],
  );
  const criterio = doc.criterio_reparto ? (DERRAMA_CRITERIO[doc.criterio_reparto] ?? 'otro') : 'coeficiente';
  const perUnit = num(doc.recibo?.cuota_extraordinaria) ?? (doc.cuotas ?? []).map((c) => num(c.importe)).find((n) => n !== null) ?? null;
  const startsOn = monthStart(
    (doc.cuotas ?? []).flatMap((c) => c.plazos ?? []).map((p) => iso(p.fecha)).filter((d): d is string => d !== null).sort()[0] ?? doc.fecha,
  );

  let derramaId: string;
  if (existing) {
    derramaId = String(existing.id);
    await client.query(
      `update public.derramas
          set importe_total = coalesce($2, importe_total), criterio = $3::public.derrama_criterio,
              per_unit_amount = coalesce($4, per_unit_amount), starts_on = coalesce(starts_on, $5::date),
              months = coalesce($6, months), target_account_id = coalesce(target_account_id, $7)
        where id = $1`,
      [derramaId, num(doc.importe_total), criterio, perUnit, startsOn, num(doc.numero_plazos), targetAccountId],
    );
  } else {
    derramaId = String(
      await firstId(
        client,
        `insert into public.derramas (community_id, objeto, importe_total, criterio, per_unit_amount, starts_on, months, target_account_id, entry_source)
         values ($1, $2, $3, $4::public.derrama_criterio, $5, $6::date, $7, $8, 'extraction')
         returning id`,
        [document.community_id, objeto, num(doc.importe_total), criterio, perUnit, startsOn, num(doc.numero_plazos), targetAccountId],
      ),
    );
  }

  // expected rows per unit and period; a label that matches no unit is reported, not invented
  let ledgerRows = 0;
  let unmatched = 0;
  const write = async (label: string | null, period: string | null, expected: number | null): Promise<void> => {
    if (period === null || expected === null) return;
    const unitId = await unitIdByLabel(client, document.community_id, label);
    if (!unitId) {
      unmatched += 1;
      return;
    }
    await client.query(
      `insert into public.derrama_ledger (community_id, derrama_id, unit_id, period, expected, basis, status)
       values ($1, $2, $3, $4::date, $5, 'assertion', 'expected')
       on conflict (derrama_id, unit_id, period) do update set expected = excluded.expected`,
      [document.community_id, derramaId, unitId, period, expected],
    );
    ledgerRows += 1;
  };

  for (const cuota of doc.cuotas ?? []) {
    if ((cuota.plazos ?? []).length > 0) {
      for (const plazo of cuota.plazos) await write(cuota.entidad_label, monthStart(plazo.fecha), num(plazo.importe));
    } else {
      await write(cuota.entidad_label, monthStart(doc.fecha), num(cuota.importe));
    }
  }
  if (doc.recibo) {
    const period = monthStart(doc.recibo.periodo) ?? monthStart(doc.fecha);
    await write(doc.recibo.entidad_label, period, num(doc.recibo.cuota_extraordinaria) ?? num(doc.recibo.total));
  }

  return { derrama_id: derramaId, objeto, ledger_rows: ledgerRows, unit_labels_without_unit: unmatched };
}

// ---------------------------------------------------------------------------
// factura → parties, party_ibans, invoices, lines, VAT summary, document dedupe
// ---------------------------------------------------------------------------

async function persistFactura(client: Queryable, input: PersistInput, pages: PageLookup): Promise<Record<string, unknown>> {
  const doc = input.parsed as Factura;
  const { document } = input;

  const vendorId = await upsertParty(client, {
    communityId: document.community_id,
    documentId: document.id,
    kind: 'vendor',
    displayName: doc.emisor?.nombre ?? null,
    nif: doc.emisor?.nif ?? null,
    address: doc.emisor?.domicilio ?? null,
    originClass: 'vendor_direct',
  });

  let ibanState: string = 'no_iban';
  if (vendorId && doc.iban_mostrado) {
    ibanState = await upsertPartyIban(client, {
      communityId: document.community_id,
      partyId: vendorId,
      iban: doc.iban_mostrado,
      documentId: document.id,
      seenOn: iso(doc.fecha_expedicion),
    });
  }

  const communityNif = normaliseNif(document.community_nif ?? null);
  const recipientNif = normaliseNif(doc.destinatario?.nif ?? null);
  const number = normaliseInvoiceNumber(doc.numero);
  const { hmac: shownHmac, last4: shownLast4 } = ibanPseudonym(doc.iban_mostrado);

  const params = [
    document.community_id,
    document.id,
    vendorId,
    str(doc.serie),
    str(doc.numero),
    number.numberInt,
    iso(doc.fecha_expedicion),
    iso(doc.fecha_operacion),
    str(doc.destinatario?.nombre),
    recipientNif || null,
    communityNif ? recipientNif === communityNif : null,
    num(doc.base_imponible_total),
    num(doc.iva_total),
    doc.retencion_irpf ? num(doc.retencion_irpf.pct) : null,
    doc.retencion_irpf ? num(doc.retencion_irpf.importe) : null,
    num(doc.suplidos),
    num(doc.total_factura),
    doc.forma_pago,
    shownHmac,
    shownLast4,
    iso(doc.vencimiento),
    doc.doc_type_confirmed === 'factura_simplificada',
    doc.doc_type_confirmed === 'factura_rectificativa',
    doc.menciones?.inversion_sujeto_pasivo ?? null,
    doc.menciones?.materiales_40pct ?? null,
    doc.menciones?.verifactu_qr_presente ?? null,
    str(doc.referencia_presupuesto_o_obra),
  ];

  const invoiceId = String(
    await firstId(
      client,
      `insert into public.invoices (community_id, document_id, vendor_party_id, serie, numero, numero_int, fecha_expedicion,
                                    fecha_operacion, recipient_name, recipient_nif, recipient_matches_community,
                                    base_imponible, iva_total, retencion_irpf_pct, retencion_irpf_importe, suplidos, total,
                                    forma_pago, iban_shown_hmac, iban_shown_last4, vencimiento, es_simplificada, es_rectificativa,
                                    mencion_isp, mencion_materiales_40, verifactu_qr, referencia_presupuesto)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::date,
               $22, $23, $24, $25, $26, $27)
       on conflict (document_id) do update
          set vendor_party_id = excluded.vendor_party_id, serie = excluded.serie, numero = excluded.numero,
              numero_int = excluded.numero_int, fecha_expedicion = excluded.fecha_expedicion,
              fecha_operacion = excluded.fecha_operacion, recipient_name = excluded.recipient_name,
              recipient_nif = excluded.recipient_nif, recipient_matches_community = excluded.recipient_matches_community,
              base_imponible = excluded.base_imponible, iva_total = excluded.iva_total,
              retencion_irpf_pct = excluded.retencion_irpf_pct, retencion_irpf_importe = excluded.retencion_irpf_importe,
              suplidos = excluded.suplidos, total = excluded.total, forma_pago = excluded.forma_pago,
              iban_shown_hmac = excluded.iban_shown_hmac, iban_shown_last4 = excluded.iban_shown_last4,
              vencimiento = excluded.vencimiento, es_simplificada = excluded.es_simplificada,
              es_rectificativa = excluded.es_rectificativa, mencion_isp = excluded.mencion_isp,
              mencion_materiales_40 = excluded.mencion_materiales_40, verifactu_qr = excluded.verifactu_qr,
              referencia_presupuesto = excluded.referencia_presupuesto
       returning id`,
      params,
    ),
  );

  await client.query('delete from public.invoice_lines where invoice_id = $1', [invoiceId]);
  const firstPageId = document.pages[0]?.page_id ?? null;
  for (const line of doc.lineas ?? []) {
    await client.query(
      `insert into public.invoice_lines (community_id, invoice_id, orden, codigo, descripcion, cantidad, unidad, precio_unitario,
                                         descuento_pct, base, tipo_iva_pct, cuota_iva, total_linea, es_manuscrito,
                                         es_partida_alzada, element_scope, unit_hint, page_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        document.community_id,
        invoiceId,
        line.orden,
        str(line.codigo),
        line.descripcion,
        num(line.cantidad),
        str(line.unidad),
        num(line.precio_unitario),
        num(line.descuento_pct),
        num(line.base),
        num(line.tipo_iva_pct),
        num(line.cuota_iva),
        num(line.total_linea),
        line.es_manuscrito,
        line.es_partida_alzada,
        line.element_scope,
        str(line.unit_hint),
        firstPageId,
      ],
    );
  }

  await client.query('delete from public.invoice_vat_summary where invoice_id = $1', [invoiceId]);
  for (const row of doc.resumen_iva ?? []) {
    if (num(row.base) === null || num(row.tipo_pct) === null || num(row.cuota) === null) continue;
    await client.query('insert into public.invoice_vat_summary (invoice_id, base, tipo_pct, cuota) values ($1, $2, $3, $4)', [
      invoiceId,
      num(row.base),
      num(row.tipo_pct),
      num(row.cuota),
    ]);
  }

  // deterministic document-level dedup, before any counting rule sees the invoice
  const key = dedupeKey({
    vendorNif: doc.emisor?.nif ?? null,
    serie: doc.serie,
    numero: doc.numero,
    total: num(doc.total_factura),
    fecha: doc.fecha_expedicion,
  });
  const twin = await first<{ id: string }>(
    client,
    `select id from public.documents
      where community_id = $1 and dedupe_key = $2 and id <> $3 and duplicate_of_document_id is null
      order by created_at, id limit 1`,
    [document.community_id, key, document.id],
  );
  await client.query('update public.documents set dedupe_key = $2, duplicate_of_document_id = $3, issuer_party_id = coalesce(issuer_party_id, $4) where id = $1', [
    document.id,
    key,
    twin ? twin.id : null,
    vendorId,
  ]);

  return {
    invoice_id: invoiceId,
    vendor_party_id: vendorId,
    lines: (doc.lineas ?? []).length,
    vat_rows: (doc.resumen_iva ?? []).length,
    dedupe_key: key,
    duplicate_of_document_id: twin ? String(twin.id) : null,
    vendor_iban: ibanState,
  };
}

// ---------------------------------------------------------------------------
// document header fields
// ---------------------------------------------------------------------------

/** Main date of a parsed document, used for `documents.doc_date` and the fiscal year. */
export function documentDate(docType: DocType, parsed: unknown): string | null {
  const p = parsed as Record<string, unknown>;
  const period = p['periodo'] as { desde?: string | null; hasta?: string | null } | undefined;
  switch (docType) {
    case 'factura':
    case 'factura_simplificada':
    case 'factura_rectificativa':
      return iso(p['fecha_expedicion']);
    case 'acta':
    case 'convocatoria':
    case 'aviso_derrama':
    case 'recibo_comunidad':
      return iso(p['fecha']);
    case 'contrato_obra':
    case 'contrato_ascensor':
    case 'contrato_mantenimiento':
    case 'contrato_prestamo':
      return iso(p['fecha_firma']);
    case 'extracto_bancario':
    case 'liquidacion_anual':
    case 'presupuesto_comunidad':
      return iso(period?.hasta ?? null) ?? iso(period?.desde ?? null) ?? iso(p['fecha_emision']);
    default:
      return iso(p['fecha']) ?? iso(p['fecha_expedicion']);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Write everything one extraction produces. Runs whatever transaction the caller opened: the extract
 * step wraps the call so a failure halfway leaves no partial document behind.
 */
export async function persistExtraction(client: Queryable, input: PersistInput): Promise<PersistResult> {
  const { document, docType, parsed } = input;
  const notes: string[] = [];
  const pages = pageLookup(document);

  // validator_results is append-only: a re-run appends a new dated set next to the previous one
  const validators = validateParsed(docType, parsed, input.now ? { now: input.now } : {});
  for (const v of validators) {
    await client.query(
      `insert into public.validator_results (community_id, document_id, validator_code, validator_version, passed, details)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [document.community_id, document.id, v.code, v.version, v.passed, JSON.stringify(v.details)],
    );
  }

  const fields = await writeFields(client, input, validators, pages);

  let domain: Record<string, unknown> = {};
  switch (docType) {
    case 'acta':
    case 'convocatoria':
      domain = await persistActa(client, input, pages);
      break;
    case 'liquidacion_anual':
    case 'presupuesto_comunidad':
      domain = await persistLiquidacion(client, input, pages);
      break;
    case 'extracto_bancario':
      domain = await persistExtracto(client, input, pages, validators);
      break;
    case 'contrato_obra':
    case 'contrato_ascensor':
    case 'contrato_mantenimiento':
    case 'contrato_prestamo':
      domain = await persistContrato(client, input);
      break;
    case 'aviso_derrama':
    case 'recibo_comunidad':
      domain = await persistDerrama(client, input);
      break;
    case 'factura':
    case 'factura_simplificada':
    case 'factura_rectificativa':
      domain = await persistFactura(client, input, pages);
      break;
    default:
      notes.push(`no domain table for ${docType}; fields and validators only`);
  }

  const docDate = documentDate(docType, parsed);
  const language = (parsed as { idioma?: string }).idioma ?? null;
  await client.query(
    `update public.documents
        set doc_date = coalesce($2::date, doc_date),
            fiscal_year = case when $2::date is null then fiscal_year
                          else public.fiscal_year($2::date, (select fy_start_month from public.communities where id = $3)) end,
            language = coalesce($4, language)
      where id = $1`,
    [document.id, docDate, document.community_id, language && ['es', 'ca', 'mixed', 'en', 'unknown'].includes(language) ? language : null],
  );

  return {
    document_id: document.id,
    field_revisions: fields.written,
    fields_kept_human: fields.keptHuman,
    validators: { total: validators.length, failed: validators.filter((v) => !v.passed).map((v) => v.code) },
    domain,
    notes,
  };
}
