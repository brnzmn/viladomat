/**
 * `rea` — REA, the national register of accredited construction companies (Registro de Empresas
 * Acreditadas; Ley 32/2006, RD 1109/2007), read through the public lookup form of the Ministry
 * of Labour (`SOURCES.rea`).
 *
 * The register is an HTML form, not an API. The check therefore GETs the form page (to pick up
 * any session cookie and hidden field the form carries), POSTs the identifier with the field
 * names the research report established (`tipoIdentificacion`, `numIdentificacion`,
 * `submitButton_mostrar`), and reads the result table `<table id="tabla-consulta">`. A page
 * containing "no existe ningún registro" is `not_found`; one containing "inscrita" or
 * "acreditada" is `ok` with whatever the table publishes (registration number, autonomous
 * community, validity dates); anything else is an `error` that lists the markers it could not
 * find, so a changed page shows up as "not read" rather than as an answer.
 *
 * Absence from the register is a discrepancy to verify, never a conclusion: a sole trader
 * without employees is outside REA, the registration may be held by a group company or in
 * another autonomous community's section, or it may have lapsed after the works were done.
 *
 * **Gated.** The form was never exercised live: whether it answers a plain POST without a
 * session, a token or a captcha is unconfirmed. Until the register (`public.registry_sources`)
 * marks the source verified — by `vx vendors sources probe --source rea` from the operator's
 * machine, which runs {@link reaLookup} once with a legal-person identifier on file — the check
 * validates the identifier locally and then stops before anything leaves the machine, returning
 * `error` with that reason plus the manual route. The runner passes the register's state through
 * `ctx.sourceVerified` (`sourceVerifiedIn` in `vendors/types.ts`), exactly as for `rasic`.
 *
 * **Data protection.** Only identifiers already printed on ingested documents are looked up.
 * For a natural person (DNI, NIE, K/L/M identifier) the row keeps the verification outcome and
 * the registration facts only: the published name is dropped, the status text is reduced to the
 * marker matched (a sentence read from a page could carry the name), and the page is not
 * archived.
 *
 * **Source status.** `SOURCES.rea.verified` is false until the form has been exercised from the
 * operator's machine; `normalised.source_verified` carries the flag onto every row, and the
 * manual route (`MANUAL_SOURCES.rea`, check type `rea_manual`) stays available as fallback. The
 * check type stays `rea`, which `snapshot.ts` (`registryState`) and rule B7 read.
 */
import { isNaturalPersonNif, validateNif, type NifValidation } from '@viladomat/core';
import { MANUAL_SOURCES, SOURCES } from '../config.ts';
import { asIsoDate, fetchText } from '../http.ts';
import {
  errorResult,
  sourceVerifiedIn,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type FetchLike,
  type VendorCheck,
} from '../types.ts';

/** Values of the form field `tipoIdentificacion`, as established by the research report. */
export const REA_ID_TYPES = Object.freeze({
  NIF: '1',
  NIE: '2',
  CIF: '3',
  PASSPORT: '6',
});

/** Form field value for a validated identifier; null when the identifier is not valid. */
export function reaIdType(v: NifValidation): string | null {
  if (!v.valid) return null;
  switch (v.kind) {
    case 'DNI':
    case 'SPECIAL':
      return REA_ID_TYPES.NIF;
    case 'NIE':
      return REA_ID_TYPES.NIE;
    case 'CIF':
      return REA_ID_TYPES.CIF;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers: a tolerant, dependency-free reading of the result page
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  ccedil: 'ç',
  Ccedil: 'Ç',
  uuml: 'ü',
  Uuml: 'Ü',
  agrave: 'à',
  egrave: 'è',
  ograve: 'ò',
  middot: '·',
  ordm: 'º',
  ordf: 'ª',
});

/** Decode the numeric and the common named entities of a Spanish-language page. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

/** Visible text of a markup fragment: scripts and styles dropped, tags removed, spaces collapsed. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' \n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Accents stripped, lower case, one space between words: the form the markers are matched in. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * Hidden inputs of the page, in document order (a Struts or Spring form token, a language
 * field): they are sent back with the search so the POST is the one the page expects.
 */
