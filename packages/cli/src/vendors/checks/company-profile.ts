/**
 * `company_profile` — registry profile of a vendor entity: registered address, incorporation
 * date, share capital, CNAE activity, current officers and the timeline of gazette entries.
 *
 * Route: OpenMercantil, an aggregator of the official gazette (`SOURCES.openmercantil`,
 * `https://openmercantil.es/api/v1`), searched by NIF and, failing that, by name:
 * `GET /search?q=…&limit=5` (answering `{ query, count, offset, items, _attributions }`), then
 * `GET /company/{slug}` and, when the detail does not carry them, `/company/{slug}/officers` and
 * `/company/{slug}/events`. The paths come from the provider's published OpenAPI as read by the
 * research report; **the field names inside the objects are still to verify**, so the parser
 * accepts several plausible spellings of each field and lists what it could not read in
 * `normalised.unread`, and a wrong guess surfaces as a gap rather than as a wrong figure. An
 * optional API key (`VX_OPENMERCANTIL_API_KEY`, header `X-API-Key`) raises the quota; without it
 * the provider reports 200 requests per day and IP. The licence (CC BY 4.0) requires attribution:
 * `_attributions` is kept with every row. When the route fails, the result carries the manual
 * fallback (the provider's site or the BORME buscador) with the search terms to type.
 *
 * Officer names are natural-person data. They are written to `entity_officers` and stay there:
 * outside the reviewer screen they are rendered as a role and initials.
 */
import { normaliseCompanyName, normaliseName, tokenSetSimilarity } from '@viladomat/core';
import { envOptional } from '../../lib/env.ts';
import { OPENMERCANTIL_API_KEY_VAR, SOURCES } from '../config.ts';
import { asArray, asIsoDate, asNumber, asString, fetchJson, firstOf, qs } from '../http.ts';
import {
  errorResult,
  type CheckContext,
  type CheckResult,
  type CheckSubject,
  type VendorCheck,
} from '../types.ts';

/** One officer as published in the gazette. */
export interface ProfileOfficer {
  name: string;
  name_norm: string;
  cargo: string | null;
  date_from: string | null;
  date_to: string | null;
  borme_ref: Record<string, unknown> | null;
}

/** One entry of the gazette timeline. */
export interface ProfileEvent {
  date: string | null;
  type: string | null;
  text: string | null;
  borme_ref: Record<string, unknown> | null;
}

export interface CompanyProfile {
  name: string | null;
  name_norm: string | null;
  nif: string | null;
  address: string | null;
  postcode: string | null;
  municipality: string | null;
  incorporation_date: string | null;
  capital_eur: number | null;
  cnae: string | null;
  cnae_label: string | null;
  status: string | null;
  officers: ProfileOfficer[];
  events: ProfileEvent[];
  /** Fields the parser could not find under any accepted key. */
  unread: string[];
}

const NAME_KEYS = [
  'name',
  'nombre',
  'denominacion',
  'denominacion_social',
  'razon_social',
  'company_name',
  'title',
];
const NIF_KEYS = ['nif', 'cif', 'nif_cif', 'tax_id', 'identificador'];
const ADDRESS_KEYS = [
  'address',
  'domicilio',
  'domicilio_social',
  'direccion',
  'registered_address',
  'adreca',
];
const POSTCODE_KEYS = ['postcode', 'postal_code', 'codigo_postal', 'cp'];
const CITY_KEYS = ['municipality', 'municipio', 'city', 'localidad', 'poblacion'];
const INCORP_KEYS = [
  'incorporation_date',
  'fecha_constitucion',
  'constitucion',
  'date_incorporated',
  'fecha_alta',
  'founded',
];
const CAPITAL_KEYS = ['capital', 'capital_social', 'share_capital', 'capital_eur'];
const CNAE_KEYS = ['cnae', 'cnae_code', 'codigo_cnae', 'actividad_cnae', 'sic'];
const CNAE_LABEL_KEYS = [
  'cnae_label',
  'cnae_descripcion',
  'actividad',
  'objeto_social',
  'activity',
];
const STATUS_KEYS = ['status', 'situacion', 'estado', 'situacion_registral'];
const OFFICERS_KEYS = [
  'officers',
  'cargos',
  'administradores',
  'directors',
  'organos',
  'appointments',
];
const EVENTS_KEYS = ['events', 'acts', 'actos', 'borme', 'anuncios', 'timeline', 'historial'];
// The slug is what the detail path takes; a numeric id is the fallback.
const ID_KEYS = ['slug', 'id', 'company_id', 'uid', 'ref'];
const ROLE_KEYS = ['role', 'cargo', 'position', 'tipo_cargo'];
const FROM_KEYS = ['from', 'date_from', 'fecha_nombramiento', 'fecha_inicio', 'desde', 'fecha'];
const TO_KEYS = ['to', 'date_to', 'fecha_cese', 'fecha_fin', 'hasta'];
const RESULT_KEYS = ['results', 'data', 'items', 'companies', 'empresas', 'hits'];

