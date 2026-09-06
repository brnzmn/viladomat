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
 *    concern the office without learning who holds it;
 *  - a registry lookup made for a natural person (a sole trader) keeps its outcome only: the
 *    names inside its request and its result are dropped before the row leaves the database.
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

/**
 * IBAN-shaped strings anywhere in free text, compact or in groups of four. Groups are uppercase
 * or digits, exactly four characters, and a shorter tail must be attached without a space: an
 * IBAN is written in upper case, so the pattern cannot swallow the prose that follows it. The
 * compacted length is checked against the IBAN range before anything is rewritten.
 */
const IBAN_RE = /\b([A-Z]{2}\d{2})((?:[ ]?[A-Z0-9]{4})+[A-Z0-9]{0,3})(?![A-Za-z0-9])/g;

/** Shortest and longest IBAN in use; anything outside is some other alphanumeric string. */
const IBAN_MIN = 15;
const IBAN_MAX = 34;

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
  return text.replace(IBAN_RE, (match: string, prefix: string, rest: string) => {
    const compact = `${prefix}${rest}`.replace(/\s+/g, '');
    if (compact.length < IBAN_MIN || compact.length > IBAN_MAX) return match;
    return `${prefix.slice(0, 2)}** **** ${compact.slice(-4)}`;
  });
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

// ---------------------------------------------------------------------------
// Registry lookups (external_checks) for natural persons
// ---------------------------------------------------------------------------

/** Columns of an exported `external_checks` row that carry a JSON payload (as text or parsed). */
const CHECK_PAYLOAD_COLUMNS = ['request', 'normalised'] as const;

/**
 * Keys, at any depth of a lookup's request or result, whose value is a name: the name sent to a
 * source (`name_sent`) and the name a source returned (`name`, `name_registered`, `beneficiary`).
 * Their values also feed the equality rule of {@link stripPersonNames}, so a search `term` equal
 * to the name goes with them. Errs towards redacting: a key of a company's own name inside a
 * natural person's row is dropped too.
 */
const PERSON_NAME_KEYS: ReadonlySet<string> = new Set([
  'name',
  'name_sent',
  'name_registered',
  'beneficiary',
]);

/**
 * Keys dropped as well, whose value may carry the name without being one: the search terms typed
 * for a manual route (`query`, "identifier · name"). Not used for the equality rule, since a
 * `query` of an identifier alone would otherwise take the identifier fields with it.
 */
const PERSON_TEXT_KEYS: ReadonlySet<string> = new Set([...PERSON_NAME_KEYS, 'query']);

/** `parties.nif_kind` values of a natural person: DNI, NIE and the K/L/M identifiers. */
const NATURAL_PERSON_NIF_KINDS: ReadonlySet<string> = new Set(['DNI', 'NIE', 'SPECIAL']);

/** The helper column the data-room query adds so the party's kind of identifier is known. */
export const CHECK_PARTY_NIF_KIND = 'party_nif_kind';

function parsePayload(v: unknown): { value: unknown; wasText: boolean } | null {
  if (v == null) return null;
  if (typeof v !== 'string') return { value: v, wasText: false };
  try {
    return { value: JSON.parse(v) as unknown, wasText: true };
  } catch {
    // Not JSON: the text itself could carry the name, so nothing of it is kept.
    return { value: { redacted: 'unreadable payload of a natural-person lookup' }, wasText: true };
  }
}

/**
 * Whether an exported `external_checks` row is a lookup made for a natural person: the party's
 * identifier is a person's (`party_nif_kind`), or the check itself flagged the subject
 * (`natural_person: true` in its request or result).
 */
export function isNaturalPersonCheckRow(row: Record<string, unknown>): boolean {
  const kind = row[CHECK_PARTY_NIF_KIND];
  if (typeof kind === 'string' && NATURAL_PERSON_NIF_KINDS.has(kind.toUpperCase())) return true;
  for (const col of CHECK_PAYLOAD_COLUMNS) {
    const parsed = parsePayload(row[col]);
    const value = parsed?.value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ((value as Record<string, unknown>).natural_person === true) return true;
    }
  }
  return false;
}

function collectNames(value: unknown, into: Set<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, into);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PERSON_NAME_KEYS.has(k) && typeof v === 'string' && v.trim()) into.add(norm(v));
    collectNames(v, into);
  }
}

function withoutNames(value: unknown, names: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') {
    // A value equal to a dropped name under any other key (a search `term`) goes with it.
    return typeof value === 'string' && names.has(norm(value)) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withoutNames(item, names)).filter((item) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PERSON_TEXT_KEYS.has(k)) continue;
    const kept = withoutNames(v, names);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

/**
 * Drop every name from a natural person's lookup payload: the name and search-term keys above at
 * any depth, and any other string equal to one of the names they carried. Pure; exported for
 * tests.
 */
export function stripPersonNames(payload: unknown): unknown {
  const names = new Set<string>();
  collectNames(payload, names);
  return withoutNames(payload, names);
}

/**
 * An exported `external_checks` row: the helper column removed and, for a lookup made for a
 * natural person, the request and the result reduced to what is not a name. A legal person's row
 * is returned as read (a vendor's name is business data). Applied before {@link redactRecord}.
 */
export function redactExternalCheckRow(row: Record<string, unknown>): Record<string, unknown> {
  const natural = isNaturalPersonCheckRow(row);
  const out: Record<string, unknown> = { ...row };
  delete out[CHECK_PARTY_NIF_KIND];
  if (!natural) return out;
  for (const col of CHECK_PAYLOAD_COLUMNS) {
    const parsed = parsePayload(row[col]);
    if (!parsed) continue;
    const stripped = stripPersonNames(parsed.value);
    out[col] = parsed.wasText ? JSON.stringify(stripped) : stripped;
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
