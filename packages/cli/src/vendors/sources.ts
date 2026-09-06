/**
 * Register of the public sources in the database (`public.registry_sources`, migration 0015) and
 * the probes that verify them from the operator's machine.
 *
 * Every source starts unverified: the sandbox the checks were written in could not reach the
 * government domains, so each endpoint, parameter and field name is a documented guess until a
 * live answer has been parsed into the shape the check expects. A probe is one known-good lookup
 * made with data the command already has — the community's own cadastral reference and
 * identifier, the administrator's identifier as printed on ingested documents — run through the
 * normal check machinery and recorded as an `external_checks` row (`check_type = 'source_probe'`,
 * `subject_type = 'source'`). The source is marked verified only when the answer parsed into the
 * expected shape; a reachable endpoint that answers something else stays unverified and the
 * reason is written to the register's notes.
 *
 * The check runner (`commands/vendors.ts`) reads the register once per run and, for every
 * automated non-local check, sets `normalised.source_verified` from it ({@link applySourceGate})
 * and offers `ctx.sourceVerified(id)` to the checks that gate themselves (`rasic`, `rea`: they
 * refuse to call out until their source is verified). A figure in a pack can therefore only rest
 * on a source that was probed successfully; until then the other checks still run and their rows
 * say so.
 *
 * Data protection: probes only use identifiers of legal persons already on ingested documents
 * (the community's own H-NIF, the administrator's or a vendor's CIF); a natural-person identifier
 * is never used as probe material, and owners and the president are never looked up.
 */
import { isNaturalPersonNif, validateNif } from '@viladomat/core';
import type { Community } from '../lib/community.ts';
import { aeatCensus, VNIF_RESULTS } from './checks/aeat-census.ts';
import { catastroUnits, placeFromAddress } from './checks/catastro-units.ts';
import { companyProfile } from './checks/company-profile.ts';
import { bdnsGrants, raiscGrants } from './checks/grants.ts';
import { rea, reaLookup } from './checks/rea.ts';
import {
  MANUAL_SOURCES,
  RASIC_DATASET_ID,
  SOURCES,
  type ManualSourceConfig,
  type SourceConfig,
} from './config.ts';
import { asArray, asString, fetchJson, firstOf } from './http.ts';
import { persistCheck, type Queryable } from './persist.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from './types.ts';

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export type SourceAccess = 'api' | 'dataset' | 'form' | 'manual' | 'local';

/** One row of `public.registry_sources`. */
export interface RegistrySourceRow {
  id: string;
  name: string;
  base_url: string | null;
  access: SourceAccess;
  licence_note: string | null;
  verified_at: string | null;
  verified_by: string | null;
  probe_check_id: string | null;
  notes: string | null;
  updated_at: string | null;
}

export type SourceRegister = Map<string, RegistrySourceRow>;

/** `check_type` of a probe row; `subject_type` is `source` and the subject key the source id. */
export const PROBE_CHECK_TYPE = 'source_probe';
/** Probe rows are about a source, not a party (`SubjectType` in vendors/types.ts). */
const PROBE_SUBJECT_TYPE = 'source' as const;

/** Sources whose id is a check `source` but that are not JSON APIs. */
const CONFIG_ACCESS: Readonly<Record<string, SourceAccess>> = Object.freeze({
  raisc: 'dataset',
  rasic: 'dataset',
  rea: 'form',
});

const AUTOMATED: readonly SourceConfig[] = Object.values(SOURCES);
const MANUAL: readonly ManualSourceConfig[] = Object.values(MANUAL_SOURCES);

/** Every source id known to the code, automated and manual. */
export function configSourceIds(): string[] {
  return [...new Set([...AUTOMATED.map((s) => s.id), ...MANUAL.map((m) => m.id)])].sort();
}

/** Register columns for a source id, taken from the code configuration (for an upsert). */
export function configForSource(id: string): {
  name: string;
  base_url: string | null;
  access: SourceAccess;
  licence_note: string | null;
} {
  const src = AUTOMATED.find((s) => s.id === id);
  if (src) {
    return {
      name: src.name,
      base_url: src.baseUrl,
      access: CONFIG_ACCESS[id] ?? 'api',
      licence_note: src.licenceNote ?? null,
    };
  }
  const man = MANUAL.find((m) => m.id === id);
  if (man) return { name: man.name, base_url: man.url, access: 'manual', licence_note: null };
  return { name: id, base_url: null, access: CONFIG_ACCESS[id] ?? 'api', licence_note: null };
}

