import type { Enums, Json } from '@/lib/database.types';
import type { ServerClient } from '@/lib/supabase/server';

/**
 * Appends an audit_log row through the security-definer RPC. The actor is the caller's auth uid;
 * the RPC refuses callers who are not members of the community.
 */
export async function logAccess(
  supabase: ServerClient,
  cid: string,
  act: Enums<'audit_action'>,
  entityType: string | null,
  entityId: string | null,
  before: Json | null,
  after: Json | null,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('log_access', {
    cid,
    act,
    etype: entityType,
    eid: entityId,
    before_j: before,
    after_j: after,
    why: reason,
  });
  if (error) throw new Error(`audit log: ${error.message}`);
}

/** Strips undefined values so a row can be stored as JSON in the audit log. */
export function asJson(value: unknown): Json | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}
