import { describe, expect, it } from 'vitest';
import {
  applyGates,
  baseRateGate,
  compareFindings,
  DISTRIBUTABLE_STATUSES,
  legalCitationGate,
  refusalRecorded,
  replyGate,
  SCORE_FIELDS,
  scoreFieldsPresent,
  stripScores,
  tierGate,
  withholdCitations,
  type FindingStatus,
  type GateFinding,
  type RuleCatalogEntry,
  type Tier,
} from './gates.ts';

const rule = (over: Partial<RuleCatalogEntry> = {}): RuleCatalogEntry => ({
  code: 'D1',
  family: 'D',
  version: 1,
  nameEs: 'Residuos a tres bandas',
  nameEn: 'Three-way residuals',
  description: null,
  legalBasisKind: 'internal_control',
  attribution: 'funds',
  articleRefs: [],
  legalSourceIds: [],
  neverT1T2: false,
  worklistEligible: true,
  enabledInV1: true,
  milestone: 'M3',
  specificity: 0.85,
  ...over,
});

let seq = 0;
const finding = (over: Partial<GateFinding> = {}): GateFinding => {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    fingerprint: `fp${String(seq).padStart(4, '0')}`,
    ruleCode: 'D1',
    ruleVersion: 1,
    tier: 'T2',
    severity: 3,
    status: 'confirmed_discrepancy',
    explanationRequestedOn: '2026-08-01',
    explanationReceivedOn: null,
    fourEyesOk: false,
    extractionQuality: 0.9,
    independence: 0.7,
    specificity: 0.85,
    confidence: 0.535,
    hitScore: 1.6,
    amountAtStake: 900,
    fiscalYear: 2024,
    actDateFirst: '2024-06-01',
    actDateLast: '2024-06-01',
    summaryEs: 'Cargo no conciliado. Verificar.',
    summaryEn: 'Debit not reconciled. Verify.',
    innocentExplanations: [],
    nextCheck: null,
    resolvingDocument: null,
    computed: {},
    entityType: 'bank_transaction',
    entityId: null,
    worksPackageId: null,
    rule: rule(),
    reviews: [],
    evidence: [],
    ...over,
  };
};

describe('(a) right of reply', () => {
  it('lets through only the three workflow states that follow a request', () => {
    expect([...DISTRIBUTABLE_STATUSES].sort()).toEqual(['confirmed_discrepancy', 'explained', 'needs_document']);
    for (const status of DISTRIBUTABLE_STATUSES) {
      expect(replyGate({ status, explanationRequestedOn: '2026-08-01' })).toEqual({ ok: true, reason: 'ok' });
    }
  });

  it('withholds an item that has not reached one of those states, however complete it looks', () => {
    for (const status of ['new', 'in_review', 'sent_for_explanation', 'dismissed_fp'] as FindingStatus[]) {
      expect(replyGate({ status, explanationRequestedOn: '2026-08-01' })).toEqual({ ok: false, reason: 'status_not_reached' });
    }
  });

  it('withholds an item whose request for clarifications was never dated', () => {
    expect(replyGate({ status: 'explained', explanationRequestedOn: null })).toEqual({ ok: false, reason: 'no_request_recorded' });
  });

  it('accepts a dated refusal recorded in the latest review as a reply', () => {
    expect(refusalRecorded('la administración se niega a facilitar los extractos, 2026-08-20')).toBe(true);
    expect(refusalRecorded('declined to answer on 2026-08-20')).toBe(true);
    expect(refusalRecorded('reviewed and queued')).toBe(false);
    expect(
      replyGate({ status: 'needs_document', explanationRequestedOn: null, latestReviewReason: 'refusal recorded on 2026-08-20' }),
    ).toEqual({ ok: true, reason: 'ok' });
  });
});

