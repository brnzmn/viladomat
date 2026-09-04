/**
 * Claude API client of the extraction module: request builders, synchronous extraction with one
 * repair retry, page classification, Message Batches helpers and cost estimation.
 *
 * Verified API shape (SDK 0.123): `claude-opus-5` extraction, `claude-sonnet-5` classification;
 * adaptive thinking by default (no `thinking` key); no `temperature`, `top_p`, `budget_tokens` or
 * assistant prefill; structured output through `output_config.format` (citations are incompatible
 * and never set); prompt caching on the last system block with a 1-hour TTL.
 *
 * Why `messages.create` + local parse instead of `messages.parse`: the SDK's `parse` throws when
 * the model's JSON fails the Zod schema, which loses the raw `Message`. The raw response has to be
 * stored on `extraction_runs.response_json` and echoed back in the repair turn, so the request is
 * sent with `create` (byte-identical params) and parsed with the same `zodOutputFormat(...).parse`
 * function `parse` uses internally.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  classifierInstruction,
  contextNextLabel,
  contextPrevLabel,
  extractionInstruction,
  pageLabel,
  repairInstruction,
} from './prompts.ts';
import { sanitiseEvidence, type EvidenceItem, type RefinementIssue } from './schemas/common.ts';
import { schemaFor } from './schemas/index.ts';
import { PaginaBatchSchema, type PageClassification } from './schemas/pagina.ts';
import {
  ExtractionInputError,
  type DocType,
  type Language,
  type PageImage,
  type SchemaKey,
} from './types.ts';

type MessageCreateParams = Anthropic.MessageCreateParamsNonStreaming;
type Message = Anthropic.Message;
type ContentBlockParam = Anthropic.ContentBlockParam;
type TextBlockParam = Anthropic.TextBlockParam;
type Usage = Anthropic.Usage;
type MessageBatch = Anthropic.Messages.MessageBatch;
type MessageBatchIndividualResponse = Anthropic.Messages.MessageBatchIndividualResponse;
type BatchCreateParams = Anthropic.Messages.BatchCreateParams;
type JSONOutputFormat = Anthropic.JSONOutputFormat;

export type Effort = NonNullable<Anthropic.OutputConfig['effort']>;
export type CacheTtl = '5m' | '1h';

// ---------------------------------------------------------------------------
// models, limits, pricing
// ---------------------------------------------------------------------------

/** Model ids (exact; see the bundled `claude-api` skill, `shared/models.md`). */
export const MODELS = Object.freeze({
  extraction: 'claude-opus-5',
  classification: 'claude-sonnet-5',
  verification: 'claude-sonnet-5',
} as const);

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** Hard limits of a single request. */
export const LIMITS = Object.freeze({
  maxImagesPerRequest: 20,
  maxImageLongEdgePx: 2576,
});

export const DEFAULTS = Object.freeze({
  extractionMaxTokens: 8000,
  classificationMaxTokens: 4000,
  effort: 'medium' as Effort,
  cacheTtl: '1h' as CacheTtl,
  maxRetries: 6,
  timeoutMs: 600_000,
});

/** USD per million tokens (`shared/models.md`, `model-migration.md`): Opus 5 $5/$25, Sonnet 5 $2/$10. */
export const PRICING_USD_PER_MTOK: Readonly<Record<ModelId, { input: number; output: number }>> =
  Object.freeze({
    'claude-opus-5': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 2, output: 10 },
  });

/** Multipliers on the input price (`shared/prompt-caching.md`, `cost-optimization.md`). */
export const PRICE_MULTIPLIERS = Object.freeze({
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  batch: 0.5,
});

/** Token usage summed over the requests of one extraction. */
export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation_5m_input_tokens: number;
  cache_creation_1h_input_tokens: number;
  requests: number;
}

