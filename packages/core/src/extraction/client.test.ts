import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { facturaFixture, paginaFixture } from './__fixtures__/documents.ts';
import {
  CUSTOM_ID_RE,
  DEFAULTS,
  LIMITS,
  MODELS,
  batchCustomId,
  buildBatchRequest,
  buildClassifierParams,
  buildExtractionParams,
  buildRepairParams,
  classifyPages,
  classifyPagesDetailed,
  createExtractionClient,
  estimateCostUsd,
  extractDocument,
  outputFormatFor,
  parseBatchResult,
  parseCustomId,
  readBatchResults,
  redactRequest,
  runStatusOf,
  submitBatch,
  summariseUsage,
  ExtractionResponseError,
  type ExtractionClientLike,
} from './client.ts';
import { EXTRACTION_SYSTEM_PROMPT, CLASSIFIER_SYSTEM_PROMPT, PROMPT_VERSION, SCHEMA_VERSION } from './prompts.ts';
import { SCHEMAS } from './schemas/index.ts';
import { ExtractionInputError, type PageImage } from './types.ts';

type Message = Anthropic.Message;
type Params = Anthropic.MessageCreateParamsNonStreaming;
type BatchResponse = Anthropic.Messages.MessageBatchIndividualResponse;

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** A tiny valid JPEG-ish buffer (content is irrelevant; only bytes and hash matter). */
function page(index: number, width = 1200, height = 1568): PageImage {
  const jpeg = Buffer.from(`fake-jpeg-${index}-${width}x${height}`);
  return { index, jpeg, width, height, sha256: createHash('sha256').update(jpeg).digest('hex') };
}

function fakeMessage(opts: {
  text?: string;
  stopReason?: Message['stop_reason'];
  model?: string;
  usage?: Partial<Message['usage']>;
}): Message {
  const content: Message['content'] = opts.text === undefined ? [] : [{ type: 'text', text: opts.text, citations: null }];
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5',
    content,
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: opts.stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: null } : null,
    container: null,
    usage: {
      input_tokens: 5000,
      output_tokens: 1500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      ...opts.usage,
    },
  } as Message;
}

interface FakeClient extends ExtractionClientLike {
  calls: Params[];
  batchCalls: unknown[];
}

