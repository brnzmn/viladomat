import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  actaFixture,
  certificacionFixture,
  contratoFixture,
  derramaFixture,
  extractoFixture,
  facturaFixture,
  liquidacionFixture,
  paginaFixture,
  presupuestoFixture,
} from './__fixtures__/documents.ts';
import { outputFormatFor } from './client.ts';
import { SCHEMAS, schemaFor } from './schemas/index.ts';
import { PaginaBatchSchema } from './schemas/pagina.ts';
import {
  clampConfidence,
  docTypeConfirmed,
  isIsoDate,
  sanitiseBbox,
  sanitiseEvidence,
  selfChecks,
  type EvidenceItem,
} from './schemas/common.ts';
import { DOC_TYPES, ExtractionInputError, schemaKeyFor } from './types.ts';

const ALL: Record<string, z.ZodType> = { ...SCHEMAS, pagina: PaginaBatchSchema };

/** Walk a JSON schema and collect violations of the structured-output subset. */
function strictnessProblems(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if ('$ref' in n) out.push(`${path}: $ref`);
  if ('$defs' in n) out.push(`${path}: $defs`);
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum', 'const']) {
    if (key in n) out.push(`${path}: ${key}`);
  }
  if (n['type'] === 'object') {
    if (n['additionalProperties'] !== false) out.push(`${path}: additionalProperties`);
    const props = (n['properties'] ?? {}) as Record<string, unknown>;
    const required = (n['required'] ?? []) as string[];
    for (const k of Object.keys(props)) {
      if (!required.includes(k)) out.push(`${path}.${k}: not required`);
      strictnessProblems(props[k], `${path}.${k}`, out);
    }
  }
  if (n['items']) strictnessProblems(n['items'], `${path}[]`, out);
  if (Array.isArray(n['anyOf'])) n['anyOf'].forEach((v, i) => strictnessProblems(v, `${path}|${i}`, out));
}