/** Sum the `usage` blocks of one or more responses. */
export function summariseUsage(usages: ReadonlyArray<Usage | UsageSummary>): UsageSummary {
  const out: UsageSummary = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    requests: 0,
  };
  for (const u of usages) {
    out.input_tokens += u.input_tokens ?? 0;
    out.output_tokens += u.output_tokens ?? 0;
    out.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    out.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    if ('requests' in u) {
      out.cache_creation_5m_input_tokens += u.cache_creation_5m_input_tokens;
      out.cache_creation_1h_input_tokens += u.cache_creation_1h_input_tokens;
      out.requests += u.requests;
    } else {
      const cc = u.cache_creation;
      if (cc) {
        out.cache_creation_5m_input_tokens += cc.ephemeral_5m_input_tokens ?? 0;
        out.cache_creation_1h_input_tokens += cc.ephemeral_1h_input_tokens ?? 0;
      }
      out.requests += 1;
    }
  }
  return out;
}

/** Pricing entry for a model id (dated ids such as `claude-opus-5-2026…` resolve by prefix). */
export function pricingFor(model: string): { id: ModelId; input: number; output: number } {
  const ids = Object.keys(PRICING_USD_PER_MTOK) as ModelId[];
  const id = ids.find((k) => model === k || model.startsWith(`${k}-`));
  if (!id) throw new RangeError(`no pricing for model "${model}"`);
  return { id, ...PRICING_USD_PER_MTOK[id] };
}

/**
 * Estimated cost in USD of a usage block. Cache writes without a TTL breakdown are priced at the
 * 1-hour rate (the TTL this module uses). `batch: true` applies the 50% Batches discount.
 */
