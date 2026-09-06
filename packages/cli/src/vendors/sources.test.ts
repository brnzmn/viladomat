/**
 * Register, gate and probe tests. No network and no database: `ctx.fetch` answers from the m5
 * fixtures and a fake client records the SQL the register code would run. Identifiers are the
 * synthetic ones of the fixtures (valid check digits, fictional companies); no natural person.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/env.ts';
import { resetRateLimiters } from './http.ts';
import type { Queryable } from './persist.ts';
import type { CheckContext, CheckResult, HttpRequestInit, HttpResponse } from './types.ts';
import {
  applySourceGate,
  bdnsProbeVerdict,
  catastroProbeVerdict,
  companyProfileProbeVerdict,
  configForSource,
  configSourceIds,
  isSourceVerified,
  legalPersonNif,
  loadSourceRegister,
  PROBE_CHECK_TYPE,
  PROBES,
  raiscProbeVerdict,
  rasicMetadataVerdict,
  reaProbeVerdict,
  recordProbeOutcomes,
  runProbes,
  socrataNifColumn,
  socrataViewUrl,
  sourceStatusRows,
  sourceVerification,
  vnifProbeVerdict,
  withSourceGate,
  type ProbeInputs,
  type RegistrySourceRow,
  type SourceRegister,
} from './sources.ts';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'm5');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

function fixtureFetch(routes: readonly Route[], seen: string[] = []): CheckContext['fetch'] {
  return (url: string) => {
    seen.push(url);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    const body = route
      ? typeof route.body === 'string'
        ? route.body
        : JSON.stringify(route.body)
      : '';
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(res);
  };
}

function ctxWith(routes: readonly Route[], seen: string[] = []): CheckContext {
  return {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch: fixtureFetch(routes, seen),
    rateLimit: () => Promise.resolve(),
    timeoutMs: 10_000,
  };
}

function text(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * The REA form: the GET answers the form page, the POST a result page chosen by the identifier
 * posted (so a probe can be seen trying one identifier after another).
 */
function reaCtx(
  resultFor: (nif: string) => { body: string; status?: number },
  seen: Array<{ method: string; nif: string | null }> = [],
): CheckContext {
  const fetch = (url: string, init?: HttpRequestInit) => {
    const post = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const nif = post ? new URLSearchParams(init?.body ?? '').get('numIdentificacion') : null;
    seen.push({ method: post ? 'POST' : 'GET', nif });
    const page = post ? resultFor(nif ?? '') : { body: text('rea-form.html') };
    const status = page.status ?? 200;
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(page.body),
    };
    void url;
    return Promise.resolve(res);
  };
  return {
    cid: '00000000-0000-0000-0000-0000000000c1',
    fetch,
    rateLimit: () => Promise.resolve(),
    timeoutMs: 10_000,
  };
}

interface Call {
  sql: string;
  params: unknown[];
}

