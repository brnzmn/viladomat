/**
 * Shared types for the vendor due-diligence checks (M5).
 *
 * A check is a small, reproducible lookup against one public source. Every check returns the
 * same shape and every run appends one `external_checks` row with the request, the raw response
 * and the moment it was fetched, so a figure printed in a pack can be traced to the exact
 * response it came from. Nothing here decides anything about a person: a check reports what a
 * register says on a date, and the absence of an entry is stated as non-exculpatory.
 *
 * All network access goes through {@link CheckContext.fetch} so tests run on recorded fixtures
 * and never touch the network.
 */

/** Minimal response surface used by the checks (structurally satisfied by the global `Response`). */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Minimal request options used by the checks (structurally accepted by the global `fetch`). */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Injectable `fetch`. The global `fetch` is assignable to it; tests pass a fixture player. */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** Status of a check, mirroring `public.external_checks.status`. */
export type CheckStatus = 'ok' | 'not_found' | 'error' | 'manual_pending';

/**
 * What a check is about. Mirrors `public.external_checks.subject_type` (free text in the schema).
 *
 * For `party` the subject key is the party's uuid, so a corrected identifier does not orphan the
 * earlier rows; for `surname` and `address` it is the normalised value, because those checks are
 * about reference data shared by several parties; for `source` it is the id of the public source a
 * probe verified.
 */
export type SubjectType =
  | 'party'
  | 'community'
  | 'unit'
  | 'works_package'
  | 'surname'
  | 'address'
  /** A probe of a public source (`vendors/sources.ts`); the subject key is the source id. */
  | 'source';

/** The subject of a check: a vendor, the community itself, a unit or a works package. */
export interface CheckSubject {
  subjectType: SubjectType;
  /** Stable key stored on the row: NIF when there is one, else the normalised name or address. */
  subjectKey: string;
  partyId?: string | null;
  name?: string | null;
  nif?: string | null;
  address?: string | null;
  postcode?: string | null;
  municipality?: string | null;
  province?: string | null;
  iban?: string | null;
  /** Free-form input for checks that need more than the fields above (e.g. a surname). */
  extra?: Record<string, unknown>;
}

/** What a reviewer must obtain by hand for a manual check. */
export interface ManualInstruction {
  /** Exact page to open. */
  url: string;
  /** Evidence to capture and upload with `vx vendors evidence`. */
  evidence: string[];
  /** What the reviewer types into the form. */
  query?: string;
  /** Cost of the document, in cents, when the source charges for it. */
  costCents?: number;
  note?: string;
}

/** Uniform result of a check. `normalised` is what the rules read; `raw` is what came back. */
export interface CheckResult {
  type: string;
  status: CheckStatus;
  normalised: Record<string, unknown>;
  raw: unknown;
  source_url: string | null;
  cost_cents: number;
  /** Request parameters, stored so the lookup can be repeated verbatim. */
  request?: Record<string, unknown>;
  /** Present on manual checks: what the reviewer has to do. */
  manual?: ManualInstruction;
  /** Human-readable note printed by the CLI (fallback routes, caveats). */
  note?: string;
}

/** Everything a check needs from its caller. */
export interface CheckContext {
  cid: string;
  fetch: FetchLike;
  /**
   * Transport that presents the operator's client certificate (mutual TLS), for the sources that
   * only answer to an identified caller (AEAT VNifV2). Absent when no certificate is configured;
   * a certificate-gated check then falls back to its manual route instead of calling out. Built
   * by `vendors/transport/mtls.ts` from `VX_CLIENT_CERT_P12`; only ever set on the operator's
   * machine, never in a hosted function.
   */
  certFetch?: FetchLike;
  /** Per-request timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Wall clock, injectable so tests are deterministic. */
  now?: () => Date;
  /** Awaited before every outbound request of a source; defaults to the shared rate limiters. */
  rateLimit?: (source: string) => Promise<void>;
  /**
   * Cache lookup for checks that may reuse a recent response (surname frequencies).
   * Returns the normalised payload of a previous `ok` row, or null.
   */
  cacheLookup?: (
    type: string,
    subjectKey: string,
    maxAgeDays: number,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Whether the register (`public.registry_sources`) marks a source as verified by a probe from
   * the operator's machine. Set by the check runner (`withSourceGate` in `vendors/sources.ts`);
   * absent in a bare context, which the gated checks read as "not verified". Checks that refuse to
   * call out until their source is verified (`rasic`, `rea`) ask it through
   * {@link sourceVerifiedIn}.
   */
  sourceVerified?: (sourceId: string) => boolean;
}

/**
 * Whether the runner has marked a source verified in the register. A context without the member
 * — a test harness, a probe run — answers false, so a gated check never calls out by default.
 */
export function sourceVerifiedIn(ctx: CheckContext, sourceId: string): boolean {
  return typeof ctx.sourceVerified === 'function' && ctx.sourceVerified(sourceId) === true;
}

/** One check module. `manual: true` means the reviewer fetches it and uploads the evidence. */
export interface VendorCheck {
  type: string;
  label: string;
  manual: boolean;
  /** Which source register this check reads (used for rate limiting and for the docs table). */
  source: string;
  run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult>;
}

/** Ten seconds, as agreed for every outbound registry request. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export function nowOf(ctx: CheckContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

/** Build an `error` result without throwing, so one failing source never aborts a run. */
export function errorResult(
  type: string,
  url: string | null,
  err: unknown,
  request?: Record<string, unknown>,
): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    type,
    status: 'error',
    normalised: { error: message },
    raw: { error: message },
    source_url: url,
    cost_cents: 0,
    ...(request ? { request } : {}),
  };
}
