/**
 * `vx anchors` — write a Merkle root over the append-only tables, and record the timestamp
 * token an operator obtained for a previous root.
 *
 *   vx anchors                          compute and store a new anchor, print the root
 *   vx anchors --dry-run                compute and print, store nothing
 *   vx anchors --list                   the anchors on record
 *   vx anchors --token <id> --file <p>  record the timestamp token obtained for anchor <id>
 *
 * The root is what an operator hands to a qualified trust service provider (RFC 3161) or
 * deposits before a notary; the instruction is printed after every run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { query, transaction } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { uploadObject } from '../lib/storage.ts';
import { attachTimestampToken, computeAnchor, insertAnchor, timestampInstruction } from '../report/anchors.ts';
import type { Lang } from '../report/i18n.ts';

export interface AnchorsOptions {
  community?: string;
  lang?: string;
  dryRun?: boolean;
  list?: boolean;
  /** anchor id whose timestamp token is being recorded */
  token?: string;
  /** path to the token file (`.tsr`, notarial receipt, …) */
  file?: string;
}

export async function anchorsCommand(opts: AnchorsOptions): Promise<void> {
  const lang: Lang = opts.lang === 'en' ? 'en' : 'es';
  const community = await resolveCommunity(opts.community);

  if (opts.list) {
    const rows = await query<Record<string, unknown>>(
      `select id, covers_until, merkle_root, previous_root, row_counts, timestamp_token_path, created_at
         from public.chain_anchors where community_id = $1 order by created_at`,
      [community.id],
    );
    if (rows.length === 0) {
      console.log('no anchors yet');
      return;
    }
    for (const r of rows) {
      const counts = r.row_counts as Record<string, number> | null;
      const total = counts ? Object.values(counts).reduce((a, b) => a + Number(b), 0) : 0;
      const covers = r.covers_until instanceof Date ? r.covers_until.toISOString() : String(r.covers_until);
      console.log(
        `${String(r.id).slice(0, 8)}  ${covers.slice(0, 19)}Z  ${String(r.merkle_root).slice(0, 32)}…  rows ${total}  ${r.timestamp_token_path ? `token ${String(r.timestamp_token_path)}` : 'no token on the row'}`,
      );
    }
    return;
  }

  if (opts.token) {
    if (!opts.file) throw new Error('--token requires --file <path to the timestamp token>');
    const file = path.isAbsolute(opts.file) ? opts.file : path.resolve(process.cwd(), opts.file);
    if (!existsSync(file)) throw new Error(`token file not found: ${file}`);
    const bytes = readFileSync(file);
    const tokenSha = createHash('sha256').update(bytes).digest('hex');
    const key = `${community.id}/anchors/${opts.token}${path.extname(file) || '.tsr'}`;
    await uploadObject('exports', key, bytes, 'application/timestamp-reply');
    const attached = await transaction((client) => attachTimestampToken(client, community.id, opts.token!, key, tokenSha));
    console.log(`token stored: exports/${key}`);
    console.log(`token sha256: ${tokenSha}`);
    if (attached.storedOnAnchor) console.log(`chain_anchors.timestamp_token_path set on ${opts.token}`);
    else console.log(`recorded in audit_log for ${opts.token}: ${attached.note ?? 'anchor row is immutable'}`);
    return;
  }

  const computed = await transaction(async (client) => {
    const a = await computeAnchor(client, community.id);
    if (opts.dryRun) return { ...a, id: null as string | null };
    const stored = await insertAnchor(client, community.id, a);
    await client.query("select public.log_access($1, 'export', 'chain_anchor', $2, null, $3::jsonb, 'vx anchors')", [
      community.id,
      stored.id,
      JSON.stringify({ merkle_root: stored.merkleRoot, tables: stored.tables, row_counts: stored.rowCounts, leaves: stored.leafCount }),
    ]);
    return { ...stored, id: stored.id as string | null };
  });

  console.log(`anchor ${computed.id ?? '(dry run)'} covers until ${computed.coversUntil}`);
  console.log(`merkle root: ${computed.merkleRoot}`);
  if (computed.previousRoot) console.log(`previous root: ${computed.previousRoot}`);
  console.log(`tables: ${computed.tables.join(', ')}`);
  console.log(`rows: ${Object.entries(computed.rowCounts).map(([k, v]) => `${k}=${v}`).join(' ')} (leaves ${computed.leafCount})`);
  console.log('');
  console.log(timestampInstruction(lang));
}
