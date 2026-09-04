'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fail, ok, type ActionResult } from '@/lib/actions';
import { asJson, logAccess } from '@/lib/audit';
import { getCommunity } from '@/lib/community';
import type { Enums, Json } from '@/lib/database.types';
import { createClient, type ServerClient } from '@/lib/supabase/server';
import {
  ACCOUNT_PURPOSES,
  DERRAMA_CRITERIOS,
  HOLDER_KINDS,
  HOLDER_ROLES,
  MEETING_KINDS,
  RESOLUTION_KINDS,
  RESOLUTION_RESULTS,
  RULE_TOPICS,
  SUSPENSION_REASONS,
  WORKS_CODES,
  WORKS_STATUSES,
} from './constants';

// ---------------------------------------------------------------------------
// Field parsers. Every form value arrives as a trimmed string; '' means "not provided".
// ---------------------------------------------------------------------------
const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
const str = z.string().trim().min(1, 'required');
const nstr = z.preprocess(emptyToNull, z.string().nullable());
const nnum = z.preprocess(emptyToNull, z.coerce.number().nullable());
const nint = z.preprocess(emptyToNull, z.coerce.number().int().nullable());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.string().regex(DATE_RE, 'date must be YYYY-MM-DD');
const ndate = z.preprocess(emptyToNull, dateStr.nullable());
const bool = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());
const nbool = z.preprocess((v) => (v === '' || v === undefined || v === null ? null : v === 'true'), z.boolean().nullable());
const nuuid = z.preprocess(emptyToNull, z.uuid().nullable());
const reason = nstr;

function formObject(formData: FormData): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === 'string') o[k] = v.trim();
  }
  return o;
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ');
}

function dbMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case '23505':
      return 'A row with the same key already exists.';
    case '42501':
      return 'Not permitted: row-level security or an append-only rule refused the change.';
    case '23503':
      return 'A referenced row does not exist.';
    default:
      return error.message;
  }
}

type Writer = { supabase: ServerClient; cid: string; userId: string };

async function writer(): Promise<{ w: Writer } | { result: ActionResult }> {
  const ctx = await getCommunity();
  if (!ctx.canWrite) return { result: fail('Your role is read-only for this community.') };
  const supabase = await createClient();
  return { w: { supabase, cid: ctx.id, userId: ctx.userId } };
}

