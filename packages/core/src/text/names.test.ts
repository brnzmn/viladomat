import { describe, expect, it } from 'vitest';
import {
  PAYEE_MATCH_THRESHOLD,
  canonicalGivenName,
  isKnownGivenName,
  jaroWinkler,
  normaliseCompanyName,
  normaliseCompanyNameBasic,
  normaliseName,
  payeesMatch,
  splitSpanishName,
  tokenSetSimilarity,
} from './names.ts';

// All person names below are synthetic (given names from the dictionary + invented surnames).

describe('normaliseName', () => {
  it('strips accents, handles l·l and ç, uppercases and collapses spaces', () => {
    expect(normaliseName('  Lluís  Exemple   Prova ')).toBe('LLUIS EXEMPLE PROVA');
    expect(normaliseName('Marcel·lí Provança')).toBe('MARCELLI PROVANCA');
    expect(normaliseName('Marcel.lí Provança')).toBe('MARCELLI PROVANCA');
    expect(normaliseName('Núria Àngels Ficció')).toBe('NURIA ANGELS FICCIO');
  });
  it('drops particles', () => {
    expect(normaliseName('Josep de la Torre Exemple')).toBe('JOSEP TORRE EXEMPLE');
    expect(normaliseName('Ana de los Rios Prova')).toBe('ANA RIOS PROVA');
    expect(normaliseName('Joan del Mostra i Fictici')).toBe('JOAN MOSTRA FICTICI');
    expect(normaliseName("Maria d'Exemple y Prova")).toBe('MARIA EXEMPLE PROVA');
    expect(normaliseName('Anna van Mostra von Prova')).toBe('ANNA MOSTRA PROVA');
  });
  it('removes punctuation and digits', () => {
    expect(normaliseName('Pere, Exemple-Prova (2)')).toBe('PERE EXEMPLE PROVA');
    expect(normaliseName('')).toBe('');
    expect(normaliseName(null)).toBe('');
  });
});

describe('given-name dictionary', () => {
  it('recognises variants across languages', () => {
    for (const n of [
      'Josep',
      'José',
      'Pep',
      'Joan',
      'Jordi',
      'Francesc',
      'Cesc',
      'Paco',
      'Xavi',
      'Miquel',
      'Pere',
      'Lluís',
      'Enric',
      'Toni',
      'María',
      'Àngel',
      'Ramon',
      'Montse',
      'Núria',
      'Carles',
      'Marc',
      'Anna',
    ]) {
      expect(isKnownGivenName(n), n).toBe(true);
    }
    expect(isKnownGivenName('Exemple')).toBe(false);
  });
  it('maps variants to a canonical form', () => {
    expect(canonicalGivenName('Josep')).toBe('JOSE');
    expect(canonicalGivenName('Pep')).toBe('JOSE');
    expect(canonicalGivenName('Xavier')).toBe('JAVIER');
    expect(canonicalGivenName('Cesc')).toBe('FRANCISCO');
    expect(canonicalGivenName('Anna')).toBe('ANA');
    expect(canonicalGivenName('Montse')).toBe('MONTSERRAT');
    expect(canonicalGivenName('Exemple')).toBe('EXEMPLE');
  });
});

describe('splitSpanishName', () => {
  it('splits given first with one given name', () => {
    expect(splitSpanishName('Josep Exemple Prova')).toEqual({
      given: 'JOSEP',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
      order: 'given_first',
    });
  });
  it('joins two dictionary given names', () => {
    expect(splitSpanishName('Josep Maria Exemple Prova')).toMatchObject({
      given: 'JOSEP MARIA',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
    });
    expect(splitSpanishName('Maria Rosa Exemple')).toMatchObject({
      given: 'MARIA ROSA',
      surname1: 'EXEMPLE',
      surname2: '',
    });
  });
  it('detects surnames first when a dictionary name ends the string', () => {
    expect(splitSpanishName('Exemple Prova Josep Maria')).toEqual({
      given: 'JOSEP MARIA',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
      order: 'surnames_first',
    });
    expect(splitSpanishName('EXEMPLE JOAN')).toMatchObject({
      given: 'JOAN',
      surname1: 'EXEMPLE',
      order: 'surnames_first',
    });
  });
  it('treats a comma as surnames, given', () => {
    expect(splitSpanishName('Exemple Prova, Núria')).toEqual({
      given: 'NURIA',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
      order: 'surnames_first',
    });
    expect(splitSpanishName('de la Torre Exemple, Xavier')).toMatchObject({
      given: 'XAVIER',
      surname1: 'TORRE',
      surname2: 'EXEMPLE',
    });
  });
  it('honours an explicit order', () => {
    expect(splitSpanishName('Exemple Prova Josep', 'surnames_first')).toMatchObject({
      given: 'JOSEP',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
    });
    expect(splitSpanishName('Josep Exemple Prova', 'surnames_first')).toMatchObject({
      given: 'PROVA',
      surname1: 'JOSEP',
      surname2: 'EXEMPLE',
    });
    expect(splitSpanishName('Exemple Prova Josep', 'given_first')).toMatchObject({
      given: 'EXEMPLE',
      surname1: 'PROVA',
      surname2: 'JOSEP',
    });
  });
  it('falls back sensibly for unknown given names', () => {
    expect(splitSpanishName('Zyx Exemple Prova')).toMatchObject({
      given: 'ZYX',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
    });
    expect(splitSpanishName('Zyx Wvu Exemple Prova')).toMatchObject({
      given: 'ZYX WVU',
      surname1: 'EXEMPLE',
      surname2: 'PROVA',
    });
  });
  it('handles degenerate inputs', () => {
    expect(splitSpanishName('')).toEqual({
      given: '',
      surname1: '',
      surname2: '',
      order: 'given_first',
    });
    expect(splitSpanishName('Anna')).toMatchObject({ given: 'ANNA', surname1: '', surname2: '' });
    expect(splitSpanishName(null)).toMatchObject({ given: '' });
  });
});