export function estimateCostUsd(
  usage: Usage | UsageSummary,
  model: string,
  opts: { batch?: boolean } = {},
): number {
  const p = pricingFor(model);
  const u = 'requests' in usage ? usage : summariseUsage([usage]);
  const known5m = u.cache_creation_5m_input_tokens;
  const known1h = u.cache_creation_1h_input_tokens;
  const unattributed = Math.max(0, u.cache_creation_input_tokens - known5m - known1h);
  const write5m = known5m;
  const write1h = known1h + unattributed;
  const perTok = 1 / 1_000_000;
  let cost =
    u.input_tokens * p.input * perTok +
    u.cache_read_input_tokens * p.input * PRICE_MULTIPLIERS.cacheRead * perTok +
    write5m * p.input * PRICE_MULTIPLIERS.cacheWrite5m * perTok +
    write1h * p.input * PRICE_MULTIPLIERS.cacheWrite1h * perTok +
    u.output_tokens * p.output * perTok;
  if (opts.batch) cost *= PRICE_MULTIPLIERS.batch;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// client interface
// ---------------------------------------------------------------------------

/** Minimal surface of the Anthropic client used here; a fake implementing it can be injected. */
export interface ExtractionClientLike {
  messages: {
    create(params: MessageCreateParams): Promise<Message>;
    parse(params: MessageCreateParams): Promise<Message & { parsed_output: unknown }>;
    batches: {
      create(params: BatchCreateParams): Promise<MessageBatch>;
      retrieve(id: string): Promise<MessageBatch>;
      results(id: string): Promise<AsyncIterable<MessageBatchIndividualResponse>>;
    };
  };
}

/** Thrown by {@link classifyPages} when the classifier refused or returned unusable output. */
export class ExtractionResponseError extends Error {
  override readonly name = 'ExtractionResponseError';
  readonly stopReason: string;
  readonly raw: Message | null;
  constructor(message: string, stopReason: string, raw: Message | null) {
    super(message);
    this.stopReason = stopReason;
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// output format with inlined definitions
// ---------------------------------------------------------------------------

type ParseableFormat = JSONOutputFormat & { parse(content: string): unknown };

function inlineDefs(node: unknown, defs: Record<string, unknown>, depth: number): unknown {
  if (depth > 64) throw new Error('outputFormatFor: schema nesting too deep (recursive $ref?)');
  if (Array.isArray(node)) return node.map((n) => inlineDefs(n, defs, depth + 1));
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj['$ref'] === 'string') {
    const name = obj['$ref'].replace(/^#\/\$defs\//, '');
    const target = defs[name];
    if (target === undefined) throw new Error(`outputFormatFor: unresolved $ref ${obj['$ref']}`);
    const rest = { ...obj };
    delete rest['$ref'];
    const resolved = inlineDefs(target, defs, depth + 1) as Record<string, unknown>;
    return { ...resolved, ...rest };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$defs') continue;
    out[k] = inlineDefs(v, defs, depth + 1);
  }
  return out;
}

/**
 * `zodOutputFormat(schema)` with `$defs` inlined. zod v4 hoists described sub-schemas into `$defs`
 * when `reused: 'ref'` is set; the SDK accepts that, but a flat schema is easier to audit in
 * `request_json` and avoids any grammar-side `$ref` handling. The `parse` function is the SDK's.
 */
export function outputFormatFor(schema: z.ZodType): ParseableFormat {
  const fmt = zodOutputFormat(schema);
  const defs = (fmt.schema['$defs'] as Record<string, unknown> | undefined) ?? {};
  const flat = inlineDefs(fmt.schema, defs, 0) as Record<string, unknown>;
  return { type: 'json_schema', schema: flat, parse: fmt.parse };
}

/** Plain JSON form of an output format (no `parse` function), for batches and `request_json`. */
export function plainFormat(format: JSONOutputFormat): JSONOutputFormat {
  return { type: 'json_schema', schema: format.schema };
}

// ---------------------------------------------------------------------------
// request builders
// ---------------------------------------------------------------------------

export interface ExtractInput {
  docType: DocType | SchemaKey;
  pages: PageImage[];
  language?: Language;
}

export interface BuildOptions {
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  cacheTtl?: CacheTtl;
}

function assertPages(pages: readonly PageImage[], what: string): PageImage[] {
  if (!pages.length) throw new ExtractionInputError(`${what}: no pages`, 'no_pages');
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const seen = new Set<number>();
  for (const p of sorted) {
    if (!Number.isInteger(p.index) || p.index < 0) throw new ExtractionInputError(`${what}: page index ${p.index} is not a non-negative integer`, 'bad_page');
    if (seen.has(p.index)) throw new ExtractionInputError(`${what}: duplicate page index ${p.index}`, 'bad_page');
    seen.add(p.index);
    if (!Buffer.isBuffer(p.jpeg) || p.jpeg.length === 0) throw new ExtractionInputError(`${what}: page ${p.index} has no JPEG bytes`, 'bad_page');
    if (Math.max(p.width, p.height) > LIMITS.maxImageLongEdgePx) {
      throw new ExtractionInputError(`${what}: page ${p.index} long edge ${Math.max(p.width, p.height)} px exceeds ${LIMITS.maxImageLongEdgePx}`, 'image_too_large');
    }
  }
  return sorted;
}

function imageBlock(page: PageImage): ContentBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: page.jpeg.toString('base64') },
  };
}

function labelledPages(pages: readonly PageImage[], label: (i: number) => string): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const p of pages) {
    blocks.push({ type: 'text', text: label(p.index) });
    blocks.push(imageBlock(p));
  }
  return blocks;
}

function systemBlock(text: string, ttl: CacheTtl): TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl } }];
}

export interface BuiltExtraction {
  key: SchemaKey;
  params: MessageCreateParams;
  format: ParseableFormat;
  pageIndexes: Set<number>;
}

/** Build the synchronous extraction request (images first, labelled "Page n:", instruction last). */
export function buildExtractionParams(input: ExtractInput, opts: BuildOptions = {}): BuiltExtraction {
  const { key, schema } = schemaFor(input.docType);
  const pages = assertPages(input.pages, 'extractDocument');
  if (pages.length > LIMITS.maxImagesPerRequest) {
    throw new ExtractionInputError(`extractDocument: ${pages.length} pages exceed the ${LIMITS.maxImagesPerRequest}-image limit; split the document`, 'too_many_images');
  }
  const format = outputFormatFor(schema);
  const content: ContentBlockParam[] = [
    ...labelledPages(pages, pageLabel),
    { type: 'text', text: extractionInstruction(input.docType, key, input.language) },
  ];
  const params: MessageCreateParams = {
    model: opts.model ?? MODELS.extraction,
    max_tokens: opts.maxTokens ?? DEFAULTS.extractionMaxTokens,
    system: systemBlock(EXTRACTION_SYSTEM_PROMPT, opts.cacheTtl ?? DEFAULTS.cacheTtl),
    messages: [{ role: 'user', content }],
    output_config: { effort: opts.effort ?? DEFAULTS.effort, format },
  };
  return { key, params, format, pageIndexes: new Set(pages.map((p) => p.index)) };
}

