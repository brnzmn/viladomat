/**
 * `rea` — the public lookup form: page parser, form helpers and the check itself, all against
 * synthetic fixtures. No test touches the network: `ctx.fetch` answers the GET with the form
 * page (and a cookie) and the POST with a result page, and the rate limiter is stubbed.
 *
 * Fixture identifiers pass the check digit but belong to no one (B12345674, A12345674,
 * 12345678Z, X1234567L); the registered name is a fictional company; the natural-person page
 * carries a role placeholder, never a name.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateNif } from '@viladomat/core';
import { REPO_ROOT } from '../../lib/env.ts';
import { MANUAL_SOURCES, SOURCES } from '../config.ts';
import { resetRateLimiters } from '../http.ts';
import type {
  CheckContext,
  CheckSubject,
  FetchLike,
  HttpRequestInit,
  HttpResponse,
} from '../types.ts';
import {
  buildReaForm,
  communityIn,
  cookieHeaderFrom,
  decodeEntities,
  entriesFromTable,
  extractHiddenInputs,
  extractTable,
  parseReaPage,
  rea,
  REA_ID_TYPES,
  REA_MARKERS,
  reaColumnOf,
  reaIdType,
  reaLookup,
  statusMarker,
  stripTags,
} from './rea.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

interface Seen {
  url: string;
  init: HttpRequestInit | undefined;
}

/** A `fetch` that answers the GET with the form page and the POST with the result page. */
function reaFetch(
  pages: { form?: string; result: string; status?: number; cookie?: string | null },
  seen: Seen[] = [],
): FetchLike {
  return (url: string, init?: HttpRequestInit) => {
    seen.push({ url, init });
    const post = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const body = post ? pages.result : (pages.form ?? fixture('rea-form.html'));
    const status = post ? (pages.status ?? 200) : 200;
    const cookie =
      pages.cookie === undefined
        ? 'JSESSIONID=fixture123; Path=/rea; HttpOnly, TS01abc=def; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT'
        : pages.cookie;
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => (!post && name.toLowerCase() === 'set-cookie' ? cookie : null),
      },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(res);
  };
}

/**
 * A context whose register has verified the REA form, as the runner builds it once the probe has
 * run (`withSourceGate`); `verified: false` is the bare context the check refuses to call out from.
 */
function ctxWith(fetch: FetchLike, verified: boolean | 'other' = true): CheckContext {
  return {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch,
    rateLimit: () => Promise.resolve(),
    timeoutMs: 10_000,
    ...(verified === true
      ? { sourceVerified: (id: string) => id === 'rea' }
      : verified === 'other'
        ? { sourceVerified: (id: string) => id === 'rasic' }
        : {}),
  };
}

const VENDOR: CheckSubject = {
  subjectType: 'party',
  subjectKey: '11111111-1111-1111-1111-111111111111',
  partyId: '11111111-1111-1111-1111-111111111111',
  name: 'OBRES EXEMPLE BARNA, S.L.',
  nif: 'B12345674',
};

/** A result page for a natural person: same table, a role placeholder instead of a name. */
const NATURAL_PERSON_PAGE = fixture('rea-registered.html')
  .replace('OBRES EXEMPLE BARNA, S.L.', 'PERSONA FÍSICA EXEMPLE (ROLE PLACEHOLDER)')
  .replace(/B12345674/g, '12345678Z');

beforeEach(() => {
  resetRateLimiters();
});