/** A client that answers the register and insert statements the module runs, and records them. */
function fakeClient(
  registerRows: Array<Record<string, unknown>> = [],
  failWith?: { code: string },
): { client: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/insert into public\.external_checks/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              id: params[0],
              check_type: params[2],
              status: params[10],
              evidence_storage_path: null,
              fetched_at: '2026-09-05T10:00:00+00:00',
            },
          ],
        });
      }
      if (/from public\.registry_sources/.test(sql)) {
        if (failWith) return Promise.reject(Object.assign(new Error('relation missing'), failWith));
        return Promise.resolve({ rows: registerRows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client: client as unknown as Queryable, calls };
}

function row(over: Partial<RegistrySourceRow> & { id: string }): RegistrySourceRow {
  return {
    name: over.id,
    base_url: null,
    access: 'api',
    licence_note: null,
    verified_at: null,
    verified_by: null,
    probe_check_id: null,
    notes: null,
    updated_at: null,
    ...over,
  };
}

const register = (...rows: RegistrySourceRow[]): SourceRegister =>
  new Map(rows.map((r) => [r.id, r] as const));

function result(over: Partial<CheckResult> & { type: string }): CheckResult {
  return {
    status: 'ok',
    normalised: {},
    raw: null,
    source_url: 'https://example.test/',
    cost_cents: 0,
    ...over,
  };
}

const ADMIN = { nif: 'B12345674', name: 'OBRES EXEMPLE BARNA, S.L.', role: 'administrator' };

const INPUTS: ProbeInputs = {
  community: {
    id: '00000000-0000-0000-0000-0000000000c1',
    name: 'Comunitat exemple',
    nif: 'H12345674',
    address: 'Carrer de Mostra 25, 08015 Barcelona',
    catastro_rc: '9999999ZZ9999Z',
  },
  administrator: ADMIN,
  candidates: [ADMIN],
  certificateConfigured: false,
};

const RASIC_META_WITH_NIF = {
  id: 'exxq-fubu',
  columns: [
    { name: 'Número de RASIC', fieldName: 'n_mero_de_rasic', dataTypeName: 'text' },
    { name: 'Nom titular actual', fieldName: 'nom_titular_actual', dataTypeName: 'text' },
    { name: 'NIF titular', fieldName: 'nif_titular', dataTypeName: 'text' },
  ],
};

const RASIC_META_WITHOUT_NIF = {
  id: 'exxq-fubu',
  columns: [
    { name: 'Número de RASIC', fieldName: 'n_mero_de_rasic' },
    { name: 'Nom titular actual', fieldName: 'nom_titular_actual' },
    { name: 'Adreça', fieldName: 'adre_a' },
  ],
};

beforeEach(() => {
  resetRateLimiters();
});

describe('register helpers', () => {
  it('reads verification from the register and treats a missing row as unverified', () => {
    const reg = register(
      row({ id: 'catastro', verified_at: '2026-09-05T10:00:00+00:00', probe_check_id: 'p-1' }),
      row({ id: 'bdns' }),
    );
    expect(isSourceVerified(reg, 'catastro')).toBe(true);
    expect(isSourceVerified(reg, 'bdns')).toBe(false);
    expect(isSourceVerified(reg, 'raisc')).toBe(false);
    expect(sourceVerification(reg, 'raisc')).toEqual({
      source: 'raisc',
      registered: false,
      verified: false,
      verified_at: null,
      probe_check_id: null,
    });
  });

  it('loads the register rows through the client and returns an empty map when the table is missing', async () => {
    const { client } = fakeClient([
      { id: 'catastro', name: 'Cadastre', access: 'api', verified_at: null },
      {
        id: 'bdns',
        name: 'BDNS',
        access: 'api',
        verified_at: '2026-09-05 10:00:00+00',
        probe_check_id: 'p-2',
      },
    ]);
    const reg = await loadSourceRegister(client);
    expect(reg.size).toBe(2);
    expect(reg.get('bdns')?.probe_check_id).toBe('p-2');
    expect(isSourceVerified(reg, 'bdns')).toBe(true);

    const missing = await loadSourceRegister(fakeClient([], { code: '42P01' }).client);
    expect(missing.size).toBe(0);
    await expect(loadSourceRegister(fakeClient([], { code: '42501' }).client)).rejects.toThrow();
  });

  it('knows every source id in code and its access kind', () => {
    const ids = configSourceIds();
    for (const id of [
      'catastro',
      'bdns',
      'raisc',
      'rasic',
      'openmercantil',
      'aeat_vnif',
      'idescat',
      'insolvency',
    ]) {
      expect(ids).toContain(id);
    }
    expect(configForSource('rasic').access).toBe('dataset');
    expect(configForSource('rea').access).toBe('form');
    expect(configForSource('insolvency').access).toBe('manual');
    expect(configForSource('catastro').base_url).toContain('ovc.catastro.meh.es');
    // No source without a check module: the Banco de España register is resolved offline.
    expect(ids).not.toContain('bde_bank');
    expect(configForSource('never_heard_of')).toEqual({
      name: 'never_heard_of',
      base_url: null,
      access: 'api',
      licence_note: null,
    });
  });

  it('merges the register with the ids in code for the status table', () => {
    const rows = sourceStatusRows(
      register(
        row({ id: 'catastro', verified_at: '2026-09-05T10:00:00+00:00', probe_check_id: 'p-1' }),
        row({ id: 'retired_source', access: 'dataset' }),
      ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('catastro')).toMatchObject({
      registered: true,
      in_code: true,
      probeable: true,
      verified_at: '2026-09-05T10:00:00+00:00',
    });
    expect(byId.get('bdns')).toMatchObject({
      registered: false,
      in_code: true,
      probeable: true,
      verified_at: null,
    });
    expect(byId.get('idescat')).toMatchObject({
      registered: false,
      in_code: true,
      probeable: false,
    });
    expect(byId.get('rea')).toMatchObject({ registered: false, in_code: true, probeable: true });
    expect(byId.get('retired_source')).toMatchObject({
      registered: true,
      in_code: false,
      probeable: false,
      access: 'dataset',
    });
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
  });

  it('only treats a valid legal-person identifier as probe material', () => {
    expect(legalPersonNif('H12345674')).toBe(true);
    expect(legalPersonNif('B12345674')).toBe(true);
    expect(legalPersonNif('12345678Z')).toBe(false);
    expect(legalPersonNif('B12345670')).toBe(false);
    expect(legalPersonNif(null)).toBe(false);
  });
});

describe('applySourceGate', () => {
  const base = result({
    type: 'catastro_units',
    normalised: { units: [], source_verified: false },
    note: 'own note',
  });

  it('leaves local arithmetic and manual placeholders alone', () => {
    const local = applySourceGate(base, register(), { source: 'local', manual: false });
    expect(local.gated).toBe(false);
    expect(local.result).toBe(base);
    const manual = applySourceGate(base, register(), { source: 'rea_manual', manual: true });
    expect(manual.gated).toBe(false);
  });

  it('forces source_verified false while the source is unverified or unregistered', () => {
    const unregistered = applySourceGate(base, register(), { source: 'catastro', manual: false });
    expect(unregistered.gated).toBe(true);
    expect(unregistered.verified).toBe(false);
    expect(unregistered.result.normalised.source_verified).toBe(false);
    expect(unregistered.result.normalised.source_verification).toMatchObject({
      source: 'catastro',
      registered: false,
    });
    expect(unregistered.result.note).toBe('own note');

    const registered = applySourceGate(base, register(row({ id: 'catastro' })), {
      source: 'catastro',
      manual: false,
    });
    expect(registered.verified).toBe(false);
    expect(registered.result.normalised.source_verification).toMatchObject({
      registered: true,
      verified_at: null,
    });
  });

  it('sets source_verified true with a note naming the probe once verified, without overwriting the module constant elsewhere', () => {
    const optimistic = result({ type: 'catastro_units', normalised: { source_verified: true } });
    const still = applySourceGate(optimistic, register(row({ id: 'catastro' })), {
      source: 'catastro',
      manual: false,
    });
    expect(still.result.normalised.source_verified).toBe(false);

    const reg = register(
      row({ id: 'catastro', verified_at: '2026-09-05T10:00:00+00:00', probe_check_id: 'p-1' }),
    );
    const verified = applySourceGate(base, reg, { source: 'catastro', manual: false });
    expect(verified.verified).toBe(true);
    expect(verified.result.normalised.source_verified).toBe(true);
    expect(verified.result.note).toBe(
      'own note · source catastro verified on 2026-09-05 (probe p-1)',
    );
    expect(base.normalised.source_verified).toBe(false);
  });

  it('exposes sourceVerified on the context for self-gating checks', () => {
    const reg = register(row({ id: 'rasic', verified_at: '2026-09-05T10:00:00+00:00' }));
    const ctx = withSourceGate(ctxWith([]), reg);
    expect(ctx.sourceVerified('rasic')).toBe(true);
    expect(ctx.sourceVerified('bdns')).toBe(false);
    expect(ctx.cid).toBe('00000000-0000-0000-0000-0000000000c1');
  });
});

describe('probe verdicts', () => {
  it('verifies the Cadastre only when a unit carries a coefficient', () => {
    expect(
      catastroProbeVerdict(
        result({
          type: 'catastro_units',
          normalised: {
            units: [{ coefficient_pct: 7.32 }, { coefficient_pct: null }],
            envelope: 'lrcdnp',
          },
        }),
      ),
    ).toEqual({ ok: true, reason: '2 unit(s) parsed, 1 with a coefficient; envelope lrcdnp' });
    expect(
      catastroProbeVerdict(
        result({ type: 'catastro_units', normalised: { units: [{ floor: '01' }] } }),
      ).ok,
    ).toBe(false);
    expect(
      catastroProbeVerdict(
        result({ type: 'catastro_units', status: 'error', normalised: { error: 'HTTP 500' } }),
      ).reason,
    ).toContain('HTTP 500');
    expect(
      catastroProbeVerdict(result({ type: 'catastro_units', normalised: { units: [] } })).reason,
    ).toBe('no unit parsed from the answer');
  });

  it('verifies BDNS and RAISC only on a parsed row, and names an empty envelope for what it is', () => {
    expect(
      bdnsProbeVerdict(
        result({ type: 'bdns_grants', normalised: { grants: [{ reference: '1' }], count: 1 } }),
      ).ok,
    ).toBe(true);
    const empty = bdnsProbeVerdict(
      result({
        type: 'bdns_grants',
        status: 'not_found',
        normalised: { grants: [] },
        raw: { content: [], totalElements: 0 },
      }),
    );
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/envelope confirmed/);
    expect(
      bdnsProbeVerdict(
        result({
          type: 'bdns_grants',
          status: 'not_found',
          normalised: {},
          raw: { unexpected: true },
        }),
      ).reason,
    ).toMatch(/no content\[\] envelope/);
    expect(
      raiscProbeVerdict(
        result({ type: 'raisc_grants', normalised: { grants: [{ reference: 'x' }] } }),
      ).ok,
    ).toBe(true);
    expect(
      raiscProbeVerdict(
        result({ type: 'raisc_grants', status: 'not_found', normalised: { grants: [] }, raw: [] }),
      ).reason,
    ).toMatch(/empty list/);
    expect(
      raiscProbeVerdict(
        result({ type: 'raisc_grants', status: 'error', normalised: { error: 'HTTP 400' } }),
      ).reason,
    ).toContain('HTTP 400');
  });

  it('verifies a company profile when its name or identifier was read, listing what was not', () => {
    const ok = companyProfileProbeVerdict(
      result({
        type: 'company_profile',
        normalised: { name: 'EXEMPLE SL', nif: 'B12345674', matched_by: 'nif', unread: ['cnae'] },
      }),
    );
    expect(ok).toEqual({
      ok: true,
      reason: 'profile read (matched by nif); fields not read: cnae',
    });
    expect(
      companyProfileProbeVerdict(
        result({ type: 'company_profile', normalised: { matched_by: 'nif', unread: ['name'] } }),
      ).ok,
    ).toBe(false);
    expect(
      companyProfileProbeVerdict(
        result({ type: 'company_profile', status: 'not_found', normalised: {} }),
      ).reason,
    ).toContain('not_found');
  });

  it('verifies REA on a registered entry or on the not-found marker, and on nothing else', () => {
    const registered = reaProbeVerdict(
      result({
        type: 'rea',
        normalised: {
          registered: true,
          registration_number: '09/08/0004567',
          community: 'Cataluña',
          unread: ['valid_to'],
        },
      }),
    );
    expect(registered.ok).toBe(true);
    expect(registered.reason).toBe(
      'registered entry read from the result table (number 09/08/0004567, Cataluña); fields not read: valid_to',
    );
    const notFound = reaProbeVerdict(
      result({ type: 'rea', status: 'not_found', normalised: { registered: false } }),
    );
    expect(notFound.ok).toBe(true);
    expect(notFound.reason).toMatch(/not-found marker/);
    expect(
      reaProbeVerdict(result({ type: 'rea', status: 'error', normalised: { error: 'HTTP 503' } }))
        .reason,
    ).toBe('rea answered error: HTTP 503');
    expect(
      reaProbeVerdict(
        result({ type: 'rea', status: 'not_found', normalised: { registered: null } }),
      ).ok,
    ).toBe(false);
  });

  it('verifies AEAT only on a documented Resultado', () => {
    expect(
      vnifProbeVerdict(
        result({
          type: 'aeat_census',
          normalised: { result: 'NO IDENTIFICADO', census_match: false },
        }),
      ).ok,
    ).toBe(true);
    expect(
      vnifProbeVerdict(result({ type: 'aeat_census', normalised: { result: 'ALGO RARO' } })).ok,
    ).toBe(false);
    expect(
      vnifProbeVerdict(result({ type: 'aeat_census', status: 'manual_pending', normalised: {} }))
        .reason,
    ).toMatch(/no certificate/);
    expect(
      vnifProbeVerdict(
        result({ type: 'aeat_census', status: 'error', normalised: { error: 'HTTP 401' } }),
      ).reason,
    ).toContain('HTTP 401');
  });

  it('finds an identifier column in Socrata view metadata', () => {
    expect(socrataNifColumn(RASIC_META_WITH_NIF)).toEqual({
      column: 'nif_titular',
      columns: ['n_mero_de_rasic', 'nom_titular_actual', 'nif_titular'],
    });
    expect(socrataNifColumn(RASIC_META_WITHOUT_NIF).column).toBeNull();
    expect(socrataNifColumn({ columns: [{ fieldName: 'cif_beneficiari' }] }).column).toBe(
      'cif_beneficiari',
    );
    expect(socrataNifColumn({ columns: [{ fieldName: 'identificacio_fiscal' }] }).column).toBe(
      'identificacio_fiscal',
    );
    expect(socrataNifColumn({ columns: [{ fieldName: 'magnific' }] }).column).toBeNull();
    expect(socrataNifColumn({}).columns).toEqual([]);
    expect(rasicMetadataVerdict(RASIC_META_WITH_NIF).ok).toBe(true);
    expect(rasicMetadataVerdict(RASIC_META_WITHOUT_NIF).reason).toMatch(
      /none looks like an identifier column/,
    );
    expect(rasicMetadataVerdict({ error: true }).reason).toMatch(/no columns\[\]/);
    expect(socrataViewUrl('https://analisi.transparenciacatalunya.cat/resource', 'exxq-fubu')).toBe(
      'https://analisi.transparenciacatalunya.cat/api/views/exxq-fubu.json',
    );
  });
});

describe('probes', () => {
  it('one probe per automatable source, and an unknown source is refused', async () => {
    expect(PROBES.map((p) => p.source)).toEqual([
      'catastro',
      'bdns',
      'raisc',
      'rasic',
      'rea',
      'openmercantil',
      'aeat_vnif',
    ]);
    await expect(runProbes(INPUTS, ctxWith([]), { only: 'idescat' })).rejects.toThrow(
      /no probe for source "idescat"/,
    );
  });

  it('verifies the Cadastre with the community reference and wraps the answer in a source_probe row', async () => {
    const seen: string[] = [];
    const [outcome] = await runProbes(
      INPUTS,
      ctxWith([{ match: 'Consulta_DNPRC', body: fixture('catastro-dnprc-14.json') }], seen),
      { only: 'catastro' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('RefCat=9999999ZZ9999Z');
    expect(outcome?.verified).toBe(true);
    expect(outcome?.skipped).toBe(false);
    expect(outcome?.reason).toBe('4 unit(s) parsed, 4 with a coefficient; envelope lrcdnp');
    const row = outcome?.attempts[0]?.result;
    expect(row?.type).toBe(PROBE_CHECK_TYPE);
    expect(row?.status).toBe('ok');
    expect(row?.normalised).toMatchObject({
      source: 'catastro',
      verified: true,
      probed_check_type: 'catastro_units',
      probed_status: 'ok',
      probed_subject: '9999999ZZ9999Z',
      source_verified: true,
    });
    expect(row?.request).toMatchObject({ probe_of: 'catastro_units', rc: '9999999ZZ9999Z' });
    expect(row?.source_url).toContain('Consulta_DNPRC');
  });

  it('does not verify the Cadastre when the answer parses without coefficients, and skips without a reference', async () => {
    const body = {
      consulta_dnprcResult: {
        lrcdnp: {
          rcdnp: [
            {
              rc: { pc1: '9999999', pc2: 'ZZ9999Z', car: '0001', cc1: 'A', cc2: 'B' },
              debi: { sfc: '88' },
            },
          ],
        },
      },
    };
    const [outcome] = await runProbes(INPUTS, ctxWith([{ match: 'Consulta_DNPRC', body }]), {
      only: 'catastro',
    });
    expect(outcome?.verified).toBe(false);
    expect(outcome?.reason).toMatch(/none carries a coefficient/);
    expect(outcome?.attempts[0]?.result.status).toBe('not_found');

    const [none] = await runProbes(
      { ...INPUTS, community: { ...INPUTS.community, catastro_rc: null, address: null } },
      ctxWith([]),
      { only: 'catastro' },
    );
    expect(none?.skipped).toBe(true);
    expect(none?.attempts).toEqual([]);
  });

  it('tries the next legal-person identifier when BDNS answers an empty envelope, and stops on a row', async () => {
    const seen: string[] = [];
    const [outcome] = await runProbes(
      INPUTS,
      ctxWith(
        [
          {
            match: 'H12345674',
            body: { content: [], totalElements: 0, totalPages: 0, size: 50, number: 0 },
          },
          { match: 'B12345674', body: fixture('bdns-concesiones.json') },
        ],
        seen,
      ),
      { only: 'bdns' },
    );
    expect(seen).toHaveLength(2);
    expect(outcome?.verified).toBe(true);
    expect(outcome?.attempts).toHaveLength(2);
    expect(outcome?.attempts[0]?.verdict.ok).toBe(false);
    expect(outcome?.attempts[0]?.verdict.reason).toMatch(/envelope confirmed/);
    expect(outcome?.attempts[0]?.result.status).toBe('not_found');
    expect(outcome?.attempts[1]?.verdict.ok).toBe(true);
    expect(outcome?.attempts[1]?.subjectKey).toBe('B12345674');
  });

  it('stops after an error answer: another identifier would not change a wrong route', async () => {
    const seen: string[] = [];
    const [outcome] = await runProbes(
      INPUTS,
      ctxWith([{ match: 'concesiones', body: { error: 'boom' }, status: 500 }], seen),
      { only: 'bdns' },
    );
    expect(seen).toHaveLength(1);
    expect(outcome?.verified).toBe(false);
    expect(outcome?.attempts).toHaveLength(1);
    expect(outcome?.attempts[0]?.result.status).toBe('error');
    expect(outcome?.reason).toMatch(/HTTP 500/);
  });

  it('verifies RAISC on a parsed row and not on an empty list', async () => {
    const [ok] = await runProbes(
      INPUTS,
      ctxWith([{ match: 's9xt-n979', body: fixture('raisc-grants.json') }]),
      { only: 'raisc' },
    );
    expect(ok?.verified).toBe(true);
    const [empty] = await runProbes(INPUTS, ctxWith([{ match: 's9xt-n979', body: [] }]), {
      only: 'raisc',
    });
    expect(empty?.verified).toBe(false);
    expect(empty?.reason).toMatch(/empty list/);
  });

  it('skips the grant probes when no legal-person identifier is on file', async () => {
    const [outcome] = await runProbes(
      {
        ...INPUTS,
        community: { ...INPUTS.community, nif: null },
        candidates: [{ nif: '12345678Z', name: null, role: 'vendor' }],
      },
      ctxWith([]),
      { only: 'raisc' },
    );
    expect(outcome?.skipped).toBe(true);
  });

  it('verifies RASIC from the view metadata when an identifier column exists', async () => {
    const seen: string[] = [];
    const [ok] = await runProbes(
      INPUTS,
      ctxWith([{ match: '/api/views/exxq-fubu.json', body: RASIC_META_WITH_NIF }], seen),
      { only: 'rasic' },
    );
    expect(seen[0]).toBe('https://analisi.transparenciacatalunya.cat/api/views/exxq-fubu.json');
    expect(ok?.verified).toBe(true);
    expect(ok?.reason).toBe('identifier column nif_titular among 3 column(s)');
    expect(ok?.attempts[0]?.result.normalised).toMatchObject({
      probed_check_type: 'socrata_view_metadata',
      probed_normalised: { dataset: 'exxq-fubu', nif_column: 'nif_titular' },
    });

    const [none] = await runProbes(
      INPUTS,
      ctxWith([{ match: '/api/views/exxq-fubu.json', body: RASIC_META_WITHOUT_NIF }]),
      { only: 'rasic' },
    );
    expect(none?.verified).toBe(false);
    expect(none?.reason).toMatch(/none looks like an identifier column/);

    const [missing] = await runProbes(INPUTS, ctxWith([]), { only: 'rasic' });
    expect(missing?.verified).toBe(false);
    expect(missing?.reason).toMatch(/HTTP 404/);
  });

  it('verifies REA through a vendor identifier and wraps the answer in a source_probe row', async () => {
    const seen: Array<{ method: string; nif: string | null }> = [];
    const [outcome] = await runProbes(
      INPUTS,
      reaCtx(() => ({ body: text('rea-registered.html') }), seen),
      { only: 'rea' },
    );
    expect(seen).toEqual([
      { method: 'GET', nif: null },
      { method: 'POST', nif: 'B12345674' },
    ]);
    expect(outcome?.verified).toBe(true);
    expect(outcome?.reason).toMatch(
      /^registered entry read from the result table \(number 09\/08\/0004567, Cataluña\)/,
    );
    const row = outcome?.attempts[0]?.result;
    expect(row?.type).toBe(PROBE_CHECK_TYPE);
    expect(row?.status).toBe('ok');
    expect(row?.normalised).toMatchObject({
      source: 'rea',
      verified: true,
      probed_check_type: 'rea',
      probed_status: 'ok',
      probed_subject: 'B12345674',
      source_verified: true,
    });
    expect(row?.request).toMatchObject({ probe_of: 'rea', nif: 'B12345674', id_type: '3' });
  });

  it('takes a not-found marker as confirmation of the route, tries the next identifier, and prefers a registered entry', async () => {
    const seen: Array<{ method: string; nif: string | null }> = [];
    const inputs: ProbeInputs = {
      ...INPUTS,
      candidates: [
        ADMIN,
        { nif: 'A12345674', name: 'SERVEIS EXEMPLE DE PROVA SA', role: 'vendor' },
      ],
    };
    const [outcome] = await runProbes(
      inputs,
      reaCtx(
        (nif) => ({
          body:
            nif === 'A12345674'
              ? text('rea-registered.html').replace(/B12345674/g, 'A12345674')
              : text('rea-not-found.html'),
        }),
        seen,
      ),
      { only: 'rea' },
    );
    expect(seen.filter((s) => s.method === 'POST').map((s) => s.nif)).toEqual([
      'B12345674',
      'A12345674',
    ]);
    expect(outcome?.verified).toBe(true);
    expect(outcome?.attempts).toHaveLength(2);
    expect(outcome?.attempts[0]?.verdict.ok).toBe(true);
    expect(outcome?.attempts[0]?.verdict.reason).toMatch(/not-found marker/);
    expect(outcome?.attempts[0]?.result.status).toBe('ok');
    expect(outcome?.attempts[1]?.verdict.ok).toBe(true);
    // The stronger attempt names the probe row.
    expect(outcome?.reason).toMatch(/^registered entry read/);

    // Every identifier answering the marker still verifies the route, with the reason saying so.
    const [markerOnly] = await runProbes(
      inputs,
      reaCtx(() => ({ body: text('rea-not-found.html') })),
      {
        only: 'rea',
      },
    );
    expect(markerOnly?.verified).toBe(true);
    expect(markerOnly?.attempts).toHaveLength(2);
    expect(markerOnly?.reason).toMatch(/result-table columns are exercised the first time/);
  });

  it('does not verify REA on an unexpected page or a failing form, and skips without a legal-person identifier', async () => {
    const [maintenance] = await runProbes(
      INPUTS,
      reaCtx(() => ({ body: '<html><body><h1>Servicio en mantenimiento</h1></body></html>' })),
      { only: 'rea' },
    );
    expect(maintenance?.verified).toBe(false);
    expect(maintenance?.attempts).toHaveLength(1);
    expect(maintenance?.attempts[0]?.result.status).toBe('error');
    expect(maintenance?.reason).toMatch(/none of the expected markers/);

    const seen: Array<{ method: string; nif: string | null }> = [];
    const [failing] = await runProbes(
      { ...INPUTS, candidates: [ADMIN, { nif: 'A12345674', name: null, role: 'vendor' }] },
      reaCtx(() => ({ body: 'busy', status: 503 }), seen),
      { only: 'rea' },
    );
    expect(failing?.verified).toBe(false);
    // An error stops the probe: another identifier would not change a form that does not answer.
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
    expect(failing?.reason).toMatch(/HTTP 503/);

    const [person] = await runProbes(
      { ...INPUTS, candidates: [{ nif: '12345678Z', name: null, role: 'vendor' }] },
      reaCtx(() => ({ body: text('rea-registered.html') })),
      { only: 'rea' },
    );
    expect(person?.skipped).toBe(true);
    expect(person?.attempts).toEqual([]);
  });

  it("verifies OpenMercantil through the administrator's profile and skips without a legal-person administrator", async () => {
    const [ok] = await runProbes(
      INPUTS,
      ctxWith([
        { match: '/officers', body: [] },
        { match: '/events', body: [] },
        { match: '/search', body: fixture('company-profile-search.json') },
        { match: 'obres-exemple-barna-sl', body: fixture('company-profile-detail.json') },
      ]),
      { only: 'openmercantil' },
    );
    expect(ok?.verified).toBe(true);
    expect(ok?.attempts[0]?.subjectKey).toBe('B12345674');
    expect(ok?.attempts[0]?.result.normalised).toMatchObject({
      probed_check_type: 'company_profile',
    });

    const [noAdmin] = await runProbes({ ...INPUTS, administrator: null }, ctxWith([]), {
      only: 'openmercantil',
    });
    expect(noAdmin?.skipped).toBe(true);
    const [person] = await runProbes(
      { ...INPUTS, administrator: { nif: '12345678Z', name: null, role: 'administrator' } },
      ctxWith([]),
      { only: 'openmercantil' },
    );
    expect(person?.skipped).toBe(true);
  });

  it('skips the AEAT probe without a certificate transport', async () => {
    const seen: string[] = [];
    const [outcome] = await runProbes(INPUTS, ctxWith([], seen), { only: 'aeat_vnif' });
    expect(outcome?.skipped).toBe(true);
    expect(outcome?.reason).toMatch(/VX_CLIENT_CERT_P12/);
    expect(seen).toHaveLength(0);
  });
});

describe('recordProbeOutcomes', () => {
  it('appends one source_probe row per attempt and updates the register accordingly', async () => {
    const outcomes = await runProbes(
      INPUTS,
      ctxWith([
        { match: 'Consulta_DNPRC', body: fixture('catastro-dnprc-14.json') },
        { match: 's9xt-n979', body: [] },
      ]),
    );
    const { client, calls } = fakeClient();
    const summaries = await recordProbeOutcomes(client, INPUTS.community.id, outcomes);

    const inserts = calls.filter((c) => /insert into public\.external_checks/.test(c.sql));
    const attempts = outcomes.reduce((acc, o) => acc + o.attempts.length, 0);
    expect(inserts).toHaveLength(attempts);
    for (const ins of inserts) {
      expect(ins.params[1]).toBe(INPUTS.community.id);
      expect(ins.params[2]).toBe('source_probe');
      expect(ins.params[3]).toBe('source');
      expect(ins.params[13]).toBeNull();
    }
    expect(inserts.map((i) => i.params[4])).toContain('catastro');

    const catastro = summaries.find((s) => s.source === 'catastro');
    expect(catastro?.verified).toBe(true);
    expect(catastro?.probeCheckId).toBe(catastro?.checkIds[0]);
    const verifiedUpsert = calls.find(
      (c) => /verified_at = now\(\)/.test(c.sql) && c.params[0] === 'catastro',
    );
    expect(verifiedUpsert?.params[6]).toBe(catastro?.probeCheckId);
    expect(verifiedUpsert?.params[3]).toBe('api');

    // RAISC answered an empty list for the community and then for the vendor identifier: two
    // attempts, two rows, no verification.
    const raisc = summaries.find((s) => s.source === 'raisc');
    expect(raisc?.verified).toBe(false);
    expect(raisc?.probeCheckId).toBeNull();
    expect(raisc?.checkIds).toHaveLength(2);
    const failureUpsert = calls.find(
      (c) => /set notes = excluded\.notes/.test(c.sql) && c.params[0] === 'raisc',
    );
    expect(failureUpsert).toBeDefined();
    expect(String(failureUpsert?.params[5])).toMatch(/did not verify the source/);
    expect(calls.some((c) => /verified_at = now\(\)/.test(c.sql) && c.params[0] === 'raisc')).toBe(
      false,
    );

    const aeat = summaries.find((s) => s.source === 'aeat_vnif');
    expect(aeat?.skipped).toBe(true);
    expect(aeat?.checkIds).toEqual([]);
    expect(calls.some((c) => c.params[0] === 'aeat_vnif')).toBe(false);
  });
});
