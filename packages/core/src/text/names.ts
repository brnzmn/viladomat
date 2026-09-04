/**
 * Person and company name normalisation and fuzzy matching (Jaro-Winkler, token-set).
 * All fixtures and examples use synthetic names; the functions never look anything up.
 */
import { stripDiacritics } from './amounts.ts';

/** Particles dropped from person names (single tokens). */
const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'DE',
  'DEL',
  'DELS',
  'D',
  'I',
  'Y',
  'VAN',
  'VON',
  'DA',
  'DO',
  'DOS',
  'DAS',
]);

/** Articles that follow `DE` in compound particles (`DE LA`, `DE LOS`, `DE LES`, …). */
const ARTICLES_AFTER_DE: ReadonlySet<string> = new Set(['LA', 'LAS', 'LOS', 'LES', 'EL', 'L']);

/**
 * Given-name variant groups. The first entry of each group is the canonical form used
 * by {@link canonicalGivenName}; every entry is recognised by {@link isKnownGivenName}.
 */
export const GIVEN_NAME_GROUPS: readonly (readonly string[])[] = Object.freeze([
  ['JOSE', 'JOSEP', 'PEP'],
  ['JUAN', 'JOAN'],
  ['JORGE', 'JORDI'],
  ['FRANCISCO', 'FRANCESC', 'CESC', 'PACO'],
  ['JAVIER', 'XAVIER', 'XAVI'],
  ['MIGUEL', 'MIQUEL'],
  ['PEDRO', 'PERE'],
  ['LUIS', 'LLUIS'],
  ['ENRIQUE', 'ENRIC'],
  ['ANTONIO', 'ANTONI', 'TONI'],
  ['MARIA'],
  ['ANGEL'],
  ['RAMON'],
  ['MONTSERRAT', 'MONTSE'],
  ['NURIA'],
  ['CARLOS', 'CARLES'],
  ['MARCOS', 'MARC'],
  ['ANA', 'ANNA'],
  ['JAIME', 'JAUME'],
  ['JOAQUIN', 'JOAQUIM', 'QUIM'],
  ['FERNANDO', 'FERRAN'],
  ['VICENTE', 'VICENC'],
  ['ANDRES', 'ANDREU'],
  ['ESTEBAN', 'ESTEVE'],
  ['GUILLERMO', 'GUILLEM'],
  ['MANUEL', 'MANEL'],
  ['AGUSTIN', 'AGUSTI'],
  ['DOMINGO', 'DOMENEC'],
  ['ALBERTO', 'ALBERT'],
  ['SERGIO', 'SERGI'],
  ['EDUARDO', 'EDUARD'],
  ['RICARDO', 'RICARD'],
  ['RAFAEL', 'RAFEL'],
  ['IGNACIO', 'IGNASI', 'NACHO'],
  ['ALEJANDRO', 'ALEX'],
  ['PABLO', 'PAU'],
  ['GERARDO', 'GERARD'],
  ['ROSA'],
  ['ISABEL', 'ELISABET'],
  ['ELENA', 'HELENA'],
  ['CRISTINA'],
  ['SILVIA'],
  ['EVA'],
  ['PILAR'],
  ['DOLORES', 'DOLORS', 'LOLA'],
  ['MERCEDES', 'MERCE'],
  ['TERESA'],
  ['ROSARIO', 'ROSER'],
  ['NIEVES', 'NEUS'],
  ['INMACULADA', 'IMMACULADA', 'IMMA'],
  ['ANGELES', 'ANGELS'],
  ['CARMEN', 'CARME'],
  ['CARLA'],
  ['CLARA'],
  ['JULIA'],
  ['PAULA'],
  ['SARA'],
  ['MARTA'],
  ['LAURA'],
  ['MIREIA'],
  ['GEMMA'],
  ['MERITXELL'],
  ['LAIA'],
  ['AINA'],
  ['ALBA'],
  ['JUDIT', 'JUDITH'],
  ['RAQUEL'],
  ['SONIA'],
  ['SUSANA'],
  ['MONICA'],
  ['VERONICA'],
  ['LOURDES'],
  ['ESTHER', 'ESTER'],
  ['BEATRIZ', 'BEATRIU'],
  ['PATRICIA'],
  ['LIDIA'],
  ['OLGA'],
  ['IRENE'],
  ['DAVID'],
  ['DANIEL', 'DANI'],
  ['ORIOL'],
  ['ROGER'],
  ['ARNAU'],
  ['MARTI'],
  ['POL'],
  ['BIEL'],
  ['NIL'],
  ['VICTOR'],
  ['HUGO'],
  ['MARIO'],
  ['RUBEN'],
  ['ADRIAN', 'ADRIA'],
  ['OSCAR'],
  ['RAUL'],
  ['SALVADOR'],
  ['SANTIAGO', 'SANTI'],
  ['TOMAS'],
  ['GABRIEL'],
  ['MATEO', 'MATEU'],
  ['LORENZO', 'LLORENC'],
  ['BERNARDO', 'BERNAT'],
  ['ROSA MARIA'],
]);

