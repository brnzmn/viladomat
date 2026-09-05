import { query } from './db.ts';

export interface Community {
  id: string;
  name: string;
  nif: string | null;
  /** Postal address of the building as seeded; the Cadastre street lookup is derived from it. */
  address: string | null;
  /** Cadastral reference of the building (14 characters) or of one unit (20), as seeded. */
  catastro_rc: string | null;
  building_year: number | null;
  fy_start_month: number;
  ordinary_budget_default: string | null;
}

const COMMUNITY_COLUMNS =
  'id, name, nif, address, catastro_rc, building_year, fy_start_month, ordinary_budget_default';

/** Resolve the working community: explicit id, else the only one in the database. */
export async function resolveCommunity(id?: string): Promise<Community> {
  if (id) {
    const rows = await query<Community>(
      `select ${COMMUNITY_COLUMNS} from public.communities where id = $1`,
      [id],
    );
    const c = rows[0];
    if (!c) throw new Error(`community ${id} not found`);
    return c;
  }
  const rows = await query<Community>(
    `select ${COMMUNITY_COLUMNS} from public.communities order by created_at`,
  );
  if (rows.length === 1 && rows[0]) return rows[0];
  if (rows.length === 0) throw new Error('no community yet: run `vx seed <file>` first');
  throw new Error(
    `several communities exist; pass --community <id>:\n${rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')}`,
  );
}