function fakeClient(responses: Message[], batchResults: BatchResponse[] = []): FakeClient {
  const queue = [...responses];
  const calls: Params[] = [];
  const batchCalls: unknown[] = [];
  const create = async (params: Params): Promise<Message> => {
    calls.push(params);
    const next = queue.shift();
    if (!next) throw new Error('fake client: no more canned responses');
    return next;
  };
  return {
    calls,
    batchCalls,
    messages: {
      create,
      parse: async (params) => ({ ...(await create(params)), parsed_output: null }),
      batches: {
        create: async (params) => {
          batchCalls.push(params);
          return {
            id: 'msgbatch_test',
            type: 'message_batch',
            processing_status: 'in_progress',
            request_counts: { processing: params.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
            created_at: '2026-09-04T00:00:00Z',
            expires_at: '2026-09-05T00:00:00Z',
            ended_at: null,
            archived_at: null,
            cancel_initiated_at: null,
            results_url: null,
          };
        },
        retrieve: async (id) => ({
          id,
          type: 'message_batch',
          processing_status: 'ended',
          request_counts: { processing: 0, succeeded: batchResults.length, errored: 0, canceled: 0, expired: 0 },
          created_at: '2026-09-04T00:00:00Z',
          expires_at: '2026-09-05T00:00:00Z',
          ended_at: '2026-09-04T01:00:00Z',
          archived_at: null,
          cancel_initiated_at: null,
          results_url: 'https://example.invalid/results',
        }),
        results: async () => (async function* () {
          for (const r of batchResults) yield r;
        })(),
      },
    },
  };
}

const VALID_JSON = JSON.stringify(facturaFixture);
const input = { docType: 'factura' as const, pages: [page(0), page(1)], language: 'ca' as const };

// ---------------------------------------------------------------------------
// request shape
// ---------------------------------------------------------------------------

describe('buildExtractionParams', () => {
  const { params, key, format } = buildExtractionParams(input);

  it('uses the verified request shape', () => {
    expect(key).toBe('factura');
    expect(params.model).toBe(MODELS.extraction);
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(DEFAULTS.extractionMaxTokens);
    expect(params.output_config?.effort).toBe('medium');
    expect(params.output_config?.format?.type).toBe('json_schema');
    expect(params.output_config?.format).toBe(format);
    expect((params.output_config?.format?.schema as Record<string, unknown>)['additionalProperties']).toBe(false);
    // never sent
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('stream');
    expect(JSON.stringify(params)).not.toContain('citations');
    expect(JSON.stringify(params)).not.toContain('budget_tokens');
  });

  it('caches the last system block with a 1-hour TTL', () => {
    const system = params.system as Anthropic.TextBlockParam[];
    expect(Array.isArray(system)).toBe(true);
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system.at(-1)?.text).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(buildExtractionParams(input, { cacheTtl: '5m' }).params.system).toEqual([
      { type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '5m' } },
    ]);
  });

  it('puts labelled images first and the instruction last, in a single user turn', () => {
    expect(params.messages).toHaveLength(1);
    const msg = params.messages[0] as Anthropic.MessageParam;
    expect(msg.role).toBe('user');
    const content = msg.content as Anthropic.ContentBlockParam[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect((content[0] as Anthropic.TextBlockParam).text).toBe('Page 0:');
    expect((content[2] as Anthropic.TextBlockParam).text).toBe('Page 1:');
    const img = content[1] as Anthropic.ImageBlockParam;
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: page(0).jpeg.toString('base64') });
    const last = content.at(-1) as Anthropic.TextBlockParam;
    expect(last.text).toContain('Expected document type: factura');
    expect(last.text).toContain('Expected language of the printed text: ca');
    // pages are sorted by index even when given out of order
    const reversed = buildExtractionParams({ docType: 'factura', pages: [page(1), page(0)] });
    const c2 = (reversed.params.messages[0] as Anthropic.MessageParam).content as Anthropic.TextBlockParam[];
    expect(c2[0]?.text).toBe('Page 0:');
  });

  it('enforces the image limits and page sanity', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => page(i));
    expect(() => buildExtractionParams({ docType: 'acta', pages: twenty })).not.toThrow();
    expect(() => buildExtractionParams({ docType: 'acta', pages: [...twenty, page(20)] })).toThrow(ExtractionInputError);
    try {
      buildExtractionParams({ docType: 'acta', pages: [...twenty, page(20)] });
    } catch (e) {
      expect((e as ExtractionInputError).code).toBe('too_many_images');
    }
    expect(() => buildExtractionParams({ docType: 'acta', pages: [page(0, 2577, 1000)] })).toThrow(/2576/);
    expect(() => buildExtractionParams({ docType: 'acta', pages: [page(0, 1000, LIMITS.maxImageLongEdgePx)] })).not.toThrow();
    expect(() => buildExtractionParams({ docType: 'acta', pages: [] })).toThrow(/no pages/);
    expect(() => buildExtractionParams({ docType: 'acta', pages: [page(0), page(0)] })).toThrow(/duplicate/);
    expect(() => buildExtractionParams({ docType: 'albaran', pages: [page(0)] })).toThrow(/no extraction schema/);
  });
});

