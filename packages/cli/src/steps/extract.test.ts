import { describe, expect, it } from 'vitest';
import { LIMITS } from '../extract/adapter.ts';
import { chunkPages, extractionKey, mergeParsedChunks } from './extract.ts';

/**
 * Reading a document that is longer than one request.
 *
 * The page indexes sent in each chunk are the ones the page has in the document, so the evidence
 * comes back with document-wide page numbers and the row arrays of the chunks can simply be
 * concatenated. What must not happen is a second chunk overwriting the header the first chunk read,
 * or the rows of a table being lost because they arrived in two pieces.
 */

describe('splitting a long document', () => {
  it('never sends more images than one request allows', () => {
    const pages = Array.from({ length: 47 }, (_, i) => i);
    const chunks = chunkPages(pages);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 7]);
    expect(chunks.flat()).toEqual(pages);
    expect(LIMITS.maxImagesPerRequest).toBe(20);
  });

  it('leaves a short document in one piece', () => {
    expect(chunkPages([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
});

describe('merging what the chunks returned', () => {
  it('concatenates the row arrays in chunk order', () => {
    const merged = mergeParsedChunks([
      { movimientos: [{ importe: 1 }, { importe: 2 }], evidence: [{ field_path: 'saldo_inicial' }] },
      { movimientos: [{ importe: 3 }], evidence: [{ field_path: 'saldo_final' }] },
    ]) as { movimientos: unknown[]; evidence: unknown[] };
    expect(merged.movimientos).toEqual([{ importe: 1 }, { importe: 2 }, { importe: 3 }]);
    expect(merged.evidence).toHaveLength(2);
  });

  it('keeps the first value a chunk printed for a header field', () => {
    const merged = mergeParsedChunks([
      { banco: 'CaixaBank', saldo_inicial: 12500.4, saldo_final: null },
      { banco: null, saldo_inicial: null, saldo_final: 9114.6 },
    ]) as Record<string, unknown>;
    expect(merged).toMatchObject({ banco: 'CaixaBank', saldo_inicial: 12500.4, saldo_final: 9114.6 });
  });

  it('returns the single chunk unchanged', () => {
    const only = { total_factura: 3253.8 };
    expect(mergeParsedChunks([only])).toBe(only);
  });

  it('ignores a chunk that produced nothing', () => {
    const merged = mergeParsedChunks([{ lineas: [{ orden: 1 }] }, null]) as { lineas: unknown[] };
    expect(merged.lineas).toEqual([{ orden: 1 }]);
  });
});

describe('the run key', () => {
  it('names the document, the prompt, the schema and the model, so a version bump re-reads', () => {
    expect(extractionKey('doc-1', 'p1', 's1', 'claude-opus-5')).toBe('doc:doc-1:p1:s1:claude-opus-5');
    expect(extractionKey('doc-1', 'p2', 's1', 'claude-opus-5')).not.toBe(extractionKey('doc-1', 'p1', 's1', 'claude-opus-5'));
    expect(extractionKey('doc-1', 'p1', 's1', 'claude-sonnet-5')).not.toBe(extractionKey('doc-1', 'p1', 's1', 'claude-opus-5'));
  });
});
