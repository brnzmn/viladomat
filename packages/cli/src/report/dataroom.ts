/**
 * The data room: every normalised ledger as a hashed file, plus the manifest that ties them to
 * the rule run, the parameter version and the rule versions they were produced with.
 *
 * The data room is the one place where the internal scores live (`hit_score`, `specificity`,
 * `independence`, `confidence`), because a reviewer reproducing the work needs them and the
 * methodology note travels with them. Everything else follows the same redaction rules as the
 * packs: natural-person counterparties become a placeholder, IBANs keep four digits, units are
 * named by label or by role.
 *
 * Column order comes from the query, so a re-export of unchanged data produces identical bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { Lang } from './i18n.ts';
import { applyGates, loadArchivedLegalSources, loadGateFindings, type GateStats } from './gates.ts';
import { loadRedactionContext, redactBankRow, redactRecord, type RedactionContext } from './redact.ts';
import { sha256 } from './sections.ts';

export interface DataRoomTableSpec {
  /** file base name, also the ledger name in the manifest */
  name: string;
  sql: string;
  /** `bank` applies the bank-row rules, `record` the generic column rules, `none` exports as read */
  redaction: 'bank' | 'record' | 'none';
  /** also write a JSON copy, for ledgers whose jsonb columns do not fit a CSV cell */
  json?: boolean;
}

/**
 * Every ledger the reviewer needs, in a fixed order. `$1` is the community id; global
 * catalogues (rules, legal sources) ignore it.
 */
