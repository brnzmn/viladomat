/**
 * `vx vendors` — the operator side of the vendor due-diligence module.
 *
 *   vx vendors check [--vendor <party_id> | --all] [--only <types>]
 *   vx vendors links [--community <uuid>]
 *   vx vendors evidence --check <id> --file <path>
 *   vx vendors factsheet [--community <uuid>] [--json]
 *   vx vendors catastro [--apply] [--dry-run] [--force] [--community <uuid>]
 *   vx vendors sources probe [--source <id>] [--community <uuid>]
 *   vx vendors sources status
 *
 * `catastro` compares the latest Cadastre unit list with the unit table and, with `--apply`,
 * fills `units.catastro_rc20` and `units.surface_m2` where one unit matches one Cadastre unit;
 * `quota_pct` is never written. `sources probe` verifies each automatable source with one live
 * lookup from the operator's machine and records the outcome in `public.registry_sources`;
 * `sources status` prints that register. Before running a check, `check` reads the register and
 * sets `normalised.source_verified` from it, so a figure can only be cited once its source was
 * probed successfully.
 *
 * `check` runs the registry lookups and appends one `external_checks` row per check; manual
 * checks print the page to open and the evidence to capture. `links` scores the related-party
 * signals and writes `party_links`. `evidence` files the screenshot or PDF a reviewer captured.
 * `factsheet` prints registry facts only — the output that may reach the assembly.
 *
 * `links` output stays with the reviewer and legal counsel. It is deliberately not part of any
 * pack the assembly receives; the pre-junta pack takes the fact sheet instead.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normaliseName } from '@viladomat/core';
import { resolveCommunity } from '../lib/community.ts';
import { transaction } from '../lib/db.ts';
import {
  CERTIFICATE_GATED_CHECKS,
  checkByType,
  CHECKS,
  COMMUNITY_DEFAULT_CHECKS,
  plannedVendorChecks,
} from '../vendors/checks/index.ts';
import { officersFromProfile, upsertOfficers } from '../vendors/officers.ts';
import { attachEvidence, cachedNormalised, persistCheck } from '../vendors/persist.ts';
import {
  aggregateLinks,
  scoreVendorLinks,
  vendorLinkScore,
  writePartyLinks,
  loadPartyLinks,
  LINKS_ENGINE_VERSION,
} from '../vendors/links.ts';
import { loadLinkInputs } from '../vendors/snapshot.ts';
import { vendorFactSheet } from '../vendors/factsheet.ts';
import { placeFromAddress } from '../vendors/checks/catastro-units.ts';
import { applyCatastroToUnits, renderComparison } from '../vendors/catastro-apply.ts';
import {
  applySourceGate,
  loadProbeInputs,
  loadSourceRegister,
  PROBES,
  recordProbeOutcomes,
  runProbes,
  sourceStatusRows,
  withSourceGate,
} from '../vendors/sources.ts';
import {
  CLIENT_CERT_PATH_VAR,
  loadClientCertificate,
  mtlsFetch,
} from '../vendors/transport/mtls.ts';
import type { CheckContext, CheckResult, CheckSubject, FetchLike } from '../vendors/types.ts';
import type { CompanyProfile } from '../vendors/checks/company-profile.ts';

interface CommonOpts {
  community?: string;
}

function defaultFetch(): FetchLike {
  const f = globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch available in this runtime');
  return f.bind(globalThis) as unknown as FetchLike;
}

/**
 * The certificate transport for the checks that only answer an identified caller (AEAT
 * VNifV2), or undefined when `VX_CLIENT_CERT_P12` is not set — those checks then raise their
 * manual route. Built once per command run; the passphrase never reaches a log line.
 */
function certificateFetch(): FetchLike | undefined {
  const certificate = loadClientCertificate();
  if (!certificate) return undefined;
  console.log(
    `client certificate loaded from ${CLIENT_CERT_PATH_VAR}: certificate-gated checks query their source directly`,
  );
  return mtlsFetch(certificate);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  html: 'text/html',
  json: 'application/json',
  txt: 'text/plain',
};

// ---------------------------------------------------------------------------
// vx vendors check
// ---------------------------------------------------------------------------

export interface VendorsCheckOpts extends CommonOpts {
  vendor?: string;
  all?: boolean;
  only?: string;
  dryRun?: boolean;
}

