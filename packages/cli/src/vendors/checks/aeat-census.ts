/**
 * `aeat_census` — AEAT identity check of an identifier and the name printed with it, through the
 * "Calidad de datos identificativos" web service (VNifV2).
 *
 * For each NIF + name pair the service answers whether the pair is `IDENTIFICADO` in the tax
 * census. For a legal person it also returns the registered name; for a natural person only an
 * echo of the name sent (AEAT withholds census names of natural persons). Any result other than
 * `IDENTIFICADO` is a discrepancy to verify, not a conclusion: the innocent explanations are an OCR
 * misread of the name, a trade name printed instead of the legal name, a recent change of name, a
 * de-registration after the document date, or the source itself still being unverified.
 *
 * **Certificate-gated.** The service identifies its caller by client certificate (mutual TLS).
 * When the context carries `certFetch` — built by `vendors/transport/mtls.ts` from
 * `VX_CLIENT_CERT_P12`, on the operator's machine only — the check calls the service; otherwise
 * it delegates to the manual placeholder in `manual.ts`, which raises the web-form route (AEAT
 * procedure G321, `MANUAL_SOURCES.aeat_census`) exactly as before.
 *
 * **Data protection.** Only identifiers already printed on ingested documents are looked up, and
 * never parties of kind `owner_role` or `president_role` (filtered in `commands/vendors.ts`). For
 * natural persons the row keeps the outcome only: the response body is not archived, the echoed
 * name is dropped from the rows, and the name sent is written neither to `request` nor to
 * `normalised` (it stays on the party record it was read from), so the row holds nothing about a
 * person beyond the identifier and match / no match. An identifier that fails its check digit is
 * not sent at all.
 *
 * **Source status.** `SOURCES.aeat_vnif.verified` is false until a live call from the operator's
 * machine confirms the endpoint, the namespaces and the result strings (see `toVerify`);
 * `normalised.source_verified` carries the flag onto every row. The check type stays
 * `aeat_census`: `snapshot.ts` reads `normalised.census_match` and signal S10 consumes it.
 */
import { XMLParser } from 'fast-xml-parser';
import { isNaturalPersonNif, normaliseNif, validateNif, type NifValidation } from '@viladomat/core';
import { MANUAL_SOURCES, SOURCES } from '../config.ts';
import { asArray, asString, fetchText } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';
import { aeatCensus as aeatCensusManual } from './manual.ts';

/**
 * Result vocabulary of the service, as documented for the web service and its web-form sibling.
 * `NO IDENTIFICABLE` is reported by one client library and `NO IDENTIFICADO-SIMILAR` by the web
 * form; whether the web service emits them is to verify. Unknown values are kept verbatim.
 */
export const VNIF_RESULTS = [
  'IDENTIFICADO',
  'NO IDENTIFICADO',
  'IDENTIFICADO-BAJA',
  'IDENTIFICADO-REVOCADO',
  'NO PROCESADO',
  'NO IDENTIFICABLE',
  'NO IDENTIFICADO-SIMILAR',
] as const;
export type VnifResult = (typeof VNIF_RESULTS)[number];

/** Namespaces of the request and response schemas (to verify against the published WSDL). */
export const VNIF_ENT_NS =
  'http://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/burt/jdit/ws/VNifV2Ent.xsd';
export const VNIF_SAL_NS =
  'http://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/burt/jdit/ws/VNifV2Sal.xsd';
const SOAP_ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

