import { describe, expect, it } from 'vitest';
import type { PageClassification } from '../extract/adapter.ts';
import {
  MAX_GROUP_PAGES,
  groupPages,
  hintKey,
  majorityDocType,
  majorityLanguage,
  orderPages,
  parsePageMarker,
  provenanceOf,
  weakestProvenance,
  type BatchPage,
  type GroupablePage,
} from './group.ts';

/**
 * Stage A and stage C of the grouping step, on canned classifications.
 *
 * These are the decisions a person would otherwise make on the confirmation screen, so each case
 * below is one thing the operator should be able to trust without looking: that the order of a batch
 * is reproducible, that a multi-page PDF is not cut into pieces, that a genuinely new document
 * inside one PDF is, that a printed page marker joins pages the classifier was unsure about, and
 * that no chain runs away past the cap.
 */

function cls(over: Partial<PageClassification> = {}): PageClassification {
  return {
    page_index: 0,
    doc_type: 'factura',
    page_role: 'single',
    issuer_name_hint: null,
    doc_number_hint: null,
    date_hint: null,
    page_marker: null,
    language: 'ca',
    legibility: 0.95,
    is_handwritten_mostly: false,
    continues_previous: false,
    continues_previous_confidence: 0,
    reason: 'test',
    ...over,
  };
}

function page(over: Omit<Partial<GroupablePage>, 'cls'> & { cls?: Partial<PageClassification> } = {}): GroupablePage {
  const { cls: clsOver, ...rest } = over;
  return {
    key: 'p',
    file_id: 'f1',
    page_no: 1,
    is_pdf: false,
    cls: cls(clsOver),
    ...rest,
  };
}

function batchPage(over: Partial<BatchPage> = {}): BatchPage {
  return {
    page_id: 'p',
    file_id: 'f',
    page_no: 1,
    thumb_path: 'derived/c/s/t1.jpg',
    mime: 'image/jpeg',
    original_name: 'img1.jpg',
    capture_epoch: null,
    uploaded_epoch: 1000,
    supplied_by_role: 'administrator',
    file_source: 'admin_delivery',
    ...over,
  };
}