interface PlannedCheck {
  subject: CheckSubject;
  type: string;
  label: string;
}

export async function vendorsCheckCommand(opts: VendorsCheckOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const only = opts.only
    ? new Set(
        opts.only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  if (!opts.vendor && !opts.all) throw new Error('pass --vendor <party_id> or --all');

  const subjects = await transaction(async (client) => {
    const res = await client.query(
      // The account number itself is never held in clear, so the IBAN check is given the stored
      // pseudonym (bank code, last four, the verdicts recorded when the number was read).
      `select p.id, p.kind::text as kind, p.display_name, p.nif, p.address_norm, p.postcode,
              ib.iban_last4, ib.bank_code, ib.bank_name, ib.country, ib.iban_valid, ib.ccc_dc_valid, ib.iban_hmac
         from public.parties p
         left join lateral (
           select i.iban_last4, i.bank_code, i.bank_name, i.country, i.iban_valid, i.ccc_dc_valid, i.iban_hmac
             from public.party_ibans i where i.party_id = p.id order by i.created_at limit 1
         ) ib on true
        where p.community_id = $1 and p.kind in ('vendor', 'administrator', 'architect')
          and ($2::uuid is null or p.id = $2::uuid)
        order by p.display_name`,
      [community.id, opts.vendor ?? null],
    );
    return res.rows as Array<Record<string, unknown>>;
  });
  if (subjects.length === 0)
    throw new Error(
      opts.vendor ? `party ${opts.vendor} not found in this community` : 'no vendor parties yet',
    );

  const planned: PlannedCheck[] = [];
  for (const p of subjects) {
    const subject: CheckSubject = {
      subjectType: 'party',
      subjectKey: String(p.id),
      partyId: String(p.id),
      name: String(p.display_name),
      nif: (p.nif as string | null) ?? null,
      address: (p.address_norm as string | null) ?? null,
      postcode: (p.postcode as string | null) ?? null,
      extra: {
        last4: (p.iban_last4 as string | null) ?? null,
        bank_code: (p.bank_code as string | null) ?? null,
        bank_name: (p.bank_name as string | null) ?? null,
        country: (p.country as string | null) ?? null,
        iban_valid: (p.iban_valid as boolean | null) ?? null,
        ccc_dc_valid: (p.ccc_dc_valid as boolean | null) ?? null,
        iban_hmac: (p.iban_hmac as string | null) ?? null,
      },
    };
    // The planner drops `catastro_units` for a party without an address on record and, should
    // the kinds selected above ever widen, keeps every owner or president identifier out of the
    // tax census. The Cadastre lookup for a vendor takes its transcribed address (no cadastral
    // reference is known for it), so it resolves through `Consulta_DNPLOC`; the answer describes
    // the building at that address and carries no holder data.
    const partyPlan = {
      kind: String(p.kind),
      address_norm: (p.address_norm as string | null) ?? null,
    };
    for (const type of plannedVendorChecks(partyPlan, only ? [...only] : null)) {
      const check = checkByType(type);
      if (!check)
        throw new Error(
          `unknown check type "${type}"; known: ${CHECKS.map((c) => c.type).join(', ')}`,
        );
      planned.push({ subject, type, label: check.label });
    }
  }
  if (opts.all && !opts.vendor) {
    // The Cadastre check needs the seeded reference (`extra.rc`) or, failing that, the address;
    // province and municipality are read from the address and default to BARCELONA.
    const place = placeFromAddress(community.address);
    const communitySubject: CheckSubject = {
      subjectType: 'community',
      subjectKey: community.nif ?? community.id,
      name: community.name,
      nif: community.nif,
      address: community.address,
      municipality: place.municipality,
      province: place.province,
      extra: { rc: community.catastro_rc },
    };
    for (const type of only ? [...only] : COMMUNITY_DEFAULT_CHECKS) {
      const check = checkByType(type);
      if (check) planned.push({ subject: communitySubject, type, label: check.label });
    }
  }

  if (opts.dryRun) {
    console.log(`${planned.length} check(s) planned:`);
    for (const p of planned)
      console.log(
        `  ${p.subject.subjectType} ${p.subject.name ?? p.subject.subjectKey} · ${p.type}`,
      );
    return;
  }

  const fetchImpl = defaultFetch();
  // The register (public.registry_sources) decides what `source_verified` means at run time: a
  // source counts as verified only after `vx vendors sources probe` parsed a live answer from
  // the operator's machine. Every automated non-local check runs regardless; its row says so.
  const register = await transaction((client) => loadSourceRegister(client));
  const unverifiedSources = new Set<string>();
  // The PKCS#12 is only read when a certificate-gated check is actually planned.
  const certFetch = planned.some((p) => CERTIFICATE_GATED_CHECKS.has(p.type))
    ? certificateFetch()
    : undefined;
  const results: Array<{ subject: CheckSubject; result: CheckResult }> = [];
  for (const p of planned) {
    const check = checkByType(p.type);
    if (!check) continue;
    const ctx = withSourceGate(
      {
        cid: community.id,
        fetch: fetchImpl,
        ...(certFetch ? { certFetch } : {}),
        cacheLookup: async (type, key, days) =>
          transaction((client) => cachedNormalised(client, community.id, type, key, days)),
      },
      register,
    );
    const gated = applySourceGate(await check.run(p.subject, ctx), register, check);
    if (gated.gated && !gated.verified) unverifiedSources.add(check.source);
    results.push({ subject: p.subject, result: gated.result });
  }

  // Surnames found in the profiles need their frequency before the links can be weighted.
  const surnames = new Set<string>();
  for (const { result } of results) {
    if (result.type !== 'company_profile' || result.status !== 'ok') continue;
    const profile = result.normalised as unknown as CompanyProfile;
    for (const o of officersFromProfile(profile)) {
      if (o.surname1) surnames.add(o.surname1);
      if (o.surname2) surnames.add(o.surname2);
    }
  }
  const surnameCheck = checkByType('surname_frequency');
  if (surnameCheck && (!only || only.has('surname_frequency') || only.has('company_profile'))) {
    for (const surname of surnames) {
      const subject: CheckSubject = {
        subjectType: 'surname',
        subjectKey: normaliseName(surname),
        extra: { surname },
      };
      const ctx = withSourceGate(
        {
          cid: community.id,
          fetch: fetchImpl,
          cacheLookup: async (type, key, days) =>
            transaction((client) => cachedNormalised(client, community.id, type, key, days)),
        },
        register,
      );
      const gated = applySourceGate(await surnameCheck.run(subject, ctx), register, surnameCheck);
      if (gated.gated && !gated.verified) unverifiedSources.add(surnameCheck.source);
      results.push({ subject, result: gated.result });
    }
  }

  const summary = await transaction(async (client) => {
    const lines: string[] = [];
    let manual = 0;
    let officersWritten = 0;
    for (const { subject, result } of results) {
      const row = await persistCheck(client, community.id, subject, result);
      lines.push(
        `  ${result.type.padEnd(24)} ${result.status.padEnd(15)} ${subject.name ?? subject.subjectKey}` +
          (result.source_url ? `\n      ${result.source_url}` : ''),
      );
      if (result.status === 'manual_pending' && result.manual) {
        manual++;
        lines.push(`      open: ${result.manual.url}`);
        if (result.manual.query) lines.push(`      search: ${result.manual.query}`);
        for (const e of result.manual.evidence) lines.push(`      capture: ${e}`);
        lines.push(`      then: vx vendors evidence --check ${row.id} --file <path>`);
      }
      if (result.note) lines.push(`      note: ${result.note}`);
      if (result.type === 'company_profile' && result.status === 'ok' && subject.partyId) {
        const officers = officersFromProfile(result.normalised as unknown as CompanyProfile);
        const written = await upsertOfficers(
          client,
          community.id,
          subject.partyId,
          officers,
          row.id,
        );
        officersWritten += written.inserted + written.updated;
        if (officers.length > 0) {
          lines.push(
            `      officers recorded: ${written.inserted} new, ${written.updated} updated`,
          );
        }
      }
    }
    await client.query(
      `select public.log_access($1, 'external_check', 'external_checks', null, null, $2::jsonb, 'vx vendors check')`,
      [community.id, JSON.stringify({ checks: results.length, manual, officers: officersWritten })],
    );
    return { lines, manual, officersWritten };
  });

  console.log(
    `vendor checks: ${results.length} recorded (${summary.manual} awaiting manual evidence)`,
  );
  for (const line of summary.lines) console.log(line);
  const cost = results.reduce((acc, r) => acc + r.result.cost_cents, 0);
  if (cost > 0) console.log(`documents to purchase: ${(cost / 100).toFixed(2)} EUR`);
  if (unverifiedSources.size > 0) {
    console.log(`${unverifiedSources.size} sources unverified: run vx vendors sources probe`);
  }
}

// ---------------------------------------------------------------------------
// vx vendors links
// ---------------------------------------------------------------------------

export interface VendorsLinksOpts extends CommonOpts {
  dryRun?: boolean;
}

export async function vendorsLinksCommand(opts: VendorsLinksOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const today = new Date().toISOString().slice(0, 10);

  const out = await transaction(async (client) => {
    const inputs = await loadLinkInputs(client, community.id, today);
    const signals = inputs.vendors.flatMap((v) => scoreVendorLinks(v, inputs.context));
    const links = aggregateLinks(signals);
    if (opts.dryRun)
      return {
        links,
        written: 0,
        skipped: 0,
        vendors: inputs.vendors.length,
        reference: inputs.context.reference.length,
      };
    const res = await writePartyLinks(client, community.id, links, LINKS_ENGINE_VERSION);
    await client.query(
      `select public.log_access($1, 'rule_run', 'party_links', null, null, $2::jsonb, 'vx vendors links')`,
      [
        community.id,
        JSON.stringify({
          signals: signals.length,
          written: res.written,
          roleless: res.skippedRoleless,
        }),
      ],
    );
    return {
      links,
      written: res.written,
      skipped: res.skippedRoleless,
      vendors: inputs.vendors.length,
      reference: inputs.context.reference.length,
    };
  });

  console.log(
    `related-party signals over ${out.vendors} vendor(s) and ${out.reference} reference record(s): ` +
      `${out.links.length} signal group(s), ${out.written} stored as party_links, ${out.skipped} without an office-holder role`,
  );
  if (out.reference === 0) {
    console.log(
      'no reference records: the surname and identifier tests cannot run until public.upsert_reference_person has been called',
    );
  }
  const byParty = new Map<string, typeof out.links>();
  for (const l of out.links) {
    const list = byParty.get(l.partyId) ?? [];
    list.push(l);
    byParty.set(l.partyId, list);
  }
  for (const [partyId, list] of byParty) {
    console.log(`\n  party ${partyId}  (total ${vendorLinkScore(list)} points)`);
    for (const l of list) {
      console.log(
        `    ${l.signal} ${String(l.points).padStart(6)} ${l.tier.padEnd(9)} ${l.role ?? 'no office-holder role'}`,
      );
      console.log(`      ${l.explanation}`);
    }
  }
  console.log(
    '\nThese are questions for the register, not conclusions. They belong to the reviewer and to legal counsel; ' +
      'the assembly receives the fact sheet (`vx vendors factsheet`), which carries registry facts only.',
  );
}

// ---------------------------------------------------------------------------
// vx vendors evidence
// ---------------------------------------------------------------------------

export interface VendorsEvidenceOpts extends CommonOpts {
  check: string;
  file: string;
  note?: string;
}

export async function vendorsEvidenceCommand(opts: VendorsEvidenceOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const bytes = await readFile(opts.file);
  const ext = path.extname(opts.file).replace(/^\./, '').toLowerCase() || 'bin';
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

  const row = await transaction((client) =>
    attachEvidence(client, community.id, {
      checkId: opts.check,
      bytes,
      ext,
      contentType,
      note: opts.note ?? null,
    }),
  );
  console.log(`evidence stored: ${row.storagePath}`);
  console.log(`completion recorded as check ${row.id} (${row.checkType}, status ${row.status})`);
  console.log(
    'the pending row is kept: both the date the check was raised and the date it was satisfied stay on the record',
  );
}

// ---------------------------------------------------------------------------
// vx vendors factsheet
// ---------------------------------------------------------------------------

export interface VendorsFactsheetOpts extends CommonOpts {
  json?: boolean;
}

export async function vendorsFactsheetCommand(opts: VendorsFactsheetOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const sheet = await transaction((client) => vendorFactSheet(client, community.id));

  if (opts.json) {
    console.log(JSON.stringify(sheet, null, 2));
    return;
  }
  console.log(`Vendor fact sheet — ${community.name} — ${sheet.generated_at}`);
  console.log('Registry facts only. No scores, no links, no names of natural persons.\n');
  for (const v of sheet.vendors) {
    console.log(`${v.display_name}  [${v.kind}]`);
    console.log(
      `  identifier: ${v.nif ?? 'not transcribed'}` +
        (v.nif_valid === null
          ? ' (not checked)'
          : v.nif_valid
            ? ' (check digit correct)'
            : ' (check digit does not match)') +
        (v.entity_kind ? ` · ${v.entity_kind}` : ''),
    );
    console.log(
      `  incorporation: ${v.incorporation_date ?? 'not located'}${v.cnae ? ` · CNAE ${v.cnae}` : ''}`,
    );
    console.log(
      `  officers: ${v.officers.length === 0 ? 'not located' : v.officers.map((o) => `${o.initials}${o.cargo ? ` (${o.cargo})` : ''}`).join(', ')}`,
    );
    console.log(`  REA: ${v.rea_status} · RASIC: ${v.rasic_status}`);
    if (v.grants.length > 0) {
      console.log(`  published grants: ${v.grants.length}`);
    }
    console.log(
      `  first document on file: ${v.first_document_date ?? 'not recorded'}` +
        ` · first invoice: ${v.first_invoice_date ?? 'none'} (${v.invoice_count})`,
    );
    console.log('');
  }
  if (sheet.community_grants.length > 0) {
    console.log('Grants published for the Community:');
    for (const g of sheet.community_grants) {
      console.log(
        `  ${g.register} ${g.date ?? 'no date'} ${g.programme ?? ''} ${g.amount_granted ?? '-'}`,
      );
    }
    console.log('');
  }
  if (sheet.unverified_sources.length > 0) {
    console.log(
      `Sources whose endpoint or dataset is still to verify: ${sheet.unverified_sources.join(', ')}`,
    );
  }
  console.log(sheet.note_en);
}

// ---------------------------------------------------------------------------
// vx vendors catastro
// ---------------------------------------------------------------------------

export interface VendorsCatastroOpts extends CommonOpts {
  /** Write the matched columns; without it the command only prints the comparison. */
  apply?: boolean;
  /** Print what `--apply` would write and write nothing. */
  dryRun?: boolean;
  /** Overwrite a non-empty `catastro_rc20` or `surface_m2`. */
  force?: boolean;
}

export async function vendorsCatastroCommand(opts: VendorsCatastroOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  const apply = Boolean(opts.apply) && !opts.dryRun;
  const out = await transaction((client) =>
    applyCatastroToUnits(client, community.id, { apply, force: Boolean(opts.force) }),
  );

  console.log(
    `Cadastre units vs unit table — ${community.name} — check ${out.check.id} fetched ${out.check.fetchedAt}` +
      (out.check.sourceVerified === false
        ? ' (source not yet verified: run vx vendors sources probe)'
        : ''),
  );
  for (const line of renderComparison(out.table)) console.log(line);
  console.log('');

  const planned = out.plans.filter(
    (p) => p.set.catastro_rc20 !== undefined || p.set.surface_m2 !== undefined,
  );
  console.log(
    apply
      ? `written: ${out.written} unit(s) (catastro_rc20, surface_m2); quota_pct untouched; one log_access row per unit names check ${out.check.id}`
      : `${planned.length} unit(s) would be written (catastro_rc20, surface_m2); pass --apply to write, --force to overwrite values already present`,
  );
  for (const p of out.plans) {
    const sets = Object.entries(p.set)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    if (sets) console.log(`  ${p.label}: ${sets}`);
    for (const k of p.kept) console.log(`  ${p.label}: ${k}`);
  }
  if (out.report.ambiguous.length > 0) {
    console.log(
      `  ${out.report.ambiguous.length} key(s) not one-to-one, left alone: ${out.report.ambiguous.map((a) => a.key).join(', ')}`,
    );
  }
  if (out.report.unmatchedUnits.length > 0) {
    console.log(
      `  ${out.report.unmatchedUnits.length} unit(s) without a Cadastre counterpart: ${out.report.unmatchedUnits.map((u) => u.unit.label).join(', ')}`,
    );
  }
  if (out.report.unmatchedCatastro.length > 0) {
    console.log(
      `  ${out.report.unmatchedCatastro.length} Cadastre unit(s) without a table counterpart: ${out.report.unmatchedCatastro.map((c) => c.catastro.rc ?? c.key ?? '?').join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// vx vendors sources probe | status
// ---------------------------------------------------------------------------

export interface VendorsSourcesProbeOpts extends CommonOpts {
  /** Probe one source only (its id in the register). */
  source?: string;
}

export async function vendorsSourcesProbeCommand(opts: VendorsSourcesProbeOpts): Promise<void> {
  const community = await resolveCommunity(opts.community);
  if (opts.source && !PROBES.some((p) => p.source === opts.source)) {
    throw new Error(
      `no probe for source "${opts.source}"; probes exist for: ${PROBES.map((p) => p.source).join(', ')}`,
    );
  }
  // The PKCS#12 is only read when the AEAT probe is part of the run.
  const certFetch = !opts.source || opts.source === 'aeat_vnif' ? certificateFetch() : undefined;
  const inputs = await transaction((client) =>
    loadProbeInputs(client, community, { certificateConfigured: Boolean(certFetch) }),
  );
  const ctx: CheckContext = {
    cid: community.id,
    fetch: defaultFetch(),
    ...(certFetch ? { certFetch } : {}),
  };
  const outcomes = await runProbes(inputs, ctx, { only: opts.source ?? null });
  const summaries = await transaction(async (client) => {
    const rows = await recordProbeOutcomes(client, community.id, outcomes);
    await client.query(
      `select public.log_access($1, 'external_check', 'registry_sources', null, null, $2::jsonb, 'vx vendors sources probe')`,
      [
        community.id,
        JSON.stringify({
          probes: rows.length,
          verified: rows.filter((r) => r.verified).length,
          skipped: rows.filter((r) => r.skipped).length,
        }),
      ],
    );
    return rows;
  });

  console.log(`source probes — ${community.name}`);
  for (const s of summaries) {
    const outcome = s.verified ? 'verified' : s.skipped ? 'skipped' : 'not verified';
    console.log(`  ${s.source.padEnd(16)} ${outcome.padEnd(13)} ${s.label}`);
    console.log(`      ${s.reason}`);
    if (s.probeCheckId) console.log(`      probe check: ${s.probeCheckId}`);
    else if (s.checkIds.length > 0) console.log(`      checks recorded: ${s.checkIds.join(', ')}`);
  }
  const verified = summaries.filter((s) => s.verified).length;
  console.log(
    `${verified}/${summaries.length} probed source(s) verified. A source is verified only when its live answer parsed into the shape the check expects; ` +
      'sources without a probe (idescat and the manual routes) are verified by hand in the register.',
  );
}

export async function vendorsSourcesStatusCommand(): Promise<void> {
  const register = await transaction((client) => loadSourceRegister(client));
  const rows = sourceStatusRows(register);
  if (register.size === 0) {
    console.log(
      'the register is empty: apply migration 0015_registry_sources.sql (bash scripts/db-local.sh migrate) to seed it',
    );
  }
  console.log(
    `${'id'.padEnd(24)} ${'access'.padEnd(8)} ${'verified_at'.padEnd(25)} ${'probe check id'.padEnd(36)} notes`,
  );
  for (const r of rows) {
    const flags = [
      r.registered ? null : 'not in register: add a row in a migration',
      r.in_code ? null : 'no check module uses this id',
    ]
      .filter(Boolean)
      .join('; ');
    console.log(
      `${r.id.padEnd(24)} ${r.access.padEnd(8)} ${(r.verified_at ?? 'unverified').padEnd(25)} ${(r.probe_check_id ?? '-').padEnd(36)} ` +
        `${(r.notes ?? '').slice(0, 80)}${flags ? ` [${flags}]` : ''}`,
    );
  }
  const verified = rows.filter((r) => r.verified_at !== null).length;
  const probeable = rows.filter((r) => r.probeable && r.verified_at === null).length;
  console.log(
    `${verified}/${rows.length} verified; ${probeable} unverified source(s) have a probe: vx vendors sources probe`,
  );
}

/** Listing helper used by the reviewer screen and by tests. */
export async function listPartyLinks(cid: string): Promise<Array<Record<string, unknown>>> {
  return transaction((client) => loadPartyLinks(client, cid));
}