function bormeRef(o: unknown): Record<string, unknown> | null {
  const seccion = asString(firstOf(o, ['seccion', 'section', 'borme_seccion']));
  const fecha = asIsoDate(
    firstOf(o, ['borme_fecha', 'fecha_borme', 'published_at', 'fecha_publicacion', 'fecha']),
  );
  const num = asString(firstOf(o, ['borme_num', 'num_borme', 'numero', 'issue']));
  const pagina = asString(firstOf(o, ['pagina', 'page', 'borme_pagina']));
  const anuncio = asString(firstOf(o, ['anuncio', 'announcement', 'registro', 'num_anuncio']));
  const ref: Record<string, unknown> = {};
  if (seccion) ref.seccion = seccion;
  if (fecha) ref.fecha = fecha;
  if (num) ref.num = num;
  if (pagina) ref.pagina = pagina;
  if (anuncio) ref.anuncio = anuncio;
  return Object.keys(ref).length > 0 ? ref : null;
}

function parseOfficer(o: unknown): ProfileOfficer | null {
  const name = asString(firstOf(o, NAME_KEYS) ?? firstOf(o, ['persona', 'person', 'full_name']));
  if (!name) return null;
  return {
    name,
    name_norm: normaliseName(name),
    cargo: asString(firstOf(o, ROLE_KEYS)),
    date_from: asIsoDate(firstOf(o, FROM_KEYS)),
    date_to: asIsoDate(firstOf(o, TO_KEYS)),
    borme_ref: bormeRef(o),
  };
}

function parseEvent(o: unknown): ProfileEvent | null {
  if (typeof o === 'string') return { date: null, type: null, text: o, borme_ref: null };
  const date = asIsoDate(firstOf(o, ['date', 'fecha', 'fecha_publicacion', 'published_at']));
  const type = asString(firstOf(o, ['type', 'tipo', 'acto', 'act', 'concepto']));
  const text = asString(firstOf(o, ['text', 'texto', 'descripcion', 'description', 'detalle']));
  if (!date && !type && !text) return null;
  return { date, type, text, borme_ref: bormeRef(o) };
}

/**
 * Turn a provider payload into the neutral profile shape. Exported so the parser can be tested
 * against a recorded fixture without any transport.
 */
export function parseCompanyProfile(payload: unknown): CompanyProfile {
  const body = (firstOf(payload, ['company', 'empresa', 'result', 'data']) ?? payload) as unknown;
  const unread: string[] = [];
  const take = <T>(label: string, value: T | null): T | null => {
    if (value === null || value === undefined) unread.push(label);
    return value ?? null;
  };
  const name = asString(firstOf(body, NAME_KEYS));
  const officersRaw = asArray(firstOf(body, OFFICERS_KEYS));
  const eventsRaw = asArray(firstOf(body, EVENTS_KEYS));
  const officers = officersRaw.map(parseOfficer).filter((o): o is ProfileOfficer => o !== null);
  const events = eventsRaw.map(parseEvent).filter((e): e is ProfileEvent => e !== null);
  events.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const profile: CompanyProfile = {
    name,
    name_norm: name ? normaliseCompanyName(name) : null,
    nif: asString(firstOf(body, NIF_KEYS))?.toUpperCase().replace(/[\s-]/g, '') ?? null,
    address: take('address', asString(firstOf(body, ADDRESS_KEYS))),
    postcode: asString(firstOf(body, POSTCODE_KEYS)),
    municipality: asString(firstOf(body, CITY_KEYS)),
    incorporation_date: take('incorporation_date', asIsoDate(firstOf(body, INCORP_KEYS))),
    capital_eur: take('capital_eur', asNumber(firstOf(body, CAPITAL_KEYS))),
    cnae: take('cnae', asString(firstOf(body, CNAE_KEYS))),
    cnae_label: asString(firstOf(body, CNAE_LABEL_KEYS)),
    status: asString(firstOf(body, STATUS_KEYS)),
    officers,
    events,
    unread: [],
  };
  if (officers.length === 0) unread.push('officers');
  if (events.length === 0) unread.push('events');
  profile.unread = unread;
  return profile;
}