function rowFrom(r: Record<string, unknown>): RegistrySourceRow {
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    name: String(r.name ?? r.id),
    base_url: s(r.base_url),
    access: (s(r.access) ?? 'api') as SourceAccess,
    licence_note: s(r.licence_note),
    verified_at: s(r.verified_at),
    verified_by: s(r.verified_by),
    probe_check_id: s(r.probe_check_id),
    notes: s(r.notes),
    updated_at: s(r.updated_at),
  };
}

/**
 * The register as a map by source id. When migration 0015 has not been applied the map is
 * empty, which is the safe reading (nothing verified); call it in its own transaction, since a
 * missing table aborts the transaction it was queried in.
 */
export async function loadSourceRegister(client: Queryable): Promise<SourceRegister> {
  let rows: Array<Record<string, unknown>>;
  try {
    const res = await client.query(
      `select id, name, base_url, access, licence_note, verified_at::text as verified_at, verified_by,
              probe_check_id, notes, updated_at::text as updated_at
         from public.registry_sources order by id`,
    );
    rows = res.rows as Array<Record<string, unknown>>;
  } catch (err) {
    if ((err as { code?: unknown }).code === '42P01') return new Map();
    throw err;
  }
  return new Map(rows.map((r) => [String(r.id), rowFrom(r)] as const));
}

export interface SourceVerification {
  source: string;
  registered: boolean;
  verified: boolean;
  verified_at: string | null;
  probe_check_id: string | null;
}

export function sourceVerification(register: SourceRegister, id: string): SourceVerification {
  const row = register.get(id);
  return {
    source: id,
    registered: row !== undefined,
    verified: row !== undefined && row.verified_at !== null,
    verified_at: row?.verified_at ?? null,
    probe_check_id: row?.probe_check_id ?? null,
  };
}

export function isSourceVerified(register: SourceRegister, id: string): boolean {
  return sourceVerification(register, id).verified;
}

/**
 * Mark a source verified by a probe row. An upsert, so a source that exists in code but has no
 * register row yet (a new source before its migration) is still recorded.
 */
export async function markSourceVerified(
  client: Queryable,
  id: string,
  probeCheckId: string,
  checkedBy: string | null,
  reason: string | null = null,
): Promise<void> {
  const cfg = configForSource(id);
  const notes = `verified by probe ${probeCheckId} on ${new Date().toISOString()}${reason ? `: ${reason}` : ''}`;
  await client.query(
    `insert into public.registry_sources
       (id, name, base_url, access, licence_note, verified_at, verified_by, probe_check_id, notes)
     values ($1, $2, $3, $4, $5, now(), $6::uuid, $7::uuid, $8)
     on conflict (id) do update
        set verified_at = now(), verified_by = excluded.verified_by,
            probe_check_id = excluded.probe_check_id, notes = excluded.notes, updated_at = now()`,
    [id, cfg.name, cfg.base_url, cfg.access, cfg.licence_note, checkedBy, probeCheckId, notes],
  );
}

/**
 * Record a probe that did not verify the source: the reason goes to the notes, `verified_at` is
 * left as it was (a transient failure does not undo an earlier verification; the note dates it).
 */
export async function recordProbeFailure(
  client: Queryable,
  id: string,
  probeCheckId: string | null,
  reason: string,
): Promise<void> {
  const cfg = configForSource(id);
  const notes = `probe${probeCheckId ? ` ${probeCheckId}` : ''} on ${new Date().toISOString()} did not verify the source: ${reason}`;
  await client.query(
    `insert into public.registry_sources (id, name, base_url, access, licence_note, notes)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set notes = excluded.notes, updated_at = now()`,
    [id, cfg.name, cfg.base_url, cfg.access, cfg.licence_note, notes],
  );
}

// ---------------------------------------------------------------------------
// Gate applied by the check runner
// ---------------------------------------------------------------------------

/** A context that also tells a self-gating check whether its source is verified in the register. */
export type SourceGateContext = CheckContext & { sourceVerified: (id: string) => boolean };

export function withSourceGate(ctx: CheckContext, register: SourceRegister): SourceGateContext {
  return { ...ctx, sourceVerified: (id: string) => isSourceVerified(register, id) };
}

export interface GatedResult {
  result: CheckResult;
  /** False for local arithmetic and manual placeholders, which the register does not govern. */
  gated: boolean;
  verified: boolean;
  source: string;
}

