/**
 * Single seam between the worker and the extraction module of `@viladomat/core`.
 *
 * Everything the M2 steps and commands use from the extraction module passes through this file, so
 * a change on the core side (a renamed export, a moved path, a different client factory) is fixed
 * here and nowhere else.
 *
 * Import mapping: the core package exports `"./*": "./src/*.ts"`, so the specifier is
 * `@viladomat/core/extraction/index` **without** the `.ts` suffix — the suffix is supplied by the
 * exports map and `.../index.ts` would resolve to `src/extraction/index.ts.ts`.
 */
export {
  // client + request/response handling
  buildBatchRequest,
  buildClassifierParams,
  buildExtractionParams,
  batchCustomId,
  classifyPages,
  classifyPagesDetailed,
  createExtractionClient,
  estimateCostUsd,
  extractDocument,
  parseBatchResult,
  parseCustomId,
  readBatchResults,
  redactRequest,
  runStatusOf,
  submitBatch,
  summariseUsage,
  DEFAULTS,
  LIMITS,
  MODELS,
  ExtractionResponseError,
  // schemas + document types
  DOC_TYPES,
  DOC_TYPE_TO_SCHEMA,
  SCHEMAS,
  SCHEMA_KEYS,
  ExtractionInputError,
  isDocType,
  isSchemaKey,
  schemaFor,
  schemaKeyFor,
  // prompts
  PROMPT_VERSION,
  SCHEMA_VERSION,
  // flattening (two-source rule)
  criticalFieldPaths,
  criticalSeeds,
  flattenParsed,
  indexEvidence,
  isCriticalPath,
  kindForPath,
  normaliseFieldPath,
  pathMatches,
  // validators
  allPassed,
  validateParsed,
  VALIDATOR_VERSIONS,
} from '@viladomat/core/extraction/index';

export type {
  AnyParsedDocument,
  BatchOutcome,
  BatchRequest,
  ClassifyPagesResult,
  DocType,
  Effort,
  EvidenceItem,
  ExtractDocumentResult,
  ExtractInput,
  ExtractionClient,
  ExtractionClientLike,
  FieldValueKind,
  FieldValueSeed,
  Language,
  PageClassification,
  PageImage,
  ParsedDocument,
  SchemaKey,
  UsageSummary,
  ValidatorResult,
  Acta,
  Contrato,
  Derrama,
  Extracto,
  Factura,
  Liquidacion,
} from '@viladomat/core/extraction/index';

import {
  createExtractionClient,
  type ExtractionClient,
  type ExtractionClientLike,
} from '@viladomat/core/extraction/index';
import { envOptional } from '../lib/env.ts';

let injected: ExtractionClientLike | null = null;

/**
 * Install a client for the extraction steps (tests inject a fake; no network, no key). Passing
 * `null` restores the real client. Returns the previous value so a test can restore it.
 */
export function setExtractionClient(client: ExtractionClientLike | null): ExtractionClientLike | null {
  const previous = injected;
  injected = client;
  return previous;
}

/** True when a fake client is installed. */
export function hasInjectedClient(): boolean {
  return injected !== null;
}

/**
 * The extraction client the steps use: the injected one when present, otherwise a real client
 * wired to `ANTHROPIC_API_KEY` (the SDK also reads that variable itself; passing it explicitly
 * turns a missing key into a clear error before any request is built).
 */
export function extractionClient(): ExtractionClient {
  if (injected) return createExtractionClient({ client: injected });
  const apiKey = envOptional('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set: extraction needs an API key (see .env.example)');
  }
  return createExtractionClient({ apiKey });
}
