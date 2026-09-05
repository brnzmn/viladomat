/**
 * `aeat_census` (VNifV2) — envelope builder, response parser, verdict and the check itself, all
 * against synthetic fixtures. No test touches the network: the certificate transport is a
 * fixture player answering XML by URL fragment, and the rate limiter is stubbed.
 *
 * Fixture identifiers pass the check digit but belong to no one (B12345674, A12345674,
 * 12345678Z, X1234567L); names are fictional companies or role placeholders.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../lib/env.ts';
import { MANUAL_SOURCES, SOURCES } from '../config.ts';
import { fetchText, HttpError, resetRateLimiters } from '../http.ts';
import type {
  CheckContext,
  CheckSubject,
  FetchLike,
  HttpRequestInit,
  HttpResponse,
} from '../types.ts';
import { checkByType, VENDOR_DEFAULT_CHECKS } from './index.ts';
import {
  aeatCensus,
  buildVnifEnvelope,
  cleanName,
  escapeXml,
  interpretVnif,
  normaliseVnifResult,
  parseVnifResponse,
  VNIF_ENT_NS,
  VNIF_RESULTS,
  vnifNif,
} from './aeat-census.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** A minimal VNifV2Sal envelope for one row, so every vocabulary value can be exercised inline. */
function salEnvelope(rows: Array<{ nif: string; name?: string; result: string }>): string {
  const body = rows
    .map(
      (r) =>
        `<Contribuyente><Nif>${r.nif}</Nif><Nombre>${r.name ?? ''}</Nombre><Resultado>${r.result}</Resultado></Contribuyente>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>' +
    `<VNifV2Sal xmlns="${VNIF_ENT_NS.replace('Ent', 'Sal')}">${body}</VNifV2Sal>` +
    '</env:Body></env:Envelope>'
  );
}

interface Route {
  match: string;
  body: string;
  status?: number;
}

interface Seen {
  url: string;
  init: HttpRequestInit | undefined;
}

/** A text-answering `fetch` (the certificate transport in the tests) that records what it was asked. */
function textFetch(routes: readonly Route[], seen: Seen[] = []): FetchLike {
  return (url: string, init?: HttpRequestInit) => {
    seen.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    const body = route?.body ?? '';
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(res);
  };
}

interface Harness {
  ctx: CheckContext;
  plain: Seen[];
  cert: Seen[];
  limited: string[];
}

/** Context with a plain transport that must stay unused and a certificate transport playing fixtures. */
function harness(routes: readonly Route[], withCert = true): Harness {
  const plain: Seen[] = [];
  const cert: Seen[] = [];
  const limited: string[] = [];
  const ctx: CheckContext = {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch: textFetch([], plain),
    ...(withCert ? { certFetch: textFetch(routes, cert) } : {}),
    rateLimit: (source) => {
      limited.push(source);
      return Promise.resolve();
    },
    timeoutMs: 10_000,
  };
  return { ctx, plain, cert, limited };
}

const ENDPOINT = 'VNifV2SOAP';

const VENDOR: CheckSubject = {
  subjectType: 'party',
  subjectKey: '11111111-1111-1111-1111-111111111111',
  partyId: '11111111-1111-1111-1111-111111111111',
  name: 'OBRES EXEMPLE BARNA SL',
  nif: 'B12345674',
};

/** A sole trader: DNI-shaped identifier, name given as a role placeholder, never a person's name. */
const SOLE_TRADER: CheckSubject = {
  subjectType: 'party',
  subjectKey: '22222222-2222-2222-2222-222222222222',
  partyId: '22222222-2222-2222-2222-222222222222',
  name: 'VENDOR SOLE TRADER PLACEHOLDER',
  nif: '12345678Z',
};

beforeEach(() => {
  resetRateLimiters();
});

describe('buildVnifEnvelope', () => {
  it('builds a SOAP 1.1 document/literal request with Nif and Nombre in the VNifV2Ent namespace', () => {
    const xml = buildVnifEnvelope([{ nif: 'B12345674', name: 'OBRES EXEMPLE & FILLS SL' }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(xml).toContain(`xmlns:vnif="${VNIF_ENT_NS}"`);
    expect(xml).toContain('<vnif:VNifV2Ent><vnif:Contribuyente><vnif:Nif>B12345674</vnif:Nif>');
    expect(xml).toContain('<vnif:Nombre>OBRES EXEMPLE &amp; FILLS SL</vnif:Nombre>');
    expect(xml).toContain('</vnif:VNifV2Ent></soapenv:Body></soapenv:Envelope>');
  });

  it('normalises the identifier to 9 upper-case characters without the ES prefix', () => {
    expect(vnifNif('es b-1234.5674')).toBe('B12345674');
    expect(vnifNif('1234567l')).toBe('01234567L');
    const xml = buildVnifEnvelope([{ nif: 'ES B12345674', name: 'X' }]);
    expect(xml).toContain('<vnif:Nif>B12345674</vnif:Nif>');
    expect(xml).not.toContain('ESB');
  });

  it('requires the name for a natural person (DNI, NIE) and accepts a legal person without one', () => {
    expect(() => buildVnifEnvelope([{ nif: '12345678Z' }])).toThrow(/requires the name/);
    expect(() => buildVnifEnvelope([{ nif: 'X1234567L', name: '   ' }])).toThrow(
      /requires the name/,
    );
    expect(
      buildVnifEnvelope([{ nif: '12345678Z', name: 'VENDOR SOLE TRADER PLACEHOLDER' }]),
    ).toContain('<vnif:Nombre>VENDOR SOLE TRADER PLACEHOLDER</vnif:Nombre>');
    expect(buildVnifEnvelope([{ nif: 'B12345674' }])).toContain('<vnif:Nombre></vnif:Nombre>');
  });

  it('refuses identifiers that do not normalise to 9 characters and an empty list', () => {
    expect(() => buildVnifEnvelope([{ nif: 'B123', name: 'X' }])).toThrow(/9 characters/);
    expect(() => buildVnifEnvelope([])).toThrow(/at least one/);
  });

  it('accepts several entries in one envelope, in order', () => {
    const xml = buildVnifEnvelope([
      { nif: 'B12345674', name: 'ONE SL' },
      { nif: 'A12345674', name: 'TWO SA' },
    ]);
    expect(xml.indexOf('B12345674')).toBeLessThan(xml.indexOf('A12345674'));
    expect(xml.match(/<vnif:Contribuyente>/g)).toHaveLength(2);
  });

  it('escapes the five XML metacharacters and collapses whitespace in names', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
    expect(cleanName('  OBRES   EXEMPLE\tSL ')).toBe('OBRES EXEMPLE SL');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(null)).toBeNull();
  });
});

describe('parseVnifResponse', () => {
  it('reads the identifier, the registered name and the result from the recorded response', () => {
    const parsed = parseVnifResponse(fixture('aeat-vnif-identificado.xml'));
    expect(parsed.fault).toBeNull();
    expect(parsed.rows).toEqual([
      { nif: 'B12345674', name: 'OBRES EXEMPLE BARNA SL', result: 'IDENTIFICADO' },
    ]);
  });

  it('accepts every documented result value, and normalises spacing and hyphenation', () => {
    for (const value of VNIF_RESULTS) {
      const parsed = parseVnifResponse(salEnvelope([{ nif: 'B12345674', result: value }]));
      expect(parsed.rows[0]?.result).toBe(value);
    }
    expect(normaliseVnifResult('identificado - baja')).toBe('IDENTIFICADO-BAJA');
    expect(normaliseVnifResult('  NO   IDENTIFICADO ')).toBe('NO IDENTIFICADO');
    expect(normaliseVnifResult('')).toBeNull();
    expect(normaliseVnifResult(undefined)).toBeNull();
  });

  it('reads several rows, with namespace prefixes, keeping their order', () => {
    const parsed = parseVnifResponse(fixture('aeat-vnif-multiple.xml'));
    expect(parsed.rows.map((r) => r.result)).toEqual([
      'NO IDENTIFICADO',
      'NO IDENTIFICADO-SIMILAR',
      'IDENTIFICADO-REVOCADO',
    ]);
    expect(parsed.rows[1]?.name).toBe('OBRES EXEMPLE BARNA 2000 SL');
    expect(parsed.rows[2]?.nif).toBe('A12345674');
  });

  it('keeps an identifier with leading zeros as text', () => {
    const parsed = parseVnifResponse(
      salEnvelope([{ nif: '00000010X', name: 'PLACEHOLDER', result: 'IDENTIFICADO' }]),
    );
    expect(parsed.rows[0]?.nif).toBe('00000010X');
  });

  it('reads a SOAP fault and yields no rows', () => {
    const parsed = parseVnifResponse(fixture('aeat-vnif-fault.xml'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.fault?.code).toBe('env:Client');
    expect(parsed.fault?.reason).toMatch(/no cumple el esquema/);
  });

  it('reads a SOAP 1.2 fault too', () => {
    const xml =
      '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>' +
      '<env:Code><env:Value>env:Receiver</env:Value></env:Code>' +
      '<env:Reason><env:Text xml:lang="es">Servicio no disponible</env:Text></env:Reason>' +
      '</env:Fault></env:Body></env:Envelope>';
    const parsed = parseVnifResponse(xml);
    expect(parsed.fault).toEqual({ code: 'env:Receiver', reason: 'Servicio no disponible' });
  });

  it('yields nothing for a body that is not the expected envelope', () => {
    expect(parseVnifResponse('<html><body>Error</body></html>')).toEqual({
      rows: [],
      fault: null,
    });
    expect(parseVnifResponse('')).toEqual({ rows: [], fault: null });
  });
});

describe('interpretVnif', () => {
  it('matches only on IDENTIFICADO, over the rows that name the identifier', () => {
    const { rows } = parseVnifResponse(fixture('aeat-vnif-multiple.xml'));
    const b = interpretVnif(rows, 'B12345674');
    expect(b.census_match).toBe(false);
    expect(b.result).toBe('NO IDENTIFICADO');
    expect(b.rows).toHaveLength(2);
    const a = interpretVnif(rows, 'A12345674');
    expect(a.census_match).toBe(false);
    expect(a.result).toBe('IDENTIFICADO-REVOCADO');
    expect(a.rows).toHaveLength(1);
  });

  it('prefers IDENTIFICADO when any of several rows says so', () => {
    const rows = [
      { nif: 'B12345674', name: 'OTHER SL', result: 'NO IDENTIFICADO-SIMILAR' },
      { nif: 'B12345674', name: 'OBRES EXEMPLE BARNA SL', result: 'IDENTIFICADO' },
    ];
    const v = interpretVnif(rows, 'b-12345674');
    expect(v.census_match).toBe(true);
    expect(v.result).toBe('IDENTIFICADO');
  });

  it('falls back to every row only when no row names any identifier, and lists values outside the vocabulary', () => {
    const v = interpretVnif([{ nif: null, name: null, result: 'ALGO NUEVO' }], 'B12345674');
    expect(v.rows).toHaveLength(1);
    expect(v.result).toBe('ALGO NUEVO');
    expect(v.unknown_results).toEqual(['ALGO NUEVO']);
    expect(v.census_match).toBe(false);
    expect(v.rows_for_other_identifiers).toBe(0);
  });

  it('never reads a row that names another identifier as the answer for the one sent', () => {
    const rows = [
      { nif: 'A12345674', name: 'OTHER SA', result: 'IDENTIFICADO' },
      { nif: 'X1234567L', name: null, result: 'IDENTIFICADO' },
    ];
    const v = interpretVnif(rows, 'B12345674');
    expect(v.census_match).toBe(false);
    expect(v.result).toBeNull();
    expect(v.rows).toEqual([]);
    expect(v.rows_for_other_identifiers).toBe(2);
    // A mixed answer: the identifier's own rows decide, the others are only counted.
    const mixed = interpretVnif(
      [...rows, { nif: 'B12345674', name: 'OBRES EXEMPLE BARNA SL', result: 'NO IDENTIFICADO' }],
      'B12345674',
    );
    expect(mixed.census_match).toBe(false);
    expect(mixed.result).toBe('NO IDENTIFICADO');
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.rows_for_other_identifiers).toBe(2);
  });
});

describe('aeat_census check', () => {
  it('is the registered aeat_census check and stays in the default vendor run', () => {
    const registered = checkByType('aeat_census');
    expect(registered).toBe(aeatCensus);
    expect(registered?.manual).toBe(false);
    expect(registered?.source).toBe(SOURCES.aeat_vnif.id);
    expect(VENDOR_DEFAULT_CHECKS).toContain('aeat_census');
    expect(SOURCES.aeat_vnif.perMinute).toBe(30);
    expect(SOURCES.aeat_vnif.verified).toBe(false);
    expect(MANUAL_SOURCES.aeat_census.url).toContain('G321');
  });

  it('raises the manual web-form route, unchanged, when no certificate transport is configured', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-identificado.xml') }], false);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.type).toBe('aeat_census');
    expect(r.status).toBe('manual_pending');
    expect(r.manual?.url).toBe(MANUAL_SOURCES.aeat_census.url);
    expect(r.manual?.url).toContain('G321');
    expect(r.manual?.query).toBe('B12345674');
    expect(r.manual?.evidence.length).toBeGreaterThan(0);
    expect(r.normalised.manual).toBe(true);
    expect(String(r.note)).toContain('VX_CLIENT_CERT_P12');
    expect(h.plain).toHaveLength(0);
    expect(h.cert).toHaveLength(0);
    expect(h.limited).toHaveLength(0);
  });

  it('queries the service through the certificate transport only, under the aeat_vnif limiter', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-identificado.xml') }]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('ok');
    expect(r.normalised.census_match).toBe(true);
    expect(r.normalised.result).toBe('IDENTIFICADO');
    expect(r.normalised.nif).toBe('B12345674');
    // A legal person's name is business data: the name sent and the registered name are kept.
    expect(r.normalised.name_sent).toBe('OBRES EXEMPLE BARNA SL');
    expect(r.normalised.name_registered).toBe('OBRES EXEMPLE BARNA SL');
    expect(r.normalised.natural_person).toBe(false);
    expect(r.normalised.source_verified).toBe(false);
    expect((r.normalised.manual as { url: string }).url).toContain('G321');
    expect(r.source_url).toBe(SOURCES.aeat_vnif.baseUrl);
    expect(r.cost_cents).toBe(0);
    expect(r.request?.endpoint).toBe(SOURCES.aeat_vnif.baseUrl);
    expect(r.request?.nif).toBe('B12345674');
    expect(r.request?.name_sent).toBe('OBRES EXEMPLE BARNA SL');
    expect(r.request?.natural_person).toBe(false);
    expect(r.note).toBeUndefined();

    expect(h.plain).toHaveLength(0);
    expect(h.cert).toHaveLength(1);
    expect(h.limited).toEqual(['aeat_vnif']);
    const call = h.cert[0] as Seen;
    expect(call.url).toBe(SOURCES.aeat_vnif.baseUrl);
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers?.['Content-Type']).toMatch(/^text\/xml/);
    expect(call.init?.headers?.SOAPAction).toBe('""');
    expect(call.init?.body).toContain('<vnif:Nif>B12345674</vnif:Nif>');
    expect(call.init?.body).toContain('<vnif:Nombre>OBRES EXEMPLE BARNA SL</vnif:Nombre>');
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    // A legal person's response is archived in full.
    expect(String((r.raw as { body: string }).body)).toContain(
      '<Resultado>IDENTIFICADO</Resultado>',
    );
  });

  it('reports NO IDENTIFICADO as an answer to verify, not as an error', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-no-identificado.xml') }]);
    const r = await aeatCensus.run(
      { ...VENDOR, nif: 'A12345674', name: 'SERVEIS EXEMPLE DE PROVA SA' },
      h.ctx,
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.census_match).toBe(false);
    expect(r.normalised.result).toBe('NO IDENTIFICADO');
    expect(String(r.normalised.note)).toMatch(/To verify, not a conclusion/);
    expect(String(r.note)).toMatch(/Re-read both/);
  });

  it('reports IDENTIFICADO-BAJA with census_match false and the result kept', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-baja.xml') }]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('ok');
    expect(r.normalised.census_match).toBe(false);
    expect(r.normalised.result).toBe('IDENTIFICADO-BAJA');
    expect(r.normalised.name_registered).toBe('OBRES EXEMPLE BARNA SL');
  });

  it('keeps several rows for one identifier and lets IDENTIFICADO on any of them count', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-multiple.xml') }]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('ok');
    expect(r.normalised.census_match).toBe(false);
    expect(r.normalised.result).toBe('NO IDENTIFICADO');
    expect(r.normalised.rows).toHaveLength(2);
  });

  it('stores the outcome only for a natural person: no archived body, no echoed name, no name sent on the row', async () => {
    const h = harness([
      {
        match: ENDPOINT,
        body: salEnvelope([
          { nif: '12345678Z', name: 'VENDOR SOLE TRADER PLACEHOLDER', result: 'IDENTIFICADO' },
        ]),
      },
    ]);
    const r = await aeatCensus.run(SOLE_TRADER, h.ctx);
    expect(r.status).toBe('ok');
    expect(r.normalised.census_match).toBe(true);
    expect(r.normalised.natural_person).toBe(true);
    expect(r.normalised.name_registered).toBeNull();
    expect('name_sent' in r.normalised).toBe(false);
    expect(r.normalised.rows).toEqual([{ nif: '12345678Z', name: null, result: 'IDENTIFICADO' }]);
    // Neither the persisted request nor the normalised payload carries the person's name: both
    // columns of external_checks travel into the data room.
    expect(r.request?.natural_person).toBe(true);
    expect('name_sent' in (r.request ?? {})).toBe(false);
    expect(JSON.stringify(r.request)).not.toContain('PLACEHOLDER');
    expect(JSON.stringify(r.normalised)).not.toContain('PLACEHOLDER');
    expect(JSON.stringify(r.raw)).not.toContain('PLACEHOLDER');
    expect(JSON.stringify(r.raw)).not.toContain('<Resultado>');
    expect((r.raw as { redacted: string }).redacted).toMatch(/natural person/);
    // The name was still sent, as the service requires for a natural person.
    expect((h.cert[0] as Seen).init?.body).toContain('VENDOR SOLE TRADER PLACEHOLDER');
  });

  it('keeps the name out of an error row for a natural person too', async () => {
    const h = harness([{ match: ENDPOINT, status: 500, body: fixture('aeat-vnif-fault.xml') }]);
    const r = await aeatCensus.run(SOLE_TRADER, h.ctx);
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.request)).not.toContain('PLACEHOLDER');
    expect(JSON.stringify(r.normalised)).not.toContain('PLACEHOLDER');
    expect(JSON.stringify(r.raw)).not.toContain('PLACEHOLDER');
    // Before anything is sent as well: a misread natural-person identifier.
    const bad = await aeatCensus.run({ ...SOLE_TRADER, nif: '12345678A' }, h.ctx);
    expect(bad.status).toBe('error');
    expect(String(bad.normalised.error)).toMatch(/check digit/);
    expect(bad.request?.natural_person).toBe(true);
    expect(JSON.stringify(bad.request)).not.toContain('PLACEHOLDER');
    expect(h.cert).toHaveLength(1);
  });

  it('reports rows that name another identifier as an error, never as the party’s result', async () => {
    const h = harness([
      {
        match: ENDPOINT,
        body: salEnvelope([{ nif: 'A12345674', name: 'OTHER SA', result: 'IDENTIFICADO' }]),
      },
    ]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(
      /1 row\(s\) for other identifiers and none for B12345674/,
    );
    expect(r.normalised.census_match).toBeUndefined();
    expect(r.normalised.rows_for_other_identifiers).toBe(1);
    expect((r.normalised.manual as { url: string }).url).toContain('G321');
  });

  it('does not query for a natural person without a recorded name', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-identificado.xml') }]);
    const r = await aeatCensus.run({ ...SOLE_TRADER, name: null }, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/requires the name/);
    expect(r.normalised.manual).toBeDefined();
    expect(h.cert).toHaveLength(0);
  });

  it('does not send an identifier that fails its check digit', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-identificado.xml') }]);
    const r = await aeatCensus.run({ ...VENDOR, nif: 'B12345670' }, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/check digit/);
    expect(r.normalised.source_verified).toBe(false);
    expect(h.cert).toHaveLength(0);
    expect(h.limited).toHaveLength(0);
  });

  it('records the absence of an identifier as not_found without calling out', async () => {
    const h = harness([{ match: ENDPOINT, body: fixture('aeat-vnif-identificado.xml') }]);
    const r = await aeatCensus.run({ ...VENDOR, nif: null }, h.ctx);
    expect(r.status).toBe('not_found');
    expect(r.normalised.census_match).toBeNull();
    expect(h.cert).toHaveLength(0);
  });

  it('turns a rejected certificate (HTTP 401) into an error result naming the cause', async () => {
    const h = harness([
      {
        match: ENDPOINT,
        status: 401,
        body: 'Se ha producido un error al verificar el certificado presentado',
      },
    ]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/rejected the client certificate \(HTTP 401\)/);
    expect(String(r.normalised.error)).toContain('VX_CLIENT_CERT_P12');
    expect((r.normalised.manual as { url: string }).url).toContain('G321');
    expect(r.request?.endpoint).toBe(SOURCES.aeat_vnif.baseUrl);
  });

  it('turns a SOAP fault (HTTP 500) into an error result that keeps the fault', async () => {
    const h = harness([{ match: ENDPOINT, status: 500, body: fixture('aeat-vnif-fault.xml') }]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/SOAP fault env:Client: .*no cumple el esquema/);
    expect((r.raw as { fault: { code: string } }).fault.code).toBe('env:Client');
    expect((r.raw as { http_status: number }).http_status).toBe(500);
  });

  it('reports a body without Resultado as an error rather than guessing', async () => {
    const h = harness([{ match: ENDPOINT, body: '<html><body>Mantenimiento</body></html>' }]);
    const r = await aeatCensus.run(VENDOR, h.ctx);
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toMatch(/no VNifV2Sal\/Contribuyente\/Resultado/);
    expect((r.raw as { body: string }).body).toContain('Mantenimiento');
  });

  it('reports other HTTP statuses and transport failures as error results, never throwing', async () => {
    const forbidden = harness([{ match: ENDPOINT, status: 403, body: 'Forbidden' }]);
    const r1 = await aeatCensus.run(VENDOR, forbidden.ctx);
    expect(r1.status).toBe('error');
    expect(String(r1.normalised.error)).toMatch(/HTTP 403/);

    const h = harness([]);
    const r2 = await aeatCensus.run(VENDOR, {
      ...h.ctx,
      certFetch: () => Promise.reject(new Error('ECONNRESET')),
    });
    expect(r2.status).toBe('error');
    expect(String(r2.normalised.error)).toContain('ECONNRESET');
    expect(r2.normalised.manual).toBeDefined();
    expect(r2.normalised.source_verified).toBe(false);
  });
});

describe('fetchText', () => {
  it('uses the transport given in the options, passes method, headers, body and a signal, and returns the text', async () => {
    const plain: Seen[] = [];
    const cert: Seen[] = [];
    const ctx: CheckContext = {
      cid: 'c',
      fetch: textFetch([], plain),
      rateLimit: () => Promise.resolve(),
    };
    const res = await fetchText(ctx, 'https://example.invalid/soap', {
      source: 'aeat_vnif',
      fetch: textFetch([{ match: '/soap', body: '<ok/>' }], cert),
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: '<req/>',
    });
    expect(res).toEqual({ status: 200, url: 'https://example.invalid/soap', text: '<ok/>' });
    expect(plain).toHaveLength(0);
    const call = cert[0] as Seen;
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe('<req/>');
    expect(call.init?.headers).toEqual({ 'Content-Type': 'text/xml' });
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws HttpError for a status that is not allowed and returns allowed ones', async () => {
    const ctx: CheckContext = {
      cid: 'c',
      fetch: textFetch([{ match: '/x', status: 500, body: 'fault' }]),
      rateLimit: () => Promise.resolve(),
    };
    await expect(
      fetchText(ctx, 'https://example.invalid/x', { source: 's' }),
    ).rejects.toBeInstanceOf(HttpError);
    const allowed = await fetchText(ctx, 'https://example.invalid/x', {
      source: 's',
      allowStatus: [500],
    });
    expect(allowed.status).toBe(500);
    expect(allowed.text).toBe('fault');
  });
});