describe('stage A: deterministic order', () => {
  it('puts photos in the order they were taken', () => {
    const pages = [
      batchPage({ page_id: 'c', original_name: 'IMG_0003.HEIC', capture_epoch: 300 }),
      batchPage({ page_id: 'a', original_name: 'IMG_0001.HEIC', capture_epoch: 100 }),
      batchPage({ page_id: 'b', original_name: 'IMG_0002.HEIC', capture_epoch: 200 }),
    ];
    expect(orderPages(pages).map((p) => p.page_id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to a natural sort of the file name, so scan-02 precedes scan-10', () => {
    const pages = [
      batchPage({ page_id: 'ten', original_name: 'scan-10.jpg' }),
      batchPage({ page_id: 'two', original_name: 'scan-02.jpg' }),
      batchPage({ page_id: 'one', original_name: 'scan-1.jpg' }),
    ];
    expect(orderPages(pages).map((p) => p.page_id)).toEqual(['one', 'two', 'ten']);
  });

  it('keeps the pages of one PDF in file order and is stable across re-runs', () => {
    const pages = [
      batchPage({ page_id: 'p3', file_id: 'pdf', page_no: 3, mime: 'application/pdf', original_name: 'acta.pdf', uploaded_epoch: 5 }),
      batchPage({ page_id: 'p1', file_id: 'pdf', page_no: 1, mime: 'application/pdf', original_name: 'acta.pdf', uploaded_epoch: 5 }),
      batchPage({ page_id: 'p2', file_id: 'pdf', page_no: 2, mime: 'application/pdf', original_name: 'acta.pdf', uploaded_epoch: 5 }),
    ];
    const once = orderPages(pages).map((p) => p.page_id);
    const twice = orderPages([...pages].reverse()).map((p) => p.page_id);
    expect(once).toEqual(['p1', 'p2', 'p3']);
    expect(twice).toEqual(once);
  });

  it('sorts files with a capture time before files without one', () => {
    const pages = [
      batchPage({ page_id: 'pdf', original_name: 'aaa.pdf', mime: 'application/pdf' }),
      batchPage({ page_id: 'photo', original_name: 'zzz.jpg', capture_epoch: 10 }),
    ];
    expect(orderPages(pages).map((p) => p.page_id)).toEqual(['photo', 'pdf']);
  });
});

describe('page markers', () => {
  it.each([
    ['Pág. 2/3', { page: 2, of: 3 }],
    ['Página 2 de 5', { page: 2, of: 5 }],
    ['Hoja 2 de 3', { page: 2, of: 3 }],
    ['Full 2 de 3', { page: 2, of: 3 }],
    ['2/5', { page: 2, of: 5 }],
    ['Pagina 4', { page: 4, of: null }],
  ])('reads %s', (raw, expected) => {
    const marker = parsePageMarker(raw);
    expect(marker).not.toBeNull();
    expect(marker?.page).toBe(expected.page);
    expect(marker?.of).toBe(expected.of);
  });

  it('recognises a carried-forward total', () => {
    expect(parsePageMarker('Suma y sigue')?.carry).toBe(true);
    expect(parsePageMarker('Suma i segueix')?.carry).toBe(true);
  });

  it('returns null when nothing is printed', () => {
    expect(parsePageMarker(null)).toBeNull();
    expect(parsePageMarker('total factura')).toBeNull();
  });

  it('compares issuer and number hints without punctuation or accents', () => {
    expect(hintKey('F-2024/017')).toBe(hintKey('F 2024 017'));
    expect(hintKey('Instal·lacions Exemple S.L.')).toBe(hintKey('INSTALLACIONS EXEMPLE SL'));
    expect(hintKey(null)).toBe('');
  });
});

describe('stage C: grouping', () => {
  it('keeps the pages of one PDF together', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'pdf', page_no: 1, is_pdf: true, cls: { doc_type: 'acta', page_role: 'first' } }),
      page({ key: 'b', file_id: 'pdf', page_no: 2, is_pdf: true, cls: { doc_type: 'acta', page_role: 'continuation' } }),
      page({ key: 'c', file_id: 'pdf', page_no: 3, is_pdf: true, cls: { doc_type: 'acta', page_role: 'last' } }),
    ];
    const groups = groupPages(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toEqual([0, 1, 2]);
    expect(groups[0]?.docType).toBe('acta');
    expect(groups[0]?.reason).toContain('same PDF');
  });

  it('cuts one PDF when the classifier marks a first page of another type', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'pdf', page_no: 1, is_pdf: true, cls: { doc_type: 'acta', page_role: 'first' } }),
      page({ key: 'b', file_id: 'pdf', page_no: 2, is_pdf: true, cls: { doc_type: 'acta', page_role: 'last' } }),
      page({ key: 'c', file_id: 'pdf', page_no: 3, is_pdf: true, cls: { doc_type: 'factura', page_role: 'first' } }),
      page({ key: 'd', file_id: 'pdf', page_no: 4, is_pdf: true, cls: { doc_type: 'factura', page_role: 'last' } }),
    ];
    const groups = groupPages(pages);
    expect(groups.map((g) => g.members)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(groups.map((g) => g.docType)).toEqual(['acta', 'factura']);
  });

  it('does not cut a PDF when a page is marked first but keeps the same type', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'pdf', page_no: 1, is_pdf: true, cls: { doc_type: 'acta', page_role: 'first' } }),
      page({ key: 'b', file_id: 'pdf', page_no: 2, is_pdf: true, cls: { doc_type: 'acta', page_role: 'first' } }),
    ];
    expect(groupPages(pages)).toHaveLength(1);
  });

  it('joins photos when the classifier is confident the page continues the previous one', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1' }),
      page({ key: 'b', file_id: 'f2', cls: { continues_previous: true, continues_previous_confidence: 0.94 } }),
    ];
    const groups = groupPages(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBeCloseTo(0.94);
  });

  it('leaves photos apart when the classifier is not confident', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1' }),
      page({ key: 'b', file_id: 'f2', cls: { continues_previous: true, continues_previous_confidence: 0.5 } }),
    ];
    expect(groupPages(pages)).toHaveLength(2);
  });

  it('joins photos that print the same number from the same issuer', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1', cls: { doc_number_hint: 'F-2024/017', issuer_name_hint: 'Instal·lacions Exemple S.L.' } }),
      page({ key: 'b', file_id: 'f2', cls: { doc_number_hint: 'F 2024 017', issuer_name_hint: 'INSTALLACIONS EXEMPLE SL' } }),
    ];
    const groups = groupPages(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toContain('same document number and issuer');
  });

  it('joins a photo chain by its printed page markers', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1', cls: { page_marker: 'Pàg. 1/3' } }),
      page({ key: 'b', file_id: 'f2', cls: { page_marker: 'Pàg. 2/3' } }),
      page({ key: 'c', file_id: 'f3', cls: { page_marker: 'Pàg. 3/3' } }),
      page({ key: 'd', file_id: 'f4', cls: { page_marker: 'Pàg. 1/2', doc_type: 'acta' } }),
    ];
    const groups = groupPages(pages);
    expect(groups.map((g) => g.members)).toEqual([[0, 1, 2], [3]]);
  });

  it('joins the page after a carried-forward total', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1', cls: { page_marker: 'Suma y sigue' } }),
      page({ key: 'b', file_id: 'f2' }),
    ];
    expect(groupPages(pages)).toHaveLength(1);
  });

  it('caps a chain at 30 pages and continues in the next group', () => {
    const pages: GroupablePage[] = Array.from({ length: 35 }, (_, i) =>
      page({
        key: `p${i}`,
        file_id: 'pdf',
        page_no: i + 1,
        is_pdf: true,
        cls: { doc_type: 'extracto_bancario', page_role: i === 0 ? 'first' : 'continuation' },
      }),
    );
    const groups = groupPages(pages);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.members).toHaveLength(MAX_GROUP_PAGES);
    expect(groups[1]?.members).toHaveLength(5);
    expect(groups[0]?.reason).toContain(`cap of ${MAX_GROUP_PAGES} pages`);
  });

  it('gives a single page full confidence, because no join was made', () => {
    const groups = groupPages([page({ key: 'only' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe(1);
  });

  it('takes the lowest confidence of the chain', () => {
    const pages: GroupablePage[] = [
      page({ key: 'a', file_id: 'f1' }),
      page({ key: 'b', file_id: 'f2', cls: { continues_previous: true, continues_previous_confidence: 0.99 } }),
      page({ key: 'c', file_id: 'f3', cls: { continues_previous: true, continues_previous_confidence: 0.81 } }),
    ];
    expect(groupPages(pages)[0]?.confidence).toBeCloseTo(0.81);
  });
});

describe('document type and language of a group', () => {
  it('takes the majority type, breaking ties with the first page', () => {
    expect(
      majorityDocType([
        page({ cls: { doc_type: 'acta' } }),
        page({ cls: { doc_type: 'factura' } }),
        page({ cls: { doc_type: 'factura' } }),
      ]),
    ).toBe('factura');
    expect(majorityDocType([page({ cls: { doc_type: 'acta' } }), page({ cls: { doc_type: 'factura' } })])).toBe('acta');
  });

  it('reports mixed when two languages are equally present, and unknown when none is legible', () => {
    expect(majorityLanguage([page({ cls: { language: 'ca' } }), page({ cls: { language: 'es' } })])).toBe('mixed');
    expect(majorityLanguage([page({ cls: { language: 'unknown' } })])).toBe('unknown');
    expect(majorityLanguage([page({ cls: { language: 'ca' } }), page({ cls: { language: 'ca' } }), page({ cls: { language: 'es' } })])).toBe('ca');
  });
});

describe('provenance', () => {
  it('maps the supplying role to an issuer class and a chain', () => {
    expect(provenanceOf('administrator', 'admin_delivery')).toMatchObject({
      issuer_class: 'administrator',
      provenance_chain: ['administrator', 'requesting_owner'],
      obtained_directly: false,
    });
    expect(provenanceOf('president', 'admin_delivery').provenance_chain).toEqual(['president', 'requesting_owner']);
    expect(provenanceOf('requesting_owner', 'local').provenance_chain).toEqual(['requesting_owner']);
  });

  it('treats a bank export as obtained directly', () => {
    expect(provenanceOf(null, 'bank_export')).toMatchObject({ issuer_class: 'bank', provenance_chain: ['bank'], obtained_directly: true });
  });

  it('treats an on-site capture as administrator provenance', () => {
    expect(provenanceOf(null, 'onsite').provenance_chain).toEqual(['administrator', 'requesting_owner']);
  });

  it('takes the least independent leg when a document spans files', () => {
    const p = weakestProvenance([
      { supplied_by_role: null, file_source: 'bank_export' },
      { supplied_by_role: 'administrator', file_source: 'admin_delivery' },
    ]);
    expect(p.issuer_class).toBe('administrator');
    expect(p.obtained_directly).toBe(false);
  });
});