describe('(b) legal citation', () => {
  const archived = new Set(['cccat-553-6']);

  it('prints the article when the basis is statutory and every source is archived', () => {
    const r = legalCitationGate(
      { legalBasisKind: 'statutory', articleRefs: ['CCCat 553-6'], legalSourceIds: ['cccat-553-6'] },
      archived,
      'es',
    );
    expect(r).toMatchObject({ printable: true, articles: ['CCCat 553-6'], reason: 'ok', placeholder: null });
  });

  it('withholds the article while any cited source is unarchived, naming what is missing', () => {
    const r = legalCitationGate(
      { legalBasisKind: 'statutory', articleRefs: ['CCCat 553-6', 'CCCat 553-18'], legalSourceIds: ['cccat-553-6', 'cccat-553-18'] },
      archived,
      'es',
    );
    expect(r.printable).toBe(false);
    expect(r.articles).toEqual([]);
    expect(r.placeholder).toBe('referencia normativa pendiente de archivo');
    expect(r.missingSources).toEqual(['cccat-553-18']);
    expect(legalCitationGate({ legalBasisKind: 'statutory', articleRefs: ['x'], legalSourceIds: ['y'] }, archived, 'en').placeholder).toBe(
      'legal reference pending archive',
    );
  });

  it('treats a rule that declares no source at all as unarchived', () => {
    const r = legalCitationGate({ legalBasisKind: 'subsidy_bases', articleRefs: ['Ley 38/2003 art. 31.3'], legalSourceIds: [] }, archived, 'es');
    expect(r.printable).toBe(false);
    expect(r.reason).toBe('source_not_archived');
  });

  it('never prints an article for a professional-standard or internal-control rule', () => {
    for (const kind of ['professional_standard', 'internal_control'] as const) {
      const r = legalCitationGate({ legalBasisKind: kind, articleRefs: ['CCCat 553-6'], legalSourceIds: ['cccat-553-6'] }, archived, 'es');
      expect(r.printable).toBe(false);
      expect(r.reason).toBe('basis_kind_not_citable');
    }
  });

  it('says nothing at all when the rule cites no article', () => {
    const r = legalCitationGate({ legalBasisKind: 'internal_control', articleRefs: [], legalSourceIds: [] }, archived, 'es');
    expect(r).toMatchObject({ printable: false, reason: 'no_articles', placeholder: null });
  });

  it('withholds citations inside free text that cannot point at a source', () => {
    const out = withholdCitations('Ley 11/2021 amending Ley 7/2012 art. 7: limit reduced (statutory).', 'es');
    expect(out).not.toContain('Ley 7/2012');
    expect(out).not.toContain('art. 7');
    expect(out).toContain('referencia normativa pendiente de archivo');
    expect(out).toContain('limit reduced (statutory).');
    expect(withholdCitations('Minimum outflow considered by payment rules (internal control).', 'es')).toBe(
      'Minimum outflow considered by payment rules (internal control).',
    );
  });
});

describe('(c) tier', () => {
  it('keeps tier 1 when a second pair of eyes signed off', () => {
    expect(tierGate({ tier: 'T1', fourEyesOk: true, extractionQuality: 0.9, independence: 0.7 })).toEqual({
      tier: 'T1',
      capped: false,
      reason: 'ok',
    });
  });

  it('keeps tier 1 on machine two-source fields with an issuer-direct leg', () => {
    expect(tierGate({ tier: 'T1', fourEyesOk: false, extractionQuality: 0.99, independence: 1 })).toMatchObject({ tier: 'T1', capped: false });
  });

  it('caps a single reviewer at tier 2 whichever threshold falls short', () => {
    expect(tierGate({ tier: 'T1', fourEyesOk: false, extractionQuality: 0.98, independence: 1 })).toEqual({
      tier: 'T2',
      capped: true,
      reason: 'capped_to_t2_single_reviewer',
    });
    expect(tierGate({ tier: 'T1', fourEyesOk: false, extractionQuality: 1, independence: 0.85 })).toMatchObject({ tier: 'T2', capped: true });
    expect(tierGate({ tier: 'T1', fourEyesOk: false, extractionQuality: null, independence: null })).toMatchObject({ tier: 'T2', capped: true });
  });

  it('leaves tiers 2 and 3 alone', () => {
    for (const tier of ['T2', 'T3'] as Tier[]) {
      expect(tierGate({ tier, fourEyesOk: false, extractionQuality: 0.1, independence: 0.1 })).toEqual({ tier, capped: false, reason: 'ok' });
    }
  });
});

describe('(d) base-rate rules', () => {
  it('sends a base-rate rule to the annex whatever tier it carried', () => {
    expect(baseRateGate({ neverT1T2: true, tier: 'T1' })).toEqual({ annexOnly: true, tier: 'T3' });
    expect(baseRateGate({ neverT1T2: true, tier: 'T2' })).toEqual({ annexOnly: true, tier: 'T3' });
  });

  it('sends tier 3 to the annex and leaves tiers 1 and 2 in the body', () => {
    expect(baseRateGate({ neverT1T2: false, tier: 'T3' })).toEqual({ annexOnly: true, tier: 'T3' });
    expect(baseRateGate({ neverT1T2: false, tier: 'T2' })).toEqual({ annexOnly: false, tier: 'T2' });
    expect(baseRateGate({ neverT1T2: false, tier: 'T1' })).toEqual({ annexOnly: false, tier: 'T1' });
  });
});