describe('form helpers', () => {
  it('maps a validated identifier onto the form’s identifier type', () => {
    expect(reaIdType(validateNif('B12345674'))).toBe(REA_ID_TYPES.CIF);
    expect(reaIdType(validateNif('12345678Z'))).toBe(REA_ID_TYPES.NIF);
    expect(reaIdType(validateNif('X1234567L'))).toBe(REA_ID_TYPES.NIE);
    expect(reaIdType(validateNif('B12345670'))).toBeNull();
  });

  it('reads the hidden inputs of the form page and sends them back with the search', () => {
    const hidden = extractHiddenInputs(fixture('rea-form.html'));
    expect(hidden).toEqual({ idioma: 'es', _token: 'fixture-token-0001' });
    const body = new URLSearchParams(buildReaForm(hidden, '3', 'B12345674'));
    expect(body.get('idioma')).toBe('es');
    expect(body.get('_token')).toBe('fixture-token-0001');
    expect(body.get('tipoIdentificacion')).toBe('3');
    expect(body.get('numIdentificacion')).toBe('B12345674');
    expect(body.get('submitButton_mostrar')).toBe('Mostrar');
    // A stale hidden copy of a search field never overrides the search.
    expect(
      new URLSearchParams(buildReaForm({ numIdentificacion: 'OLD' }, '1', '12345678Z')).get(
        'numIdentificacion',
      ),
    ).toBe('12345678Z');
  });

  it('turns a joined Set-Cookie header into a Cookie header, ignoring attributes and Expires commas', () => {
    expect(
      cookieHeaderFrom(
        'JSESSIONID=abc123; Path=/rea; HttpOnly, TS01=xyz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      ),
    ).toBe('JSESSIONID=abc123; TS01=xyz');
    expect(cookieHeaderFrom(null)).toBeNull();
    expect(cookieHeaderFrom('Path=/')).toBeNull();
  });

  it('decodes entities and strips markup', () => {
    expect(decodeEntities('Catalu&ntilde;a &amp; Arag&oacute;n &#241; &#x00F1;')).toBe(
      'Cataluña & Aragón ñ ñ',
    );
    expect(stripTags('<p>Uno<br/>dos</p><script>x()</script><td>tres</td>')).toBe('Uno dos\ntres');
  });

  it('recognises the expected column headings whatever their accents and casing', () => {
    expect(reaColumnOf('Nº REA')).toBe('number');
    expect(reaColumnOf('Número de inscripción')).toBe('number');
    expect(reaColumnOf('Razón social')).toBe('name');
    expect(reaColumnOf('NIF/CIF')).toBe('nif');
    expect(reaColumnOf('Comunidad Autónoma')).toBe('community');
    expect(reaColumnOf('Fecha de inscripción')).toBe('from');
    expect(reaColumnOf('Fecha de vencimiento')).toBe('to');
    expect(reaColumnOf('Estado')).toBe('status');
    expect(reaColumnOf('Ingeniería')).toBeNull();
    expect(communityIn('Comunitat Valenciana')).toBe('Comunitat Valenciana');
    expect(communityIn('sin comunidad')).toBeNull();
  });
});

describe('result-page parser', () => {
  it('reads a registered company from the column layout of tabla-consulta', () => {
    const parsed = parseReaPage(fixture('rea-registered.html'));
    expect(parsed.table_found).toBe(true);
    expect(parsed.registered).toBe(true);
    expect(parsed.registration_number).toBe('09/08/0004567');
    expect(parsed.community).toBe('Cataluña');
    expect(parsed.valid_from).toBe('2022-05-12');
    expect(parsed.valid_to).toBe('2025-05-12');
    expect(parsed.raw_status_text).toBe('Inscrita');
    expect(parsed.name).toBe('OBRES EXEMPLE BARNA, S.L.');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.nif).toBe('B12345674');
    expect(parsed.unread).toEqual([]);
  });

  it('reads the empty result as not registered, keeping the sentence it was read from', () => {
    const parsed = parseReaPage(fixture('rea-not-found.html'));
    expect(parsed.registered).toBe(false);
    expect(parsed.registration_number).toBeNull();
    expect(parsed.raw_status_text).toMatch(/^No existe ningún registro/);
    expect(parsed.unread).toEqual([]);
  });

  it('reads a label/value layout and lists the fields the page did not carry', () => {
    const html =
      '<table id="tabla-consulta">' +
      '<tr><th>Número de inscripción</th><td>09/08/0004567</td></tr>' +
      '<tr><th>Comunidad Autónoma</th><td>Cataluña</td></tr>' +
      '<tr><th>Fecha de inscripción</th><td>12/05/2022</td></tr>' +
      '<tr><th>Estado</th><td>Empresa inscrita</td></tr>' +
      '</table>';
    const table = extractTable(html, 'tabla-consulta');
    expect(table?.rows).toHaveLength(4);
    expect(entriesFromTable(table as NonNullable<typeof table>)[0]?.registration_number).toBe(
      '09/08/0004567',
    );
    const parsed = parseReaPage(html);
    expect(parsed.registered).toBe(true);
    expect(parsed.valid_from).toBe('2022-05-12');
    expect(parsed.valid_to).toBeNull();
    expect(parsed.raw_status_text).toBe('Empresa inscrita');
    expect(parsed.unread).toEqual(['valid_to']);
  });

  it('falls back to the text when the page has no table but states the registration', () => {
    const parsed = parseReaPage(
      '<div class="resultado">La empresa figura inscrita con el número 09/08/0001234 en Cataluña desde el 01/02/2020 hasta el 01/02/2023.</div>',
    );
    expect(parsed.table_found).toBe(false);
    expect(parsed.registered).toBe(true);
    expect(parsed.registration_number).toBe('09/08/0001234');
    expect(parsed.community).toBe('Cataluña');
    expect(parsed.valid_from).toBe('2020-02-01');
    expect(parsed.valid_to).toBe('2023-02-01');
  });

  it('reports the markers it could not find on an unexpected page instead of answering', () => {
    const parsed = parseReaPage('<html><body><h1>Servicio en mantenimiento</h1></body></html>');
    expect(parsed.registered).toBeNull();
    expect(parsed.unread).toEqual([
      REA_MARKERS.table,
      REA_MARKERS.registered,
      REA_MARKERS.notFound,
    ]);
  });
});

