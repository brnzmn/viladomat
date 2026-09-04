/**
 * Building blocks shared by every extraction schema.
 *
 * Rules that keep the generated JSON Schema acceptable to structured outputs (see
 * `@anthropic-ai/sdk/lib/transform-json-schema`):
 *
 * - never `.optional()` — every property is required; absence is expressed with `.nullable()`;
 * - no `z.tuple` (it produces a node without `type`, which the SDK rejects) — `bbox` is a plain
 *   number array checked locally after parsing ({@link sanitiseBbox});
 * - no `min/max/length/regex` constraints in the wire schema — they live in local refinements
 *   applied after parsing ({@link clampConfidence}, validators);
 * - shared shapes are factories (`evidenceItem()`, `partyRef()`), so the same Zod instance is never
 *   reused inside one schema and `z.toJSONSchema` never emits `$ref`/`$defs`.
 */
import { z } from 'zod';

/** Language of the document text. */
export const LanguageEnum = z.enum(['es', 'ca', 'mixed']);
export type LanguageValue = z.infer<typeof LanguageEnum>;

/** Payment method as printed on an invoice, quote or contract. */
export const FormaPagoEnum = z.enum([
  'transferencia',
  'domiciliacion',
  'efectivo',
  'tarjeta',
  'cheque',
  'pagare',
  'bizum',
  'confirming',
  'otro',
]);
export type FormaPagoValue = z.infer<typeof FormaPagoEnum>;

/** Whether an invoice/quote line concerns common elements or a private unit. */
export const ElementScopeEnum = z.enum(['common', 'private_unit', 'unknown']);
export type ElementScopeValue = z.infer<typeof ElementScopeEnum>;

/** Nullable string (the field exists on the form; null when not printed or not legible). */
export const nstr = () => z.string().nullable();
/** Nullable normalised number (dot decimal, no separators; the printed text goes to evidence.quote). */
export const nnum = () => z.number().nullable();
/** Nullable integer. */
export const nint = () => z.number().int().nullable();
/** Nullable boolean (null when the document does not say). */
export const nbool = () => z.boolean().nullable();

/** ISO date `yyyy-mm-dd` or null; enforced locally, not in the wire schema. */
export const ndate = () => z.string().nullable().describe('ISO date yyyy-mm-dd, or null');

/** Description text used for every `bbox` field. */
export const BBOX_DESCRIPTION =
  '[x0, y0, x1, y1] in pixel coordinates of the page image as sent (origin top-left), or null when it cannot be located';

/**
 * One provenance item. Every monetary and identity field of a document returns one of these in
 * `evidence[]` (citations are not available with structured outputs, so provenance lives here).
 */
export const evidenceItem = () =>
  z.object({
    field_path: z
      .string()
      .describe('Dot path of the field this item supports, e.g. "total_factura" or "lineas[3].base"'),
    page_index: z
      .number()
      .int()
      .describe('0-based page index, as labelled "Page n:" in the request'),
    bbox: z.array(z.number()).nullable().describe(BBOX_DESCRIPTION),
    quote: z
      .string()
      .describe('The text exactly as printed (digits, separators, currency symbol, letters)'),
    confidence: z.number().describe('0 to 1: how sure you are that the value was read correctly'),
  });

export type EvidenceItem = z.infer<ReturnType<typeof evidenceItem>>;

/** Array of evidence items with the standard description. */
export const evidenceArray = () =>
  z
    .array(evidenceItem())
    .describe('One item per monetary or identity field that is present on the document');

/** Name / NIF / address of a legal entity as printed. Natural persons: name null, role elsewhere. */
export const partyRef = () =>
  z.object({
    nombre: z
      .string()
      .nullable()
      .describe('Legal entity name as printed; null for a natural person (see rules on persons)'),
    nif: z.string().nullable().describe('NIF/CIF as printed; null for a natural person'),
    domicilio: z.string().nullable().describe('Address as printed; null for a natural person'),
  });

export type PartyRef = z.infer<ReturnType<typeof partyRef>>;

/** Community name and NIF (allowed: the community is a legal entity, not a person). */
export const comunidadRef = () =>
  z.object({
    nombre: nstr().describe('Community name as printed (e.g. "Comunitat de Propietaris …")'),
    nif: nstr().describe('Community NIF as printed (usually starts with H)'),
  });

/** A percentage and the amount it produces, both as printed. */
export const pctImporte = () =>
  z.object({
    pct: nnum().describe('Percentage as printed, e.g. 21 for "21 %"'),
    importe: nnum().describe('Amount as printed'),
  });

