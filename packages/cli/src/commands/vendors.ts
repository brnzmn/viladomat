/**
 * `vx vendors` — the operator side of the vendor due-diligence module.
 *
 *   vx vendors check [--vendor <party_id> | --all] [--only <types>]
 *   vx vendors links [--community <uuid>]
 *   vx vendors evidence --check <id> --file <path>
 *   vx vendors factsheet [--community <uuid>] [--json]
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
  checkByType,
  CHECKS,
  COMMUNITY_DEFAULT_CHECKS,
  VENDOR_DEFAULT_CHECKS,
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
      `select p.id, p.kind::text as kind, p.display_name, p.nif, p.address_norm, p.postcode,
              (select i.iban_last4 from public.party_ibans i where i.party_id = p.id order by i.created_at limit 1) as iban_last4
         from public.parties p
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
    };
    for (const type of only ? [...only] : VENDOR_DEFAULT_CHECKS) {
      const check = checkByType(type);
      if (!check)
        throw new Error(
          `unknown check type "${type}"; known: ${CHECKS.map((c) => c.type).join(', ')}`,
        );
      planned.push({ subject, type, label: check.label });
    }
  }
  if (opts.all && !opts.vendor) {
    const communitySubject: CheckSubject = {
      subjectType: 'community',
      subjectKey: community.nif ?? community.id,
      name: community.name,
      nif: community.nif,
      address: null,
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
  const results: Array<{ subject: CheckSubject; result: CheckResult }> = [];
  for (const p of planned) {
    const check = checkByType(p.type);
    if (!check) continue;
    const ctx: CheckContext = {
      cid: community.id,
      fetch: fetchImpl,
      cacheLookup: async (type, key, days) =>
        transaction((client) => cachedNormalised(client, community.id, type, key, days)),
    };
    const result = await check.run(p.subject, ctx);
    results.push({ subject: p.subject, result });
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
      const ctx: CheckContext = {
        cid: community.id,
        fetch: fetchImpl,
        cacheLookup: async (type, key, days) =>
          transaction((client) => cachedNormalised(client, community.id, type, key, days)),
      };
      results.push({ subject, result: await surnameCheck.run(subject, ctx) });
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

/** Listing helper used by the reviewer screen and by tests. */
export async function listPartyLinks(cid: string): Promise<Array<Record<string, unknown>>> {
  return transaction((client) => loadPartyLinks(client, cid));
}
