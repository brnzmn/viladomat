/**
 * Schema registry: one Zod object per {@link SchemaKey}, plus lookups by document type.
 */
import type { z } from 'zod';
import { ExtractionInputError, schemaKeyFor, type DocType, type SchemaKey } from '../types.ts';
import { ActaSchema } from './acta.ts';
import { CertificacionSchema } from './certificacion.ts';
import { ContratoSchema } from './contrato.ts';
import { DerramaSchema } from './derrama.ts';
import { ExtractoSchema } from './extracto.ts';
import { FacturaSchema } from './factura.ts';
import { LiquidacionSchema } from './liquidacion.ts';
import { PresupuestoSchema } from './presupuesto.ts';

export const SCHEMAS = Object.freeze({
  factura: FacturaSchema,
  presupuesto: PresupuestoSchema,
  certificacion: CertificacionSchema,
  contrato: ContratoSchema,
  extracto: ExtractoSchema,
  liquidacion: LiquidacionSchema,
  acta: ActaSchema,
  derrama: DerramaSchema,
}) satisfies Readonly<Record<SchemaKey, z.ZodType>>;

export type Schemas = typeof SCHEMAS;

/** Parsed document for a schema key. */
export type ParsedDocument<K extends SchemaKey> = z.infer<Schemas[K]>;

/** Any parsed document. */
export type AnyParsedDocument = ParsedDocument<SchemaKey>;

/** Resolve the schema for a document type or schema key; throws for unsupported types. */
export function schemaFor(docType: DocType | SchemaKey): { key: SchemaKey; schema: z.ZodType } {
  const key = schemaKeyFor(docType);
  if (!key) {
    throw new ExtractionInputError(
      `document type "${docType}" has no extraction schema`,
      'unsupported_doc_type',
    );
  }
  return { key, schema: SCHEMAS[key] };
}

export * from './common.ts';
export * from './factura.ts';
export * from './presupuesto.ts';
export * from './certificacion.ts';
export * from './contrato.ts';
export * from './extracto.ts';
export * from './liquidacion.ts';
export * from './acta.ts';
export * from './derrama.ts';
export * from './pagina.ts';
