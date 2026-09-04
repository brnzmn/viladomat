/**
 * Extraction module: Zod schemas with in-schema provenance, versioned transcription prompts, the
 * Claude API client (sync + batches), field flattening for the two-source rule, and validators.
 */
export * from './types.ts';
export * from './schemas/index.ts';
export * from './prompts.ts';
export * from './client.ts';
export * from './flatten.ts';
export * from './validators.ts';