describe('the gate', () => {
  it('refuses to call out while the register has not verified the form, and offers the manual route', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      VENDOR,
      ctxWith(reaFetch({ result: fixture('rea-registered.html') }, seen), false),
    );
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toMatch(/not verified/);
    expect(String(r.normalised.note)).toContain('vx vendors sources probe --source rea');
    expect(r.normalised.registered).toBeNull();
    expect(r.normalised.source_verified).toBe(false);
    expect(r.normalised.searched).toEqual({ nif: 'B12345674', id_type: '3' });
    expect((r.normalised.manual as { url: string; query: string }).url).toBe(
      MANUAL_SOURCES.rea.url,
    );
    expect((r.normalised.manual as { url: string; query: string }).query).toBe('CIF B12345674');
    expect(r.raw).toEqual({ skipped: true, reason: 'source_unverified' });
    expect(r.request?.nif).toBe('B12345674');
    expect(r.request?.natural_person).toBe(false);
  });

  it('stays closed when the register verifies other sources only', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      VENDOR,
      ctxWith(reaFetch({ result: fixture('rea-registered.html') }, seen), 'other'),
    );
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
  });

  it('validates the identifier before the gate, so a misread identifier is reported as such', async () => {
    const seen: Seen[] = [];
    const bad = await rea.run(
      { ...VENDOR, nif: 'B12345670' },
      ctxWith(reaFetch({ result: '' }, seen), false),
    );
    expect(bad.status).toBe('error');
    expect(String(bad.normalised.error)).toMatch(/check digit/);
    const none = await rea.run(
      { ...VENDOR, nif: null },
      ctxWith(reaFetch({ result: '' }, seen), false),
    );
    expect(none.status).toBe('not_found');
    expect(seen).toHaveLength(0);
  });

  it('lets the probe exercise the form through reaLookup while the register still says unverified', async () => {
    const seen: Seen[] = [];
    const r = await reaLookup(
      VENDOR,
      ctxWith(reaFetch({ result: fixture('rea-registered.html') }, seen), false),
      {
        sourceVerified: true,
      },
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(r.normalised.registered).toBe(true);
    // The module constant still says unverified: only the register (through the runner) says otherwise.
    expect(r.normalised.source_verified).toBe(false);
  });
});

