import { query } from './db.ts';

export interface Community {
  id: string;
  name: string;
  nif: string | null;
  fy_start_month: number;
  ordinary_budget_default: string | null;
}

/** Resolve the working community: explicit id, else the only one in the database. */
export async function resolveCommunity(id?: string): Promise<Community> {
  if (id) {
    const rows = await query<Community>('select id, name, nif, fy_start_month, ordinary_budget_default from public.communities where id = $1', [id]);
    const c = rows[0];
    if (!c) throw new Error(`community ${id} not found`);
    return c;
  }
  const rows = await query<Community>('select id, name, nif, fy_start_month, ordinary_budget_default from public.communities order by created_at');
  if (rows.length === 1 && rows[0]) return rows[0];
  if (rows.length === 0) throw new Error('no community yet: run `vx seed <file>` first');
  throw new Error(`several communities exist; pass --community <id>:\n${rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')}`);
}