export interface ClassifyInput {
  thumbs: PageImage[];
  window: { prev: PageImage[]; next: PageImage[] };
}

export interface BuiltClassification {
  params: MessageCreateParams;
  format: ParseableFormat;
  targetIndexes: number[];
  prevIndexes: number[];
  nextIndexes: number[];
}

/**
 * Build the classifier request. Context pages are trimmed (farthest first) so that the whole
 * window fits the 20-image limit; the target pages alone must fit.
 */
export function buildClassifierParams(input: ClassifyInput, opts: BuildOptions = {}): BuiltClassification {
  const thumbs = assertPages(input.thumbs, 'classifyPages');
  if (thumbs.length > LIMITS.maxImagesPerRequest) {
    throw new ExtractionInputError(`classifyPages: ${thumbs.length} target pages exceed the ${LIMITS.maxImagesPerRequest}-image limit`, 'too_many_images');
  }
  let prev = input.window.prev.length ? assertPages(input.window.prev, 'classifyPages.prev') : [];
  let next = input.window.next.length ? assertPages(input.window.next, 'classifyPages.next') : [];
  const budget = LIMITS.maxImagesPerRequest - thumbs.length;
  while (prev.length + next.length > budget) {
    if (next.length >= prev.length && next.length > 0) next = next.slice(0, -1);
    else prev = prev.slice(1);
  }
  const format = outputFormatFor(PaginaBatchSchema);
  const targetIndexes = thumbs.map((p) => p.index);
  const prevIndexes = prev.map((p) => p.index);
  const nextIndexes = next.map((p) => p.index);
  const content: ContentBlockParam[] = [
    ...labelledPages(prev, contextPrevLabel),
    ...labelledPages(thumbs, pageLabel),
    ...labelledPages(next, contextNextLabel),
    { type: 'text', text: classifierInstruction(targetIndexes, prevIndexes, nextIndexes) },
  ];
  const params: MessageCreateParams = {
    model: opts.model ?? MODELS.classification,
    max_tokens: opts.maxTokens ?? DEFAULTS.classificationMaxTokens,
    system: systemBlock(CLASSIFIER_SYSTEM_PROMPT, opts.cacheTtl ?? DEFAULTS.cacheTtl),
    messages: [{ role: 'user', content }],
    output_config: { effort: opts.effort ?? DEFAULTS.effort, format },
  };
  return { params, format, targetIndexes, prevIndexes, nextIndexes };
}

// ---------------------------------------------------------------------------
// request redaction (what is stored on extraction_runs.request_json)
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Copy of the request with every base64 image replaced by `{ sha256, width, height, bytes }` and
 * the output format reduced to its JSON schema. Plain JSON (no functions, no buffers).
 */
export function redactRequest(params: MessageCreateParams, pages: readonly PageImage[] = []): unknown {
  const dims = new Map(pages.map((p) => [p.sha256, p]));
  const redactBlock = (block: ContentBlockParam): unknown => {
    if (block.type === 'image' && block.source.type === 'base64') {
      const bytes = Buffer.from(block.source.data, 'base64');
      const sha256 = sha256Hex(bytes);
      const page = dims.get(sha256);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.media_type,
          sha256,
          width: page?.width ?? null,
          height: page?.height ?? null,
          bytes: bytes.length,
        },
      };
    }
    return block;
  };
  const messages = params.messages.map((m) => ({
    ...m,
    content: typeof m.content === 'string' ? m.content : m.content.map(redactBlock),
  }));
  const output_config = params.output_config
    ? { ...params.output_config, format: params.output_config.format ? plainFormat(params.output_config.format) : null }
    : undefined;
  const redacted: Record<string, unknown> = { ...params, messages };
  if (output_config) redacted['output_config'] = output_config;
  return JSON.parse(JSON.stringify(redacted));
}