describe('the check', () => {
  it('GETs the form, then POSTs the identifier with the page’s cookie and hidden fields, and reads the registration', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      VENDOR,
      ctxWith(reaFetch({ result: fixture('rea-registered.html') }, seen)),
    );
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe(SOURCES.rea.baseUrl);
    expect((seen[0]?.init?.method ?? 'GET').toUpperCase()).toBe('GET');
    const post = seen[1];
    expect(post?.url).toBe(SOURCES.rea.baseUrl);
    expect(post?.init?.method).toBe('POST');
    expect(post?.init?.headers?.['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(post?.init?.headers?.Cookie).toBe('JSESSIONID=fixture123; TS01abc=def');
    const body = new URLSearchParams(post?.init?.body ?? '');
    expect(body.get('tipoIdentificacion')).toBe('3');
    expect(body.get('numIdentificacion')).toBe('B12345674');
    expect(body.get('submitButton_mostrar')).toBe('Mostrar');
    expect(body.get('_token')).toBe('fixture-token-0001');

    expect(r.normalised).toMatchObject({
      registered: true,
      registration_number: '09/08/0004567',
      community: 'Cataluña',
      valid_from: '2022-05-12',
      valid_to: '2025-05-12',
      raw_status_text: 'Inscrita',
      name: 'OBRES EXEMPLE BARNA, S.L.',
      natural_person: false,
      source_verified: false,
    });
    expect((r.normalised.manual as { url: string }).url).toBe(MANUAL_SOURCES.rea.url);
    expect((r.raw as { body: string }).body).toContain('tabla-consulta');
    expect(r.request?.id_type).toBe('3');
    expect(r.request?.form_fields).toEqual(['idioma', '_token']);
    expect(r.note).toBeUndefined();
  });

  it('works without a cookie or hidden fields, sending only the search', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      VENDOR,
      ctxWith(
        reaFetch(
          {
            form: '<html><body><form></form></body></html>',
            result: fixture('rea-registered.html'),
            cookie: null,
          },
          seen,
        ),
      ),
    );
    expect(r.status).toBe('ok');
    expect(seen[1]?.init?.headers?.Cookie).toBeUndefined();
    expect(new URLSearchParams(seen[1]?.init?.body ?? '').toString()).toBe(
      'tipoIdentificacion=3&numIdentificacion=B12345674&submitButton_mostrar=Mostrar',
    );
  });

  it('keeps only the outcome for a natural person: no name, no archived page', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      { ...VENDOR, nif: '12345678Z', name: null },
      ctxWith(reaFetch({ result: NATURAL_PERSON_PAGE }, seen)),
    );
    expect(r.status).toBe('ok');
    expect(new URLSearchParams(seen[1]?.init?.body ?? '').get('tipoIdentificacion')).toBe('1');
    expect(r.normalised.natural_person).toBe(true);
    expect(r.normalised.registered).toBe(true);
    expect(r.normalised.registration_number).toBe('09/08/0004567');
    expect('name' in r.normalised).toBe(false);
    expect((r.normalised.entries as Array<{ name: unknown }>)[0]?.name).toBeNull();
    expect((r.raw as { redacted?: string }).redacted).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('PERSONA F');
  });

  it('reduces a natural person’s status text to the marker when the page states the registration in a sentence', async () => {
    // No result table: the registration is stated in prose that carries the name.
    const page =
      '<html><body><p>La persona PERSONA FÍSICA EXEMPLE (ROLE PLACEHOLDER), con NIF 12345678Z, figura inscrita en el REA ' +
      'con el n&uacute;mero 09/08/0004567 (Catalu&ntilde;a) desde 12/05/2022 hasta 12/05/2025.</p></body></html>';
    const r = await rea.run(
      { ...VENDOR, nif: '12345678Z', name: null },
      ctxWith(reaFetch({ result: page })),
    );
    expect(r.status).toBe('ok');
    expect(r.normalised.registered).toBe(true);
    expect(r.normalised.registration_number).toBe('09/08/0004567');
    expect(r.normalised.raw_status_text).toBe('inscrita');
    expect((r.normalised.entries as Array<{ status_text: unknown }>)[0]?.status_text).toBe(
      'inscrita',
    );
    expect(JSON.stringify(r)).not.toContain('PERSONA F');
    // A company's status sentence is kept as printed.
    const company = await rea.run(
      VENDOR,
      ctxWith(reaFetch({ result: page.replace('12345678Z', 'B12345674') })),
    );
    expect(String(company.normalised.raw_status_text)).toContain('figura inscrita');
    // The not-found marker for a natural person.
    const none = await rea.run(
      { ...VENDOR, nif: '12345678Z' },
      ctxWith(reaFetch({ result: fixture('rea-not-found.html') })),
    );
    expect(none.normalised.raw_status_text).toBe(REA_MARKERS.notFound);
    expect(statusMarker({ registered: null, raw_status_text: null })).toBeNull();
    expect(statusMarker({ registered: true, raw_status_text: 'Empresa acreditada' })).toBe(
      'acreditada',
    );
    expect(statusMarker({ registered: true, raw_status_text: null })).toBe(REA_MARKERS.registered);
  });

  it('sends a NIE as identifier type 2', async () => {
    const seen: Seen[] = [];
    await rea.run(
      { ...VENDOR, nif: 'X1234567L' },
      ctxWith(reaFetch({ result: fixture('rea-not-found.html') }, seen)),
    );
    expect(new URLSearchParams(seen[1]?.init?.body ?? '').get('tipoIdentificacion')).toBe('2');
  });

  it('records the empty result as not_found with the non-exculpatory note and the manual route', async () => {
    const r = await rea.run(
      { ...VENDOR, nif: 'A12345674' },
      ctxWith(reaFetch({ result: fixture('rea-not-found.html') })),
    );
    expect(r.status).toBe('not_found');
    expect(r.normalised.registered).toBe(false);
    expect(String(r.normalised.raw_status_text)).toMatch(/No existe ningún registro/);
    expect(String(r.normalised.note)).toMatch(/Not exculpatory/);
    expect((r.normalised.manual as { query: string }).query).toBe('CIF A12345674');
    expect((r.raw as { body: string }).body).toContain('tabla-consulta');
  });

  it('returns an error listing the unread markers when the page is not the expected one', async () => {
    const r = await rea.run(
      VENDOR,
      ctxWith(reaFetch({ result: '<html><body><h1>Servicio en mantenimiento</h1></body></html>' })),
    );
    expect(r.status).toBe('error');
    expect(String(r.normalised.error)).toContain(REA_MARKERS.table);
    expect(r.normalised.unread).toEqual([
      REA_MARKERS.table,
      REA_MARKERS.registered,
      REA_MARKERS.notFound,
    ]);
    expect(r.normalised.registered).toBeNull();
    expect(r.normalised.manual).toBeDefined();
  });

  it('does not send an identifier that fails its check digit', async () => {
    const seen: Seen[] = [];
    const r = await rea.run(
      { ...VENDOR, nif: 'B12345670' },
      ctxWith(reaFetch({ result: '' }, seen)),
    );
    expect(r.status).toBe('error');
    expect(seen).toHaveLength(0);
    expect(String(r.normalised.error)).toMatch(/check digit/);
    expect(r.normalised.manual).toBeDefined();
  });

  it('records the absence of an identifier as not_found: the form searches by identifier only', async () => {
    const seen: Seen[] = [];
    const r = await rea.run({ ...VENDOR, nif: null }, ctxWith(reaFetch({ result: '' }, seen)));
    expect(r.status).toBe('not_found');
    expect(seen).toHaveLength(0);
    expect(r.normalised.registered).toBeNull();
  });

  it('turns an HTTP failure or a transport failure into an error result with the manual route', async () => {
    const http = await rea.run(VENDOR, ctxWith(reaFetch({ result: 'busy', status: 503 })));
    expect(http.status).toBe('error');
    expect(String(http.normalised.error)).toContain('HTTP 503');
    const transport = await rea.run(
      VENDOR,
      ctxWith(() => Promise.reject(new Error('ECONNRESET'))),
    );
    expect(transport.status).toBe('error');
    expect(String(transport.normalised.error)).toContain('ECONNRESET');
    expect((transport.normalised.manual as { url: string }).url).toBe(MANUAL_SOURCES.rea.url);
    expect(transport.normalised.source_verified).toBe(false);
  });
});
