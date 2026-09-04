/**
 * Persistence for external checks.
 *
 * `public.external_checks` is append-only (`forbid_change` on UPDATE and DELETE): a re-run never
 * overwrites an earlier answer, it adds a row. That is what lets a pack say "as published on
 * <date>" and lets a later reader see that the register said something different before.
 *
 * Large payloads (Cadastre building listings, long BORME timelines) are archived in the
 * `exports` bucket instead of being stored inline; the row then carries the storage path and a
 * short stub, so `raw_response` stays readable in the database.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { putObject } from '../lib/storage.ts';
import { LARGE_RAW_BYTES } from './config.ts';
import type { CheckResult, CheckSubject } from './types.ts';

/** A pg client or pool: the vendor code only ever runs parameterised queries. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface PersistedCheck {
  id: string;
  checkType: string;
  status: string;
  storagePath: string | null;
  fetchedAt: string;
}

function checksKey(cid: string, checkId: string, ext: string): string {
  return `${cid}/checks/${checkId}.${ext}`;
}

/**
 * Append one `external_checks` row for a completed check. Returns the new row.
 *
 * The row id is generated here so a large payload can be archived under the id it belongs to
 * before the insert, keeping the storage key and the row in step.
 */
export async function persistCheck(
  client: Queryable,
  cid: string,
  subject: CheckSubject,
  result: CheckResult,
  opts: { checkedBy?: string | null; archiveLarge?: boolean } = {},
): Promise<PersistedCheck> {
  const id = randomUUID();
  const rawJson = JSON.stringify(result.raw ?? null);
  let storagePath: string | null = null;
  let stored: unknown = result.raw ?? null;

  if ((opts.archiveLarge ?? true) && rawJson.length > LARGE_RAW_BYTES) {
    const key = checksKey(cid, id, 'json');
    await putObject('exports', key, Buffer.from(rawJson, 'utf8'), 'application/json');
    storagePath = `exports/${key}`;
    stored = { archived: true, storage_path: storagePath, bytes: rawJson.length };
  }

  const res = await client.query(
    `insert into public.external_checks
       (id, community_id, check_type, subject_type, subject_key, source_url, request, raw_response,
        evidence_storage_path, normalised, status, cost_cents, checked_by)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12,$13)
     returning id, check_type, status, evidence_storage_path, fetched_at::text as fetched_at`,
    [
      id,
      cid,
      result.type,
      subject.subjectType,
      subject.subjectKey,
      result.source_url,
      JSON.stringify(result.request ?? {}),
      JSON.stringify(stored),
      storagePath,
      JSON.stringify(result.normalised ?? {}),
      result.status,
      result.cost_cents,
      opts.checkedBy ?? null,
    ],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return {
    id: String(row?.id ?? id),
    checkType: String(row?.check_type ?? result.type),
    status: String(row?.status ?? result.status),
    storagePath: (row?.evidence_storage_path as string | null) ?? storagePath,
    fetchedAt: String(row?.fetched_at ?? ''),
  };
}

/**
 * Latest `ok` response of a check type for a subject, when it is younger than `maxAgeDays`.
 * Used by the surname-frequency check: the statistical table changes once a year at most.
 */
export async function cachedNormalised(
  client: Queryable,
  cid: string,
  checkType: string,
  subjectKey: string,
  maxAgeDays: number,
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `select normalised from public.external_checks
      where community_id = $1 and check_type = $2 and subject_key = $3 and status = 'ok'
        and fetched_at > now() - ($4 || ' days')::interval
      order by fetched_at desc limit 1`,
    [cid, checkType, subjectKey, String(maxAgeDays)],
  );
  const row = res.rows[0] as { normalised?: Record<string, unknown> } | undefined;
  return row?.normalised ?? null;
}

/** Every check ever recorded for a subject key, newest first. */
export async function checkHistory(
  client: Queryable,
  cid: string,
  subjectKey: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await client.query(
    `select id, check_type, status, source_url, normalised, evidence_storage_path,
            fetched_at::text as fetched_at, cost_cents
       from public.external_checks
      where community_id = $1 and subject_key = $2
      order by fetched_at desc`,
    [cid, subjectKey],
  );
  return res.rows as Array<Record<string, unknown>>;
}

/**
 * The most recent check of each type for each subject key. This is what the rules read: a
 * re-run appends, so "current" means "latest row", never "the row was changed".
 */
export async function latestChecks(
  client: Queryable,
  cid: string,
  checkTypes?: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const res = await client.query(
    `select distinct on (check_type, subject_key)
            id, check_type, subject_type, subject_key, status, source_url, normalised,
            evidence_storage_path, fetched_at::text as fetched_at
       from public.external_checks
      where community_id = $1
        and ($2::text[] is null or check_type = any($2::text[]))
      order by check_type, subject_key, fetched_at desc`,
    [cid, checkTypes && checkTypes.length > 0 ? checkTypes : null],
  );
  return res.rows as Array<Record<string, unknown>>;
}

export interface EvidenceUpload {
  /** The manual check the evidence answers. */
  checkId: string;
  bytes: Buffer;
  /** Extension without the dot, taken from the uploaded file. */
  ext: string;
  contentType: string;
  note?: string | null;
}

/**
 * Store the evidence a reviewer captured for a manual check and record the completion.
 *
 * Because `external_checks` is append-only, "setting the status to ok" is done by appending a
 * completion row that carries the same check type and subject, the storage path of the evidence
 * and, in `request`, the id of the `manual_pending` row it answers. Both rows stay visible, so
 * the date the check was raised and the date it was satisfied are both on the record.
 */
export async function attachEvidence(
  client: Queryable,
  cid: string,
  upload: EvidenceUpload,
  opts: { checkedBy?: string | null } = {},
): Promise<PersistedCheck> {
  const pending = await client.query(
    `select id, check_type, subject_type, subject_key, source_url, request, normalised, status, cost_cents
       from public.external_checks where id = $1 and community_id = $2`,
    [upload.checkId, cid],
  );
  const row = pending.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`external check ${upload.checkId} not found in this community`);

  const key = checksKey(cid, upload.checkId, upload.ext.replace(/^\./, ''));
  await putObject('exports', key, upload.bytes, upload.contentType);
  const storagePath = `exports/${key}`;

  const normalised = {
    ...((row.normalised as Record<string, unknown> | null) ?? {}),
    evidence_uploaded: true,
    evidence_bytes: upload.bytes.length,
    evidence_note: upload.note ?? null,
    answers_check_id: upload.checkId,
  };
  const res = await client.query(
    `insert into public.external_checks
       (community_id, check_type, subject_type, subject_key, source_url, request, raw_response,
        evidence_storage_path, normalised, status, cost_cents, checked_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,'ok',$10,$11)
     returning id, check_type, status, evidence_storage_path, fetched_at::text as fetched_at`,
    [
      cid,
      String(row.check_type),
      String(row.subject_type ?? 'party'),
      String(row.subject_key ?? ''),
      (row.source_url as string | null) ?? null,
      JSON.stringify({ answers_check_id: upload.checkId, uploaded_ext: upload.ext }),
      JSON.stringify({ evidence_storage_path: storagePath }),
      storagePath,
      JSON.stringify(normalised),
      Number(row.cost_cents ?? 0),
      opts.checkedBy ?? null,
    ],
  );
  const out = res.rows[0] as Record<string, unknown>;
  return {
    id: String(out.id),
    checkType: String(out.check_type),
    status: String(out.status),
    storagePath,
    fetchedAt: String(out.fetched_at ?? ''),
  };
}