const GIVEN_NAME_CANONICAL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of GIVEN_NAME_GROUPS) {
    const canonical = group[0] ?? '';
    for (const variant of group) m.set(variant, canonical);
  }
  return m;
})();

/** Canonical (Spanish) form of a given name, or the normalised token when unknown. */
export function canonicalGivenName(token: string): string {
  const t = normaliseName(token);
  return GIVEN_NAME_CANONICAL.get(t) ?? t;
}

/** True when the (normalised) token is in the given-name dictionary. */
export function isKnownGivenName(token: string): boolean {
  return GIVEN_NAME_CANONICAL.has(normaliseName(token));
}

/**
 * Normalise a person name for comparison: NFD accent stripping, `l·l`/`l.l` → `ll`,
 * `ç` → `c`, upper case, punctuation removed, spaces collapsed and particles
 * (DE, DEL, DE LA, DE LAS, DE LOS, D', I, Y, VAN, VON) dropped.
 */
export function normaliseName(s: string | null | undefined): string {
  if (s == null) return '';
  let t = String(s).normalize('NFKC');
  t = t.replace(/l[·.\-]l/gi, 'll');
  t = stripDiacritics(t).toUpperCase();
  t = t.replace(/[’`´]/g, "'");
  t = t.replace(/[^A-Z' ]+/g, ' ');
  t = t.replace(/\b([A-Z])'\s*/g, '$1 '); // D'ALMEIDA → D ALMEIDA (particle dropped below)
  t = t.replace(/'/g, '');
  const tokens = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i] ?? '';
    const next = tokens[i + 1] ?? '';
    if (tk === 'DE' && ARTICLES_AFTER_DE.has(next)) {
      i++;
      continue;
    }
    if (NAME_PARTICLES.has(tk)) continue;
    out.push(tk);
  }
  return out.join(' ');
}

/** Requested or detected token order of a person name. */
export type NameOrder = 'auto' | 'surnames_first' | 'given_first';

/** Result of {@link splitSpanishName}. Parts are normalised (see {@link normaliseName}). */
export interface SplitName {
  given: string;
  surname1: string;
  surname2: string;
  /** Order the name was read in. */
  order: 'surnames_first' | 'given_first';
}

function detectOrder(tokens: readonly string[]): 'surnames_first' | 'given_first' {
  const first = tokens[0] ?? '';
  const last = tokens[tokens.length - 1] ?? '';
  const firstKnown = GIVEN_NAME_CANONICAL.has(first);
  const lastKnown = GIVEN_NAME_CANONICAL.has(last);
  if (lastKnown && !firstKnown) return 'surnames_first';
  return 'given_first';
}

/**
 * Split a Spanish/Catalan person name into given name(s), first surname and second surname.
 *
 * - A comma always means `surnames, given`.
 * - With `order: 'auto'` the given-name dictionary decides: a known given name at the end
 *   but not at the start reads as `surnames first`; otherwise `given first`.
 * - Up to two leading (or trailing) dictionary tokens form the given name
 *   (`JOSEP MARIA …`); when no token is known, one token is used (two when there are
 *   four or more tokens).
 */
export function splitSpanishName(s: string | null | undefined, order: NameOrder = 'auto'): SplitName {
  const raw = s == null ? '' : String(s);
  const empty: SplitName = { given: '', surname1: '', surname2: '', order: 'given_first' };
  const commaIdx = raw.indexOf(',');
  if (commaIdx >= 0 && order !== 'given_first') {
    const surnames = normaliseName(raw.slice(0, commaIdx)).split(' ').filter(Boolean);
    const given = normaliseName(raw.slice(commaIdx + 1));
    return {
      given,
      surname1: surnames[0] ?? '',
      surname2: surnames.slice(1).join(' '),
      order: 'surnames_first',
    };
  }

  const tokens = normaliseName(raw).split(' ').filter(Boolean);
  if (tokens.length === 0) return empty;
  if (tokens.length === 1) return { ...empty, given: tokens[0] ?? '' };

  const resolved = order === 'auto' ? detectOrder(tokens) : order;
  const maxGiven = Math.min(2, tokens.length - 1);

  if (resolved === 'surnames_first') {
    let k = 0;
    while (k < maxGiven && GIVEN_NAME_CANONICAL.has(tokens[tokens.length - 1 - k] ?? '')) k++;
    if (k === 0) k = 1;
    const surnames = tokens.slice(0, tokens.length - k);
    return {
      given: tokens.slice(tokens.length - k).join(' '),
      surname1: surnames[0] ?? '',
      surname2: surnames.slice(1).join(' '),
      order: 'surnames_first',
    };
  }

  let k = 0;
  while (k < maxGiven && GIVEN_NAME_CANONICAL.has(tokens[k] ?? '')) k++;
  if (k === 0) k = tokens.length >= 4 ? 2 : 1;
  const surnames = tokens.slice(k);
  return {
    given: tokens.slice(0, k).join(' '),
    surname1: surnames[0] ?? '',
    surname2: surnames.slice(1).join(' '),
    order: 'given_first',
  };
}

/** Legal-form abbreviations removed from company names (after dot removal). */
const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'SL',
  'SLU',
  'SLL',
  'SLP',
  'SLNE',
  'SA',
  'SAU',
  'SAL',
  'SCP',
  'SCCL',
  'SCCLP',
  'SCOOP',
  'COOP',
  'CB',
  'SC',
  'SRL',
  'AIE',
  'UTE',
]);

/** Legal-form tokens that are only removed at the end of the name (short, ambiguous). */
const LEGAL_FORM_TAIL_ONLY: ReadonlySet<string> = new Set(['SA', 'SC']);

/** Trailing qualifiers that follow a legal form. */
const TAIL_QUALIFIERS: readonly RegExp[] = [
  /\s+UNIPERSONAL$/,
  /\s+EN\s+LIQUIDACIO(N)?$/,
  /\s+EN\s+CONSTITUCIO(N)?$/,
  /\s+PROFESIONAL$/,
  /\s+PROFESSIONAL$/,
];

/** Multi-word legal forms removed anywhere in the name. */
const LEGAL_FORM_PHRASES: readonly RegExp[] = [
  /\bSOCIEDAD\s+(DE\s+RESPONSABILIDAD\s+)?LIMITADA(\s+UNIPERSONAL|\s+LABORAL|\s+PROFESIONAL|\s+NUEVA\s+EMPRESA)?\b/g,
  /\bSOCIETAT\s+(DE\s+RESPONSABILITAT\s+)?LIMITADA(\s+UNIPERSONAL|\s+LABORAL|\s+PROFESSIONAL)?\b/g,
  /\bSOCIEDAD\s+ANONIMA(\s+UNIPERSONAL|\s+LABORAL)?\b/g,
  /\bSOCIETAT\s+ANONIMA(\s+UNIPERSONAL|\s+LABORAL)?\b/g,
  /\bSOCIEDAD\s+CIVIL(\s+PROFESIONAL|\s+PARTICULAR)?\b/g,
  /\bSOCIETAT\s+CIVIL(\s+PROFESSIONAL|\s+PARTICULAR)?\b/g,
  /\bSOCIEDAD\s+COOPERATIVA(\s+CATALANA)?(\s+LIMITADA)?\b/g,
  /\bSOCIETAT\s+COOPERATIVA(\s+CATALANA)?(\s+LIMITADA)?\b/g,
  /\bCOMUNIDAD\s+DE\s+BIENES\b/g,
  /\bCOMUNITAT\s+DE\s+BENS\b/g,
  /\bUNION\s+TEMPORAL\s+DE\s+EMPRESAS\b/g,
  /\bUNIO\s+TEMPORAL\s+D\s*EMPRESES\b/g,
  /\bAGRUPACION\s+DE\s+INTERES\s+ECONOMICO\b/g,
];

/** Articles, prepositions and conjunctions always dropped from company names. */
export const COMPANY_CONNECTORS: ReadonlySet<string> = new Set([
  'DE',
  'DEL',
  'DELS',
  'LA',
  'EL',
  'LES',
  'LOS',
  'LAS',
  'I',
  'Y',
  'AND',
]);

/** Generic trade words ignored when comparing company names (kept when nothing else remains). */
export const COMPANY_STOPWORDS: ReadonlySet<string> = new Set([
  'OBRES',
  'OBRAS',
  'REFORMES',
  'REFORMAS',
  'CONSTRUCCIONS',
  'CONSTRUCCIONES',
  'INSTALLACIONS',
  'INSTALACIONS',
  'INSTALACIONES',
  'SERVEIS',
  'SERVICIOS',
  'ASCENSORS',
  'ASCENSORES',
  'GRUP',
  'GRUPO',
]);

/**
 * Basic company-name normalisation without stopword or legal-form removal:
 * upper case, accents stripped, `l·l` → `ll`, dotted abbreviations joined (`S.L.` → `SL`),
 * punctuation to spaces, spaces collapsed.
 */
export function normaliseCompanyNameBasic(s: string | null | undefined): string {
  if (s == null) return '';
  let t = String(s).normalize('NFKC');
  t = t.replace(/l[·.\-]l/gi, 'll');
  t = stripDiacritics(t).toUpperCase();
  t = t.replace(/&/g, ' AND ');
  t = t.replace(/[’`´]/g, "'");
  t = t.replace(/\b[DL]'/g, ' '); // D'EMPRESES → EMPRESES, L'ASCENSOR → ASCENSOR
  // Join dotted abbreviations: "S.L.U." → "SLU.", "S. A." → "SA."
  t = t.replace(/\b([A-Z])\.\s?(?=[A-Z]\.|[A-Z](?:\s|$|,))/g, '$1');
  t = t.replace(/[^A-Z0-9 ]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Normalise a company name for matching: {@link normaliseCompanyNameBasic}, then legal-form
 * suffixes (S.L., SL, S.L.U., SLU, S.A., SA, SCP, SCCLP, C.B., SOCIEDAD LIMITADA,
 * SOCIETAT LIMITADA, …) and trade stopwords (OBRES, OBRAS, REFORMES, CONSTRUCCIONS,
 * INSTAL·LACIONS, SERVEIS, ASCENSORS, GRUP, …) are dropped. When every token is a stopword
 * the stopwords are kept so the name does not vanish.
 */
export function normaliseCompanyName(s: string | null | undefined): string {
  let t = normaliseCompanyNameBasic(s);
  if (!t) return '';
  for (const re of LEGAL_FORM_PHRASES) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  for (let guard = 0; guard < 4; guard++) {
    let changed = false;
    for (const re of TAIL_QUALIFIERS) {
      const next = t.replace(re, '');
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
    const tokens = t.split(' ').filter(Boolean);
    const last = tokens[tokens.length - 1] ?? '';
    if (tokens.length > 1 && LEGAL_FORM_TOKENS.has(last)) {
      tokens.pop();
      t = tokens.join(' ');
      changed = true;
    }
    if (!changed) break;
  }
  const tokens = t
    .split(' ')
    .filter((tk) => !(LEGAL_FORM_TOKENS.has(tk) && !LEGAL_FORM_TAIL_ONLY.has(tk)))
    .filter((tk) => !COMPANY_CONNECTORS.has(tk));
  const meaningful = tokens.filter((tk) => !COMPANY_STOPWORDS.has(tk));
  return (meaningful.length > 0 ? meaningful : tokens).join(' ');
}

/**
 * Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, at most 4 prefix characters).
 * Case-sensitive: normalise inputs first.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched: boolean[] = new Array<boolean>(la).fill(false);
  const bMatched: boolean[] = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchDistance);
    const hi = Math.min(lb - 1, i + matchDistance);
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a.charAt(i) !== b.charAt(j)) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a.charAt(i) !== b.charAt(k)) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, la, lb);
  while (prefix < maxPrefix && a.charAt(prefix) === b.charAt(prefix)) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Similarity at or above which two payee strings are treated as the same party. */
export const PAYEE_MATCH_THRESHOLD = 0.85;

/** Jaro-Winkler score above which two tokens count as the same token in a token set. */
const TOKEN_EQUIVALENCE = 0.9;

function uniqueTokens(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tk of normaliseCompanyName(s).split(' ')) {
    if (!tk || seen.has(tk)) continue;
    seen.add(tk);
    out.push(tk);
  }
  return out;
}

/**
 * Token-set similarity built on Jaro-Winkler, as used for payee matching (bank counterparty
 * text vs. invoice issuer). Both inputs pass through {@link normaliseCompanyName}; tokens
 * are matched fuzzily (JW ≥ 0.9), then the intersection is compared with each side's full
 * token string, and the best score is returned.
 */
export function tokenSetSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = uniqueTokens(a ?? '');
  const tb = uniqueTokens(b ?? '');
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  const inter: string[] = [];
  const restA: string[] = [];
  const usedB = new Set<number>();
  for (const x of ta) {
    let best = -1;
    let bestScore = 0;
    for (let j = 0; j < tb.length; j++) {
      if (usedB.has(j)) continue;
      const score = jaroWinkler(x, tb[j] ?? '');
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0 && bestScore >= TOKEN_EQUIVALENCE) {
      inter.push(x);
      usedB.add(best);
    } else {
      restA.push(x);
    }
  }
  const restB = tb.filter((_, j) => !usedB.has(j));
  const sortJoin = (xs: readonly string[]): string => [...xs].sort().join(' ');
  const i = sortJoin(inter);
  const ia = [i, sortJoin(restA)].filter(Boolean).join(' ');
  const ib = [i, sortJoin(restB)].filter(Boolean).join(' ');
  let best = jaroWinkler(ia, ib);
  if (inter.length > 0) {
    best = Math.max(best, jaroWinkler(i, ia), jaroWinkler(i, ib));
  }
  return best;
}

/** True when {@link tokenSetSimilarity} reaches {@link PAYEE_MATCH_THRESHOLD}. */
export function payeesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return tokenSetSimilarity(a, b) >= PAYEE_MATCH_THRESHOLD;
}