async function finish(
  w: Writer,
  act: Enums<'audit_action'>,
  entityType: string,
  entityId: string,
  before: Json | null,
  after: Json | null,
  why: string | null,
  message: string,
): Promise<ActionResult> {
  try {
    await logAccess(w.supabase, w.cid, act, entityType, entityId, before, after, why ?? 'seed form');
  } catch (e) {
    revalidatePath('/seed');
    return fail(`${message}, but the audit entry failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  revalidatePath('/seed');
  revalidatePath('/');
  return ok(message);
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------
const unitSchema = z.object({
  id: nuuid,
  label: str,
  floor: nstr,
  door: nstr,
  use: nstr,
  quota_pct: nnum,
  holder_role: z.enum(HOLDER_ROLES),
  notes: nstr,
  reason,
});

export async function saveUnit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = unitSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('units').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Unit not found.');
    const { data: after, error } = await w.supabase
      .from('units')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'unit', id, asJson(before), asJson(after), why, `Unit ${values.label} updated`);
  }
  const { data: after, error } = await w.supabase
    .from('units')
    .insert({ community_id: w.cid, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'unit', after.id, null, asJson(after), why, `Unit ${values.label} created`);
}

// ---------------------------------------------------------------------------
// meetings
// ---------------------------------------------------------------------------
const meetingSchema = z.object({
  id: nuuid,
  tipo: z.enum(MEETING_KINDS),
  fecha: dateStr,
  convocatoria_fecha: ndate,
  fecha_firma: ndate,
  fecha_notificacion: ndate,
  presupuesto_aprobado: nnum,
  cuentas_aprobadas: nbool,
  seed_verified: bool,
  notes: nstr,
  reason,
});

export async function saveMeeting(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = meetingSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, seed_verified, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('meetings').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Meeting not found.');
    const verification = seed_verified
      ? before.seed_verified_at
        ? {}
        : { seed_verified_by: w.userId, seed_verified_at: new Date().toISOString() }
      : { seed_verified_by: null, seed_verified_at: null };
    const { data: after, error } = await w.supabase
      .from('meetings')
      .update({ ...values, ...verification })
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'meeting', id, asJson(before), asJson(after), why, `Meeting of ${values.fecha} updated`);
  }
  const { data: after, error } = await w.supabase
    .from('meetings')
    .insert({
      community_id: w.cid,
      entry_source: 'seed',
      ...values,
      ...(seed_verified ? { seed_verified_by: w.userId, seed_verified_at: new Date().toISOString() } : {}),
    })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'meeting', after.id, null, asJson(after), why, `Meeting of ${values.fecha} created`);
}

// ---------------------------------------------------------------------------
// resolutions
// ---------------------------------------------------------------------------
const resolutionSchema = z.object({
  id: nuuid,
  meeting_id: z.uuid(),
  punto: nstr,
  texto_literal: str,
  kind: z.enum(RESOLUTION_KINDS),
  resultado: z.enum(RESOLUTION_RESULTS),
  importe_aprobado: nnum,
  tolerance_pct: nnum,
  works_package_id: nuuid,
  delegation_to_role: nstr,
  delegation_scope: nstr,
  delegation_cap: nnum,
  cap_explicit: nbool,
  page_no: nint,
  reason,
});

export async function saveResolution(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = resolutionSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('resolutions').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Resolution not found.');
    const { data: after, error } = await w.supabase
      .from('resolutions')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'resolution', id, asJson(before), asJson(after), why, 'Resolution updated');
  }
  const { data: after, error } = await w.supabase
    .from('resolutions')
    .insert({ community_id: w.cid, entry_source: 'seed', ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'resolution', after.id, null, asJson(after), why, 'Resolution created');
}

// ---------------------------------------------------------------------------
// works_packages
// ---------------------------------------------------------------------------
const worksPackageSchema = z.object({
  id: nuuid,
  code: z.enum(WORKS_CODES),
  label: nstr,
  status: z.enum(WORKS_STATUSES),
  architect_pem: nnum,
  permit_pem: nnum,
  subsidy_protegible: nnum,
  contract_price: nnum,
  suspension_date: ndate,
  suspension_reason: z.preprocess(emptyToNull, z.enum(SUSPENSION_REASONS).nullable()),
  notes: nstr,
  reason,
});

export async function saveWorksPackage(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = worksPackageSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('works_packages').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Works package not found.');
    const { data: after, error } = await w.supabase
      .from('works_packages')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'works_package', id, asJson(before), asJson(after), why, `Package ${values.code} updated`);
  }
  const { data: after, error } = await w.supabase
    .from('works_packages')
    .insert({ community_id: w.cid, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'works_package', after.id, null, asJson(after), why, `Package ${values.code} created`);
}

// ---------------------------------------------------------------------------
// derramas
// ---------------------------------------------------------------------------
const derramaSchema = z.object({
  id: nuuid,
  resolution_id: nuuid,
  objeto: str,
  works_package_id: nuuid,
  importe_total: nnum,
  criterio: z.enum(DERRAMA_CRITERIOS),
  per_unit_amount: nnum,
  starts_on: ndate,
  ends_on: ndate,
  months: nint,
  reason,
});

export async function saveDerrama(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = derramaSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('derramas').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Derrama not found.');
    const { data: after, error } = await w.supabase
      .from('derramas')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'derrama', id, asJson(before), asJson(after), why, 'Derrama updated');
  }
  const { data: after, error } = await w.supabase
    .from('derramas')
    .insert({ community_id: w.cid, entry_source: 'seed', ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'derrama', after.id, null, asJson(after), why, 'Derrama created');
}

// ---------------------------------------------------------------------------
// bank_accounts (last four digits only; the full IBAN is never entered here)
// ---------------------------------------------------------------------------
const bankAccountSchema = z.object({
  id: nuuid,
  label: str,
  iban_last4: z.preprocess(emptyToNull, z.string().regex(/^\d{4}$/, 'exactly four digits').nullable()),
  bank_name: nstr,
  holder_kind: z.enum(HOLDER_KINDS),
  purpose: z.enum(ACCOUNT_PURPOSES),
  titled_to_community: nbool,
  signatory_roles: z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== ''
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
    z.array(z.string()).nullable(),
  ),
  reason,
});

export async function saveBankAccount(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = bankAccountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('bank_accounts').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Bank account not found.');
    const { data: after, error } = await w.supabase
      .from('bank_accounts')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'bank_account', id, asJson(before), asJson(after), why, `Account ${values.label} updated`);
  }
  const { data: after, error } = await w.supabase
    .from('bank_accounts')
    .insert({ community_id: w.cid, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'bank_account', after.id, null, asJson(after), why, `Account ${values.label} created`);
}

// ---------------------------------------------------------------------------
// request_clock (single row per community)
// ---------------------------------------------------------------------------
const requestClockSchema = z.object({
  request_date: ndate,
  quotas_pct_requesting: nnum,
  units_requesting: nint,
  convocation_date: ndate,
  junta_date: ndate,
  docs_available_from: ndate,
  status: nstr,
  notes: nstr,
  reason,
});

export async function saveRequestClock(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = requestClockSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { reason: why, ...values } = parsed.data;

  const { data: before } = await w.supabase
    .from('request_clock')
    .select('*')
    .eq('community_id', w.cid)
    .order('created_at')
    .limit(1)
    .maybeSingle();

  if (before) {
    const { data: after, error } = await w.supabase
      .from('request_clock')
      .update(values)
      .eq('id', before.id)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'request_clock', before.id, asJson(before), asJson(after), why, 'Request clock updated');
  }
  const { data: after, error } = await w.supabase
    .from('request_clock')
    .insert({ community_id: w.cid, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'request_clock', after.id, null, asJson(after), why, 'Request clock created');
}

// ---------------------------------------------------------------------------
// parameters (append-only: every save is a new version of the key)
// ---------------------------------------------------------------------------
const parameterSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/, 'lower-case key, letters, digits and underscores'),
  value_num: z.coerce.number(),
  unit: nstr,
  basis_text: nstr,
  valid_from: z.preprocess((v) => (v === '' || v === undefined ? '1900-01-01' : v), dateStr),
  reason,
});

export async function appendParameter(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = parameterSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { reason: why, ...values } = parsed.data;

  const { data: latest } = await w.supabase
    .from('parameters')
    .select('id, version, value_num, unit, basis_text, valid_from')
    .eq('community_id', w.cid)
    .eq('key', values.key)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (latest?.version ?? 0) + 1;

  const { data: after, error } = await w.supabase
    .from('parameters')
    .insert({ community_id: w.cid, version, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(
    w,
    'seed',
    'parameter',
    after.id,
    asJson(latest),
    asJson(after),
    why,
    `Parameter ${values.key} version ${version} appended`,
  );
}

// ---------------------------------------------------------------------------
// community_rules
// ---------------------------------------------------------------------------
const communityRuleSchema = z.object({
  id: nuuid,
  topic: z.enum(RULE_TOPICS),
  text_literal: str,
  page_no: nint,
  reason,
});

export async function saveCommunityRule(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await writer();
  if ('result' in r) return r.result;
  const { w } = r;
  const parsed = communityRuleSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(issues(parsed.error));
  const { id, reason: why, ...values } = parsed.data;

  if (id) {
    const { data: before } = await w.supabase.from('community_rules').select('*').eq('id', id).eq('community_id', w.cid).maybeSingle();
    if (!before) return fail('Rule not found.');
    const { data: after, error } = await w.supabase
      .from('community_rules')
      .update(values)
      .eq('id', id)
      .eq('community_id', w.cid)
      .select('*')
      .single();
    if (error) return fail(dbMessage(error));
    return finish(w, 'edit', 'community_rule', id, asJson(before), asJson(after), why, 'Community rule updated');
  }
  const { data: after, error } = await w.supabase
    .from('community_rules')
    .insert({ community_id: w.cid, ...values })
    .select('*')
    .single();
  if (error) return fail(dbMessage(error));
  return finish(w, 'seed', 'community_rule', after.id, null, asJson(after), why, 'Community rule created');
}
