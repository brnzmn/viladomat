/**
 * `surname_frequency` — how common a surname is, from the Idescat onomàstica tables.
 *
 * This is the check that keeps the surname rules honest. A coincidence of surnames means very
 * little when the surname is carried by 1 in 100 people in Catalonia and a great deal when it is
 * carried by 1 in 20,000; the frequency drives the rarity weight and the printed number of
 * expected homonyms. Every surname match a pack prints is accompanied by that count.
 *
 * Responses are cached in `external_checks` (the statistical table changes at most once a year),
 * so a re-run of the vendor checks does not re-query the same surnames.
 *
 * The endpoint, the table id and **whether the published figure is per mille or an absolute
 * count** are all to verify; the result records which basis it used.
 */
import { normaliseName } from '@viladomat/core';
import { SOURCES, SURNAME_CACHE_DAYS } from '../config.ts';
import { asNumber, asString, fetchJson, firstOf, qs } from '../http.ts';
import { errorResult, type CheckContext, type CheckResult, type CheckSubject, type VendorCheck } from '../types.ts';

/** Population of Catalonia used only to convert an absolute count into a rate. To verify. */
export const CATALONIA_POPULATION = 7_900_000;

export interface SurnameFrequency {
  surname: string;
  /** Occurrences per thousand people. */
  per_mille: number | null;
  /** Absolute number of carriers, when published. */
  count: number | null;
  /** How `per_mille` was obtained. */
  basis: 'published_rate' | 'count_over_population' | 'not_read';
  rank: number | null;
}

const RATE_KEYS = ['per_mil', 'permil', 'tantpermil', 'tant_per_mil', 'freq', 'frequencia', 'frecuencia', 'rate', 'f'];
const COUNT_KEYS = ['nombre', 'numero', 'count', 'total', 'n', 'persones', 'personas', 'valor', 'v'];
const RANK_KEYS = ['ordre', 'orden', 'rank', 'posicio', 'posicion'];

/**
 * Read a frequency out of whatever the API returns. Exported so the parser is tested against a
 * recorded fixture; the shape of the real response is unverified.
 */
export function parseSurnameFrequency(payload: unknown, surname: string): SurnameFrequency {
  const container =
    firstOf(payload, ['onomastica', 'dades', 'data', 'result', 'v']) ?? payload;
  const rowsSource = firstOf(container, ['ff', 'f', 'rows', 'items', 'cognoms', 'list']) ?? container;
  const rows = Array.isArray(rowsSource) ? rowsSource : [rowsSource];
  const target = normaliseName(surname);
  const row =
    rows.find((r) => {
      const n = asString(firstOf(r, ['cognom', 'apellido', 'surname', 'nom', 'name', 'c']));
      return n !== null && normaliseName(n) === target;
    }) ?? rows[0];

  const rate = asNumber(firstOf(row, RATE_KEYS));
  const count = asNumber(firstOf(row, COUNT_KEYS));
  const rank = asNumber(firstOf(row, RANK_KEYS));
  if (rate !== null && rate > 0) {
    return { surname: target, per_mille: rate, count, basis: 'published_rate', rank };
  }
  if (count !== null && count > 0) {
    return {
      surname: target,
      per_mille: Math.round((count / CATALONIA_POPULATION) * 1000 * 1e6) / 1e6,
      count,
      basis: 'count_over_population',
      rank,
    };
  }
  return { surname: target, per_mille: null, count: null, basis: 'not_read', rank };
}

const cfg = SOURCES.idescat;

export const surnameFrequency: VendorCheck = {
  type: 'surname_frequency',
  label: 'Idescat onomàstica — surname frequency',
  manual: false,
  source: cfg.id,
  async run(subject: CheckSubject, ctx: CheckContext): Promise<CheckResult> {
    const surname = normaliseName(asString(subject.extra?.surname) ?? subject.subjectKey);
    const request = { surname, endpoint: `${cfg.baseUrl}/dades.json`, source_verified: cfg.verified };
    if (!surname) {
      return {
        type: 'surname_frequency',
        status: 'not_found',
        normalised: { note: 'No surname to look up.' },
        raw: null,
        source_url: cfg.baseUrl,
        cost_cents: 0,
        request,
      };
    }
    if (ctx.cacheLookup) {
      const cached = await ctx.cacheLookup('surname_frequency', surname, SURNAME_CACHE_DAYS);
      if (cached) {
        return {
          type: 'surname_frequency',
          status: 'ok',
          normalised: { ...cached, from_cache: true },
          raw: { from_cache: true },
          source_url: (cached.source_url as string | null) ?? cfg.baseUrl,
          cost_cents: 0,
          request,
        };
      }
    }
    const url = `${cfg.baseUrl}/dades.json${qs({ id: 'cognoms', q: surname, lang: 'ca' })}`;
    try {
      const res = await fetchJson(ctx, url, { source: cfg.id, allowStatus: [404] });
      const freq = parseSurnameFrequency(res.json, surname);
      return {
        type: 'surname_frequency',
        status: freq.per_mille === null ? 'not_found' : 'ok',
        normalised: {
          ...freq,
          source_verified: cfg.verified,
          source_url: url,
          note:
            freq.basis === 'count_over_population'
              ? `Rate derived from a published count over a population of ${CATALONIA_POPULATION.toLocaleString('es-ES')} (both to verify).`
              : freq.basis === 'not_read'
                ? 'The response did not contain a figure under any of the accepted keys; the surname weight falls back to the neutral default.'
                : 'Rate as published.',
        },
        raw: res.json ?? res.text,
        source_url: url,
        cost_cents: 0,
        request,
      };
    } catch (err) {
      return errorResult('surname_frequency', url, err, request);
    }
  },
};