// ---------------------------------------------------------------------------
// response interpretation
// ---------------------------------------------------------------------------

function textOf(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

type Interpretation =
  | { kind: 'ok'; parsed: unknown; issues: RefinementIssue[] }
  | { kind: 'refused' }
  | { kind: 'truncated' }
  | { kind: 'parse_failed'; error: string; text: string };

function hasEvidenceArray(v: unknown): v is { evidence: EvidenceItem[] } {
  return typeof v === 'object' && v !== null && Array.isArray((v as { evidence?: unknown }).evidence);
}

function interpret(message: Message, format: ParseableFormat, pageIndexes: ReadonlySet<number> | null): Interpretation {
  if (message.stop_reason === 'refusal') return { kind: 'refused' };
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'truncated' };
  }
  const text = textOf(message);
  if (!text.trim()) return { kind: 'parse_failed', error: 'response has no text block', text };
  try {
    const parsed = format.parse(text);
    const issues = hasEvidenceArray(parsed) ? sanitiseEvidence(parsed.evidence, pageIndexes) : [];
    return { kind: 'ok', parsed, issues };
  } catch (err) {
    return { kind: 'parse_failed', error: err instanceof Error ? err.message : String(err), text };
  }
}

/** Params of the single repair turn: the failed output as an assistant turn, then the repair request. */
export function buildRepairParams(params: MessageCreateParams, failed: Message, parseError: string): MessageCreateParams {
  const failedText = textOf(failed);
  const extra: Anthropic.MessageParam[] = [];
  if (failedText.trim()) extra.push({ role: 'assistant', content: [{ type: 'text', text: failedText }] });
  extra.push({ role: 'user', content: [{ type: 'text', text: repairInstruction(parseError) }] });
  return { ...params, messages: [...params.messages, ...extra] };
}

// ---------------------------------------------------------------------------
// extractDocument
// ---------------------------------------------------------------------------

export interface ExtractOptions extends BuildOptions {
  client: ExtractionClientLike;
  /** Attempt one repair turn when the output does not parse (default true). */
  repair?: boolean;
}

export interface ExtractDocumentResult<T = unknown> {
  parsed: T | null;
  /** Final response (the repair response when a repair ran). */
  raw: Message;
  /** Every response in order. */
  responses: Message[];
  usage: UsageSummary;
  /** Model requested. */
  model: string;
  /** Model reported by the API on the final response. */
  servedModel: string;
  promptVersion: string;
  schemaVersion: string;
  schemaKey: SchemaKey;
  stopReason: string;
  requestJson: unknown;
  repairRequestJson: unknown | null;
  refused: boolean;
  repaired: boolean;
  attempts: number;
  parseError: string | null;
  refinementIssues: RefinementIssue[];
  costUsd: number;
}

/** `public.run_status` value for a result. */
export function runStatusOf(result: Pick<ExtractDocumentResult, 'refused' | 'parsed'>): 'succeeded' | 'refused' | 'parse_failed' {
  if (result.refused) return 'refused';
  return result.parsed === null ? 'parse_failed' : 'succeeded';
}

/**
 * Extract one document synchronously. Refusals return `refused: true` with `parsed: null` (the
 * caller re-submits once with Sonnet); truncation returns `parsed: null` with
 * `stopReason: 'max_tokens'`; unparseable output triggers one repair turn.
 */