/**
 * Set `normalised.source_verified` from the register on the result of an automated non-local
 * check: false while the source is unverified (whatever the module's own constant says), true
 * with a note naming the probe once it is.
 */
export function applySourceGate(
  result: CheckResult,
  register: SourceRegister,
  check: Pick<VendorCheck, 'source' | 'manual'>,
): GatedResult {
  if (check.manual || check.source === 'local') {
    return { result, gated: false, verified: true, source: check.source };
  }
  const v = sourceVerification(register, check.source);
  const normalised: Record<string, unknown> = {
    ...result.normalised,
    source_verified: v.verified,
    source_verification: {
      source: v.source,
      registered: v.registered,
      verified_at: v.verified_at,
      probe_check_id: v.probe_check_id,
    },
  };
  const gated: CheckResult = { ...result, normalised };
  if (v.verified) {
    const note = `source ${check.source} verified on ${(v.verified_at ?? '').slice(0, 10)}${v.probe_check_id ? ` (probe ${v.probe_check_id})` : ''}`;
    gated.note = result.note ? `${result.note} · ${note}` : note;
  }
  return { result: gated, gated: true, verified: v.verified, source: check.source };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** A legal-person identifier already on an ingested document. */
export interface ProbeCandidate {
  nif: string;
  name: string | null;
  role: string;
}

export type ProbeCommunity = Pick<Community, 'id' | 'name' | 'nif' | 'address' | 'catastro_rc'>;

export interface ProbeInputs {
  community: ProbeCommunity;
  /** The community's administrator when it is a legal person with an identifier on file. */
  administrator: ProbeCandidate | null;
  /** Legal-person identifiers on ingested documents, tried after the community's own. */
  candidates: ProbeCandidate[];
  certificateConfigured: boolean;
}

export interface ProbeVerdict {
  ok: boolean;
  reason: string;
}

export interface ProbeAttempt {
  subjectKey: string;
  probedType: string;
  /** The row to persist (type `source_probe`), wrapping the probed check's answer. */
  result: CheckResult;
  verdict: ProbeVerdict;
}

export interface ProbeOutcome {
  source: string;
  label: string;
  verified: boolean;
  /** True when the probe could not run for want of an input; nothing was fetched or stored. */
  skipped: boolean;
  reason: string;
  attempts: ProbeAttempt[];
}

export interface SourceProbe {
  source: string;
  label: string;
  /** What the probe needs to have on file. */
  needs: string;
  run(inputs: ProbeInputs, ctx: CheckContext): Promise<ProbeOutcome>;
}

/** True for an identifier that passes its check digit and belongs to a legal person. */
export function legalPersonNif(nif: string | null | undefined): boolean {
  if (!nif) return false;
  const v = validateNif(nif);
  return v.valid && !isNaturalPersonNif(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describeFailure(r: CheckResult): string {
  const err = asString(r.normalised.error);
  return err ? `: ${err}` : '';
}

/** Verified when at least one unit with a participation coefficient was parsed. */
export function catastroProbeVerdict(r: CheckResult): ProbeVerdict {
  if (r.status !== 'ok') {
    return { ok: false, reason: `catastro_units answered ${r.status}${describeFailure(r)}` };
  }
  const units = asArray(r.normalised.units).filter(isObject);
  const withCoefficient = units.filter((u) => typeof u.coefficient_pct === 'number').length;
  if (units.length === 0) return { ok: false, reason: 'no unit parsed from the answer' };
  if (withCoefficient === 0) {
    return {
      ok: false,
      reason: `${units.length} unit(s) parsed but none carries a coefficient (debi.cpt); the field names differ from the ones expected`,
    };
  }
  return {
    ok: true,
    reason: `${units.length} unit(s) parsed, ${withCoefficient} with a coefficient; envelope ${asString(r.normalised.envelope) ?? 'unknown'}`,
  };
}

/** Verified when at least one grant row was parsed; an empty envelope confirms the route only. */
export function bdnsProbeVerdict(r: CheckResult): ProbeVerdict {
  const rows = asArray(r.normalised.grants).length;
  if (r.status === 'ok' && rows > 0) {
    return { ok: true, reason: `${rows} grant row(s) parsed from the content[] envelope` };
  }
  if (r.status === 'not_found') {
    const content = firstOf(r.raw, ['content']);
    return Array.isArray(content)
      ? {
          ok: false,
          reason:
            'envelope confirmed (content[] present) but no row for this identifier, so the row fields could not be checked',
        }
      : { ok: false, reason: 'no row and no content[] envelope in the answer' };
  }
  return { ok: false, reason: `bdns_grants answered ${r.status}${describeFailure(r)}` };
}

export function raiscProbeVerdict(r: CheckResult): ProbeVerdict {
  const rows = asArray(r.normalised.grants).length;
  if (r.status === 'ok' && rows > 0) {
    return { ok: true, reason: `${rows} grant row(s) parsed from the dataset` };
  }
  if (r.status === 'not_found') {
    return Array.isArray(r.raw)
      ? {
          ok: false,
          reason:
            'the dataset answered an empty list for this identifier: dataset id and filter column accepted, row fields not checked',
        }
      : { ok: false, reason: 'no row and no list in the answer' };
  }
  return { ok: false, reason: `raisc_grants answered ${r.status}${describeFailure(r)}` };
}

/** Verified when a profile was matched and its name or identifier could be read. */
export function companyProfileProbeVerdict(r: CheckResult): ProbeVerdict {
  if (r.status !== 'ok') {
    return { ok: false, reason: `company_profile answered ${r.status}${describeFailure(r)}` };
  }
  const name = asString(r.normalised.name);
  const nif = asString(r.normalised.nif);
  const unread = asArray(r.normalised.unread).map(String);
  if (!name && !nif) {
    return {
      ok: false,
      reason:
        'a profile was matched but neither its name nor its identifier could be read; the field names differ',
    };
  }
  return {
    ok: true,
    reason:
      `profile read (matched by ${asString(r.normalised.matched_by) ?? 'unknown'})` +
      (unread.length > 0 ? `; fields not read: ${unread.join(', ')}` : ''),
  };
}

/**
 * Verified when the form answered one of its two expected pages for the identifier: a registered
 * entry (the result table was read: strongest) or the "no existe ningún registro" marker (the
 * form accepts a plain POST and answers in the expected structure; the result-table columns stay
 * unexercised, which the reason says). A page with neither marker, or an HTTP failure, verifies
 * nothing — that is exactly the session, token or captcha the gate protects against.
 */
export function reaProbeVerdict(r: CheckResult): ProbeVerdict {
  if (r.status === 'ok' && r.normalised.registered === true) {
    const unread = asArray(r.normalised.unread).map(String);
    return {
      ok: true,
      reason:
        `registered entry read from the result table (number ${asString(r.normalised.registration_number) ?? 'not read'}, ` +
        `${asString(r.normalised.community) ?? 'community not read'})` +
        (unread.length > 0 ? `; fields not read: ${unread.join(', ')}` : ''),
    };
  }
  if (r.status === 'not_found' && r.normalised.registered === false) {
    return {
      ok: true,
      reason:
        'the form answered the not-found marker ("no existe ningún registro") for this identifier: it accepts a plain POST and answers in the expected structure; ' +
        'the result-table columns are exercised the first time a registered company is looked up',
    };
  }
  return { ok: false, reason: `rea answered ${r.status}${describeFailure(r)}` };
}

/** Verified when a `Resultado` inside the documented vocabulary came back for the identifier. */
export function vnifProbeVerdict(r: CheckResult): ProbeVerdict {
  if (r.status === 'manual_pending') {
    return {
      ok: false,
      reason: 'no certificate configured; the web-form route was raised instead',
    };
  }
  if (r.status !== 'ok') {
    return { ok: false, reason: `aeat_census answered ${r.status}${describeFailure(r)}` };
  }
  const result = asString(r.normalised.result);
  if (result && (VNIF_RESULTS as readonly string[]).includes(result)) {
    return { ok: true, reason: `Resultado ${result} read for the identifier sent` };
  }
  return {
    ok: false,
    reason: `Resultado ${result ?? 'not read'} is outside the documented vocabulary`,
  };
}

/** Column names that carry an identifier in a Socrata view (`nif`, `cif`, `identificador`, …). */
export const NIF_COLUMN_PATTERN =
  /(^|[^a-z])(nif|cif|dni|nie)([^a-z]|$)|identificador|identificaci/i;

/** The identifier-like column of a Socrata view's metadata (`columns[].fieldName`), if any. */
export function socrataNifColumn(meta: unknown): { column: string | null; columns: string[] } {
  const columns: string[] = [];
  let column: string | null = null;
  for (const c of asArray(firstOf(meta, ['columns']))) {
    const field = asString(firstOf(c, ['fieldName', 'field_name']));
    const name = asString(firstOf(c, ['name']));
    if (field) columns.push(field);
    if (column === null && NIF_COLUMN_PATTERN.test(`${field ?? ''} ${name ?? ''}`)) {
      column = field ?? name;
    }
  }
  return { column, columns };
}

export function rasicMetadataVerdict(
  meta: unknown,
): ProbeVerdict & { column: string | null; columns: string[] } {
  const { column, columns } = socrataNifColumn(meta);
  if (columns.length === 0) {
    return {
      ok: false,
      reason: 'no columns[] in the answer; not the metadata of a Socrata view',
      column,
      columns,
    };
  }
  if (!column) {
    return {
      ok: false,
      reason:
        `${columns.length} column(s) read, none looks like an identifier column ` +
        `(${columns.slice(0, 12).join(', ')}${columns.length > 12 ? ', …' : ''}); the register cannot be searched by identifier`,
      column,
      columns,
    };
  }
  return {
    ok: true,
    reason: `identifier column ${column} among ${columns.length} column(s)`,
    column,
    columns,
  };
}

/** `https://host/api/views/<dataset>.json` for a Socrata resource base URL. */
export function socrataViewUrl(resourceBaseUrl: string, dataset: string): string {
  return `${new URL(resourceBaseUrl).origin}/api/views/${dataset}.json`;
}

/** The persisted shape of one probe attempt: the probed answer wrapped in a `source_probe` row. */
function probeRow(
  source: string,
  probedType: string,
  subjectKey: string,
  inner: CheckResult,
  verdict: ProbeVerdict,
): CheckResult {
  return {
    type: PROBE_CHECK_TYPE,
    status: verdict.ok ? 'ok' : inner.status === 'error' ? 'error' : 'not_found',
    normalised: {
      source,
      verified: verdict.ok,
      reason: verdict.reason,
      probed_check_type: probedType,
      probed_status: inner.status,
      probed_subject: subjectKey,
      probed_normalised: inner.normalised,
      source_verified: verdict.ok,
    },
    raw: inner.raw,
    source_url: inner.source_url,
    cost_cents: inner.cost_cents,
    request: { ...(inner.request ?? {}), probe_of: probedType, probed_subject: subjectKey },
  };
}

function attempt(
  source: string,
  probedType: string,
  subjectKey: string,
  inner: CheckResult,
  verdict: ProbeVerdict,
): ProbeAttempt {
  return {
    subjectKey,
    probedType,
    result: probeRow(source, probedType, subjectKey, inner, verdict),
    verdict,
  };
}

function skipped(probe: SourceProbe, reason: string): ProbeOutcome {
  return {
    source: probe.source,
    label: probe.label,
    verified: false,
    skipped: true,
    reason,
    attempts: [],
  };
}

/**
 * The outcome of a probe from its attempts. The first verifying attempt names the probe row,
 * unless `prefer` picks a stronger one (a registered REA entry over a not-found marker).
 */
function fromAttempts(
  probe: SourceProbe,
  attempts: ProbeAttempt[],
  prefer?: (a: ProbeAttempt) => boolean,
): ProbeOutcome {
  const verifying = attempts.filter((a) => a.verdict.ok);
  const ok = (prefer ? verifying.find(prefer) : undefined) ?? verifying[0];
  return {
    source: probe.source,
    label: probe.label,
    verified: ok !== undefined,
    skipped: false,
    reason: ok
      ? ok.verdict.reason
      : attempts.map((a) => `${a.subjectKey}: ${a.verdict.reason}`).join(' | ') ||
        'no attempt made',
    attempts,
  };
}

function communitySubject(inputs: ProbeInputs): CheckSubject {
  const c = inputs.community;
  const place = placeFromAddress(c.address);
  return {
    subjectType: 'community',
    subjectKey: c.nif ?? c.id,
    name: c.name,
    nif: c.nif,
    address: c.address,
    municipality: place.municipality,
    province: place.province,
    extra: { rc: c.catastro_rc },
  };
}

/** The community first, then the other legal-person identifiers on file; at most four. */
function grantCandidates(inputs: ProbeInputs): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  const seen = new Set<string>();
  const c = inputs.community;
  if (c.nif && legalPersonNif(c.nif)) {
    out.push({ nif: c.nif, name: c.name, role: 'community' });
    seen.add(c.nif.toUpperCase());
  }
  for (const cand of inputs.candidates) {
    const key = cand.nif.toUpperCase();
    if (seen.has(key) || !legalPersonNif(cand.nif)) continue;
    seen.add(key);
    out.push(cand);
  }
  return out.slice(0, 4);
}

async function grantsProbe(
  probe: SourceProbe,
  check: VendorCheck,
  verdict: (r: CheckResult) => ProbeVerdict,
  inputs: ProbeInputs,
  ctx: CheckContext,
): Promise<ProbeOutcome> {
  const candidates = grantCandidates(inputs);
  if (candidates.length === 0) {
    return skipped(
      probe,
      'no legal-person identifier on file: the community has no identifier and no vendor identifier is transcribed',
    );
  }
  const attempts: ProbeAttempt[] = [];
  for (const cand of candidates) {
    const subject: CheckSubject = {
      subjectType: cand.role === 'community' ? 'community' : 'party',
      subjectKey: cand.nif,
      name: cand.name,
      nif: cand.nif,
    };
    const inner = await check.run(subject, ctx);
    const v = verdict(inner);
    attempts.push(attempt(probe.source, check.type, cand.nif, inner, v));
    // A parsed row verifies the source; an error means the route itself is wrong and another
    // identifier would not change that. Only an empty answer justifies trying the next one.
    if (v.ok || inner.status === 'error') break;
  }
  return fromAttempts(probe, attempts);
}

const catastroProbe: SourceProbe = {
  source: SOURCES.catastro.id,
  label: 'Cadastre: unit list for the community reference (Consulta_DNPRC)',
  needs: 'communities.catastro_rc (14 characters), or the address',
  async run(inputs, ctx) {
    const c = inputs.community;
    if (!c.catastro_rc && !c.address) {
      return skipped(
        this,
        'the community has neither a cadastral reference nor an address on file; seed communities.catastro_rc',
      );
    }
    const subject = communitySubject(inputs);
    const inner = await catastroUnits.run(subject, ctx);
    return fromAttempts(this, [
      attempt(
        this.source,
        catastroUnits.type,
        c.catastro_rc ?? c.address ?? subject.subjectKey,
        inner,
        catastroProbeVerdict(inner),
      ),
    ]);
  },
};

const bdnsProbe: SourceProbe = {
  source: SOURCES.bdns.id,
  label: 'BDNS: grants published for the community identifier',
  needs: 'communities.nif (then vendor identifiers on file)',
  run(inputs, ctx) {
    return grantsProbe(this, bdnsGrants, bdnsProbeVerdict, inputs, ctx);
  },
};

const raiscProbe: SourceProbe = {
  source: SOURCES.raisc.id,
  label: 'RAISC: grants published for the community identifier (Socrata)',
  needs: 'communities.nif (then vendor identifiers on file)',
  run(inputs, ctx) {
    return grantsProbe(this, raiscGrants, raiscProbeVerdict, inputs, ctx);
  },
};

const rasicProbe: SourceProbe = {
  source: SOURCES.rasic.id,
  label: `RASIC: metadata of dataset ${RASIC_DATASET_ID} carries an identifier column`,
  needs: 'nothing on file: reads the view metadata',
  async run(_inputs, ctx) {
    const dataset = RASIC_DATASET_ID;
    const url = socrataViewUrl(SOURCES.rasic.baseUrl, dataset);
    const probedType = 'socrata_view_metadata';
    const request = { endpoint: url, dataset };
    let inner: CheckResult;
    let verdict: ProbeVerdict;
    try {
      const res = await fetchJson(ctx, url, { source: SOURCES.rasic.id, allowStatus: [404] });
      const v = rasicMetadataVerdict(res.json);
      verdict =
        res.status === 404
          ? { ok: false, reason: `HTTP 404: no view ${dataset} on the portal` }
          : { ok: v.ok, reason: v.reason };
      inner = {
        type: probedType,
        status: res.status === 404 ? 'not_found' : v.ok ? 'ok' : 'not_found',
        normalised: { dataset, nif_column: v.column, columns: v.columns },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      inner = errorResult(probedType, url, err, request);
      verdict = {
        ok: false,
        reason: `metadata request failed: ${asString(inner.normalised.error) ?? 'error'}`,
      };
    }
    return fromAttempts(this, [attempt(this.source, probedType, dataset, inner, verdict)]);
  },
};

const reaProbe: SourceProbe = {
  source: SOURCES.rea.id,
  label: 'REA: the public form answers for a legal-person identifier on file',
  needs: 'a legal-person identifier on an ingested document (a vendor or the administrator)',
  async run(inputs, ctx) {
    // Vendors first: a construction contractor is the likeliest registered entry. The community
    // itself is not tried (an owners' community is not an employer in REA's sense), and a
    // natural-person identifier is never probe material.
    const candidates = inputs.candidates.filter((c) => legalPersonNif(c.nif)).slice(0, 4);
    if (candidates.length === 0) {
      return skipped(
        this,
        'no legal-person vendor or administrator identifier on file to put to the form',
      );
    }
    const attempts: ProbeAttempt[] = [];
    for (const cand of candidates) {
      const subject: CheckSubject = {
        subjectType: 'party',
        subjectKey: cand.nif,
        name: cand.name,
        nif: cand.nif,
      };
      // The probe is the one caller allowed past the gate: it exercises the form so the register
      // can open it for the check.
      const inner = await reaLookup(subject, ctx, { sourceVerified: true });
      const v = reaProbeVerdict(inner);
      attempts.push(attempt(this.source, rea.type, cand.nif, inner, v));
      // A registered entry is the strongest confirmation: stop. A not-found marker confirms the
      // route; try the next identifier for the table. An error means the form did not answer as
      // expected and another identifier would not change that.
      if ((v.ok && inner.status === 'ok') || inner.status === 'error') break;
    }
    return fromAttempts(this, attempts, (a) => a.result.normalised.probed_status === 'ok');
  },
};

const openmercantilProbe: SourceProbe = {
  source: SOURCES.openmercantil.id,
  label: "OpenMercantil: the community administrator's registry profile",
  needs: 'a party of kind administrator with a legal-person identifier',
  async run(inputs, ctx) {
    const adm = inputs.administrator;
    if (!adm || !legalPersonNif(adm.nif)) {
      return skipped(
        this,
        'no administrator party with a legal-person identifier on file (kind administrator, nif set)',
      );
    }
    const subject: CheckSubject = {
      subjectType: 'party',
      subjectKey: adm.nif,
      name: adm.name,
      nif: adm.nif,
    };
    const inner = await companyProfile.run(subject, ctx);
    return fromAttempts(this, [
      attempt(this.source, companyProfile.type, adm.nif, inner, companyProfileProbeVerdict(inner)),
    ]);
  },
};

const aeatProbe: SourceProbe = {
  source: SOURCES.aeat_vnif.id,
  label: "AEAT VNifV2: the community's own identifier and name (client certificate)",
  needs: 'VX_CLIENT_CERT_P12 and communities.nif',
  async run(inputs, ctx) {
    if (!ctx.certFetch) {
      return skipped(
        this,
        'no client certificate configured (VX_CLIENT_CERT_P12); the AEAT probe needs the operator certificate',
      );
    }
    if (!inputs.community.nif) return skipped(this, 'the community has no identifier on file');
    const subject = communitySubject(inputs);
    const inner = await aeatCensus.run(subject, ctx);
    return fromAttempts(this, [
      attempt(this.source, aeatCensus.type, subject.subjectKey, inner, vnifProbeVerdict(inner)),
    ]);
  },
};

/** One probe per automatable source; sources absent here are verified by hand. */
export const PROBES: readonly SourceProbe[] = Object.freeze([
  catastroProbe,
  bdnsProbe,
  raiscProbe,
  rasicProbe,
  reaProbe,
  openmercantilProbe,
  aeatProbe,
]);

/**
 * Run the probes (network only; nothing is stored here). `only` restricts the run to one source
 * and is refused when no probe exists for it. A probe that throws becomes a failed outcome.
 */
export async function runProbes(
  inputs: ProbeInputs,
  ctx: CheckContext,
  opts: { only?: string | null } = {},
): Promise<ProbeOutcome[]> {
  const selected = opts.only ? PROBES.filter((p) => p.source === opts.only) : [...PROBES];
  if (opts.only && selected.length === 0) {
    throw new Error(
      `no probe for source "${opts.only}"; probes exist for: ${PROBES.map((p) => p.source).join(', ')}`,
    );
  }
  const out: ProbeOutcome[] = [];
  for (const probe of selected) {
    try {
      out.push(await probe.run(inputs, ctx));
    } catch (err) {
      out.push({
        source: probe.source,
        label: probe.label,
        verified: false,
        skipped: false,
        reason: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
        attempts: [],
      });
    }
  }
  return out;
}

export interface ProbeSummary {
  source: string;
  label: string;
  verified: boolean;
  skipped: boolean;
  reason: string;
  /** Every `source_probe` row appended for this probe. */
  checkIds: string[];
  /** The row that verified the source, when it did. */
  probeCheckId: string | null;
}

/**
 * Persist every attempt as an `external_checks` row and update the register: `verified_at` and
 * `probe_check_id` on success, the dated reason in the notes otherwise. A skipped probe made no
 * lookup and leaves no row.
 */
export async function recordProbeOutcomes(
  client: Queryable,
  cid: string,
  outcomes: readonly ProbeOutcome[],
  opts: { checkedBy?: string | null } = {},
): Promise<ProbeSummary[]> {
  const checkedBy = opts.checkedBy ?? null;
  const summaries: ProbeSummary[] = [];
  for (const o of outcomes) {
    const checkIds: string[] = [];
    let probeCheckId: string | null = null;
    for (const a of o.attempts) {
      const row = await persistCheck(
        client,
        cid,
        { subjectType: PROBE_SUBJECT_TYPE, subjectKey: o.source },
        a.result,
        { checkedBy },
      );
      checkIds.push(row.id);
      if (a.verdict.ok && probeCheckId === null) probeCheckId = row.id;
    }
    if (o.verified && probeCheckId) {
      await markSourceVerified(client, o.source, probeCheckId, checkedBy, o.reason);
    } else if (!o.skipped) {
      await recordProbeFailure(client, o.source, checkIds.at(-1) ?? null, o.reason);
    }
    summaries.push({
      source: o.source,
      label: o.label,
      verified: o.verified,
      skipped: o.skipped,
      reason: o.reason,
      checkIds,
      probeCheckId,
    });
  }
  return summaries;
}

/**
 * What the probes may use: the community itself and the legal-person identifiers of parties
 * already on ingested documents (administrator first, then vendors and architects by name).
 * Natural-person identifiers are dropped here; owners and the president are never selected.
 */
export async function loadProbeInputs(
  client: Queryable,
  community: ProbeCommunity,
  opts: { certificateConfigured: boolean },
): Promise<ProbeInputs> {
  const res = await client.query(
    `select p.kind::text as kind, p.display_name, p.nif
       from public.parties p
      where p.community_id = $1 and p.kind in ('administrator', 'vendor', 'architect') and p.nif is not null
      order by (p.kind = 'administrator') desc, p.display_name`,
    [community.id],
  );
  const rows = (res.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      kind: String(r.kind),
      name: (r.display_name as string | null) ?? null,
      nif: String(r.nif),
    }))
    .filter((r) => legalPersonNif(r.nif));
  const adm = rows.find((r) => r.kind === 'administrator');
  return {
    community,
    administrator: adm ? { nif: adm.nif, name: adm.name, role: 'administrator' } : null,
    candidates: rows.slice(0, 5).map((r) => ({ nif: r.nif, name: r.name, role: r.kind })),
    certificateConfigured: opts.certificateConfigured,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface SourceStatusRow {
  id: string;
  name: string;
  access: SourceAccess;
  verified_at: string | null;
  probe_check_id: string | null;
  notes: string | null;
  /** False when the code knows the source but the register has no row for it yet. */
  registered: boolean;
  /** False when the register has a row the code no longer uses. */
  in_code: boolean;
  /** True when `vx vendors sources probe` can verify it; the rest are verified by hand. */
  probeable: boolean;
}

/** The register merged with the ids known to the code, sorted by id. */
export function sourceStatusRows(register: SourceRegister): SourceStatusRow[] {
  const codeIds = new Set(configSourceIds());
  const ids = [...new Set([...register.keys(), ...codeIds])].sort();
  const probeable = new Set(PROBES.map((p) => p.source));
  return ids.map((id) => {
    const row = register.get(id);
    const cfg = configForSource(id);
    return {
      id,
      name: row?.name ?? cfg.name,
      access: row?.access ?? cfg.access,
      verified_at: row?.verified_at ?? null,
      probe_check_id: row?.probe_check_id ?? null,
      notes: row?.notes ?? null,
      registered: row !== undefined,
      in_code: codeIds.has(id),
      probeable: probeable.has(id),
    };
  });
}
