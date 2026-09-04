/**
 * Shared types of the extraction module: page images, document types and the mapping from
 * `public.documents.doc_type` values to the extraction schema that reads them.
 */

/** One rendered page as sent to the model (JPEG, long edge ≤ 2576 px). */
export interface PageImage {
  /** 0-based index of the page within the document; the label "Page n:" uses this value. */
  index: number;
  /** JPEG bytes of the render (or thumbnail for the classifier). */
  jpeg: Buffer;
  width: number;
  height: number;
  /** SHA-256 (hex) of the JPEG bytes; recorded in `request_json` instead of the bytes. */
  sha256: string;
}

/** `public.documents.doc_type` values (see `supabase/migrations/0002_custody.sql`). */
export const DOC_TYPES = [
  'factura',
  'factura_simplificada',
  'factura_rectificativa',
  'presupuesto',
  'contrato_obra',
  'contrato_ascensor',
  'contrato_mantenimiento',
  'contrato_prestamo',
  'certificacion_obra',
  'certificat_final_obra',
  'albaran',
  'justificante_pago',
  'justificant_transferencia',
  'certificat_titularitat_bancaria',
  'extracto_bancario',
  'liquidacion_anual',
  'presupuesto_comunidad',
  'acta',
  'convocatoria',
  'aviso_derrama',
  'recibo_comunidad',
  'estatuts_titol_constitutiu',
  'requeriment_burofax',
  'permiso_obras',
  'autoliquidacion_icio',
  'iit',
  'ite',
  'solicitud_subvencion',
  'resolucio_subvencion',
  'declaracio_responsable_ascensor',
  'full_encarrec',
  'poliza_seguro',
  'modelo_111_190_347',
  'email',
  'chat_export',
  'nota_manuscrita',
  'otro',
  'ilegible',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** Keys of the extraction schemas (one schema can serve several document types). */
export const SCHEMA_KEYS = [
  'factura',
  'presupuesto',
  'certificacion',
  'contrato',
  'extracto',
  'liquidacion',
  'acta',
  'derrama',
] as const;

export type SchemaKey = (typeof SCHEMA_KEYS)[number];

/** Document types that have an extraction schema, and which one. */
export const DOC_TYPE_TO_SCHEMA: Readonly<Partial<Record<DocType, SchemaKey>>> = Object.freeze({
  factura: 'factura',
  factura_simplificada: 'factura',
  factura_rectificativa: 'factura',
  presupuesto: 'presupuesto',
  certificacion_obra: 'certificacion',
  certificat_final_obra: 'certificacion',
  contrato_obra: 'contrato',
  contrato_ascensor: 'contrato',
  contrato_mantenimiento: 'contrato',
  contrato_prestamo: 'contrato',
  extracto_bancario: 'extracto',
  liquidacion_anual: 'liquidacion',
  presupuesto_comunidad: 'liquidacion',
  acta: 'acta',
  convocatoria: 'acta',
  aviso_derrama: 'derrama',
  recibo_comunidad: 'derrama',
});

/** Document types with an extraction schema. */
export type ExtractableDocType = keyof typeof DOC_TYPE_TO_SCHEMA & DocType;

export function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value);
}

export function isSchemaKey(value: unknown): value is SchemaKey {
  return typeof value === 'string' && (SCHEMA_KEYS as readonly string[]).includes(value);
}

/** Schema key for a document type, or null when the type has no extraction schema. */
export function schemaKeyFor(docType: DocType | SchemaKey): SchemaKey | null {
  if (isSchemaKey(docType)) return docType;
  return DOC_TYPE_TO_SCHEMA[docType] ?? null;
}

/** Reason codes of {@link ExtractionInputError}. */
export type ExtractionInputErrorCode =
  | 'unsupported_doc_type'
  | 'too_many_images'
  | 'image_too_large'
  | 'no_pages'
  | 'bad_page';

/** Thrown when a request cannot be built (unsupported type, too many pages, oversized image). */
export class ExtractionInputError extends Error {
  override readonly name = 'ExtractionInputError';
  readonly code: ExtractionInputErrorCode;
  constructor(message: string, code: ExtractionInputErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Language of a document as returned by the extraction schemas. */
export type Language = 'es' | 'ca' | 'mixed';