export async function extractDocument<T = unknown>(input: ExtractInput, opts: ExtractOptions): Promise<ExtractDocumentResult<T>> {
  const built = buildExtractionParams(input, opts);
  const requestJson = redactRequest(built.params, input.pages);
  const responses: Message[] = [];
  const first = await opts.client.messages.create(built.params);
  responses.push(first);
  let outcome = interpret(first, built.format, built.pageIndexes);
  let repairRequestJson: unknown | null = null;
  let repaired = false;
  if (outcome.kind === 'parse_failed' && opts.repair !== false) {
    const repairParams = buildRepairParams(built.params, first, outcome.error);
    repairRequestJson = redactRequest(repairParams, input.pages);
    const second = await opts.client.messages.create(repairParams);
    responses.push(second);
    outcome = interpret(second, built.format, built.pageIndexes);
    repaired = outcome.kind === 'ok';
  }
  const last = responses[responses.length - 1] as Message;
  const usage = summariseUsage(responses.map((r) => r.usage));
  return {
    parsed: outcome.kind === 'ok' ? (outcome.parsed as T) : null,
    raw: last,
    responses,
    usage,
    model: built.params.model,
    servedModel: last.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    schemaKey: built.key,
    stopReason: last.stop_reason ?? 'unknown',
    requestJson,
    repairRequestJson,
    refused: outcome.kind === 'refused',
    repaired,
    attempts: responses.length,
    parseError:
      outcome.kind === 'parse_failed' ? outcome.error : outcome.kind === 'truncated' ? `output truncated (${last.stop_reason})` : null,
    refinementIssues: outcome.kind === 'ok' ? outcome.issues : [],
    costUsd: estimateCostUsd(usage, built.params.model),
  };
}

// ---------------------------------------------------------------------------
// classifyPages
// ---------------------------------------------------------------------------

export interface ClassifyOptions extends BuildOptions {
  client: ExtractionClientLike;
  repair?: boolean;
}

export interface ClassifyPagesResult {
  pages: PageClassification[];
  /** Target indexes the model did not return (filled with fallback entries in `pages`). */
  missing: number[];
  raw: Message;
  responses: Message[];
  usage: UsageSummary;
  model: string;
  servedModel: string;
  promptVersion: string;
  schemaVersion: string;
  stopReason: string;
  requestJson: unknown;
  refused: boolean;
  repaired: boolean;
  attempts: number;
  parseError: string | null;
  costUsd: number;
}

function fallbackClassification(index: number, reason: string): PageClassification {
  return {
    page_index: index,
    doc_type: 'otro',
    page_role: 'single',
    issuer_name_hint: null,
    doc_number_hint: null,
    date_hint: null,
    page_marker: null,
    language: 'unknown',
    legibility: 0,
    is_handwritten_mostly: false,
    continues_previous: false,
    continues_previous_confidence: 0,
    reason,
  };
}

const clamp01 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Classify pages and return the full envelope (usage, raw response, request). */
export async function classifyPagesDetailed(input: ClassifyInput, opts: ClassifyOptions): Promise<ClassifyPagesResult> {
  const built = buildClassifierParams(input, opts);
  const requestJson = redactRequest(built.params, [...input.thumbs, ...input.window.prev, ...input.window.next]);
  const responses: Message[] = [];
  const first = await opts.client.messages.create(built.params);
  responses.push(first);
  let outcome = interpret(first, built.format, null);
  let repaired = false;
  if (outcome.kind === 'parse_failed' && opts.repair !== false) {
    const second = await opts.client.messages.create(buildRepairParams(built.params, first, outcome.error));
    responses.push(second);
    outcome = interpret(second, built.format, null);
    repaired = outcome.kind === 'ok';
  }
  const last = responses[responses.length - 1] as Message;
  const byIndex = new Map<number, PageClassification>();
  if (outcome.kind === 'ok') {
    for (const entry of (outcome.parsed as { pages: PageClassification[] }).pages) {
      if (!byIndex.has(entry.page_index)) {
        byIndex.set(entry.page_index, {
          ...entry,
          legibility: clamp01(entry.legibility),
          continues_previous_confidence: clamp01(entry.continues_previous_confidence),
        });
      }
    }
  }
  const missing: number[] = [];
  const failReason =
    outcome.kind === 'refused' ? 'classifier refused the request' : outcome.kind === 'truncated' ? 'classifier output truncated' : outcome.kind === 'parse_failed' ? 'classifier output did not parse' : 'classifier returned no entry for this page';
  const pages = built.targetIndexes.map((i) => {
    const found = byIndex.get(i);
    if (found) return found;
    missing.push(i);
    return fallbackClassification(i, failReason);
  });
  const usage = summariseUsage(responses.map((r) => r.usage));
  return {
    pages,
    missing,
    raw: last,
    responses,
    usage,
    model: built.params.model,
    servedModel: last.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    stopReason: last.stop_reason ?? 'unknown',
    requestJson,
    refused: outcome.kind === 'refused',
    repaired,
    attempts: responses.length,
    parseError: outcome.kind === 'parse_failed' ? outcome.error : outcome.kind === 'truncated' ? 'output truncated at max_tokens' : null,
    costUsd: estimateCostUsd(usage, built.params.model),
  };
}

