import { query } from '../lib/db.ts';

/**
 * Record counsel's (or the reviewer's) sign-off on a pack before it is distributed. The gate is
 * social, not technical: the export row carries who approved and when, and the audit log keeps it.
 */
export async function signoffCommand(opts: { report: string; role: string; note?: string }): Promise<void> {
  const rows = await query<{ id: string; community_id: string; kind: string; reproduced_ok: boolean | null; approved_at: string | null }>(
    'select id, community_id, kind, reproduced_ok, approved_at from public.report_exports where id = $1',
    [opts.report],
  );
  const r = rows[0];
  if (!r) throw new Error(`report export ${opts.report} not found`);
  if (r.approved_at) throw new Error(`report ${r.id} was already signed off on ${r.approved_at}`);
  if (r.reproduced_ok !== true) {
    throw new Error(`report ${r.id} has not been reproduced successfully (run: vx report --reproduce ${r.id}) — sign-off refused`);
  }
  await query('update public.report_exports set approved_by_role = $2, approved_at = now(), approved_note = $3 where id = $1', [r.id, opts.role, opts.note ?? null]);
  await query("select public.log_access($1, 'status_change', 'report_export', $2, null, $3::jsonb, 'vx sign-off')", [
    r.community_id, r.id, JSON.stringify({ approved_by_role: opts.role, note: opts.note ?? null }),
  ]);
  console.log(`report ${r.id} (${r.kind}) signed off by role "${opts.role}"`);
}