export function extractHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputs) {
    if ((attr(tag, 'type') ?? '').toLowerCase() !== 'hidden') continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    out[name] = attr(tag, 'value') ?? '';
  }
  return out;
}

/**
 * `Cookie` request header from a `Set-Cookie` response header, as the global `fetch` exposes it
 * (several cookies joined by a comma). Attributes are dropped; a comma inside an `Expires`
 * date is not a cookie boundary.
 */
const COOKIE_ATTRIBUTES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
]);

export function cookieHeaderFrom(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const pairs = setCookie
    .split(/,(?=\s*[^;,\s=]+=)/)
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter((c) => {
      const eq = c.indexOf('=');
      if (eq <= 0) return false;
      return !COOKIE_ATTRIBUTES.has(c.slice(0, eq).trim().toLowerCase());
    });
  return pairs.length > 0 ? pairs.join('; ') : null;
}

export interface HtmlTable {
  /** Cell texts per row, header rows included. */
  rows: string[][];
  /** Whether each row was made of `<th>` cells. */
  headerRows: boolean[];
  text: string;
}

/** The table with the given id, split into rows and cells; null when the page has none. */
export function extractTable(html: string, id: string): HtmlTable | null {
  const open = new RegExp(`<table\\b[^>]*\\bid\\s*=\\s*["']?${id}["']?[^>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = html.slice(start).search(/<\/table\s*>/i);
  const inner = close >= 0 ? html.slice(start, start + close) : html.slice(start);
  const rows: string[][] = [];
  const headerRows: boolean[] = [];
  for (const tr of inner.match(/<tr\b[\s\S]*?<\/tr\s*>/gi) ?? []) {
    const cells = tr.match(/<t([dh])\b[^>]*>[\s\S]*?<\/t\1\s*>/gi) ?? [];
    if (cells.length === 0) continue;
    rows.push(cells.map((c) => stripTags(c).replace(/\s+/g, ' ').trim()));
    headerRows.push(cells.every((c) => /^<th/i.test(c)));
  }
  return { rows, headerRows, text: stripTags(inner) };
}

// ---------------------------------------------------------------------------
// Result-page parser
// ---------------------------------------------------------------------------

/** One registration as published in the result table. */
export interface ReaEntry {
  registration_number: string | null;
  /** Name as published: business data for a company; dropped by the check for a natural person. */
  name: string | null;
  nif: string | null;
  community: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status_text: string | null;
}

export interface ReaParsed {
  /** true when the page says "inscrita"/"acreditada", false on "no existe ningún registro", null otherwise. */
  registered: boolean | null;
  registration_number: string | null;
  community: string | null;
  valid_from: string | null;
  valid_to: string | null;
  /** The sentence or cell the verdict was read from, as printed. */
  raw_status_text: string | null;
  name: string | null;
  entries: ReaEntry[];
  table_found: boolean;
  /** Fields (on a registered entry) or markers (on an unreadable page) that were not read. */
  unread: string[];
}

/** Markers the parser looks for; listed in `unread` when a page carries none of them. */
export const REA_MARKERS = Object.freeze({
  table: 'table#tabla-consulta',
  registered: 'inscrita/acreditada',
  notFound: 'no existe ningún registro',
});

type Column = 'number' | 'name' | 'nif' | 'community' | 'from' | 'to' | 'status';

/** Column recognised from a folded header cell; null when it is none of the expected ones. */
export function reaColumnOf(header: string): Column | null {
  const h = foldText(header);
  if (!h) return null;
  if (/(^|\W)(n(um(ero)?)?\.?\s*(de\s*)?(inscripcion|rea|registro)|codigo\s*rea|rea)(\W|$)/.test(h))
    return 'number';
  if (/comunidad|autonom|autoridad laboral|ccaa/.test(h)) return 'community';
  if (/vencimiento|caducidad|hasta|fin\b|expira|renovac/.test(h)) return 'to';
  if (/fecha|desde|alta|inicio|efectos|validez/.test(h)) return 'from';
  if (/estado|situacion/.test(h)) return 'status';
  if (/\b(nif|cif|nie|dni)\b|identificac|documento/.test(h)) return 'nif';
  if (/razon social|nombre|denominacion|empresa|titular/.test(h)) return 'name';
  return null;
}

const COMMUNITIES: ReadonlyArray<readonly [string, string]> = [
  ['andalucia', 'Andalucía'],
  ['aragon', 'Aragón'],
  ['asturias', 'Asturias'],
  ['illes balears', 'Illes Balears'],
  ['islas baleares', 'Illes Balears'],
  ['baleares', 'Illes Balears'],
  ['canarias', 'Canarias'],
  ['cantabria', 'Cantabria'],
  ['castilla y leon', 'Castilla y León'],
  ['castilla-la mancha', 'Castilla-La Mancha'],
  ['castilla la mancha', 'Castilla-La Mancha'],
  ['cataluna', 'Cataluña'],
  ['catalunya', 'Cataluña'],
  ['comunitat valenciana', 'Comunitat Valenciana'],
  ['comunidad valenciana', 'Comunitat Valenciana'],
  ['extremadura', 'Extremadura'],
  ['galicia', 'Galicia'],
  ['madrid', 'Madrid'],
  ['murcia', 'Murcia'],
  ['navarra', 'Navarra'],
  ['pais vasco', 'País Vasco'],
  ['euskadi', 'País Vasco'],
  ['la rioja', 'La Rioja'],
  ['ceuta', 'Ceuta'],
  ['melilla', 'Melilla'],
];

/** The autonomous community named in a text, in its canonical spelling; null when none is. */
export function communityIn(text: string): string | null {
  const folded = foldText(text);
  for (const [needle, canonical] of COMMUNITIES) {
    if (folded.includes(needle)) return canonical;
  }
  return null;
}

/** REA registration numbers as published: AA/PP/SSSSSSS (community, province, sequence). */
const REA_NUMBER = /\b\d{2}\/\d{2}\/\d{7}\b/;
const DATE_ES = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b/g;
const REGISTERED_WORDS = /\b(inscrita|acreditada)\b/;
const NOT_FOUND_WORDS = /no existe ningun registro/;

/** The first sentence (or line, or cell) of the text in which the marker occurs, as printed. */
function sentenceAround(text: string, re: RegExp): string | null {
  for (const piece of text.split(/(?<=\.)\s+|\n/)) {
    const sentence = piece.replace(/\s+/g, ' ').trim();
    if (sentence && re.test(foldText(sentence))) return sentence.slice(0, 200);
  }
  return null;
}

function entryFromRegexes(text: string, status: string | null): ReaEntry {
  const dates = [...text.matchAll(DATE_ES)].map((m) => asIsoDate(m[0]));
  return {
    registration_number: REA_NUMBER.exec(text)?.[0] ?? null,
    name: null,
    nif: null,
    community: communityIn(text),
    valid_from: dates[0] ?? null,
    valid_to: dates[1] ?? null,
    status_text: status,
  };
}

/** Rows of the result table turned into entries, by header columns or by label/value pairs. */
export function entriesFromTable(table: HtmlTable): ReaEntry[] {
  const headerIndex = table.rows.findIndex(
    (cells) => cells.filter((c) => reaColumnOf(c) !== null).length >= 2 && cells.length >= 3,
  );
  if (headerIndex >= 0) {
    const header = table.rows[headerIndex] ?? [];
    const columns = header.map(reaColumnOf);
    const entries: ReaEntry[] = [];
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const cells = table.rows[i] ?? [];
      if (cells.length < 2 || table.headerRows[i]) continue;
      const entry: ReaEntry = {
        registration_number: null,
        name: null,
        nif: null,
        community: null,
        valid_from: null,
        valid_to: null,
        status_text: null,
      };
      columns.forEach((col, idx) => {
        const value = (cells[idx] ?? '').trim();
        if (!col || !value) return;
        if (col === 'number') entry.registration_number = value;
        else if (col === 'name') entry.name = value;
        else if (col === 'nif') entry.nif = value.toUpperCase().replace(/[\s-]/g, '');
        else if (col === 'community') entry.community = communityIn(value) ?? value;
        else if (col === 'from') entry.valid_from = asIsoDate(value);
        else if (col === 'to') entry.valid_to = asIsoDate(value);
        else if (col === 'status') entry.status_text = value;
      });
      if (Object.values(entry).some((v) => v !== null)) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }

  // Label / value layout: two cells per row, the first naming the field.
  const pairs = table.rows.filter((cells) => cells.length === 2 && reaColumnOf(cells[0] ?? ''));
  if (pairs.length >= 2) {
    const entry: ReaEntry = {
      registration_number: null,
      name: null,
      nif: null,
      community: null,
      valid_from: null,
      valid_to: null,
      status_text: null,
    };
    for (const [label, raw] of pairs as Array<[string, string]>) {
      const value = raw.trim();
      if (!value) continue;
      switch (reaColumnOf(label)) {
        case 'number':
          entry.registration_number ??= value;
          break;
        case 'name':
          entry.name ??= value;
          break;
        case 'nif':
          entry.nif ??= value.toUpperCase().replace(/[\s-]/g, '');
          break;
        case 'community':
          entry.community ??= communityIn(value) ?? value;
          break;
        case 'from':
          entry.valid_from ??= asIsoDate(value);
          break;
        case 'to':
          entry.valid_to ??= asIsoDate(value);
          break;
        case 'status':
          entry.status_text ??= value;
          break;
        default:
          break;
      }
    }
    return [entry];
  }
  return [];
}

/**
 * Read the result page. Pure: exported so it can be tested against recorded fixtures without a
 * transport. Never throws.
 */
export function parseReaPage(html: string): ReaParsed {
  const table = extractTable(html, 'tabla-consulta');
  const text = table ? table.text : stripTags(html);
  const folded = foldText(text);

  const notFound = NOT_FOUND_WORDS.test(folded);
  const registeredWords = REGISTERED_WORDS.test(folded);
  const registered = notFound ? false : registeredWords ? true : null;

  const base: ReaParsed = {
    registered,
    registration_number: null,
    community: null,
    valid_from: null,
    valid_to: null,
    raw_status_text: null,
    name: null,
    entries: [],
    table_found: table !== null,
    unread: [],
  };

  if (registered === null) {
    base.unread = [
      ...(table ? [] : [REA_MARKERS.table]),
      REA_MARKERS.registered,
      REA_MARKERS.notFound,
    ];
    return base;
  }
  if (registered === false) {
    base.raw_status_text = sentenceAround(text, NOT_FOUND_WORDS);
    if (!table) base.unread = [REA_MARKERS.table];
    return base;
  }

  const statusSentence = sentenceAround(text, REGISTERED_WORDS);
  let entries = table ? entriesFromTable(table) : [];
  if (entries.length === 0) entries = [entryFromRegexes(text, statusSentence)];
  // Regex fallback for the fields a column layout did not carry.
  const fallback = entryFromRegexes(text, statusSentence);
  const first = entries[0] as ReaEntry;
  first.registration_number ??= fallback.registration_number;
  first.community ??= fallback.community;
  first.valid_from ??= fallback.valid_from;
  first.valid_to ??= fallback.valid_to;
  first.status_text ??= statusSentence;

  base.entries = entries;
  base.registration_number = first.registration_number;
  base.community = first.community;
  base.valid_from = first.valid_from;
  base.valid_to = first.valid_to;
  base.raw_status_text = first.status_text ?? statusSentence;
  base.name = first.name;
  base.unread = (['registration_number', 'community', 'valid_from', 'valid_to'] as const).filter(
    (k) => first[k] === null,
  );
  return base;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const cfg = SOURCES.rea;
const manualCfg = MANUAL_SOURCES.rea;
const TYPE = 'rea';

const ID_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  '1': 'NIF',
  '2': 'NIE',
  '3': 'CIF',
  '6': 'passport',
});

function manualRoute(subject: CheckSubject, idType: string | null): Record<string, unknown> {
  const nif = subject.nif ?? subject.subjectKey;
  return {
    url: manualCfg.url,
    query: idType ? `${ID_TYPE_LABELS[idType] ?? 'identifier'} ${nif}` : nif,
    evidence: manualCfg.evidence,
  };
}

function withManual(
  result: CheckResult,
  subject: CheckSubject,
  idType: string | null,
): CheckResult {
  result.normalised = {
    ...result.normalised,
    manual: manualRoute(subject, idType),
    source_verified: cfg.verified,
  };
  return result;
}

/** The form body the page expects: its own hidden fields first, then the search. */
export function buildReaForm(hidden: Record<string, string>, idType: string, nif: string): string {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) {
    if (k === 'tipoIdentificacion' || k === 'numIdentificacion' || k === 'submitButton_mostrar')
      continue;
    form.set(k, v);
  }
  form.set('tipoIdentificacion', idType);
  form.set('numIdentificacion', nif);
  form.set('submitButton_mostrar', 'Mostrar');
  return form.toString();
}

const NOT_FOUND_NOTE =
  'No REA entry located for the identifier as of the fetch date. Not exculpatory and not conclusive: a sole trader without employees is outside REA, ' +
  'the registration may be held by a group company or in another autonomous community, or it may have lapsed after the works; the source is itself still to verify.';

const UNVERIFIED_NOTE =
  'The REA public form has not been exercised from the operator’s machine: whether it answers without a session, a token or a captcha is unconfirmed. ' +
  'The automated lookup is disabled until `vx vendors sources probe --source rea` has verified it; use the manual route and upload the evidence.';

/**
 * For a natural person the status text is reduced to the marker that decided the outcome: a
 * sentence read from a page without a result table could carry the person's name.
 */
export function statusMarker(
  parsed: Pick<ReaParsed, 'registered' | 'raw_status_text'>,
): string | null {
  if (parsed.registered === false) return REA_MARKERS.notFound;
  if (parsed.registered === true) {
    return (
      REGISTERED_WORDS.exec(foldText(parsed.raw_status_text ?? ''))?.[0] ?? REA_MARKERS.registered
    );
  }
  return null;
}

export interface ReaLookupOptions {
  /**
   * Whether the register has verified the form. When false the lookup stops after the local
   * validations, before anything leaves the machine, with an `error` row that carries the manual
   * route. The probe passes true to exercise the form once from the operator's machine.
   */
  sourceVerified: boolean;
}

/**
 * The lookup itself: the check's `run` after reading the register gate from the context. Exported
 * so the source probe can exercise the form once while the register still says unverified.
 */
export async function reaLookup(
  subject: CheckSubject,
  ctx: CheckContext,
  opts: ReaLookupOptions,
): Promise<CheckResult> {
  const url = cfg.baseUrl;
  const rawNif = subject.nif ?? null;
  const request: Record<string, unknown> = {
    nif: rawNif,
    endpoint: url,
    source_verified: cfg.verified,
  };

  if (!rawNif) {
    return {
      type: TYPE,
      status: 'not_found',
      normalised: {
        registered: null,
        note: 'No identifier transcribed for this party; the register is searched by identifier only.',
        manual: manualRoute(subject, null),
        source_verified: cfg.verified,
      },
      raw: { input: null },
      source_url: url,
      cost_cents: 0,
      request,
    };
  }

  // Validate before anything leaves the machine: a misread identifier is not sent.
  const validation = validateNif(rawNif);
  const idType = reaIdType(validation);
  if (!validation.valid || !idType) {
    return withManual(
      errorResult(
        TYPE,
        url,
        new Error(
          `identifier ${validation.normalised} fails its check digit (${validation.reason ?? 'format'}); re-read it on the original page before querying the register`,
        ),
        request,
      ),
      subject,
      null,
    );
  }
  const nif = validation.normalised;
  const natural = isNaturalPersonNif(validation);
  request.nif = nif;
  request.id_type = idType;
  request.natural_person = natural;

  // The gate: nothing is posted to the form until the register says it answers as expected.
  if (!opts.sourceVerified) {
    return {
      type: TYPE,
      status: 'error',
      normalised: {
        error: 'REA form not verified',
        note: UNVERIFIED_NOTE,
        registered: null,
        searched: { nif, id_type: idType },
        natural_person: natural,
        manual: manualRoute(subject, idType),
        source_verified: false,
      },
      raw: { skipped: true, reason: 'source_unverified' },
      source_url: url,
      cost_cents: 0,
      request,
    };
  }

  try {
    // The form page first: its cookies and hidden fields travel with the search. The wrapping
    // transport only records the response headers; the limiter and the timeout still apply.
    let setCookie: string | null = null;
    const recording: FetchLike = async (u, init) => {
      const res = await ctx.fetch(u, init);
      setCookie = res.headers.get('set-cookie');
      return res;
    };
    const page = await fetchText(ctx, url, {
      source: cfg.id,
      fetch: recording,
      headers: { Accept: 'text/html' },
    });
    const hidden = extractHiddenInputs(page.text);
    const cookie = cookieHeaderFrom(setCookie);
    const body = buildReaForm(hidden, idType, nif);
    request.form_fields = Object.keys(hidden);

    const res = await fetchText(ctx, url, {
      source: cfg.id,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'text/html',
        Referer: url,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
    });

    const parsed = parseReaPage(res.text);
    // A natural person's page is never archived; a company's is.
    const rawBody = natural
      ? { redacted: 'natural person: only the outcome is kept' }
      : { body: res.text };

    if (parsed.registered === null) {
      const out = withManual(
        errorResult(
          TYPE,
          url,
          new Error(
            `result page carried none of the expected markers (${parsed.unread.join(', ')}); HTTP ${res.status}. The form or the result table may have changed.`,
          ),
          request,
        ),
        subject,
        idType,
      );
      out.normalised = { ...out.normalised, registered: null, unread: parsed.unread };
      out.raw = {
        http_status: res.status,
        ...(natural ? rawBody : { body: res.text.slice(0, 4000) }),
      };
      return out;
    }

    // A natural person's published name and status sentence are dropped; the marker stays.
    const marker = statusMarker(parsed);
    const entries = natural
      ? parsed.entries.map((e) => ({
          ...e,
          name: null,
          nif: null,
          status_text: e.status_text === null ? null : marker,
        }))
      : parsed.entries;
    const rawStatusText = natural ? marker : parsed.raw_status_text;

    if (parsed.registered === false) {
      return {
        type: TYPE,
        status: 'not_found',
        normalised: {
          registered: false,
          registration_number: null,
          community: null,
          valid_from: null,
          valid_to: null,
          raw_status_text: rawStatusText,
          searched: { nif, id_type: idType },
          natural_person: natural,
          source_verified: cfg.verified,
          manual: manualRoute(subject, idType),
          note: NOT_FOUND_NOTE,
        },
        raw: { http_status: res.status, ...rawBody },
        source_url: url,
        cost_cents: 0,
        request,
      };
    }

    return {
      type: TYPE,
      status: 'ok',
      normalised: {
        registered: true,
        registration_number: parsed.registration_number,
        community: parsed.community,
        valid_from: parsed.valid_from,
        valid_to: parsed.valid_to,
        raw_status_text: rawStatusText,
        ...(natural ? {} : { name: parsed.name }),
        entries,
        searched: { nif, id_type: idType },
        natural_person: natural,
        unread: parsed.unread,
        source_verified: cfg.verified,
        manual: manualRoute(subject, idType),
        note: 'Registered in REA as of the fetch date; compare the validity dates with the dates of the works. The source is itself still to verify.',
      },
      raw: { http_status: res.status, ...rawBody },
      source_url: url,
      cost_cents: 0,
      request,
      ...(parsed.unread.length > 0
        ? { note: `Fields not read from the result table: ${parsed.unread.join(', ')}.` }
        : {}),
    };
  } catch (err) {
    return withManual(errorResult(TYPE, url, err, request), subject, idType);
  }
}

export const rea: VendorCheck = {
  type: TYPE,
  label: 'REA — accredited construction companies register (public form)',
  manual: false,
  source: cfg.id,
  run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    return reaLookup(subject, ctx, { sourceVerified: sourceVerifiedIn(ctx, cfg.id) });
  },
};