/**
 * Classify pages (contract of `docs/interfaces.md`): one entry per thumbnail, in thumbnail order.
 * Throws {@link ExtractionResponseError} when the classifier refused or its output was unusable.
 */
export async function classifyPages(input: ClassifyInput, opts: ClassifyOptions): Promise<PageClassification[]> {
  const r = await classifyPagesDetailed(input, opts);
  if (r.refused) throw new ExtractionResponseError('classifier refused the request', r.stopReason, r.raw);
  if (r.parseError) throw new ExtractionResponseError(`classifier output unusable: ${r.parseError}`, r.stopReason, r.raw);
  return r.pages;
}

// ---------------------------------------------------------------------------
// batches
// ---------------------------------------------------------------------------

export const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** `d_<12 hex of sha256(documentId)>_<schema_version>`. */
export function batchCustomId(documentId: string, schemaVersion: string = SCHEMA_VERSION): string {
  const id = `d_${sha256Hex(Buffer.from(documentId, 'utf8')).slice(0, 12)}_${schemaVersion}`;
  if (!CUSTOM_ID_RE.test(id)) throw new RangeError(`custom_id "${id}" does not match ${CUSTOM_ID_RE}`);
  return id;
}

/** Split a custom id back into its parts, or null when it is not one of ours. */
export function parseCustomId(customId: string): { hash12: string; schemaVersion: string } | null {
  const m = /^d_([0-9a-f]{12})_([A-Za-z0-9-]+)$/.exec(customId);
  return m ? { hash12: m[1] as string, schemaVersion: m[2] as string } : null;
}

export interface BatchRequestInput extends ExtractInput {
  documentId: string;
}

export interface BatchRequest {
  custom_id: string;
  params: MessageCreateParams;
}

/** Same params as the synchronous request, plain JSON output format, keyed by custom id. */
export function buildBatchRequest(input: BatchRequestInput, opts: BuildOptions = {}): BatchRequest {
  const built = buildExtractionParams(input, opts);
  const params: MessageCreateParams = {
    ...built.params,
    output_config: { ...built.params.output_config, format: plainFormat(built.format) },
  };
  return { custom_id: batchCustomId(input.documentId), params };
}

/** Submit requests as one Message Batch. */
export function submitBatch(requests: readonly BatchRequest[], client: ExtractionClientLike): Promise<MessageBatch> {
  return client.messages.batches.create({ requests: requests.map((r) => ({ custom_id: r.custom_id, params: r.params })) });
}

/** Collect every individual result of an ended batch. */
export async function readBatchResults(batchId: string, client: ExtractionClientLike): Promise<MessageBatchIndividualResponse[]> {
  const out: MessageBatchIndividualResponse[] = [];
  for await (const r of await client.messages.batches.results(batchId)) out.push(r);
  return out;
}

export type BatchOutcome<T = unknown> =
  | {
      status: 'succeeded';
      custom_id: string;
      parsed: T | null;
      raw: Message;
      usage: UsageSummary;
      model: string;
      stopReason: string;
      refused: boolean;
      parseError: string | null;
      refinementIssues: RefinementIssue[];
      costUsd: number;
    }
  | { status: 'errored'; custom_id: string; error: unknown; retryable: boolean }
  | { status: 'expired'; custom_id: string }
  | { status: 'canceled'; custom_id: string };

