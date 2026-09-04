import { describe, expect, it } from 'vitest';
import {
  ENTITY_SCORE_CAP,
  INDEPENDENCE,
  aggregateEntity,
  assignTier,
  collapseByEventKey,
  confidence,
  hitScore,
  independenceFromProvenance,
  type Hit,
} from './scoring.ts';

function hit(overrides: Partial<Hit> = {}): Hit {
  return {
    ruleCode: 'D2',
    family: 'D',
    severity: 3,
    extractionQuality: 1,
    specificity: 1,
    independence: 1,
    eventKey: 'pay-1',
    entityType: 'payment',
    entityId: 'p1',
    documentIds: ['doc-bank-1'],
    worklistEligible: true,
    neverT1T2: false,
    ...overrides,
  };
}

describe('confidence / hitScore', () => {
  it('multiplies the three factors', () => {
    expect(
      confidence(hit({ extractionQuality: 0.9, specificity: 0.8, independence: 0.85 })),
    ).toBeCloseTo(0.612, 6);
    expect(hitScore(hit({ severity: 4, extractionQuality: 0.5 }))).toBe(2);
  });
  it('clamps factors to [0, 1]', () => {
    expect(confidence(hit({ extractionQuality: 1.5, specificity: -1 }))).toBe(0);
    expect(confidence(hit({ extractionQuality: 2, specificity: 2, independence: 2 }))).toBe(1);
    expect(confidence(hit({ extractionQuality: Number.NaN }))).toBe(0);
  });
});

describe('collapseByEventKey', () => {
  it('collapses a planted single event firing four rules to one hit', () => {
    const hits = [
      hit({ ruleCode: 'D2', family: 'D', severity: 2 }),
      hit({ ruleCode: 'D3', family: 'D', severity: 3, extractionQuality: 0.9 }),
      hit({ ruleCode: 'C3', family: 'C', severity: 3, extractionQuality: 0.95 }),
      hit({ ruleCode: 'B4', family: 'B', severity: 1 }),
    ];
    const out = collapseByEventKey(hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleCode).toBe('C3'); // max severity, tie broken by higher confidence
    expect(out[0]!.collapsedFrom).toEqual(['D2', 'D3', 'B4']);
  });
  it('keeps hits with distinct event keys and preserves order', () => {
    const out = collapseByEventKey([
      hit({ eventKey: 'a', ruleCode: 'R1' }),
      hit({ eventKey: 'b', ruleCode: 'R2' }),
      hit({ eventKey: 'a', ruleCode: 'R3', severity: 1 }),
    ]);
    expect(out.map((h) => h.ruleCode)).toEqual(['R1', 'R2']);
    expect(out[0]!.collapsedFrom).toEqual(['R3']);
    expect(out[1]!.collapsedFrom).toEqual([]);
  });
  it('never collapses hits with an empty event key', () => {
    const out = collapseByEventKey([hit({ eventKey: '' }), hit({ eventKey: '' })]);
    expect(out).toHaveLength(2);
  });
  it('prefers the first hit on a full tie and copies documentIds', () => {
    const a = hit({ ruleCode: 'A' });
    const b = hit({ ruleCode: 'B' });
    const out = collapseByEventKey([a, b]);
    expect(out[0]!.ruleCode).toBe('A');
    out[0]!.documentIds.push('x');
    expect(a.documentIds).toEqual(['doc-bank-1']);
  });
});

describe('aggregateEntity', () => {
  it('weights the top four collapsed hit scores', () => {
    const hits = [
      hit({ eventKey: 'e1', severity: 4 }),
      hit({ eventKey: 'e2', severity: 3 }),
      hit({ eventKey: 'e3', severity: 2 }),
      hit({ eventKey: 'e4', severity: 1 }),
      hit({ eventKey: 'e5', severity: 1 }),
    ];
    const agg = aggregateEntity(hits);
    expect(agg.baseScore).toBeCloseTo(4 + 1.5 + 0.5 + 0.125, 10);
    expect(agg.familyMultiplier).toBe(1); // single family
    expect(agg.score).toBeCloseTo(6.125, 10);
    expect(agg.distinctEvents).toBe(5);
  });
  it('collapses before aggregating so one event counts once', () => {
    const agg = aggregateEntity([
      hit({ ruleCode: 'D2' }),
      hit({ ruleCode: 'C3', family: 'C' }),
      hit({ ruleCode: 'B4', family: 'B' }),
    ]);
    expect(agg.distinctEvents).toBe(1);
    expect(agg.baseScore).toBe(3);
    expect(agg.familyMultiplier).toBe(1);
  });
  it('applies the family multiplier only when the families rest on two or more documents', () => {
    const sameDoc = aggregateEntity([
      hit({ eventKey: 'e1', family: 'D', documentIds: ['doc1'] }),
      hit({ eventKey: 'e2', family: 'C', documentIds: ['doc1'] }),
    ]);
    expect(sameDoc.familyMultiplier).toBe(1);
    expect(sameDoc.distinctDocuments).toBe(1);

    const twoDocs = aggregateEntity([
      hit({ eventKey: 'e1', family: 'D', documentIds: ['doc1'] }),
      hit({ eventKey: 'e2', family: 'C', documentIds: ['doc2'] }),
    ]);
    expect(twoDocs.familyMultiplier).toBe(1.5);
    expect(twoDocs.score).toBeCloseTo((3 + 1.5) * 1.5, 10);

    const threeFamilies = aggregateEntity([
      hit({ eventKey: 'e1', family: 'D', documentIds: ['doc1'] }),
      hit({ eventKey: 'e2', family: 'C', documentIds: ['doc2'] }),
      hit({ eventKey: 'e3', family: 'B', documentIds: ['doc1'] }),
    ]);
    expect(threeFamilies.familyMultiplier).toBe(2);
  });
  it('caps the score at 8 and sums money at stake for severity ≥ 3', () => {
    const agg = aggregateEntity([
      hit({ eventKey: 'e1', family: 'D', severity: 4, documentIds: ['d1'], amountAtStake: 1000 }),
      hit({ eventKey: 'e2', family: 'C', severity: 4, documentIds: ['d2'], amountAtStake: 2000 }),
      hit({ eventKey: 'e3', family: 'B', severity: 4, documentIds: ['d3'], amountAtStake: 3000 }),
      hit({ eventKey: 'e4', family: 'E', severity: 2, documentIds: ['d4'], amountAtStake: 999 }),
    ]);
    expect(agg.score).toBe(ENTITY_SCORE_CAP);
    expect(agg.eurAtStake).toBe(6000);
    expect(agg.families).toEqual(['D', 'C', 'B', 'E']);
  });
  it('handles an empty hit list', () => {
    expect(aggregateEntity([])).toMatchObject({
      score: 0,
      distinctEvents: 0,
      eurAtStake: 0,
      familyMultiplier: 1,
    });
  });
});

