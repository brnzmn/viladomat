/** Result shape returned by every server action used with `ActionForm`. */
export type ActionResult = { ok: boolean; message: string };

export type ActionFn = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

export const ok = (message: string): ActionResult => ({ ok: true, message });
export const fail = (message: string): ActionResult => ({ ok: false, message });