/** One identifier to check, with the name as printed on the document. */
export interface VnifEntry {
  nif: string;
  name?: string | null;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The identifier as the service wants it: 9 characters, upper case, no `ES` prefix. */
export function vnifNif(raw: string): string {
  const n = normaliseNif(raw);
  if (n.length !== 9) {
    throw new Error(
      `identifier "${raw}" does not normalise to the 9 characters the service expects`,
    );
  }
  return n;
}

/** Name as sent: trimmed, inner whitespace collapsed; null when nothing is left. */
export function cleanName(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

/** True for a DNI/NIE/K-L-M shaped identifier, valid or not, so a misread one is still treated as a person's. */
export function naturalPersonShape(v: NifValidation): boolean {
  return isNaturalPersonNif(v) || v.shape === 'DNI' || v.shape === 'NIE' || v.shape === 'SPECIAL';
}

/**
 * SOAP 1.1 document/literal request `VNifV2Ent/Contribuyente{Nif, Nombre}`. The name is
 * mandatory for a natural person (the service matches on it); for a legal person it is sent when
 * known and the element is left empty otherwise. Up to 20,000 entries per call per the schema;
 * the check sends one.
 */
export function buildVnifEnvelope(entries: readonly VnifEntry[]): string {
  if (entries.length === 0) throw new Error('at least one identifier is required');
  const rows = entries.map((e) => {
    const nif = vnifNif(e.nif);
    const name = cleanName(e.name);
    if (!name && naturalPersonShape(validateNif(nif))) {
      throw new Error(
        `a natural-person identifier (${nif}) requires the name as printed on the document`,
      );
    }
    return (
      `<vnif:Contribuyente><vnif:Nif>${escapeXml(nif)}</vnif:Nif>` +
      `<vnif:Nombre>${name ? escapeXml(name) : ''}</vnif:Nombre></vnif:Contribuyente>`
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="${SOAP_ENVELOPE_NS}" xmlns:vnif="${VNIF_ENT_NS}">` +
    '<soapenv:Header/><soapenv:Body>' +
    `<vnif:VNifV2Ent>${rows.join('')}</vnif:VNifV2Ent>` +
    '</soapenv:Body></soapenv:Envelope>'
  );
}

export interface VnifRow {
  nif: string | null;
  /** Registered name for a legal person; for a natural person an echo of the name sent. */
  name: string | null;
  /** Normalised `Resultado` (upper case, single spaces, `X-Y` hyphenation), or null when absent. */
  result: string | null;
}

export interface VnifFault {
  code: string | null;
  reason: string | null;
}

export interface VnifParsed {
  rows: VnifRow[];
  fault: VnifFault | null;
}

// Tag values stay strings (`parseTagValue: false`): an identifier such as 00000010X must not
// become a number, and a leading zero must survive. Prefixes are dropped so the envelope may use
// any prefix (or a default namespace) for the SOAP and the VNifV2Sal elements.
const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
});

/** Depth-first search for the first value stored under `key` anywhere in the parsed tree. */
function findNode(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const rec = node as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const found = findNode(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Upper case, one space between words, `X-Y` for the hyphenated results, no surrounding blanks. */
export function normaliseVnifResult(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `VNifV2Sal/Contribuyente{Nif, Nombre, Resultado}` rows and any SOAP fault (1.1 `faultcode` /
 * `faultstring`, or 1.2 `Code/Value` / `Reason/Text`). Tolerant of prefixes and of a single row
 * arriving as an object rather than a list. Never throws: an unreadable body yields no rows.
 */
export function parseVnifResponse(xml: string): VnifParsed {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return { rows: [], fault: null };
  }

  let fault: VnifFault | null = null;
  const faultNode = findNode(doc, 'Fault');
  if (faultNode && typeof faultNode === 'object') {
    const code =
      asString(findNode(faultNode, 'faultcode')) ??
      asString(findNode(findNode(faultNode, 'Code'), 'Value')) ??
      null;
    const reason =
      asString(findNode(faultNode, 'faultstring')) ??
      asString(findNode(findNode(faultNode, 'Reason'), 'Text')) ??
      null;
    fault = { code, reason };
  }

  const sal = findNode(doc, 'VNifV2Sal');
  const list = asArray(
    sal !== undefined ? findNode(sal, 'Contribuyente') : findNode(doc, 'Contribuyente'),
  );
  const rows = list
    .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
    .map((o): VnifRow => ({
      nif: asString(o.Nif)?.toUpperCase().replace(/[\s-]/g, '') ?? null,
      name: cleanName(asString(o.Nombre)),
      result: normaliseVnifResult(o.Resultado),
    }))
    .filter((r) => r.nif !== null || r.result !== null);

  return { rows, fault };
}

export interface VnifVerdict {
  /** True only when a row for the identifier says `IDENTIFICADO`. */
  census_match: boolean;
  /** `IDENTIFICADO` when matched; otherwise the first result returned for the identifier. */
  result: string | null;
  /**
   * The rows the verdict was taken from: those naming the identifier sent or, when no row in the
   * response names any identifier at all, every row. Empty when the response names only other
   * identifiers — an answer about someone else is not an answer about the party.
   */
  rows: VnifRow[];
  /** Rows that name an identifier other than the one sent; never read as the party's result. */
  rows_for_other_identifiers: number;
  /** Results outside the documented vocabulary, kept so a new value is noticed rather than lost. */
  unknown_results: string[];
}

/**
 * Several rows may come back for one identifier; `IDENTIFICADO` on any of them is a match. Rows
 * are attributed by their `Nif`: a response that carries no identifier on any row (a shape the
 * live service is not known to use, kept for tolerance) is read as being about the one identifier
 * sent, but a row that names a different identifier is never read as the party's result — the
 * check sends exactly one entry, so such a row means the answer is not about the party.
 */
export function interpretVnif(rows: readonly VnifRow[], nif: string): VnifVerdict {
  const wanted = normaliseNif(nif);
  const own = rows.filter((r) => r.nif !== null && normaliseNif(r.nif) === wanted);
  const anonymous = rows.every((r) => r.nif === null);
  const considered = own.length > 0 ? own : anonymous ? [...rows] : [];
  const others = rows.filter((r) => r.nif !== null && normaliseNif(r.nif) !== wanted).length;
  const identified = considered.some((r) => r.result === 'IDENTIFICADO');
  const first = considered.find((r) => r.result !== null)?.result ?? null;
  const known = new Set<string>(VNIF_RESULTS);
  const unknown = [
    ...new Set(
      considered.map((r) => r.result).filter((r): r is string => r !== null && !known.has(r)),
    ),
  ];
  return {
    census_match: identified,
    result: identified ? 'IDENTIFICADO' : first,
    rows: considered,
    rows_for_other_identifiers: others,
    unknown_results: unknown,
  };
}

const cfg = SOURCES.aeat_vnif;
const manualCfg = MANUAL_SOURCES.aeat_census;
const TYPE = 'aeat_census';

function manualRoute(subject: CheckSubject): Record<string, unknown> {
  return {
    url: manualCfg.url,
    query: subject.nif ?? subject.subjectKey,
    evidence: manualCfg.evidence,
  };
}

function withManual(result: CheckResult, subject: CheckSubject): CheckResult {
  result.normalised = {
    ...result.normalised,
    manual: manualRoute(subject),
    source_verified: cfg.verified,
  };
  return result;
}

function verdictNote(verdict: VnifVerdict, natural: boolean): string {
  if (verdict.census_match) {
    return natural
      ? 'Identifier and name identified in the census as of the fetch date. Outcome only is stored for a natural person.'
      : 'Identifier identified in the census as of the fetch date; compare the registered name with the name printed on the document.';
  }
  return (
    `Result ${verdict.result ?? 'not read'}: the identifier and name pair was not identified as sent. ` +
    'To verify, not a conclusion: re-read the name and identifier on the original page, consider a trade name printed instead of the legal name, a recent change of name or a de-registration after the document date; the source endpoint is itself still to verify.'
  );
}

export const aeatCensus: VendorCheck = {
  type: TYPE,
  label: 'AEAT identity check of the identifier and name (VNifV2; operator certificate)',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const certFetch = ctx.certFetch;
    if (!certFetch) {
      // No certificate configured: the manual web-form route is raised exactly as before.
      const fallback = await aeatCensusManual.run(subject, ctx);
      return {
        ...fallback,
        note:
          'No client certificate configured (VX_CLIENT_CERT_P12): the web-form route is raised instead. ' +
          'With the certificate set, this check queries the AEAT VNifV2 service directly.',
      };
    }

    const rawNif = subject.nif ?? null;
    const nameSent = cleanName(subject.name);
    const url = cfg.baseUrl;
    // The name sent is recorded on the row for a legal person only (see the module header); it is
    // added below once the identifier says which kind of person the party is.
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
          nif: null,
          census_match: null,
          note: 'No identifier transcribed for this party; nothing to look up.',
          manual: manualRoute(subject),
          source_verified: cfg.verified,
        },
        raw: { input: null },
        source_url: url,
        cost_cents: 0,
        request,
      };
    }

    // Validate before anything leaves the machine: a misread identifier is not sent to AEAT.
    const validation = validateNif(rawNif);
    const natural = naturalPersonShape(validation);
    request.natural_person = natural;
    if (!natural) request.name_sent = nameSent;
    if (!validation.valid) {
      return withManual(
        errorResult(
          TYPE,
          url,
          new Error(
            `identifier ${validation.normalised} fails its check digit (${validation.reason ?? 'format'}); re-read it on the original page before querying the census`,
          ),
          request,
        ),
        subject,
      );
    }
    const nif = validation.normalised;
    request.nif = nif;
    if (natural && !nameSent) {
      return withManual(
        errorResult(
          TYPE,
          url,
          new Error(
            'a natural-person identifier requires the name as printed on the document; none is recorded for this party',
          ),
          request,
        ),
        subject,
      );
    }

    let body: string;
    try {
      body = buildVnifEnvelope([{ nif, name: nameSent }]);
    } catch (err) {
      return withManual(errorResult(TYPE, url, err, request), subject);
    }

    try {
      const res = await fetchText(ctx, url, {
        source: cfg.id,
        fetch: certFetch,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '""',
          Accept: 'text/xml',
        },
        body,
        // 401: certificate rejected. 500: the usual carrier of a SOAP fault. Both are answers.
        allowStatus: [401, 500],
      });

      if (res.status === 401) {
        return withManual(
          errorResult(
            TYPE,
            url,
            new Error(
              'AEAT rejected the client certificate (HTTP 401). Check that VX_CLIENT_CERT_P12 is the intended PKCS#12, that it is in force, ' +
                'and that the host matches the certificate kind (www1 for personal or representative certificates, www10 for seal certificates).',
            ),
            request,
          ),
          subject,
        );
      }

      const parsed = parseVnifResponse(res.text);
      // A natural person's echoed name is never archived; a legal person's response is.
      const rawBody = natural
        ? { redacted: 'natural person: only the outcome is kept' }
        : { body: res.text };

      if (parsed.fault) {
        const out = withManual(
          errorResult(
            TYPE,
            url,
            new Error(
              `SOAP fault${parsed.fault.code ? ` ${parsed.fault.code}` : ''}: ${parsed.fault.reason ?? 'no reason given'}`,
            ),
            request,
          ),
          subject,
        );
        out.raw = { http_status: res.status, fault: parsed.fault, ...rawBody };
        return out;
      }

      const verdict = interpretVnif(parsed.rows, nif);
      if (verdict.rows.length === 0 || verdict.result === null) {
        // Either nothing readable came back, or every row names another identifier: neither is
        // an answer about the party, and neither is read as one.
        const reason =
          verdict.rows_for_other_identifiers > 0
            ? `response carried ${verdict.rows_for_other_identifiers} row(s) for other identifiers and none for ${nif} (HTTP ${res.status}); not read as an answer about this party`
            : `response carried no VNifV2Sal/Contribuyente/Resultado (HTTP ${res.status}); the envelope or the namespaces may differ from the ones built here`;
        const out = withManual(errorResult(TYPE, url, new Error(reason), request), subject);
        out.normalised = {
          ...out.normalised,
          rows_for_other_identifiers: verdict.rows_for_other_identifiers,
        };
        out.raw = {
          http_status: res.status,
          ...(natural ? rawBody : { body: res.text.slice(0, 4000) }),
        };
        return out;
      }

      const rows = natural
        ? verdict.rows.map((r) => ({ nif: r.nif, name: null, result: r.result }))
        : verdict.rows;
      const identifiedRow =
        verdict.rows.find((r) => r.result === 'IDENTIFICADO') ?? verdict.rows[0];
      const nameRegistered = natural ? null : (identifiedRow?.name ?? null);

      return {
        type: TYPE,
        status: 'ok',
        normalised: {
          census_match: verdict.census_match,
          result: verdict.result,
          nif,
          // A natural person's row carries the outcome and nothing else about the person.
          ...(natural ? {} : { name_sent: nameSent }),
          name_registered: nameRegistered,
          natural_person: natural,
          rows,
          ...(verdict.unknown_results.length > 0
            ? { unknown_results: verdict.unknown_results }
            : {}),
          source_verified: cfg.verified,
          manual: manualRoute(subject),
          note: verdictNote(verdict, natural),
        },
        raw: { http_status: res.status, rows, ...rawBody },
        source_url: url,
        cost_cents: 0,
        request,
        ...(verdict.census_match
          ? {}
          : {
              note: 'The census did not identify the identifier and name pair as sent. Re-read both on the original page before treating either as incorrect.',
            }),
      };
    } catch (err) {
      return withManual(errorResult(TYPE, url, err, request), subject);
    }
  },
};