/** Candidates from a search response, tolerant of the envelope shape. */
export function parseSearchResults(
  payload: unknown,
): Array<{ id: string | null; name: string | null; nif: string | null }> {
  const list = Array.isArray(payload) ? payload : asArray(firstOf(payload, RESULT_KEYS));
  return list
    .map((o) => ({
      id: asString(firstOf(o, ID_KEYS)),
      name: asString(firstOf(o, NAME_KEYS)),
      nif: asString(firstOf(o, NIF_KEYS))?.toUpperCase().replace(/[\s-]/g, '') ?? null,
    }))
    .filter((c) => c.id !== null || c.name !== null);
}

/** Pick the candidate to open: an exact NIF match, else a company-name match at ≥ 0.85. */
export function pickCandidate(
  candidates: ReturnType<typeof parseSearchResults>,
  subject: { nif?: string | null; name?: string | null },
): {
  candidate: ReturnType<typeof parseSearchResults>[number];
  how: 'nif' | 'name';
  score: number;
} | null {
  const nif = subject.nif?.toUpperCase().replace(/[\s-]/g, '') ?? null;
  if (nif) {
    const exact = candidates.find((c) => c.nif === nif);
    if (exact) return { candidate: exact, how: 'nif', score: 1 };
  }
  if (subject.name) {
    let best: { candidate: (typeof candidates)[number]; score: number } | null = null;
    for (const c of candidates) {
      if (!c.name) continue;
      const score = tokenSetSimilarity(subject.name, c.name);
      if (!best || score > best.score) best = { candidate: c, score };
    }
    if (best && best.score >= 0.85)
      return { candidate: best.candidate, how: 'name', score: best.score };
  }
  return null;
}

const cfg = SOURCES.openmercantil;

/** Officers from the `/company/{slug}/officers` answer (a bare list or a wrapped one). */
export function parseOfficersList(payload: unknown): ProfileOfficer[] {
  const list = Array.isArray(payload)
    ? payload
    : asArray(firstOf(payload, [...OFFICERS_KEYS, ...RESULT_KEYS]));
  return list.map(parseOfficer).filter((o): o is ProfileOfficer => o !== null);
}

/** Events from the `/company/{slug}/events` answer, oldest first. */
export function parseEventsList(payload: unknown): ProfileEvent[] {
  const list = Array.isArray(payload)
    ? payload
    : asArray(firstOf(payload, [...EVENTS_KEYS, ...RESULT_KEYS]));
  const events = list.map(parseEvent).filter((e): e is ProfileEvent => e !== null);
  events.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return events;
}

/** Attribution block of a search answer (CC BY 4.0 requires it to travel with the data). */
export function attributionsOf(payload: unknown): unknown {
  return firstOf(payload, ['_attributions', 'attributions', 'attribution']) ?? null;
}

/** Request headers: the optional API key, never logged. */
export function apiHeaders(): Record<string, string> {
  const key = envOptional(OPENMERCANTIL_API_KEY_VAR);
  return key ? { 'X-API-Key': key } : {};
}

function manualFallback(subject: CheckSubject): { url: string; instruction: string } {
  const term = subject.nif ?? subject.name ?? subject.subjectKey;
  return {
    url: cfg.fallbackUrl ?? 'https://openmercantil.es/',
    instruction:
      `Search "${term}" on the provider's site or in the BORME buscador (boe.es/borme), open the Section A entries for the company ` +
      'and capture the page showing the incorporation entry, the current officers and the registered address. ' +
      'Upload it with `vx vendors evidence --check <id> --file <path>`.',
  };
}