export const DATA_ROOM_TABLES: readonly DataRoomTableSpec[] = [
  {
    name: 'files',
    redaction: 'record',
    sql: `select sha256, original_name, batch_label, supplied_by_role, supplied_on, source::text as source,
                 mime, bytes, page_count, status::text as status, hash_verified, transport_note, uploaded_at
            from public.files where community_id = $1 order by batch_label, original_name, sha256`,
  },
  {
    name: 'documents',
    redaction: 'record',
    sql: `select id, doc_type, status::text as status, doc_date, fiscal_year, language, issuer_class::text as issuer_class,
                 obtained_directly, grouping_confidence, grouped_by::text as grouped_by, works_package_id,
                 duplicate_of_document_id, dedupe_key, title
            from public.documents where community_id = $1 order by doc_date, doc_type, id`,
  },
  {
    name: 'invoices',
    redaction: 'record',
    sql: `select i.id, i.document_id, p.display_name as vendor, i.serie, i.numero, i.fecha_expedicion, i.fecha_operacion,
                 i.recipient_nif, i.recipient_matches_community, i.base_imponible, i.iva_total, i.retencion_irpf_pct,
                 i.retencion_irpf_importe, i.suplidos, i.total, i.forma_pago, i.iban_shown_last4, i.es_simplificada,
                 i.es_rectificativa, i.mencion_isp, i.mencion_materiales_40, i.works_package_id, i.category_code,
                 i.arithmetic_ok, i.is_extra
            from public.invoices i left join public.parties p on p.id = i.vendor_party_id
           where i.community_id = $1 order by i.fecha_expedicion, i.numero, i.id`,
  },
  {
    name: 'invoice_lines',
    redaction: 'record',
    sql: `select id, invoice_id, orden, codigo, descripcion, cantidad, unidad, precio_unitario, descuento_pct, base,
                 tipo_iva_pct, cuota_iva, total_linea, es_partida_alzada, is_extra, element_scope, unit_hint, category_code
            from public.invoice_lines where community_id = $1 order by invoice_id, orden`,
  },
  {
    name: 'bank_transactions',
    redaction: 'bank',
    sql: `select t.id, t.bank_account_id, t.statement_id, t.fecha_operacion, t.fecha_valor, t.importe,
                 t.concepto_comun, t.concepto_text, t.counterparty_name_norm, t.counterparty_iban_last4,
                 t.counterparty_iban_hmac, t.ref1, t.ref2, t.saldo_tras, t.tx_kind::text as tx_kind, t.flags,
                 t.unit_id, t.confidence, p.kind::text as counterparty_kind
            from public.bank_transactions t left join public.parties p on p.id = t.counterparty_party_id
           where t.community_id = $1 order by t.fecha_operacion, t.id`,
  },
  {
    name: 'recon_links',
    redaction: 'none',
    sql: `select id, from_type, from_id, to_type, to_id, link_type::text as link_type, method::text as method,
                 score, amount_matched, status::text as status, engine_version
            from public.recon_links where community_id = $1 order by from_type, from_id, to_type, to_id, link_type`,
  },
  {
    name: 'resolutions',
    redaction: 'record',
    sql: `select r.id, m.fecha as meeting_fecha, m.tipo::text as meeting_tipo, r.punto, r.kind::text as kind,
                 r.resultado::text as resultado, r.texto_literal, r.quotas_favor_pct, r.voters_favor, r.voters_total,
                 r.importe_aprobado, r.delegation_to_role, r.delegation_scope, r.delegation_cap, r.cap_explicit,
                 r.challenge_3m_until, r.challenge_12m_until, r.page_no, r.entry_source::text as entry_source
            from public.resolutions r join public.meetings m on m.id = r.meeting_id
           where r.community_id = $1 order by m.fecha, r.punto, r.id`,
  },
  {
    name: 'derrama_ledger',
    redaction: 'record',
    sql: `select dl.id, dl.derrama_id, d.objeto, dl.unit_id, dl.period, dl.expected, dl.paid,
                 dl.basis::text as basis, dl.status::text as status
            from public.derrama_ledger dl join public.derramas d on d.id = dl.derrama_id
           where dl.community_id = $1 order by d.objeto, dl.period, dl.unit_id`,
  },
  {
    name: 'works_events',
    redaction: 'record',
    sql: `select e.id, w.code::text as works_code, w.label as works_label, e.event_type::text as event_type,
                 e.event_date, e.amount, e.seq_ok, e.violation_text, e.suspension_reason::text as suspension_reason,
                 e.engine_version
            from public.works_events e join public.works_packages w on w.id = e.works_package_id
           where e.community_id = $1 order by w.code, e.event_date, e.event_type, e.id`,
  },
  {
    name: 'findings',
    redaction: 'record',
    json: true,
    sql: `select id, fingerprint, event_key, rule_code, rule_version, severity, extraction_quality, specificity,
                 independence, confidence, hit_score, tier::text as tier, status::text as status, entity_type, entity_id,
                 works_package_id, fiscal_year, amount_at_stake, act_date_first, act_date_last, summary_es, summary_en,
                 innocent_explanations, next_check, resolving_document, computed, explanation_requested_on,
                 explanation_received_on, four_eyes_ok, first_seen_run_id, last_seen_run_id
            from public.findings where community_id = $1
           order by coalesce(fiscal_year, 9999), rule_code, fingerprint`,
  },
  {
    name: 'finding_evidence',
    redaction: 'record',
    json: true,
    sql: `select fe.id, fe.finding_id, f.fingerprint, fe.label, fe.document_id, fe.page_id, p.page_no,
                 coalesce(fe.file_sha256, fi.sha256) as file_sha256, fe.crop_status::text as crop_status, fe.quote,
                 fe.run_id, fe.revision_ids, fe.bank_transaction_id, fe.resolution_id, fe.benchmark_record_id,
                 fe.parameter_version, fe.computed
            from public.finding_evidence fe
            join public.findings f on f.id = fe.finding_id
            left join public.pages p on p.id = fe.page_id
            left join public.files fi on fi.id = p.file_id
           where f.community_id = $1 order by f.fingerprint, fe.label, fe.id`,
  },
  {
    name: 'parameters',
    redaction: 'none',
    sql: `select key, value_num, value_text, unit, basis_text, version, valid_from
            from public.parameters where community_id = $1 order by key, version, valid_from`,
  },
  {
    name: 'rules',
    redaction: 'none',
    sql: `select code, family, version, name_es, name_en, description, severity_default, specificity_prior,
                 legal_basis_kind::text as legal_basis_kind, attribution::text as attribution, article_refs,
                 legal_source_ids, enabled_in_v1, worklist_eligible, never_t1t2, milestone
            from public.rules order by code`,
  },
  {
    name: 'benchmark_records',
    redaction: 'none',
    sql: `select id, category_code, source_id, source_ref, unit, region, valid_from, valid_to, price_low, price_median,
                 price_high, vat_included, index_basis, index_ref_date, comparable, hash, superseded_by
            from public.benchmark_records order by category_code, source_id, valid_from, id`,
  },
  {
    name: 'legal_sources',
    redaction: 'none',
    sql: `select id, title, url, storage_path, sha256, archived_at, excerpt from public.legal_sources order by id`,
  },
];

/** The note that travels with the scores, so they are never read as a verdict. */
export const METHODOLOGY_NOTE: Record<Lang, string> = {
  es:
    'Los campos hit_score, specificity, independence y confidence son magnitudes internas de priorización del trabajo de revisión: ' +
    'no se imprimen en ningún informe distribuido y no expresan probabilidad de irregularidad alguna. specificity es un valor a priori del catálogo ' +
    'de reglas; independence puntúa la procedencia de la prueba (1.0 solo para vías directas del emisor); extraction_quality es el límite inferior del ' +
    'intervalo de Wilson de la exactitud empírica de la extracción. Cada punto es una discrepancia a verificar.',
  en:
    'The fields hit_score, specificity, independence and confidence are internal quantities used to prioritise review work: ' +
    'they are printed in no distributed report and express no probability of any irregularity. specificity is a prior from the rule catalogue; ' +
    'independence scores the provenance of the evidence (1.0 only for issuer-direct routes); extraction_quality is the lower bound of the Wilson ' +
    'interval of the empirical extraction accuracy. Every item is a discrepancy to verify.',
};