/** A period with start and end dates. */
export const periodo = () =>
  z.object({
    desde: ndate(),
    hasta: ndate(),
  });

/** A reference to a monetary mention inside free text. */
export const importeMencionado = () =>
  z.object({
    concepto: z.string().describe('What the amount refers to, as written'),
    importe: nnum(),
  });

/** A handwritten annotation found on the document. */
export const anotacionManuscrita = () =>
  z.object({
    texto: z.string().describe('The annotation as written; illegible parts as "[ilegible]"'),
    page_index: z.number().int(),
    bbox: z.array(z.number()).nullable().describe(BBOX_DESCRIPTION),
  });

/**
 * Self-check block: one nullable boolean per named check plus the discrepancy found (EUR).
 * Each check compares the printed figures with each other; it never changes the transcription.
 */
export function selfChecks<const K extends readonly string[]>(keys: K) {
  const shape = {} as { [P in K[number]]: z.ZodNullable<z.ZodBoolean> };
  for (const key of keys) {
    (shape as Record<string, z.ZodNullable<z.ZodBoolean>>)[key] = z
      .boolean()
      .nullable()
      .describe('true when the printed figures agree; false when they differ; null when not checkable');
  }
  return z.object({
    ...shape,
    discrepancia_eur: z
      .number()
      .nullable()
      .describe('Largest absolute difference found by the checks, in EUR; null when none'),
  });
}

/** TypeScript shape of a {@link selfChecks} block. */
export type SelfChecks<K extends string> = { [P in K]: boolean | null } & {
  discrepancia_eur: number | null;
};

/**
 * `doc_type_confirmed` convention: the model restates which of the expected document types it is
 * actually looking at. `otro` is always available so that a mis-grouped page is reported instead of
 * forced into a type.
 */
export function docTypeConfirmed<const V extends readonly [string, ...string[]]>(values: V) {
  const all = [...values, 'otro'] as unknown as [...V, 'otro'];
  return z
    .enum(all)
    .describe(
      'The document type you actually see. Choose "otro" when the pages do not match any of the listed types.',
    );
}

/** Standard trailing fields of every document schema. */
export const trailingFields = () => ({
  idioma: LanguageEnum.describe('Main language of the printed text'),
  notes: z
    .string()
    .nullable()
    .describe(
      'Transcription notes only: illegible areas, pages that do not belong, ambiguities. No interpretation.',
    ),
});

// ---------------------------------------------------------------------------
// Local refinements (applied after parsing; never part of the wire schema)
// ---------------------------------------------------------------------------

/** A bbox is valid when it has exactly four finite numbers with x0 ≤ x1 and y0 ≤ y1. */
export function sanitiseBbox(bbox: unknown): [number, number, number, number] | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const nums = bbox.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const [x0, y0, x1, y1] = nums as [number, number, number, number];
  if (x1 < x0 || y1 < y0) return null;
  return [x0, y0, x1, y1];
}

/** Clamp a confidence to [0, 1]; non-numeric → 0. */
export function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** True when the string is a calendar-valid ISO `yyyy-mm-dd`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Issue found by a local refinement. */
export interface RefinementIssue {
  path: string;
  message: string;
}

/**
 * Sanitise every evidence item in place: invalid bboxes become null, confidences are clamped and
 * page indexes outside the sent range are reported. Returns the issues found.
 */
export function sanitiseEvidence(
  evidence: EvidenceItem[],
  pageIndexes: ReadonlySet<number> | null,
): RefinementIssue[] {
  const issues: RefinementIssue[] = [];
  evidence.forEach((item, i) => {
    if (item.bbox !== null) {
      const clean = sanitiseBbox(item.bbox);
      if (!clean) {
        issues.push({ path: `evidence[${i}].bbox`, message: 'not a [x0,y0,x1,y1] box; set to null' });
        item.bbox = null;
      } else {
        item.bbox = clean;
      }
    }
    const c = clampConfidence(item.confidence);
    if (c !== item.confidence) {
      issues.push({ path: `evidence[${i}].confidence`, message: `clamped from ${item.confidence}` });
      item.confidence = c;
    }
    if (pageIndexes && !pageIndexes.has(item.page_index)) {
      issues.push({
        path: `evidence[${i}].page_index`,
        message: `page ${item.page_index} was not part of the request`,
      });
    }
  });
  return issues;
}
