/**
 * Redaction for third parties.
 *
 * Business data stays: a vendor's name on an invoice is the fact under examination. Personal
 * data of people who are not under examination does not:
 *
 *  - a natural-person counterparty on a bank row becomes "[particular]" / "[private individual]";
 *  - other owners' units are printed by unit label only, never by holder;
 *  - an IBAN anywhere in the text keeps its last four digits;
 *  - the units held by the presidency role are labelled by role, so a reader learns which rows
 *    concern the office without learning who holds it.
 *
 * The same functions run over pack text, evidence rows and data-room CSV cells, so one rule
 * governs every surface.
 */
import type pg from 'pg';
import type { Lang } from './i18n.ts';

export const PARTICULAR: Record<Lang, string> = { es: '[particular]', en: '[private individual]' };
export const PRESIDENCY_UNIT: Record<Lang, string> = { es: 'unidad del rol de presidencia', en: 'unit of the presidency role' };
export const OTHER_OWNER_UNIT: Record<Lang, string> = { es: 'unidad', en: 'unit' };

/** Party kinds whose names are business data and are printed as they appear. */
const BUSINESS_PARTY_KINDS = new Set(['vendor', 'administrator', 'architect', 'bank', 'public_body', 'insurer']);

/**
 * Legal-form and institution tokens. A counterparty carrying one of these is an entity, not a
 * natural person; the list errs towards redacting, because a missed entity only loses a name.
 */
const BUSINESS_TOKEN_RE =
  /(^|[^a-z0-9])(s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|s\.?\s?c\.?\s?p\.?|s\.?\s?c\.?\s?c\.?\s?l\.?|s\.?\s?l\.?\s?n\.?\s?e\.?|c\.?\s?b\.?|sociedad|societat|cooperativ\w*|coop|asociaci\w*|associaci\w*|fundaci\w*|comunidad|comunitat|ajuntament|ayuntamiento|generalitat|diputaci\w*|consorci\w*|agencia|ag[eè]ncia|tesorer\w*|hisenda|hacienda|banc|banco|bank|caixa|caja|seguros|assegurances|insurance|ltd|limited|gmbh|b\.?v\.?|s\.?a\.?r\.?l\.?|a\.?g\.?|inc|plc|holding|group|grup|serveis|servicios|reformes|reformas|construccion\w*|construccion\w*|constructor\w*|ascensor\w*|elevator\w*|instal·?lacion\w*|instalacion\w*|manteniment\w*|mantenimiento\w*|administraci\w*|gestor\w*|assessor\w*|asesor\w*|arquitect\w*|enginyer\w*|ingenier\w*|electric\w*|fontaner\w*|pintur\w*|obras|obres|energ\w*|telecom\w*|movil|m[oò]vil|endesa|naturgy|iberdrola|aigues|aguas)([^a-z0-9]|$)/i;

/** IBAN-shaped strings anywhere in free text (with or without spacing). */
const IBAN_RE = /\b([A-Z]{2}\d{2})[ ]?((?:[A-Za-z0-9]{4}[ ]?){2,7}[A-Za-z0-9]{1,4})\b/g;

export interface RedactionContext {
  lang: Lang;
  /** unit id → unit label */
  unitLabels: Map<string, string>;
  /** unit ids held by the presidency role */
  presidentUnitIds: Set<string>;
  /** unit labels held by the presidency role, normalised */
  presidentUnitLabels: Set<string>;
  /** normalised names of parties that are entities (their names are kept) */
  businessNames: Set<string>;
}

/** An empty context: nothing known about units or parties, so only the generic rules apply. */
export function emptyRedactionContext(lang: Lang): RedactionContext {
  return { lang, unitLabels: new Map(), presidentUnitIds: new Set(), presidentUnitLabels: new Set(), businessNames: new Set() };
}

function norm(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether a counterparty string reads as an entity rather than a natural person. */
export function looksLikeBusiness(name: string | null | undefined): boolean {
  if (!name) return false;
  return BUSINESS_TOKEN_RE.test(name);
}

export interface CounterpartyInput {
  name: string | null;
  /** `parties.kind` when the counterparty resolved to a party row */
  partyKind?: string | null;
  /** `bank_transactions.flags` */
  flags?: readonly string[] | null;
}

/**
 * A counterparty is treated as a natural person unless it resolved to a business party or its
 * name carries a legal form. The `person_beneficiary` flag always wins: the matcher already
 * decided.
 */
export function isNaturalPersonCounterparty(input: CounterpartyInput, ctx: RedactionContext): boolean {
  if (!input.name) return false;
  if ((input.flags ?? []).includes('person_beneficiary')) return true;
  if (input.partyKind && BUSINESS_PARTY_KINDS.has(input.partyKind)) return false;
  if (ctx.businessNames.has(norm(input.name))) return false;
  return !looksLikeBusiness(input.name);
}

/** Vendor names are kept; natural persons become the neutral placeholder. */
export function redactCounterpartyName(input: CounterpartyInput, ctx: RedactionContext): string {
  if (!input.name) return '';
  return isNaturalPersonCounterparty(input, ctx) ? PARTICULAR[ctx.lang] : input.name;
}

/** An IBAN or an IBAN fragment keeps its last four characters only. */
export function maskIban(value: string | null | undefined): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, '');
  const last4 = compact.slice(-4);
  return last4 ? `**** ${last4}` : '';
}

/** Rewrite every IBAN-shaped string in free text down to its last four characters. */
export function redactIbansInText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(IBAN_RE, (_m, prefix: string, rest: string) => `${prefix.slice(0, 2)}** **** ${rest.replace(/\s+/g, '').slice(-4)}`);
}