describe('extraction schemas', () => {
  it.each(Object.keys(ALL))('%s converts with zodOutputFormat without throwing', (key) => {
    const schema = ALL[key] as z.ZodType;
    expect(() => zodOutputFormat(schema)).not.toThrow();
    const fmt = zodOutputFormat(schema);
    expect(fmt.type).toBe('json_schema');
    expect(fmt.schema['type']).toBe('object');
  });

  it.each(Object.keys(ALL))('%s output format is flat and strict', (key) => {
    const fmt = outputFormatFor(ALL[key] as z.ZodType);
    const problems: string[] = [];
    strictnessProblems(fmt.schema, key, problems);
    expect(problems).toEqual([]);
    // the SDK parse function is preserved
    expect(typeof fmt.parse).toBe('function');
    // every schema carries provenance and a doc type confirmation (classifier excepted)
    const props = fmt.schema['properties'] as Record<string, unknown>;
    if (key !== 'pagina') {
      expect(props).toHaveProperty('evidence');
      expect(props).toHaveProperty('self_checks');
      expect(props).toHaveProperty('doc_type_confirmed');
      expect(props).toHaveProperty('idioma');
      expect(props).toHaveProperty('notes');
    }
  });

  it('schemas stay under a sane wire size', () => {
    for (const [key, schema] of Object.entries(ALL)) {
      const size = JSON.stringify(outputFormatFor(schema).schema).length;
      expect(size, key).toBeLessThan(40_000);
    }
  });

  const fixtures: Array<[string, unknown]> = [
    ['factura', facturaFixture],
    ['presupuesto', presupuestoFixture],
    ['certificacion', certificacionFixture],
    ['contrato', contratoFixture],
    ['extracto', extractoFixture],
    ['liquidacion', liquidacionFixture],
    ['acta', actaFixture],
    ['derrama', derramaFixture],
    ['pagina', paginaFixture],
  ];

  it.each(fixtures)('%s accepts a realistic synthetic document', (key, fixture) => {
    const schema = ALL[key] as z.ZodType;
    const parsed = schema.parse(fixture);
    expect(parsed).toEqual(fixture);
    // the SDK parse path (JSON text → zod) agrees
    expect(outputFormatFor(schema).parse(JSON.stringify(fixture))).toEqual(fixture);
  });

  it.each(fixtures)('%s rejects a missing property (no optional fields)', (key, fixture) => {
    const schema = ALL[key] as z.ZodType;
    const copy = structuredClone(fixture) as Record<string, unknown>;
    const first = Object.keys(copy)[0] as string;
    delete copy[first];
    expect(schema.safeParse(copy).success).toBe(false);
  });

  it('rejects unknown enum values and extra properties', () => {
    const bad = structuredClone(facturaFixture) as unknown as Record<string, unknown>;
    bad['doc_type_confirmed'] = 'nota';
    expect(SCHEMAS.factura.safeParse(bad).success).toBe(false);
    const extra = { ...structuredClone(facturaFixture), sorpresa: 1 };
    // zod objects strip unknown keys by default; the wire schema forbids them
    expect(SCHEMAS.factura.safeParse(extra).success).toBe(true);
    expect(outputFormatFor(SCHEMAS.factura).schema['additionalProperties']).toBe(false);
  });

  it('doc_type_confirmed always offers "otro"', () => {
    const e = docTypeConfirmed(['factura', 'presupuesto']);
    expect(e.safeParse('otro').success).toBe(true);
    expect(e.safeParse('factura').success).toBe(true);
    expect(e.safeParse('acta').success).toBe(false);
    for (const schema of Object.values(SCHEMAS)) {
      const props = outputFormatFor(schema).schema['properties'] as Record<string, { description?: string }>;
      expect(props['doc_type_confirmed']?.description).toContain('otro');
    }
  });

  it('selfChecks builds nullable booleans plus discrepancia_eur', () => {
    const s = selfChecks(['a', 'b']);
    expect(s.safeParse({ a: true, b: null, discrepancia_eur: 0.5 }).success).toBe(true);
    expect(s.safeParse({ a: true, discrepancia_eur: null }).success).toBe(false);
  });

  it('pagina doc_type enum matches public.documents.doc_type', () => {
    for (const t of DOC_TYPES) {
      expect(PaginaBatchSchema.shape.pages.element.shape.doc_type.safeParse(t).success).toBe(true);
    }
    expect(PaginaBatchSchema.shape.pages.element.shape.doc_type.safeParse('invoice').success).toBe(false);
    expect(DOC_TYPES).toHaveLength(38);
  });

  it('schemaFor maps document types and rejects unsupported ones', () => {
    expect(schemaFor('factura_simplificada').key).toBe('factura');
    expect(schemaFor('contrato_prestamo').key).toBe('contrato');
    expect(schemaFor('recibo_comunidad').key).toBe('derrama');
    expect(schemaFor('extracto').key).toBe('extracto');
    expect(schemaKeyFor('albaran')).toBeNull();
    expect(() => schemaFor('albaran')).toThrow(ExtractionInputError);
  });
});

describe('local refinements', () => {
  it('sanitiseBbox accepts only [x0,y0,x1,y1] with finite ordered numbers', () => {
    expect(sanitiseBbox([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(sanitiseBbox([1, 2, 3])).toBeNull();
    expect(sanitiseBbox([4, 2, 3, 4])).toBeNull();
    expect(sanitiseBbox([1, 2, Number.NaN, 4])).toBeNull();
    expect(sanitiseBbox(null)).toBeNull();
    expect(sanitiseBbox('1,2,3,4')).toBeNull();
  });

  it('clampConfidence and isIsoDate', () => {
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-0.2)).toBe(0);
    expect(clampConfidence('x')).toBe(0);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('15/03/2024')).toBe(false);
  });

  it('sanitiseEvidence nulls bad boxes, clamps confidence and flags unknown pages', () => {
    const items: EvidenceItem[] = [
      { field_path: 'total', page_index: 0, bbox: [1, 2, 3], quote: '1', confidence: 1.5 },
      { field_path: 'base', page_index: 7, bbox: [1, 2, 3, 4], quote: '2', confidence: 0.5 },
    ];
    const issues = sanitiseEvidence(items, new Set([0, 1]));
    expect(items[0]?.bbox).toBeNull();
    expect(items[0]?.confidence).toBe(1);
    expect(items[1]?.bbox).toEqual([1, 2, 3, 4]);
    expect(issues.map((i) => i.path)).toEqual(['evidence[0].bbox', 'evidence[0].confidence', 'evidence[1].page_index']);
  });
});