function csvCell(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Array.isArray(v) || (typeof v === 'object' && v !== null)) s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** RFC 4180 CSV with an explicit column order and `\n` line endings. */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export interface DataRoomFile {
  name: string;
  sha256: string;
  bytes: number;
  rows: number;
  content: Buffer;
}

export interface DataRoomManifest {
  community_id: string;
  generated_on: string;
  finding_run_id: string | null;
  parameters_version: number | null;
  pipeline_version: string | null;
  engine_version: string | null;
  rule_versions: Record<string, number>;
  redaction: string;
  methodology_note: string;
  /** what the distributed packs built from this data included and withheld */
  gates: GateStats;
  files: Array<{ name: string; sha256: string; bytes: number; rows: number }>;
  bundle_sha256: string;
}

export interface DataRoomBundle {
  files: DataRoomFile[];
  manifest: DataRoomManifest;
  manifestJson: string;
  manifestSha256: string;
  /** hash over the file names and hashes only: stable whatever day the export runs */
  bundleSha256: string;
}

const REDACTION_NOTE =
  'Natural-person counterparties are replaced by a placeholder; IBANs keep four digits; pseudonymous HMACs are truncated; ' +
  'units are named by label, and by role where the presidency holds them. Vendor names are kept: they are business data.';

/** Build the whole bundle in memory: every ledger, hashed, plus the manifest. */
export async function buildDataRoom(client: pg.PoolClient, cid: string, today: string, lang: Lang): Promise<DataRoomBundle> {
  const ctx: RedactionContext = await loadRedactionContext(client, cid, lang);
  const files: DataRoomFile[] = [];

  for (const spec of DATA_ROOM_TABLES) {
    // global catalogues carry no community_id, so they take no parameter
    const res = spec.sql.includes('$1') ? await client.query(spec.sql, [cid]) : await client.query(spec.sql);
    const columns = res.fields.map((f) => f.name);
    const raw = res.rows as Array<Record<string, unknown>>;
    let rows: Array<Record<string, unknown>>;
    if (spec.redaction === 'bank') {
      rows = raw.map((r) => {
        const kind = r.counterparty_kind == null ? null : String(r.counterparty_kind);
        const out = redactBankRow(r, ctx, kind);
        delete out.counterparty_kind;
        return out;
      });
    } else if (spec.redaction === 'record') {
      rows = raw.map((r) => redactRecord(r, ctx));
    } else {
      rows = raw;
    }
    // the redactors may rename `unit_id` to `unit_label` and drop helper columns
    const outColumns = columns
      .filter((c) => c !== 'counterparty_kind')
      .map((c) => (c === 'unit_id' && spec.redaction !== 'none' ? 'unit_label' : c));
    const csv = toCsv(outColumns, rows);
    const csvBuf = Buffer.from(csv, 'utf8');
    files.push({ name: `${spec.name}.csv`, sha256: sha256(csvBuf), bytes: csvBuf.length, rows: rows.length, content: csvBuf });
    if (spec.json) {
      const jsonBuf = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8');
      files.push({ name: `${spec.name}.json`, sha256: sha256(jsonBuf), bytes: jsonBuf.length, rows: rows.length, content: jsonBuf });
    }
  }

  const runRes = await client.query<Record<string, unknown>>(
    'select id, pipeline_version, engine_version from public.finding_runs where community_id = $1 order by started_at desc limit 1',
    [cid],
  );
  const run = runRes.rows[0];
  const paramRes = await client.query<{ v: string | null }>(
    'select max(version)::text as v from public.parameters where community_id = $1',
    [cid],
  );
  const rulesRes = await client.query<{ code: string; version: number }>('select code, version from public.rules order by code');
  const ruleVersions: Record<string, number> = {};
  for (const r of rulesRes.rows) ruleVersions[r.code] = Number(r.version);

  const bundleSha256 = sha256(
    [...files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => `${f.name} ${f.sha256}`)
      .join('\n'),
  );

  const gates = applyGates(await loadGateFindings(client, cid), await loadArchivedLegalSources(client), lang).stats;

  const manifest: DataRoomManifest = {
    community_id: cid,
    generated_on: today,
    finding_run_id: run ? String(run.id) : null,
    parameters_version: paramRes.rows[0]?.v == null ? null : Number(paramRes.rows[0].v),
    pipeline_version: run?.pipeline_version == null ? null : String(run.pipeline_version),
    engine_version: run?.engine_version == null ? null : String(run.engine_version),
    rule_versions: ruleVersions,
    redaction: REDACTION_NOTE,
    methodology_note: METHODOLOGY_NOTE[lang],
    gates,
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, rows: f.rows })),
    bundle_sha256: bundleSha256,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return { files, manifest, manifestJson, manifestSha256: sha256(manifestJson), bundleSha256 };
}

/** Write the bundle to disk under `<dir>` and return the absolute paths written. */
export function writeDataRoom(bundle: DataRoomBundle, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of bundle.files) {
    const p = path.join(dir, f.name);
    writeFileSync(p, f.content);
    written.push(p);
  }
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, bundle.manifestJson);
  written.push(manifestPath);
  return written;
}