describe('normaliseCompanyName', () => {
  it('joins dotted abbreviations and drops legal forms', () => {
    expect(normaliseCompanyNameBasic('Vendor A, S.L.')).toBe('VENDOR A SL');
    expect(normaliseCompanyName('Vendor A, S.L.')).toBe('VENDOR A');
    expect(normaliseCompanyName('Vendor A SL')).toBe('VENDOR A');
    expect(normaliseCompanyName('Vendor A S.L.U.')).toBe('VENDOR A');
    expect(normaliseCompanyName('Vendor A SLU')).toBe('VENDOR A');
    expect(normaliseCompanyName('Vendor B, S.A.')).toBe('VENDOR B');
    expect(normaliseCompanyName('Vendor B SA')).toBe('VENDOR B');
    expect(normaliseCompanyName('Vendor C SCP')).toBe('VENDOR C');
    expect(normaliseCompanyName('Vendor D, SCCLP')).toBe('VENDOR D');
    expect(normaliseCompanyName('Vendor E C.B.')).toBe('VENDOR E');
    expect(normaliseCompanyName('Vendor F Sociedad Limitada')).toBe('VENDOR F');
    expect(normaliseCompanyName('Vendor G Societat Limitada')).toBe('VENDOR G');
    expect(normaliseCompanyName('Vendor H, S.L. Unipersonal')).toBe('VENDOR H');
  });
  it('drops trade stopwords', () => {
    expect(normaliseCompanyName('Obres i Reformes Vendor A, S.L.')).toBe('VENDOR A');
    expect(normaliseCompanyName('Construccions Vendor B SL')).toBe('VENDOR B');
    expect(normaliseCompanyName('Instal·lacions Vendor C SLU')).toBe('VENDOR C');
    expect(normaliseCompanyName('Grupo Vendor D Servicios SA')).toBe('VENDOR D');
    expect(normaliseCompanyName('Ascensores Vendor E, S.A.')).toBe('VENDOR E');
  });
  it('keeps stopwords when nothing else remains', () => {
    expect(normaliseCompanyName('Construccions i Reformes S.L.')).toBe('CONSTRUCCIONS REFORMES');
  });
  it('does not remove SA from the middle of a name', () => {
    expect(normaliseCompanyName('Sa Mostra Vendor SL')).toBe('SA MOSTRA VENDOR');
  });
  it('handles empty input', () => {
    expect(normaliseCompanyName('')).toBe('');
    expect(normaliseCompanyName(undefined)).toBe('');
  });
});

describe('jaroWinkler', () => {
  it('returns 1 for identical and 0 for disjoint strings', () => {
    expect(jaroWinkler('VENDOR', 'VENDOR')).toBe(1);
    expect(jaroWinkler('ABC', 'XYZ')).toBe(0);
    expect(jaroWinkler('', 'X')).toBe(0);
  });
  it('matches published reference values', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.8133, 3);
  });
  it('is symmetric', () => {
    expect(jaroWinkler('VENDOR A', 'VENDOR AB')).toBeCloseTo(
      jaroWinkler('VENDOR AB', 'VENDOR A'),
      10,
    );
  });
});

describe('tokenSetSimilarity / payeesMatch', () => {
  it('matches the same payee across bank text and invoice name', () => {
    const score = tokenSetSimilarity('TRANSF VENDOR A OBRES I REFORMES SL', 'Vendor A, S.L.');
    expect(score).toBeGreaterThanOrEqual(PAYEE_MATCH_THRESHOLD);
    expect(payeesMatch('Ascensors Vendor B, S.A.', 'VENDOR B ASCENSORES SA')).toBe(true);
  });
  it('tolerates small spelling differences', () => {
    expect(
      tokenSetSimilarity('Vendor Alfa Instalaciones SL', 'VENDOR ALFA INSTALACIONS S.L.'),
    ).toBeGreaterThanOrEqual(0.85);
    expect(tokenSetSimilarity('Provador Electric SL', 'PROVADOR ELECTRIK')).toBeGreaterThanOrEqual(
      0.85,
    );
  });
  it('keeps different payees apart', () => {
    expect(tokenSetSimilarity('Vendor Alfa SL', 'Ascensors Beta Gamma SA')).toBeLessThan(
      PAYEE_MATCH_THRESHOLD,
    );
    expect(payeesMatch('Provador Electric SL', 'Mostra Fontaneria SL')).toBe(false);
  });
  it('handles empty inputs', () => {
    expect(tokenSetSimilarity('', '')).toBe(1);
    expect(tokenSetSimilarity('Vendor', '')).toBe(0);
    expect(tokenSetSimilarity(null, undefined)).toBe(1);
  });
});
