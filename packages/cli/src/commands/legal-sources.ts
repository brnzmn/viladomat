/**
 * `vx legal-sources` — the verification register.
 *
 *   vx legal-sources archive --id <id> --file <pdf> --url <url> --title <t> [--excerpt <text>]
 *   vx legal-sources status
 *
 * No pack may cite an article number until the primary text sits archived with its hash
 * (`docs/legal-references.md`, hard gate). `archive` hashes the PDF, stores it under
 * `exports/<community>/legal_sources/<id>.pdf` and stamps `archived_at`; `status` prints every
 * source id referenced by a rule with a yes/no, which is the gate readout the packs act on.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { query, transaction } from '../lib/db.ts';
import { resolveCommunity } from '../lib/community.ts';
import { uploadObject, storageMode } from '../lib/storage.ts';
import { loadLegalSourceRegister } from '../report/gates.ts';

export interface LegalSourcesOptions {
  community?: string;
  id?: string;
  file?: string;
  url?: string;
  title?: string;
  excerpt?: string;
  notes?: string;
}

async function archive(opts: LegalSourcesOptions): Promise<void> {
  if (!opts.id) throw new Error('--id <legal source id> is required, e.g. cccat-553-6');
  if (!opts.file) throw new Error('--file <path to the archived primary text> is required');
  if (!opts.title) throw new Error('--title <title of the primary text> is required');
  const file = path.isAbsolute(opts.file) ? opts.file : path.resolve(process.cwd(), opts.file);
  if (!existsSync(file)) throw new Error(`file not found: ${file}`);
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const community = await resolveCommunity(opts.community);
  const ext = path.extname(file) || '.pdf';
  const key = `${community.id}/legal_sources/${opts.id}${ext}`;
  const uploaded = await uploadObject('exports', key, bytes, ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
  const storagePath = uploaded ? `exports/${key}` : file;

  await transaction(async (client) => {
    await client.query(
      `insert into public.legal_sources (id, title, url, storage_path, sha256, archived_at, excerpt, notes)
       values ($1, $2, $3, $4, $5, now(), $6, $7)
       on conflict (id) do update set
         title = excluded.title,
         url = coalesce(excluded.url, public.legal_sources.url),
         storage_path = excluded.storage_path,
         sha256 = excluded.sha256,
         archived_at = now(),
         excerpt = coalesce(excluded.excerpt, public.legal_sources.excerpt),
         notes = coalesce(excluded.notes, public.legal_sources.notes)`,
      [opts.id, opts.title, opts.url ?? null, storagePath, sha256, opts.excerpt ?? null, opts.notes ?? null],
    );
    await client.query("select public.log_access($1, 'edit', 'legal_source', null, null, $2::jsonb, 'vx legal-sources archive')", [
      community.id,
      JSON.stringify({ id: opts.id, sha256, storage_path: storagePath, url: opts.url ?? null, bytes: statSync(file).size }),
    ]);
  });

  const register = await transaction((client) => loadLegalSourceRegister(client));
  const row = register.find((r) => r.id === opts.id);
  console.log(`archived ${opts.id}`);
  console.log(`  storage: ${storagePath} (${storageMode()})`);
  console.log(`  sha256:  ${sha256}`);
  if (row && row.citedBy.length > 0) console.log(`  unblocks the article citations of: ${row.citedBy.join(', ')}`);
  else console.log('  no rule in the catalogue cites this id yet');
}

async function status(): Promise<void> {
  const register = await transaction((client) => loadLegalSourceRegister(client));
  if (register.length === 0) {
    console.log('no rule references a legal source id');
    return;
  }
  const width = Math.max(...register.map((r) => r.id.length), 6);
  console.log(`${'source'.padEnd(width)}  archived  archived_at  cited by`);
  for (const r of register) {
    console.log(
      `${r.id.padEnd(width)}  ${(r.archived ? 'yes' : 'no').padEnd(8)}  ${(r.archivedAt ?? '—').slice(0, 10).padEnd(11)}  ${r.citedBy.join(', ')}`,
    );
  }
  const missing = register.filter((r) => !r.archived);
  console.log('');
  console.log(`${register.length - missing.length}/${register.length} archived`);
  if (missing.length > 0) {
    console.log(
      `article numbers stay withheld ("referencia normativa pendiente de archivo") for the rules citing: ${missing.map((r) => r.id).join(', ')}`,
    );
  }
}

export async function legalSourcesCommand(action: string, opts: LegalSourcesOptions): Promise<void> {
  if (action === 'archive') return archive(opts);
  if (action === 'status') return status();
  throw new Error(`unknown action "${action}"; expected archive or status`);
}
