import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ANCHOR_TABLES, merkleRoot, timestampInstruction } from './anchors.ts';

const h = (s: string): string => createHash('sha256').update(s).digest('hex');
const pair = (a: string, b: string): string =>
  createHash('sha256').update(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');

describe('merkle root', () => {
  it('is the SHA-256 of the empty string when there is nothing to anchor', () => {
    expect(merkleRoot([])).toBe(h(''));
  });

  it('is the leaf itself for a single row', () => {
    expect(merkleRoot([h('a')])).toBe(h('a'));
  });

  it('hashes pairs of raw digests', () => {
    expect(merkleRoot([h('a'), h('b')])).toBe(pair(h('a'), h('b')));
  });

  it('pairs an odd node with itself', () => {
    const [a, b, c] = [h('a'), h('b'), h('c')];
    expect(merkleRoot([a!, b!, c!])).toBe(pair(pair(a!, b!), pair(c!, c!)));
  });

  it('depends on order, so a reordered table changes the root', () => {
    expect(merkleRoot([h('a'), h('b')])).not.toBe(merkleRoot([h('b'), h('a')]));
  });

  it('changes as soon as one row changes', () => {
    const before = merkleRoot([h('a'), h('b'), h('c'), h('d')]);
    expect(merkleRoot([h('a'), h('b'), h('c!'), h('d')])).not.toBe(before);
  });

  it('is stable for the same input', () => {
    const leaves = ['a', 'b', 'c', 'd', 'e'].map(h);
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });
});

describe('anchor coverage', () => {
  it('covers the append-only tables named in the design', () => {
    const names = ANCHOR_TABLES.map((t) => t.name);
    expect(names).toEqual(['files', 'extraction_runs', 'field_revisions', 'validator_results', 'finding_reviews', 'audit_log', 'external_checks']);
  });

  it('reads every table through public.row_hash in primary-key order', () => {
    for (const spec of ANCHOR_TABLES) {
      expect(spec.sql).toContain('public.row_hash(t)');
      expect(spec.sql).toContain('order by t.id');
    }
  });

  it('prints the RFC 3161 instruction in both languages', () => {
    expect(timestampInstruction('es')).toContain('RFC 3161');
    expect(timestampInstruction('es')).toContain('vx anchors --token');
    expect(timestampInstruction('en')).toContain('qualified timestamp (RFC 3161)');
  });
});
