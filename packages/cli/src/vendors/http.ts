/**
 * Outbound HTTP for the vendor checks: one shared rate limiter per source and a hard timeout on
 * every request.
 *
 * The checks never call `fetch` directly — they call {@link fetchJson} (JSON endpoints) or
 * {@link fetchText} (SOAP envelopes, HTML forms) with the source id, so a limit is impossible to
 * forget and a test can replace the transport wholesale. Neither function retries: a check that
 * fails is recorded as `error` and re-run later.
 */
import { parseAmountEs } from '@viladomat/core';
import {
  DEFAULT_TIMEOUT_MS,
  type CheckContext,
  type FetchLike,
  type HttpRequestInit,
} from './types.ts';
import { SOURCES, type SourceId } from './config.ts';

/** A minimum-interval limiter: `take()` resolves no sooner than 60s/perMinute after the last one. */
export class RateLimiter {
  private nextAt = 0;
  readonly intervalMs: number;

  constructor(
    perMinute: number,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.intervalMs = perMinute > 0 ? Math.ceil(60_000 / perMinute) : 0;
  }

  async take(now: number = Date.now()): Promise<void> {
    if (this.intervalMs === 0) return;
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
    if (wait > 0) await this.sleep(wait);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const limiters = new Map<string, RateLimiter>();

/** Shared limiter for a source, created from its configured rate on first use. */
export function limiterFor(source: string): RateLimiter {
  let l = limiters.get(source);
  if (!l) {
    const cfg = (SOURCES as Record<string, { perMinute: number } | undefined>)[source];
    l = new RateLimiter(cfg?.perMinute ?? 60);
    limiters.set(source, l);
  }
  return l;
}

/** Drop every shared limiter (tests, and a long-running worker between runs). */
export function resetRateLimiters(): void {
  limiters.clear();
}

/** Build a query string, skipping null/undefined values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${url}${bodySnippet ? `: ${bodySnippet.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

/** Options shared by {@link fetchJson} and {@link fetchText}. */
export interface FetchOptionsBase extends HttpRequestInit {
  /** Source id, used for the rate limiter. */
  source: SourceId | string;
  /** Accept these statuses as an answer instead of throwing (404 for "not found", 500 for a SOAP fault). */
  allowStatus?: readonly number[];
  /**
   * Transport to use instead of `ctx.fetch`. Certificate-gated checks pass `ctx.certFetch` here;
   * the limiter and the timeout apply exactly as they do to the default transport.
   */
  fetch?: FetchLike;
}

export type FetchJsonOptions = FetchOptionsBase;

export interface FetchJsonResult<T = unknown> {
  status: number;
  url: string;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  json: T | null;
  /** Raw body text, kept when parsing failed so the row still records what came back. */
  text: string;
}

export type FetchTextOptions = FetchOptionsBase;

export interface FetchTextResult {
  status: number;
  url: string;
  /** Body as received (SOAP envelope, HTML page); the caller parses it. */
  text: string;
}

/**
 * The preamble every outbound request shares: await the source's rate limiter, then run the
 * request under the context timeout (10 s by default). The abort signal is handed to the
 * transport; the timer is cleared however the request ends.
 */
async function guarded<T>(
  ctx: CheckContext,
  source: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const limit = ctx.rateLimit ?? ((s: string) => limiterFor(s).take());
  await limit(source);

  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET/POST a JSON endpoint through `ctx.fetch`, after the source's rate limiter and under a
 * 10-second timeout. Never retries: a check that fails is recorded as `error` and re-run later.
 */
export async function fetchJson<T = unknown>(
  ctx: CheckContext,
  url: string,
  opts: FetchJsonOptions,
): Promise<FetchJsonResult<T>> {
  const { status, text } = await fetchText(ctx, url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
  });
  let json: T | null = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
  }
  return { status, url, json, text };
}

/**
 * GET/POST an endpoint that answers with text (a SOAP envelope, an HTML result page) through
 * `ctx.fetch` — or through `opts.fetch` when the source needs the certificate transport — after
 * the source's rate limiter and under the context timeout. Throws {@link HttpError} on a status
 * that is neither 2xx nor listed in `allowStatus`; never retries.
 */
export async function fetchText(
  ctx: CheckContext,
  url: string,
  opts: FetchTextOptions,
): Promise<FetchTextResult> {
  const transport = opts.fetch ?? ctx.fetch;
  return guarded(ctx, opts.source, async (signal) => {
    const res = await transport(url, {
      method: opts.method ?? 'GET',
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.body === undefined ? {} : { body: opts.body }),
      signal,
    });
    const text = await res.text();
    const allowed = opts.allowStatus ?? [];
    if (!res.ok && !allowed.includes(res.status)) throw new HttpError(res.status, url, text);
    return { status: res.status, url, text };
  });
}

/** Read a nested value by path, tolerating missing links. */
export function pick(obj: unknown, ...path: readonly (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/**
 * First defined value among several candidate keys of an object. Used because the field names of
 * the unverified sources are guesses: the parser accepts every plausible spelling and reports
 * "not read" when none matches.
 */
export function firstOf(obj: unknown, keys: readonly string[]): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * A number from a response field. Strings go through the core amount parser, which handles both
 * Spanish (`3.000,00`) and international (`30000.00`) notation; the registers use both.
 */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseAmountEs(v);
  return null;
}

/** ISO date (YYYY-MM-DD) from the usual Spanish/ISO spellings, or null. */
export function asIsoDate(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const es = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s.trim());
  if (es) return `${es[3]}-${String(es[2]).padStart(2, '0')}-${String(es[1]).padStart(2, '0')}`;
  return null;
}

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}
