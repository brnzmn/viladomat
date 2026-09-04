import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_CODES,
  NON_BENCHMARKABLE_CODES,
  categoryByCode,
  hasLayer,
  isBenchmarkable,
} from './categories.ts';
import {
  CLASSIFY_ACCEPT_THRESHOLD,
  classifyLine,
  extractQuantity,
  normaliseForMatch,
  stem,
  tokenise,
} from './classify.ts';

describe('categories', () => {
  it('holds the 43 codes of the taxonomy', () => {
    expect(CATEGORIES.length).toBe(43);
    expect(new Set(CATEGORY_CODES).size).toBe(43);
  });

  it('gives every category a label in the three languages and at least one keyword', () => {
    for (const category of CATEGORIES) {
      expect(category.labelEs.length).toBeGreaterThan(0);
      expect(category.labelCa.length).toBeGreaterThan(0);
      expect(category.labelEn.length).toBeGreaterThan(0);
      expect(category.keywordsEs.length + category.keywordsCa.length).toBeGreaterThan(0);
    }
  });

  it('marks lift and staircase scopes as non-benchmarkable in v1', () => {
    expect([...NON_BENCHMARKABLE_CODES].sort()).toEqual([
      'ELEV_CIVIL',
      'ELEV_INSTALL',
      'MISC',
      'STAIR_REHAB',
    ]);
    expect(isBenchmarkable('ELEV_INSTALL')).toBe(false);
    expect(isBenchmarkable('STAIR_REHAB')).toBe(false);
    expect(isBenchmarkable('PAINT_INT')).toBe(true);
    expect(hasLayer('ELEV_INSTALL', 'C')).toBe(true);
    expect(hasLayer('ELEV_INSTALL', 'K')).toBe(false);
  });

  it('looks a category up by code', () => {
    expect(categoryByCode('PAINT_INT')?.labelEn).toBe('Interior painting (common areas)');
    expect(categoryByCode('NOT_A_CODE')).toBeUndefined();
    expect(categoryByCode(null)).toBeUndefined();
  });
});

describe('normalisation', () => {
  it('strips accents, collapses the Catalan geminate and drops punctuation', () => {
    expect(normaliseForMatch('Instal·lació ELÈCTRICA')).toBe('installacio electrica');
    expect(normaliseForMatch('Pintura plàstica, 2a planta.')).toBe('pintura plastica 2a planta');
  });

  it('trims plural and gender endings', () => {
    expect(stem('parets')).toBe('paret');
    expect(stem('plastica')).toBe('plastic');
    expect(stem('monitors')).toBe('monitor');
    expect(tokenise('Sostres i parets')).toEqual(['sostr', 'i', 'paret']);
  });
});

describe('classifyLine', () => {
  it('maps a Catalan painting line', () => {
    const result = classifyLine('Pintura plàstica parets replà 2a planta 45 m2');
    expect(result.code).toBe('PAINT_INT');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_ACCEPT_THRESHOLD);
    expect(result.matchedKeywords).toContain('pintura');
    expect(result.matchedKeywords).toContain('replà');
  });

  it('maps a Spanish lift-maintenance line', () => {
    const result = classifyLine('Cuota mantenimiento ascensor marzo');
    expect(result.code).toBe('ELEV_MAINT');
    expect(result.matchedKeywords).toContain('mantenimiento ascensor');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_ACCEPT_THRESHOLD);
  });

  it('maps a Catalan intercom line and does not read it as a lift installation', () => {
    const result = classifyLine('Instal·lació videoporter 15 monitors');
    expect(result.code).toBe('INTERCOM');
    expect(result.matchedKeywords).toContain('videoportero');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_ACCEPT_THRESHOLD);
  });

  it('sends a line with no keyword to the review queue', () => {
    const result = classifyLine('Concepto s/n');
    expect(result.code).toBe('MISC');
    expect(result.confidence).toBe(0);
    expect(result.matchedKeywords).toEqual([]);
  });

  it('keeps the vendor memory when the line says nothing', () => {
    const result = classifyLine('Servicio mes de abril', { vendorHint: 'CLEANING' });
    expect(result.code).toBe('CLEANING');
    expect(result.confidence).toBeLessThan(CLASSIFY_ACCEPT_THRESHOLD);
  });

  it('raises the confidence when the line confirms the vendor memory', () => {
    const withHint = classifyLine('Neteja escala mes de maig', { vendorHint: 'CLEANING' });
    const without = classifyLine('Neteja escala mes de maig');
    expect(withHint.code).toBe('CLEANING');
    expect(withHint.confidence).toBeGreaterThan(without.confidence);
  });

  it('lets a clear line override the vendor memory', () => {
    const result = classifyLine('Pintura plàstica parets replà 2a planta', {
      vendorHint: 'CLEANING',
    });
    expect(result.code).toBe('PAINT_INT');
  });

  it('does not let the unclassified bucket override the vendor memory', () => {
    const result = classifyLine('Material varios', { vendorHint: 'ELECTRICAL' });
    expect(result.code).toBe('ELECTRICAL');
  });

  it('ignores an unknown vendor hint', () => {
    const result = classifyLine('Concepto s/n', { vendorHint: 'NOT_A_CODE' });
    expect(result.code).toBe('MISC');
  });
});

describe('extractQuantity', () => {
  it('reads square metres', () => {
    expect(extractQuantity('Pintura plàstica parets replà 2a planta 45 m2')).toEqual({
      qty: 45,
      unit: 'm2',
      raw: '45 m2',
    });
    expect(extractQuantity('Superficie 1.234,56 m² de fachada').qty).toBe(1234.56);
  });

  it('reads linear metres, a bare metre and units', () => {
    expect(extractQuantity('Reparación canto forjado 12 ml').unit).toBe('ml');
    expect(extractQuantity('Sustitución bajante 8 m').unit).toBe('ml');
    expect(extractQuantity('Suministro 15 uds de monitor')).toMatchObject({ qty: 15, unit: 'ud' });
    expect(extractQuantity('3 unidades de detector')).toMatchObject({ qty: 3, unit: 'ud' });
  });

  it('reads hours, months and kilograms', () => {
    expect(extractQuantity('Mano de obra 6 horas')).toMatchObject({ qty: 6, unit: 'h' });
    expect(extractQuantity('Manteniment 12 mesos')).toMatchObject({ qty: 12, unit: 'mes' });
    expect(extractQuantity('Material 25 kg')).toMatchObject({ qty: 25, unit: 'kg' });
  });

  it('recognises a lump sum without a quantity', () => {
    expect(extractQuantity('P.A. imprevistos de obra')).toMatchObject({ qty: null, unit: 'pa' });
    expect(extractQuantity('Partida alçada a justificar')).toMatchObject({ unit: 'pa' });
  });

  it('falls back to a percentage only when no other unit is present', () => {
    expect(extractQuantity('Retención de garantía 5 %')).toMatchObject({ qty: 5, unit: 'pct' });
    expect(extractQuantity('45 m2 con IVA 21%')).toMatchObject({ qty: 45, unit: 'm2' });
  });

  it('returns nothing when there is no quantity', () => {
    expect(extractQuantity('Cuota mantenimiento ascensor marzo')).toEqual({
      qty: null,
      unit: null,
      raw: null,
    });
    expect(extractQuantity(null)).toEqual({ qty: null, unit: null, raw: null });
  });

  it('does not read an ordinal as a quantity', () => {
    expect(extractQuantity('Trabajos en 2a planta').unit).toBeNull();
  });
});