/**
 * How a unit is named in an output: by its label, and by role when the presidency holds it.
 * Owner names never appear because the schema has no field for them.
 */
export function unitDisplay(unit: { id?: string | null; label?: string | null }, ctx: RedactionContext): string {
  const id = unit.id ?? null;
  const label = unit.label ?? (id ? (ctx.unitLabels.get(id) ?? null) : null);
  const isPresident = (id != null && ctx.presidentUnitIds.has(id)) || (label != null && ctx.presidentUnitLabels.has(norm(label)));
  if (isPresident) return PRESIDENCY_UNIT[ctx.lang];
  return label ?? OTHER_OWNER_UNIT[ctx.lang];
}

/** Free text going into a pack: IBANs masked, presidency unit labels replaced by the role. */
export function redactText(text: string | null | undefined, ctx: RedactionContext): string {
  if (!text) return '';
  let out = redactIbansInText(text);
  for (const [, label] of ctx.unitLabels) {
    if (!ctx.presidentUnitLabels.has(norm(label))) continue;
    out = out.split(label).join(PRESIDENCY_UNIT[ctx.lang]);
  }
  return out;
}

export interface BankRowLike {
  [key: string]: unknown;
  counterparty_name_norm?: unknown;
  counterparty_iban_last4?: unknown;
  counterparty_iban_hmac?: unknown;
  concepto_text?: unknown;
  concepto_propio?: unknown;
  ref1?: unknown;
  ref2?: unknown;
  unit_id?: unknown;
  flags?: unknown;
}

/**
 * A bank row as it may be printed or exported: the counterparty redacted when it is a natural
 * person, the IBAN reduced to four digits, the pseudonymous HMAC truncated, the unit named by
 * label or by role, and free-text concepts swept for IBANs.
 */
export function redactBankRow(row: BankRowLike, ctx: RedactionContext, partyKind?: string | null): Record<string, unknown> {
  const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
  const name = row.counterparty_name_norm == null ? null : String(row.counterparty_name_norm);
  const out: Record<string, unknown> = { ...row };
  out.counterparty_name_norm = redactCounterpartyName({ name, partyKind: partyKind ?? null, flags }, ctx);
  if (row.counterparty_iban_last4 != null) out.counterparty_iban_last4 = maskIban(String(row.counterparty_iban_last4));
  if (row.counterparty_iban_hmac != null) out.counterparty_iban_hmac = `${String(row.counterparty_iban_hmac).slice(0, 8)}…`;
  for (const key of ['concepto_text', 'concepto_propio', 'ref1', 'ref2'] as const) {
    if (row[key] != null) out[key] = redactText(String(row[key]), ctx);
  }
  if (row.unit_id != null) out.unit_label = unitDisplay({ id: String(row.unit_id) }, ctx);
  delete out.unit_id;
  return out;
}

/** Column names whose values are always masked wherever they appear in a data-room export. */
const ALWAYS_MASKED = new Set([
  'iban_hmac',
  'iban_shown_hmac',
  'counterparty_iban_hmac',
  'destination_iban_hmac',
  'compte_desti_hmac',
  'payer_iban_hmac',
  'payer_name_hmac',
  'mandate_ref_hmac',
  'nif_hmac',
]);

const LAST4_COLUMNS = new Set(['iban_last4', 'iban_shown_last4', 'counterparty_iban_last4']);

/** Apply the column rules above to one exported record. Unknown columns pass through. */
export function redactRecord(row: Record<string, unknown>, ctx: RedactionContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) {
      out[k] = v;
      continue;
    }
    if (ALWAYS_MASKED.has(k)) {
      out[k] = `${String(v).slice(0, 8)}…`;
      continue;
    }
    if (LAST4_COLUMNS.has(k)) {
      out[k] = maskIban(String(v));
      continue;
    }
    if (k === 'unit_id') {
      out.unit_label = unitDisplay({ id: String(v) }, ctx);
      continue;
    }
    out[k] = typeof v === 'string' ? redactText(v, ctx) : v;
  }
  return out;
}

/** Read the unit labels, the presidency's units and the entity names of one community. */
export async function loadRedactionContext(client: pg.PoolClient, cid: string, lang: Lang): Promise<RedactionContext> {
  const ctx = emptyRedactionContext(lang);
  const units = await client.query<Record<string, unknown>>(
    `select u.id, u.label, u.holder_role::text as holder_role,
            exists (select 1 from public.office_terms ot where ot.unit_id = u.id and ot.office = 'president') as held_presidency
       from public.units u where u.community_id = $1 order by u.label`,
    [cid],
  );
  for (const u of units.rows) {
    const id = String(u.id);
    const label = String(u.label);
    ctx.unitLabels.set(id, label);
    if (u.holder_role === 'president' || u.held_presidency === true) {
      ctx.presidentUnitIds.add(id);
      ctx.presidentUnitLabels.add(norm(label));
    }
  }
  const parties = await client.query<Record<string, unknown>>(
    'select display_name, legal_name_norm, kind::text as kind from public.parties where community_id = $1',
    [cid],
  );
  for (const p of parties.rows) {
    if (!BUSINESS_PARTY_KINDS.has(String(p.kind))) continue;
    if (p.display_name != null) ctx.businessNames.add(norm(String(p.display_name)));
    if (p.legal_name_norm != null) ctx.businessNames.add(norm(String(p.legal_name_norm)));
  }
  return ctx;
}
