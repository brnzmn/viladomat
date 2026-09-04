import pg from 'pg';
import { env } from './env.ts';

const { Pool } = pg;

// Keep DATE columns as ISO strings (no timezone shifts, stable rendering); numerics stay strings.
pg.types.setTypeParser(1082, (v: string) => v);

let pool: pg.Pool | undefined;

/** Direct Postgres access (DATABASE_URL: local test server or the Supabase pooler). */
export function db(): pg.Pool {
  if (!pool) {
    const url = env('DATABASE_URL');
    pool = new Pool({
      connectionString: url,
      max: 4,
      ssl: url.includes('supabase.co') || url.includes('pooler.supabase.com') ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Row = Record<string, unknown>;

export async function query<T extends object = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query(text, params);
  return res.rows as unknown as T[];
}

export async function one<T extends object = Row>(text: string, params: unknown[] = []): Promise<T> {
  const rows = await query<T>(text, params);
  const first = rows[0];
  if (!first) throw new Error(`query returned no rows: ${text.slice(0, 80)}`);
  return first;
}

export async function maybeOne<T extends object = Row>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Run a function inside a transaction with a dedicated client. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