describe('assignTier', () => {
  const direct = { issuerDirectLeg: true };

  it('T1 with one severity-4 hit at confidence ≥ 0.8 and an issuer-direct leg', () => {
    expect(assignTier([hit({ severity: 4, extractionQuality: 0.8 })], direct)).toBe('T1');
    expect(assignTier([hit({ severity: 4, extractionQuality: 0.79 })], direct)).toBe('T2');
  });
  it('T1 with two severity-3 hits from different families at confidence ≥ 0.7', () => {
    const hits = [
      hit({ eventKey: 'e1', family: 'D', extractionQuality: 0.7 }),
      hit({ eventKey: 'e2', family: 'C', extractionQuality: 0.7 }),
    ];
    expect(assignTier(hits, direct)).toBe('T1');
    const sameFamily = [hit({ eventKey: 'e1', family: 'D' }), hit({ eventKey: 'e2', family: 'D' })];
    expect(assignTier(sameFamily, direct)).toBe('T2');
    const sameEvent = [hit({ eventKey: 'e1', family: 'D' }), hit({ eventKey: 'e1', family: 'C' })];
    expect(assignTier(sameEvent, direct)).toBe('T2');
  });
  it('T1 requires an issuer-direct leg and machine two-source fields', () => {
    const hits = [hit({ severity: 4 })];
    expect(assignTier(hits, { issuerDirectLeg: false })).toBe('T2');
    expect(assignTier(hits, { issuerDirectLeg: true, humanConfirmedOnly: true })).toBe('T2');
  });
  it('neverT1T2 hits cannot support T1 or T2', () => {
    expect(assignTier([hit({ severity: 4, neverT1T2: true })], direct)).toBe('T3');
    expect(
      assignTier(
        [hit({ severity: 4, neverT1T2: true }), hit({ eventKey: 'e2', severity: 2 })],
        direct,
      ),
    ).toBe('T2');
  });
  it('T2 needs severity ≥ 2 and confidence ≥ 0.5; otherwise T3', () => {
    expect(assignTier([hit({ severity: 2, extractionQuality: 0.5 })], direct)).toBe('T2');
    expect(assignTier([hit({ severity: 2, extractionQuality: 0.49 })], direct)).toBe('T3');
    expect(assignTier([hit({ severity: 1 })], direct)).toBe('T3');
    expect(assignTier([], direct)).toBe('T3');
  });
});

describe('independenceFromProvenance', () => {
  it('scores issuer-direct legs 1.0', () => {
    expect(independenceFromProvenance(['bank'], true, 'community')).toBe(INDEPENDENCE.issuerDirect);
    expect(independenceFromProvenance(['public_registry'], true)).toBe(1);
    expect(independenceFromProvenance(['vendor_direct'], true)).toBe(1);
  });
  it('scores bank-issued documents that came via the administrator 0.85', () => {
    expect(independenceFromProvenance(['bank', 'administrator'], false)).toBe(
      INDEPENDENCE.bankViaAdministrator,
    );
    expect(independenceFromProvenance(['bank'], false)).toBe(INDEPENDENCE.bankViaAdministrator);
    expect(independenceFromProvenance(['bank', 'administrator', 'scan'], false)).toBe(0.85);
  });
  it('scores photos of printouts, single documents and administrator-origin material 0.7', () => {
    expect(independenceFromProvenance(['bank', 'administrator', 'photo_of_printout'], false)).toBe(
      INDEPENDENCE.singleDocument,
    );
    expect(independenceFromProvenance(['bank', 'printout', 'photo'], true)).toBe(0.7);
    expect(independenceFromProvenance(['administrator'], true)).toBe(0.7);
    expect(independenceFromProvenance([], true)).toBe(0.7);
    expect(independenceFromProvenance(['unknown_source'], true)).toBe(0.7);
  });
  it('downgrades vendor-direct legs while the vendor has an open link finding', () => {
    expect(
      independenceFromProvenance(['vendor_direct'], true, undefined, {
        vendorHasOpenLinkFinding: true,
      }),
    ).toBe(0.7);
  });
  it('downgrades direct bank exports whose holder is not the community', () => {
    expect(independenceFromProvenance(['bank'], true, 'administrator')).toBe(0.85);
  });
});
