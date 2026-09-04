import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  DOC_TYPE_GLOSSES,
  DOC_TYPE_INSTRUCTIONS,
  EXTRACTION_SYSTEM_PROMPT,
  GLOSSARY,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  classifierInstruction,
  contextNextLabel,
  contextPrevLabel,
  extractionInstruction,
  pageLabel,
  repairInstruction,
} from './prompts.ts';
import { DOC_TYPES, SCHEMA_KEYS } from './types.ts';

/**
 * Mirror of scripts/neutrality-check.mjs; prompts must be transcription-only. Every line below
 * names the blocklist so the CI guard's own exemption applies to this mirror.
 */
const BLOCKLIST: RegExp[] = [
  /\bfraud/, /\bestafa/, /sobrepre(cio|u)/, /\bsospech/, /\bsospit/, /desfalc/, /malversa/, /\bmordida/, // blocklist (es/ca)
  /\bsoborn/, /\bsuborn/, /\bculpable/, /\brobo\b/, /\brobar\b/, /\brobad/, /\bladr(on|ones|e)\b/, // blocklist (es/ca)
  /kickback/, /\bskim/, /\bshaving\b/, /embezzl/, /corrupt/, /\bsteal/, /\bstole/, /\bthie(f|ves)\b/, /\bguilty\b/, /\bcrook/, // blocklist (en)
  /\bhope/, /\bexpect(s|ed)? to find/, /\bdivert/, /\bmisappropriat/, /\bwrongdoing/, /\bdishonest/, // blocklist (motive vocabulary)
];

function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const allPromptText = [
  EXTRACTION_SYSTEM_PROMPT,
  CLASSIFIER_SYSTEM_PROMPT,
  ...Object.values(DOC_TYPE_INSTRUCTIONS),
  ...Object.values(DOC_TYPE_GLOSSES),
  repairInstruction('x'),
  classifierInstruction([1], [0], [2]),
].join('\n');

describe('prompts', () => {
  it('carries versions', () => {
    expect(PROMPT_VERSION).toBe('p1');
    expect(SCHEMA_VERSION).toBe('s1');
  });

  it('system prompt includes the Spanish/Catalan glossary and the transcription rules', () => {
    for (const term of ['factura', 'pressupost', 'certificació', 'derrama', 'liquidació', 'acta', 'quota', 'coeficient']) {
      expect(EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toContain(term);
    }
    expect(GLOSSARY.length).toBeGreaterThan(40);
    for (const phrase of ['Transcribe verbatim', 'Null over guess', 'Handwriting', 'Evidence', 'Persons', 'never transcribed by name', 'pixel coordinates', 'Page n:']) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(phrase);
    }
    // long enough to clear the 1024-token cache minimum of Sonnet (Opus 5 needs 512)
    expect(EXTRACTION_SYSTEM_PROMPT.length).toBeGreaterThan(6000);
    expect(CLASSIFIER_SYSTEM_PROMPT.length).toBeGreaterThan(4000);
  });

  it('every schema has a document-type instruction and every doc type a gloss', () => {
    for (const key of SCHEMA_KEYS) {
      expect(DOC_TYPE_INSTRUCTIONS[key].length).toBeGreaterThan(200);
    }
    for (const t of DOC_TYPES) {
      expect(DOC_TYPE_GLOSSES[t].length).toBeGreaterThan(5);
      expect(CLASSIFIER_SYSTEM_PROMPT).toContain(`- ${t}:`);
    }
  });

  it('contains no accusatory or motive vocabulary', () => {
    const n = normalise(allPromptText);
    for (const re of BLOCKLIST) {
      expect(re.test(n), `matched ${re}`).toBe(false);
    }
  });

  it('is deterministic (no timestamps, ids or randomness in the cached prefix)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d-\d\dT/);
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(EXTRACTION_SYSTEM_PROMPT).toBe(EXTRACTION_SYSTEM_PROMPT.trim());
  });

  it('labels and instructions', () => {
    expect(pageLabel(3)).toBe('Page 3:');
    expect(contextPrevLabel(1)).toBe('Context (previous) page 1:');
    expect(contextNextLabel(9)).toBe('Context (next) page 9:');
    const instr = extractionInstruction('factura_simplificada', 'factura', 'es');
    expect(instr).toContain('Expected document type: factura_simplificada');
    expect(instr).toContain('Expected language of the printed text: es');
    expect(instr).toContain(DOC_TYPE_INSTRUCTIONS.factura);
    expect(extractionInstruction('acta', 'acta')).not.toContain('Expected language');
    const c = classifierInstruction([3, 4], [1, 2], [5]);
    expect(c).toContain('[3, 4]');
    expect(c).toContain('exactly 2 entries');
    expect(c).toContain('Context (previous) pages [1, 2]');
    expect(c).toContain('Context (next) pages [5]');
    const r = repairInstruction('lineas[0].base: expected number');
    expect(r).toContain('lineas[0].base: expected number');
    expect(r).toContain('Keep every transcribed value unchanged');
    expect(repairInstruction('x'.repeat(5000)).length).toBeLessThan(2000);
  });
});
