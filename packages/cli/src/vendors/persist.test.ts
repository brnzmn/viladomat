/**
 * The `external_checks` writer against a recording client: what columns a row carries. The
 * append-only behaviour itself is proven against a real database in `links.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage.ts', () => ({ putObject: vi.fn(() => Promise.resolve()) }));

import { putObject } from '../lib/storage.ts';
import { attachEvidence, persistCheck, type Queryable } from './persist.ts';
import type { CheckResult, CheckSubject } from './types.ts';

interface Call {
  sql: string;
  params: unknown[];
}

function recordingClient(answer: (sql: string) => unknown[]): { client: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = answer(sql);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as Queryable;
  return { client, calls };
}

const CID = '00000000-0000-0000-0000-0000000000c1';
const PARTY = '11111111-1111-1111-1111-111111111111';

const RESULT: CheckResult = {
  type: 'rea',
  status: 'not_found',
  normalised: { registered: false },
  raw: { http_status: 200 },
  source_url: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
  cost_cents: 0,
  request: { nif: 'B12345674' },
};

const returned = [
  { id: 'row-1', check_type: 'rea', status: 'not_found', evidence_storage_path: null, fetched_at: '2026-09-05 10:00:00' },
];

beforeEach(() => {
  vi.mocked(putObject).mockClear();
});

describe('persistCheck', () => {
  it('writes party_id from the subject so a vendor’s rows are reachable by party', async () => {
    const { client, calls } = recordingClient(() => returned);
    const subject: CheckSubject = { subjectType: 'party', subjectKey: PARTY, partyId: PARTY, nif: 'B12345674' };
    const row = await persistCheck(client, CID, subject, RESULT);
    expect(row.id).toBe('row-1');
    expect(calls).toHaveLength(1);
    const insert = calls[0] as Call;
    expect(insert.sql).toMatch(/party_id/);
    expect(insert.params[13]).toBe(PARTY);
    expect(insert.params[2]).toBe('rea');
    expect(insert.params[4]).toBe(PARTY);
  });

  it('leaves party_id null for a community, surname or address subject', async () => {
    const { client, calls } = recordingClient(() => returned);
    await persistCheck(client, CID, { subjectType: 'community', subjectKey: 'H12345674', nif: 'H12345674' }, RESULT);
    expect((calls[0] as Call).params[13]).toBeNull();
  });
});

describe('attachEvidence', () => {
  it('copies the party of the row it answers onto the completion row', async () => {
    const pending = {
      id: 'pending-1',
      check_type: 'rea_manual',
      subject_type: 'party',
      subject_key: PARTY,
      source_url: 'https://expinterweb.mites.gob.es/rea/pub/consulta.htm',
      request: { query: 'B12345674' },
      normalised: { manual: true },
      status: 'manual_pending',
      cost_cents: 0,
      party_id: PARTY,
    };
    const { client, calls } = recordingClient((sql) =>
      /^\s*select/i.test(sql)
        ? [pending]
        : [{ id: 'done-1', check_type: 'rea_manual', status: 'ok', evidence_storage_path: 'exports/x', fetched_at: 't' }],
    );
    const out = await attachEvidence(client, CID, {
      checkId: 'pending-1',
      bytes: Buffer.from('png'),
      ext: 'png',
      contentType: 'image/png',
    });
    expect(out.id).toBe('done-1');
    expect(vi.mocked(putObject)).toHaveBeenCalledTimes(1);
    const select = calls[0] as Call;
    expect(select.sql).toMatch(/party_id/);
    const insert = calls[1] as Call;
    expect(insert.sql).toMatch(/party_id/);
    expect(insert.params[11]).toBe(PARTY);
    expect(insert.params[1]).toBe('rea_manual');
  });
});