export const companyProfile: VendorCheck = {
  type: 'company_profile',
  label:
    'Company registry profile (officers, address, incorporation, capital, CNAE, gazette timeline)',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const term = subject.nif ?? subject.name ?? null;
    const searchUrl = `${cfg.baseUrl}/search${qs({ q: term, limit: 5 })}`;
    const headers = apiHeaders();
    const request: Record<string, unknown> = {
      term,
      nif: subject.nif ?? null,
      name: subject.name ?? null,
      endpoint: searchUrl,
      api_key_used: Object.keys(headers).length > 0,
      source_verified: cfg.verified,
    };
    if (!term) {
      return {
        type: 'company_profile',
        status: 'not_found',
        normalised: {
          note: 'No name or identifier to search with.',
          fallback: manualFallback(subject),
          source_verified: cfg.verified,
        },
        raw: null,
        source_url: cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    try {
      const search = await fetchJson(ctx, searchUrl, {
        source: cfg.id,
        allowStatus: [404],
        headers,
      });
      const candidates = parseSearchResults(search.json);
      const attributions = attributionsOf(search.json);
      const chosen = pickCandidate(candidates, subject);
      if (!chosen) {
        return {
          type: 'company_profile',
          status: 'not_found',
          normalised: {
            searched: term,
            candidates: candidates.length,
            attributions,
            source_verified: cfg.verified,
            note: 'No registry entry matched the identifier or the name. Absence of an entry is not exculpatory: the entity may be a sole trader, a civil partnership or registered under a different name.',
            fallback: manualFallback(subject),
          },
          raw: search.json ?? search.text,
          source_url: searchUrl,
          cost_cents: 0,
          request,
        };
      }
      const slug = chosen.candidate.id ?? chosen.candidate.nif ?? '';
      const detailUrl = `${cfg.baseUrl}/company/${encodeURIComponent(slug)}`;
      request.detail_endpoint = detailUrl;
      const detail = await fetchJson(ctx, detailUrl, { source: cfg.id, allowStatus: [404], headers });
      if (detail.status === 404 || detail.json === null) {
        return {
          type: 'company_profile',
          status: 'not_found',
          normalised: {
            searched: term,
            matched_by: chosen.how,
            attributions,
            source_verified: cfg.verified,
            note: 'Search matched but the detail page was empty.',
            fallback: manualFallback(subject),
          },
          raw: detail.json ?? detail.text,
          source_url: detailUrl,
          cost_cents: 0,
          request,
        };
      }
      const profile = parseCompanyProfile(detail.json);
      const raw: Record<string, unknown> = { detail: detail.json, attributions };

      // Officers and events live on their own paths; they are fetched only when the detail
      // object did not carry them, so a provider that inlines them costs two requests, not four.
      if (profile.officers.length === 0) {
        const officersUrl = `${detailUrl}/officers`;
        request.officers_endpoint = officersUrl;
        const res = await fetchJson(ctx, officersUrl, { source: cfg.id, allowStatus: [404], headers });
        raw.officers = res.json;
        profile.officers = parseOfficersList(res.json);
        if (profile.officers.length > 0) profile.unread = profile.unread.filter((u) => u !== 'officers');
      }
      if (profile.events.length === 0) {
        const eventsUrl = `${detailUrl}/events`;
        request.events_endpoint = eventsUrl;
        const res = await fetchJson(ctx, eventsUrl, { source: cfg.id, allowStatus: [404], headers });
        raw.events = res.json;
        profile.events = parseEventsList(res.json);
        if (profile.events.length > 0) profile.unread = profile.unread.filter((u) => u !== 'events');
      }

      return {
        type: 'company_profile',
        status: 'ok',
        normalised: {
          ...profile,
          matched_by: chosen.how,
          match_score: Math.round(chosen.score * 1000) / 1000,
          attributions,
          source_verified: cfg.verified,
          fallback: manualFallback(subject),
        },
        raw,
        source_url: detailUrl,
        cost_cents: 0,
        request,
        ...(profile.unread.length > 0
          ? { note: `Fields not read from the response: ${profile.unread.join(', ')}.` }
          : {}),
      };
    } catch (err) {
      const out = errorResult('company_profile', searchUrl, err, request);
      out.normalised = { ...out.normalised, fallback: manualFallback(subject) };
      return out;
    }
  },
};