describe('redactRequest', () => {
  it('replaces image bytes with sha256/width/height/bytes and strips the parse function', () => {
    const { params } = buildExtractionParams(input);
    const json = redactRequest(params, input.pages) as {
      messages: { content: Array<Record<string, unknown>> }[];
      output_config: { format: Record<string, unknown> };
      system: Array<Record<string, unknown>>;
    };
    const blocks = json.messages[0]?.content ?? [];
    const image = blocks[1] as { source: Record<string, unknown> };
    expect(image.source['sha256']).toBe(page(0).sha256);
    expect(image.source['width']).toBe(1200);
    expect(image.source['height']).toBe(1568);
    expect(image.source['bytes']).toBe(page(0).jpeg.length);
    expect(image.source).not.toHaveProperty('data');
    expect(JSON.stringify(json)).not.toContain(page(0).jpeg.toString('base64'));
    expect(json.output_config.format['type']).toBe('json_schema');
    expect(json.output_config.format).not.toHaveProperty('parse');
    expect(json.system[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

// ---------------------------------------------------------------------------
// extractDocument
// ---------------------------------------------------------------------------

describe('extractDocument', () => {
  it('returns the parsed document on success', async () => {
    const client = fakeClient([fakeMessage({ text: VALID_JSON })]);
    const r = await extractDocument(input, { client });
    expect(r.parsed).toEqual(facturaFixture);
    expect(r.attempts).toBe(1);
    expect(r.repaired).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.parseError).toBeNull();
    expect(r.stopReason).toBe('end_turn');
    expect(r.model).toBe('claude-opus-5');
    expect(r.promptVersion).toBe(PROMPT_VERSION);
    expect(r.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.schemaKey).toBe('factura');
    expect(r.usage.requests).toBe(1);
    expect(r.usage.input_tokens).toBe(5000);
    expect(r.usage.cache_creation_1h_input_tokens).toBe(2000);
    expect(r.costUsd).toBeCloseTo(5000 * 5e-6 + 2000 * 5e-6 * 2 + 1500 * 25e-6, 6);
    expect(r.requestJson).toBeTruthy();
    expect(r.repairRequestJson).toBeNull();
    expect(r.refinementIssues).toEqual([]);
    expect(runStatusOf(r)).toBe('succeeded');
    expect(client.calls).toHaveLength(1);
  });

  it('repairs once when the output does not match the schema', async () => {
    const client = fakeClient([fakeMessage({ text: '{"doc_type_confirmed":"factura","numero":42}' }), fakeMessage({ text: VALID_JSON })]);
    const r = await extractDocument(input, { client });
    expect(r.parsed).toEqual(facturaFixture);
    expect(r.attempts).toBe(2);
    expect(r.repaired).toBe(true);
    expect(r.usage.requests).toBe(2);
    expect(r.usage.input_tokens).toBe(10000);
    expect(r.repairRequestJson).toBeTruthy();
    const repair = client.calls[1] as Params;
    expect(repair.messages).toHaveLength(3);
    expect(repair.messages[1]?.role).toBe('assistant');
    expect((repair.messages[1]?.content as Anthropic.TextBlockParam[])[0]?.text).toContain('"numero":42');
    // never ends in an assistant turn (no prefill); the repair request names the validation error
    expect(repair.messages.at(-1)?.role).toBe('user');
    const repairText = (repair.messages.at(-1)?.content as Anthropic.TextBlockParam[])[0]?.text ?? '';
    expect(repairText).toContain('not a valid JSON object');
    expect(repairText).toMatch(/Failed to parse structured output/);
    // same system, model and output format as the first request
    expect(repair.system).toEqual(client.calls[0]?.system);
    expect(repair.output_config).toBe(client.calls[0]?.output_config);
  });

  it('gives up after one failed repair', async () => {
    const client = fakeClient([fakeMessage({ text: 'not json' }), fakeMessage({ text: '{"still": "wrong"}' })]);
    const r = await extractDocument(input, { client });
    expect(r.parsed).toBeNull();
    expect(r.attempts).toBe(2);
    expect(r.repaired).toBe(false);
    expect(r.parseError).toMatch(/Failed to parse structured output/);
    expect(runStatusOf(r)).toBe('parse_failed');
    expect(client.calls).toHaveLength(2);
  });

  it('does not repair when disabled', async () => {
    const client = fakeClient([fakeMessage({ text: 'not json' })]);
    const r = await extractDocument(input, { client, repair: false });
    expect(r.parsed).toBeNull();
    expect(r.attempts).toBe(1);
  });

  it('returns a refused result without retrying', async () => {
    const client = fakeClient([fakeMessage({ stopReason: 'refusal' })]);
    const r = await extractDocument(input, { client });
    expect(r.refused).toBe(true);
    expect(r.parsed).toBeNull();
    expect(r.stopReason).toBe('refusal');
    expect(r.attempts).toBe(1);
    expect(runStatusOf(r)).toBe('refused');
    // the caller re-submits with Sonnet
    const sonnet = fakeClient([fakeMessage({ text: VALID_JSON, model: 'claude-sonnet-5' })]);
    const r2 = await extractDocument(input, { client: sonnet, model: MODELS.verification });
    expect(sonnet.calls[0]?.model).toBe('claude-sonnet-5');
    expect(r2.model).toBe('claude-sonnet-5');
    expect(r2.parsed).not.toBeNull();
  });

  it('reports truncation at max_tokens without a repair turn', async () => {
    const client = fakeClient([fakeMessage({ text: VALID_JSON.slice(0, 200), stopReason: 'max_tokens' })]);
    const r = await extractDocument(input, { client, maxTokens: 500 });
    expect(r.parsed).toBeNull();
    expect(r.stopReason).toBe('max_tokens');
    expect(r.parseError).toMatch(/truncated/);
    expect(r.attempts).toBe(1);
    expect(client.calls[0]?.max_tokens).toBe(500);
  });

  it('sanitises evidence (bad bbox → null, confidence clamped, unknown page flagged)', async () => {
    const doc = structuredClone(facturaFixture);
    doc.evidence.push({ field_path: 'suplidos', page_index: 5, bbox: [1, 2, 3], quote: '0', confidence: 2 });
    const client = fakeClient([fakeMessage({ text: JSON.stringify(doc) })]);
    const r = await extractDocument<typeof doc>(input, { client });
    const last = r.parsed?.evidence.at(-1);
    expect(last?.bbox).toBeNull();
    expect(last?.confidence).toBe(1);
    expect(r.refinementIssues.map((i) => i.path)).toEqual([
      `evidence[${doc.evidence.length - 1}].bbox`,
      `evidence[${doc.evidence.length - 1}].confidence`,
      `evidence[${doc.evidence.length - 1}].page_index`,
    ]);
  });

  it('buildRepairParams skips an empty assistant turn', () => {
    const { params } = buildExtractionParams(input);
    const repaired = buildRepairParams(params, fakeMessage({ text: '   ' }), 'boom');
    expect(repaired.messages).toHaveLength(2);
    expect(repaired.messages.at(-1)?.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// classifier
// ---------------------------------------------------------------------------

describe('classifyPages', () => {
  const thumbs = [page(3, 768, 600), page(4, 768, 600)];
  const window = { prev: [page(1, 768, 600), page(2, 768, 600)], next: [page(5, 768, 600)] };

  it('builds a Sonnet request with the sliding-window labels', () => {
    const built = buildClassifierParams({ thumbs, window });
    expect(built.params.model).toBe('claude-sonnet-5');
    expect(built.params.max_tokens).toBe(DEFAULTS.classificationMaxTokens);
    expect((built.params.system as Anthropic.TextBlockParam[])[0]?.text).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect((built.params.system as Anthropic.TextBlockParam[])[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const content = (built.params.messages[0] as Anthropic.MessageParam).content as Anthropic.ContentBlockParam[];
    const labels = content.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map((b) => b.text);
    expect(labels.slice(0, 5)).toEqual(['Context (previous) page 1:', 'Context (previous) page 2:', 'Page 3:', 'Page 4:', 'Context (next) page 5:']);
    expect(labels.at(-1)).toContain('n in [3, 4]');
    expect(content.filter((b) => b.type === 'image')).toHaveLength(5);
    expect(built.params).not.toHaveProperty('temperature');
  });

  it('trims context pages to stay within 20 images, farthest first', () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => page(from + i, 768, 600));
    const built = buildClassifierParams({ thumbs: many(10, 12), window: { prev: many(5, 5), next: many(22, 5) } });
    expect(built.prevIndexes).toEqual([6, 7, 8, 9]);
    expect(built.nextIndexes).toEqual([22, 23, 24, 25]);
    const content = (built.params.messages[0] as Anthropic.MessageParam).content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(20);
    expect(() => buildClassifierParams({ thumbs: many(0, 21), window: { prev: [], next: [] } })).toThrow(ExtractionInputError);
  });

  it('returns one classification per thumbnail, in order, filling gaps', async () => {
    const client = fakeClient([fakeMessage({ text: JSON.stringify(paginaFixture), model: 'claude-sonnet-5' })]);
    const pages = await classifyPages({ thumbs, window }, { client });
    expect(pages.map((p) => p.page_index)).toEqual([3, 4]);
    expect(pages[0]?.doc_type).toBe('factura');
    expect(pages[1]?.continues_previous).toBe(true);

    const partial = fakeClient([fakeMessage({ text: JSON.stringify({ pages: [paginaFixture.pages[0]] }), model: 'claude-sonnet-5' })]);
    const detailed = await classifyPagesDetailed({ thumbs, window }, { client: partial });
    expect(detailed.missing).toEqual([4]);
    expect(detailed.pages[1]?.doc_type).toBe('otro');
    expect(detailed.pages[1]?.reason).toMatch(/no entry/);
    expect(detailed.model).toBe('claude-sonnet-5');
    expect(detailed.costUsd).toBeCloseTo(5000 * 2e-6 + 2000 * 2e-6 * 2 + 1500 * 10e-6, 6);
  });

  it('throws on refusal or unusable output (detailed variant reports instead)', async () => {
    await expect(classifyPages({ thumbs, window }, { client: fakeClient([fakeMessage({ stopReason: 'refusal' })]) })).rejects.toBeInstanceOf(ExtractionResponseError);
    const detailed = await classifyPagesDetailed({ thumbs, window }, { client: fakeClient([fakeMessage({ stopReason: 'refusal' })]) });
    expect(detailed.refused).toBe(true);
    expect(detailed.pages).toHaveLength(2);
    expect(detailed.pages.every((p) => p.reason.includes('refused'))).toBe(true);
    const bad = fakeClient([fakeMessage({ text: 'nope' }), fakeMessage({ text: 'still nope' })]);
    await expect(classifyPages({ thumbs, window }, { client: bad })).rejects.toThrow(/unusable/);
    expect(bad.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// batches
// ---------------------------------------------------------------------------

describe('batches', () => {
  const documentId = '4c1b3a3e-1a2b-4c5d-8e9f-0123456789ab';

  it('builds a custom id from the sha256 of the document id and the schema version', () => {
    const id = batchCustomId(documentId);
    expect(id).toMatch(CUSTOM_ID_RE);
    expect(id).toMatch(/^d_[0-9a-f]{12}_s1$/);
    expect(id).toBe(`d_${createHash('sha256').update(documentId).digest('hex').slice(0, 12)}_${SCHEMA_VERSION}`);
    expect(batchCustomId(documentId)).toBe(id);
    expect(batchCustomId('other')).not.toBe(id);
    expect(parseCustomId(id)).toEqual({ hash12: id.slice(2, 14), schemaVersion: 's1' });
    expect(parseCustomId('request-1')).toBeNull();
  });

  it('builds batch requests with the same params and a plain JSON output format', () => {
    const req = buildBatchRequest({ ...input, documentId });
    expect(req.custom_id).toBe(batchCustomId(documentId));
    const sync = buildExtractionParams(input).params;
    expect(req.params.model).toBe(sync.model);
    expect(req.params.system).toEqual(sync.system);
    expect(req.params.messages).toEqual(sync.messages);
    expect(req.params.output_config?.effort).toBe('medium');
    expect(req.params.output_config?.format).toEqual({ type: 'json_schema', schema: outputFormatFor(SCHEMAS.factura).schema });
    expect(req.params.output_config?.format).not.toHaveProperty('parse');
    expect(req.params).not.toHaveProperty('fallbacks');
    expect(JSON.parse(JSON.stringify(req)).params.output_config.format.schema.type).toBe('object');
  });

  it('submits and reads results through the injected client', async () => {
    const succeeded: BatchResponse = { custom_id: batchCustomId(documentId), result: { type: 'succeeded', message: fakeMessage({ text: VALID_JSON }) } };
    const client = fakeClient([], [succeeded]);
    const batch = await submitBatch([buildBatchRequest({ ...input, documentId })], client);
    expect(batch.id).toBe('msgbatch_test');
    expect((client.batchCalls[0] as { requests: unknown[] }).requests).toHaveLength(1);
    const results = await readBatchResults(batch.id, client);
    expect(results).toHaveLength(1);
    const outcome = parseBatchResult(results[0] as BatchResponse, 'factura');
    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      expect(outcome.parsed).toEqual(facturaFixture);
      expect(outcome.refused).toBe(false);
      expect(outcome.costUsd).toBeCloseTo((5000 * 5e-6 + 2000 * 5e-6 * 2 + 1500 * 25e-6) / 2, 6);
    }
  });

  it('interprets every result type', () => {
    const id = batchCustomId(documentId);
    const expired = parseBatchResult({ custom_id: id, result: { type: 'expired' } }, 'factura');
    expect(expired).toEqual({ status: 'expired', custom_id: id });
    const canceled = parseBatchResult({ custom_id: id, result: { type: 'canceled' } }, 'factura');
    expect(canceled.status).toBe('canceled');
    const invalid = parseBatchResult(
      { custom_id: id, result: { type: 'errored', error: { type: 'error', request_id: null, error: { type: 'invalid_request_error', message: 'bad' } } } },
      'factura',
    );
    expect(invalid.status).toBe('errored');
    if (invalid.status === 'errored') expect(invalid.retryable).toBe(false);
    const overloaded = parseBatchResult(
      { custom_id: id, result: { type: 'errored', error: { type: 'error', request_id: null, error: { type: 'overloaded_error', message: 'busy' } } } },
      SCHEMAS.factura,
    );
    if (overloaded.status === 'errored') expect(overloaded.retryable).toBe(true);
    const refused = parseBatchResult({ custom_id: id, result: { type: 'succeeded', message: fakeMessage({ stopReason: 'refusal' }) } }, 'factura_rectificativa');
    if (refused.status === 'succeeded') {
      expect(refused.refused).toBe(true);
      expect(refused.parsed).toBeNull();
    }
    const unparseable = parseBatchResult({ custom_id: id, result: { type: 'succeeded', message: fakeMessage({ text: '{}' }) } }, SCHEMAS.factura);
    if (unparseable.status === 'succeeded') {
      expect(unparseable.parsed).toBeNull();
      expect(unparseable.parseError).toMatch(/Failed to parse/);
    }
  });
});

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------

describe('estimateCostUsd', () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0, cache_creation_1h_input_tokens: 0, requests: 1 };
  const M = 1_000_000;

  it('applies the pricing table and multipliers', () => {
    expect(estimateCostUsd({ ...zero, input_tokens: M }, 'claude-opus-5')).toBe(5);
    expect(estimateCostUsd({ ...zero, output_tokens: M }, 'claude-opus-5')).toBe(25);
    expect(estimateCostUsd({ ...zero, cache_read_input_tokens: M }, 'claude-opus-5')).toBe(0.5);
    expect(estimateCostUsd({ ...zero, cache_creation_input_tokens: M, cache_creation_1h_input_tokens: M }, 'claude-opus-5')).toBe(10);
    expect(estimateCostUsd({ ...zero, cache_creation_input_tokens: M, cache_creation_5m_input_tokens: M }, 'claude-opus-5')).toBe(6.25);
    // unattributed cache writes are priced at the 1h rate
    expect(estimateCostUsd({ ...zero, cache_creation_input_tokens: M }, 'claude-opus-5')).toBe(10);
    expect(estimateCostUsd({ ...zero, input_tokens: M }, 'claude-sonnet-5')).toBe(2);
    expect(estimateCostUsd({ ...zero, output_tokens: M }, 'claude-sonnet-5')).toBe(10);
    expect(estimateCostUsd({ ...zero, input_tokens: M }, 'claude-opus-5', { batch: true })).toBe(2.5);
    expect(estimateCostUsd({ ...zero, input_tokens: M }, 'claude-opus-5-20260601')).toBe(5);
    expect(() => estimateCostUsd(zero, 'claude-haiku-4-5')).toThrow(RangeError);
  });

  it('accepts raw usage blocks and sums them', () => {
    const u = fakeMessage({}).usage;
    expect(estimateCostUsd(u, 'claude-opus-5')).toBeCloseTo(5000 * 5e-6 + 2000 * 5e-6 * 2 + 1500 * 25e-6, 6);
    const s = summariseUsage([u, u]);
    expect(s.requests).toBe(2);
    expect(s.output_tokens).toBe(3000);
    expect(summariseUsage([s, u]).requests).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

describe('createExtractionClient', () => {
  it('binds the injected client', async () => {
    const fake = fakeClient([fakeMessage({ text: VALID_JSON })]);
    const client = createExtractionClient({ client: fake });
    expect(client.raw).toBe(fake);
    const r = await client.extractDocument(input);
    expect(r.parsed).toEqual(facturaFixture);
    expect(client.buildBatchRequest({ ...input, documentId: 'x' }).custom_id).toMatch(CUSTOM_ID_RE);
  });

  it('constructs a real Anthropic client with the configured retries and timeout', () => {
    const client = createExtractionClient({ apiKey: 'sk-ant-test-not-real', baseURL: 'https://example.invalid' });
    const raw = client.raw as unknown as { maxRetries: number; timeout: number; baseURL: string };
    expect(raw.maxRetries).toBe(6);
    expect(raw.timeout).toBe(600_000);
    expect(raw.baseURL).toBe('https://example.invalid');
    expect(typeof client.raw.messages.create).toBe('function');
    expect(typeof client.raw.messages.parse).toBe('function');
    expect(typeof client.raw.messages.batches.create).toBe('function');
  });
});
