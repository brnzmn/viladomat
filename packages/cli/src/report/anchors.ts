/**
 * Chain anchors: a Merkle root over the append-only tables, so that any later change to a row
 * that has already been anchored is detectable without holding a copy of the row.
 *
 * Each leaf is `public.row_hash(t)` — the SHA-256 of the row's canonical JSON, computed in the
 * database — read in primary-key order so the tree is a function of the data alone. The
 * previous anchor's root joins the leaves, which chains the anchors to each other. The root is
 * then a single short string an operator can have timestamped by a qualified TSA or deposited
 * before a notary; the token path comes back with `vx anchors --token`.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { m6Strings, type Lang } from './i18n.ts';

export interface AnchorTableSpec {
  /** name as recorded in `chain_anchors.tables` */
  name: string;
  /** row-hash query in primary-key order; `$1` is the community id */
  sql: string;
}

/**
 * The append-only tables the anchor covers. `finding_reviews` carries no `community_id`, so it
 * is scoped through its finding; `external_checks` is included only when the table exists,
 * which the loader checks before running.
 */
export const ANCHOR_TABLES: readonly AnchorTableSpec[] = [
  { name: 'files', sql: 'select public.row_hash(t) as h from public.files t where t.community_id = $1 order by t.id' },
  { name: 'extraction_runs', sql: 'select public.row_hash(t) as h from public.extraction_runs t where t.community_id = $1 order by t.id' },
  { name: 'field_revisions', sql: 'select public.row_hash(t) as h from public.field_revisions t where t.community_id = $1 order by t.id' },
  { name: 'validator_results', sql: 'select public.row_hash(t) as h from public.validator_results t where t.community_id = $1 order by t.id' },
  {
    name: 'finding_reviews',
    sql: `select public.row_hash(t) as h from public.finding_reviews t
            join public.findings f on f.id = t.finding_id where f.community_id = $1 order by t.id`,
  },
  { name: 'audit_log', sql: 'select public.row_hash(t) as h from public.audit_log t where t.community_id = $1 order by t.id' },
  { name: 'external_checks', sql: 'select public.row_hash(t) as h from public.external_checks t where t.community_id = $1 order by t.id' },
];

const EMPTY_ROOT = createHash('sha256').update('').digest('hex');

function hashPair(a: string, b: string): string {
  return createHash('sha256').update(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');
}

/**
 * Binary Merkle root over hex digests. An odd node is paired with itself, which is the
 * conventional construction; the root of an empty list is the SHA-256 of the empty string.
 */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(hashPair(a, b));
    }
    level = next;
  }
  return level[0]!;
}

export interface AnchorComputation {
  coversUntil: string;
  tables: string[];
  rowCounts: Record<string, number>;
  merkleRoot: string;
  previousRoot: string | null;
  leafCount: number;
}

async function tableExists(client: pg.PoolClient, name: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`public.${name}`]);
  return Boolean(r.rows[0]?.ok);
}

/**
 * Compute the anchor without writing it: the leaves, the counts per table and the root, with
 * the previous anchor's root chained in as the first leaf.
 */
export async function computeAnchor(client: pg.PoolClient, cid: string): Promise<AnchorComputation> {
  const prev = await client.query<{ merkle_root: string; created_at: Date }>(
    'select merkle_root, created_at from public.chain_anchors where community_id = $1 order by created_at desc, id desc limit 1',
    [cid],
  );
  const previousRoot = prev.rows[0]?.merkle_root ?? null;

  const leaves: string[] = [];
  const rowCounts: Record<string, number> = {};
  const tables: string[] = [];
  if (previousRoot) leaves.push(createHash('sha256').update(`previous_root:${previousRoot}`).digest('hex'));

  for (const spec of ANCHOR_TABLES) {
    if (!(await tableExists(client, spec.name))) continue;
    const res = await client.query<{ h: string }>(spec.sql, [cid]);
    tables.push(spec.name);
    rowCounts[spec.name] = res.rows.length;
    // the table name separates the namespaces, so two identical rows in different tables differ
    for (const r of res.rows) leaves.push(createHash('sha256').update(`${spec.name}:${r.h}`).digest('hex'));
  }

  const nowRes = await client.query<{ now: string }>("select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SSZ') as now");
  return {
    coversUntil: nowRes.rows[0]?.now ?? new Date().toISOString(),
    tables,
    rowCounts,
    merkleRoot: merkleRoot(leaves),
    previousRoot,
    leafCount: leaves.length,
  };
}

export interface StoredAnchor extends AnchorComputation {
  id: string;
}

/** Insert the anchor. `chain_anchors` is append-only, so this row is final once written. */
export async function insertAnchor(client: pg.PoolClient, cid: string, a: AnchorComputation): Promise<StoredAnchor> {
  const res = await client.query<{ id: string }>(
    `insert into public.chain_anchors (community_id, covers_until, tables, row_counts, merkle_root, previous_root)
     values ($1, $2::timestamptz, $3::text[], $4::jsonb, $5, $6) returning id`,
    [cid, a.coversUntil, a.tables, JSON.stringify(a.rowCounts), a.merkleRoot, a.previousRoot],
  );
  return { ...a, id: res.rows[0]!.id };
}

/** The operator instruction printed after every anchor. */
export function timestampInstruction(lang: Lang): string {
  return m6Strings(lang).anchorInstruction;
}

export interface TokenAttachment {
  anchorId: string;
  tokenPath: string;
  tokenSha256: string;
  /** true when `chain_anchors.timestamp_token_path` accepted the update */
  storedOnAnchor: boolean;
  note: string | null;
}

/**
 * Record the path of a timestamp token for an anchor.
 *
 * `chain_anchors` is append-only by trigger, so the column cannot be filled after the fact on
 * the current schema. The update is attempted, and when the trigger refuses it the token is
 * recorded in `audit_log` instead — which is itself anchored — and the caller is told, rather
 * than the token being silently dropped.
 */
export async function attachTimestampToken(
  client: pg.PoolClient,
  cid: string,
  anchorId: string,
  tokenPath: string,
  tokenSha256: string,
): Promise<TokenAttachment> {
  let storedOnAnchor = false;
  let note: string | null = null;
  try {
    await client.query('savepoint attach_token');
    await client.query('update public.chain_anchors set timestamp_token_path = $2 where id = $1 and community_id = $3', [
      anchorId,
      tokenPath,
      cid,
    ]);
    await client.query('release savepoint attach_token');
    storedOnAnchor = true;
  } catch (e) {
    await client.query('rollback to savepoint attach_token');
    note =
      'chain_anchors is append-only on this schema, so timestamp_token_path could not be set; ' +
      `the token is recorded in audit_log instead (${e instanceof Error ? e.message : String(e)})`;
  }
  await client.query("select public.log_access($1, 'edit', 'chain_anchor', $2, null, $3::jsonb, 'vx anchors --token')", [
    cid,
    anchorId,
    JSON.stringify({ timestamp_token_path: tokenPath, token_sha256: tokenSha256, stored_on_anchor: storedOnAnchor }),
  ]);
  return { anchorId, tokenPath, tokenSha256, storedOnAnchor, note };
}
