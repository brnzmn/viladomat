import { describe, expect, it } from 'vitest';
import { sequenceEvents, type WorksEventDraft } from './works-events.ts';

const acta: WorksEventDraft = { eventType: 'acta_approval', eventDate: '2024-03-20', refType: 'resolution', refId: 'r-1', amount: 50000 };
const contract: WorksEventDraft = { eventType: 'contract_signed', eventDate: '2024-04-01', refType: 'contract', refId: 'c-1', amount: 48000 };
const start: WorksEventDraft = { eventType: 'start_of_works', eventDate: '2024-04-15', refType: 'contract', refId: 'c-1', amount: null };

describe('sequenceEvents', () => {
  it('marks a well-ordered timeline as consistent', () => {
    const out = sequenceEvents([acta, contract, start]);
    expect(out.filter((e) => e.seqOk === false)).toHaveLength(0);
    expect(out.find((e) => e.eventType === 'contract_signed')?.seqOk).toBe(true);
  });

  it('flags a payment made before the contract was signed and names the contract', () => {
    const payment: WorksEventDraft = { eventType: 'payment', eventDate: '2024-03-25', refType: 'bank_transaction', refId: 't-1', amount: 10000 };
    const out = sequenceEvents([acta, contract, payment]);
    const hit = out.find((e) => e.eventType === 'payment')!;
    expect(hit.seqOk).toBe(false);
    expect(hit.violations.map((v) => v.predecessorType)).toEqual(['contract_signed']);
    expect(hit.violations[0]!.predecessorRefId).toBe('c-1');
    expect(hit.violations[0]!.days).toBe(7);
    expect(hit.violationText).toContain('precedes contract_signed');
  });

  it('flags a payment made before the approving meeting', () => {
    const payment: WorksEventDraft = { eventType: 'payment', eventDate: '2024-03-12', refType: 'bank_transaction', refId: 't-2', amount: 1000 };
    const out = sequenceEvents([acta, payment]);
    const hit = out.find((e) => e.eventType === 'payment')!;
    expect(hit.violations.map((v) => v.predecessorType)).toEqual(['acta_approval']);
    expect(hit.violations[0]!.predecessorRefId).toBe('r-1');
  });

  it('tolerates quotes accepted up to 15 days before the approving meeting', () => {
    const inTolerance: WorksEventDraft = { eventType: 'quote_accepted', eventDate: '2024-03-10', refType: 'document', refId: 'q-1', amount: null };
    const outside: WorksEventDraft = { eventType: 'quote_accepted', eventDate: '2024-02-10', refType: 'document', refId: 'q-2', amount: null };
    const out = sequenceEvents([acta, inTolerance, outside]);
    expect(out.find((e) => e.refId === 'q-1')?.seqOk).toBe(true);
    expect(out.find((e) => e.refId === 'q-2')?.seqOk).toBe(false);
  });

  it('treats quotes received and suspensions as neutral, and events without a date as untestable', () => {
    const quote: WorksEventDraft = { eventType: 'quote_received', eventDate: '2024-01-01', refType: 'document', refId: 'q-3', amount: null };
    const suspension: WorksEventDraft = { eventType: 'suspension', eventDate: '2024-08-01', refType: 'works_package', refId: 'w-1', amount: null, suspensionReason: 'seasonal' };
    const undated: WorksEventDraft = { eventType: 'invoice', eventDate: null, refType: 'invoice', refId: 'i-1', amount: 100 };
    const out = sequenceEvents([acta, contract, quote, suspension, undated]);
    for (const refId of ['q-3', 'w-1', 'i-1']) {
      expect(out.find((e) => e.refId === refId)?.seqOk).toBeNull();
    }
  });

  it('compares against the earliest event of each predecessor stage', () => {
    const laterContract: WorksEventDraft = { eventType: 'contract_signed', eventDate: '2024-09-01', refType: 'contract', refId: 'c-2', amount: null };
    const invoice: WorksEventDraft = { eventType: 'invoice', eventDate: '2024-05-01', refType: 'invoice', refId: 'i-2', amount: 500 };
    const out = sequenceEvents([contract, laterContract, invoice]);
    expect(out.find((e) => e.refId === 'i-2')?.seqOk).toBe(true);
  });
});