describe('(e) scores', () => {
  it('names exactly the four fields that never print', () => {
    expect([...SCORE_FIELDS]).toEqual(['hit_score', 'specificity', 'independence', 'confidence']);
  });

  it('drops every score field and the extraction quality behind them', () => {
    const out = stripScores({ fingerprint: 'a', hit_score: 2.4, specificity: 0.85, independence: 0.7, confidence: 0.5, extraction_quality: 0.9, amount: 900 });
    expect(out).toEqual({ fingerprint: 'a', amount: 900 });
  });

  it('reports which score fields a rendered text still carries', () => {
    expect(scoreFieldsPresent('<p>amount 900</p>')).toEqual([]);
    expect(scoreFieldsPresent('<td>hit_score 2.4</td><td>confidence 0.5</td>')).toEqual(['hit_score', 'confidence']);
  });
});

describe('deterministic ordering', () => {
  it('orders by fiscal year, then rule code, then fingerprint, with undated items last', () => {
    const rows = [
      finding({ fiscalYear: 2025, ruleCode: 'D1', fingerprint: 'b' }),
      finding({ fiscalYear: null, ruleCode: 'A1', fingerprint: 'a' }),
      finding({ fiscalYear: 2024, ruleCode: 'E5', fingerprint: 'c' }),
      finding({ fiscalYear: 2024, ruleCode: 'D1', fingerprint: 'z' }),
      finding({ fiscalYear: 2024, ruleCode: 'D1', fingerprint: 'a' }),
    ];
    const sorted = [...rows].sort(compareFindings).map((f) => `${f.fiscalYear ?? '-'}/${f.ruleCode}/${f.fingerprint}`);
    expect(sorted).toEqual(['2024/D1/a', '2024/D1/z', '2024/E5/c', '2025/D1/b', '-/A1/a']);
  });
});

describe('applyGates', () => {
  it('splits findings into distributed, withheld and annex, and counts each', () => {
    const distributed = finding({ fiscalYear: 2024, status: 'confirmed_discrepancy', explanationRequestedOn: '2026-08-01' });
    const pending = finding({ fiscalYear: 2024, ruleCode: 'D6', status: 'new', explanationRequestedOn: null, rule: rule({ code: 'D6', legalBasisKind: 'statutory', articleRefs: ['CCCat 553-6'], legalSourceIds: ['cccat-553-6'] }) });
    const baseRate = finding({ fiscalYear: 2024, ruleCode: 'E4', tier: 'T2', rule: rule({ code: 'E4', neverT1T2: true }) });
    const observation = finding({ fiscalYear: 2024, ruleCode: 'E5', tier: 'T3' });
    const out = applyGates([observation, baseRate, pending, distributed], new Set(), 'es');

    expect(out.distributed.map((g) => g.finding.ruleCode)).toEqual(['D1']);
    expect(out.pendingReply.map((g) => g.finding.ruleCode)).toEqual(['D6']);
    expect(out.annex.map((g) => g.finding.ruleCode).sort()).toEqual(['E4', 'E5']);
    expect(out.stats).toMatchObject({
      findings_total: 4,
      findings_distributed: 1,
      withheld_pending_reply: 1,
      withheld_pending_legal_source: 1,
      annex_only: 2,
      unreviewed_t1t2: 1,
    });
    expect(out.stats.pending_by_status).toEqual({ new: 1 });
  });

  it('caps a tier-1 item without four eyes and reports it', () => {
    const out = applyGates([finding({ tier: 'T1', fourEyesOk: false, extractionQuality: 0.9, independence: 0.7 })], new Set(), 'es');
    expect(out.distributed[0]?.effectiveTier).toBe('T2');
    expect(out.distributed[0]?.tierCapped).toBe(true);
    expect(out.stats.tier_capped).toBe(1);
  });

  it('carries the counterparty reply and its attachments next to the item', () => {
    const f = finding({
      status: 'confirmed_discrepancy',
      explanationRequestedOn: '2026-08-01',
      explanationReceivedOn: '2026-08-25',
      reviews: [
        { fromStatus: 'in_review', toStatus: 'sent_for_explanation', reason: 'letter sent', createdAt: '2026-08-01T10:00:00Z', attachments: [] },
        {
          fromStatus: 'sent_for_explanation',
          toStatus: 'confirmed_discrepancy',
          reason: 'Respuesta recibida: el importe corresponde a una provisión.',
          createdAt: '2026-08-25T10:00:00Z',
          attachments: [{ fileId: 'f1', sha256: 'abc123', originalName: 'respuesta.pdf' }],
        },
      ],
    });
    const g = applyGates([f], new Set(), 'es').distributed[0];
    expect(g?.replyText).toContain('Respuesta recibida');
    expect(g?.replyReceivedOn).toBe('2026-08-25');
    expect(g?.replyAttachments[0]?.sha256).toBe('abc123');
  });

  it('keeps a dismissed item out of the body and in the annex', () => {
    const out = applyGates([finding({ status: 'dismissed_fp' })], new Set(), 'es');
    expect(out.distributed).toHaveLength(0);
    expect(out.annex).toHaveLength(1);
  });
});