/**
 * Interpret one batch result against a schema (key, document type or Zod schema). A refusal or an
 * unparseable output is reported, not repaired: the caller re-submits synchronously.
 */
export function parseBatchResult<T = unknown>(
  result: MessageBatchIndividualResponse,
  schema: SchemaKey | DocType | z.ZodType,
): BatchOutcome<T> {
  const custom_id = result.custom_id;
  const r = result.result;
  switch (r.type) {
    case 'expired':
      return { status: 'expired', custom_id };
    case 'canceled':
      return { status: 'canceled', custom_id };
    case 'errored': {
      const type = r.error?.error?.type;
      return { status: 'errored', custom_id, error: r.error, retryable: type !== 'invalid_request_error' };
    }
    case 'succeeded': {
      const zodSchema = typeof schema === 'string' ? schemaFor(schema).schema : schema;
      const format = outputFormatFor(zodSchema);
      const message = r.message;
      const outcome = interpret(message, format, null);
      const usage = summariseUsage([message.usage]);
      return {
        status: 'succeeded',
        custom_id,
        parsed: outcome.kind === 'ok' ? (outcome.parsed as T) : null,
        raw: message,
        usage,
        model: message.model,
        stopReason: message.stop_reason ?? 'unknown',
        refused: outcome.kind === 'refused',
        parseError:
          outcome.kind === 'parse_failed' ? outcome.error : outcome.kind === 'truncated' ? 'output truncated at max_tokens' : null,
        refinementIssues: outcome.kind === 'ok' ? outcome.issues : [],
        costUsd: estimateCostUsd(usage, message.model, { batch: true }),
      };
    }
    default:
      return { status: 'errored', custom_id, error: r, retryable: false };
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export interface CreateExtractionClientOptions {
  apiKey?: string;
  baseURL?: string;
  /** Injected client (tests); when given, no `Anthropic` instance is created. */
  client?: ExtractionClientLike;
  maxRetries?: number;
  timeout?: number;
}

export interface ExtractionClient {
  raw: ExtractionClientLike;
  extractDocument<T = unknown>(input: ExtractInput, opts?: Omit<ExtractOptions, 'client'>): Promise<ExtractDocumentResult<T>>;
  classifyPages(input: ClassifyInput, opts?: Omit<ClassifyOptions, 'client'>): Promise<PageClassification[]>;
  classifyPagesDetailed(input: ClassifyInput, opts?: Omit<ClassifyOptions, 'client'>): Promise<ClassifyPagesResult>;
  buildBatchRequest(input: BatchRequestInput, opts?: BuildOptions): BatchRequest;
  submitBatch(requests: readonly BatchRequest[]): Promise<MessageBatch>;
  readBatchResults(batchId: string): Promise<MessageBatchIndividualResponse[]>;
  parseBatchResult<T = unknown>(result: MessageBatchIndividualResponse, schema: SchemaKey | DocType | z.ZodType): BatchOutcome<T>;
}

/**
 * Create the extraction client. Without `apiKey`/`baseURL` the SDK resolves credentials from the
 * environment (`ANTHROPIC_API_KEY`). `maxRetries` 6 and a 10-minute timeout suit long vision
 * requests.
 */
export function createExtractionClient(options: CreateExtractionClientOptions = {}): ExtractionClient {
  const raw: ExtractionClientLike =
    options.client ??
    new Anthropic({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      timeout: options.timeout ?? DEFAULTS.timeoutMs,
    });
  return {
    raw,
    extractDocument: (input, opts = {}) => extractDocument(input, { ...opts, client: raw }),
    classifyPages: (input, opts = {}) => classifyPages(input, { ...opts, client: raw }),
    classifyPagesDetailed: (input, opts = {}) => classifyPagesDetailed(input, { ...opts, client: raw }),
    buildBatchRequest,
    submitBatch: (requests) => submitBatch(requests, raw),
    readBatchResults: (batchId) => readBatchResults(batchId, raw),
    parseBatchResult,
  };
}
