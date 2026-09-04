import { describe, expect, it } from 'vitest';
import { normaliseValue } from '@viladomat/core';
import { valueKindOf } from '../extract/persist.ts';
import { cropStatusFor, foldForMatch, insideBbox, locateQuote, similarity, twoSourceStatus, type Bbox, type OcrWord } from './crosscheck.ts';
import { statusAfterVerify } from './verify.ts';

/**
 * The two-source rule and the machinery that decides whether the two sources agree.
 *
 * The quote locator is what makes the rule usable at all: Tesseract and the model tokenise the same
 * printed figure differently, so the comparison has to be fuzzy about how the characters are cut up
 * and exact about what they mean once normalised.
 */

let nextIdx = 0;
function word(text: string, x0: number, y0: number, x1 = x0 + 40, y1 = y0 + 20): OcrWord {
  return { idx: nextIdx++, text, x0, y0, x1, y1 };
}

/** A canned invoice page: a totals block on the right, and a decoy amount in a line above it. */
function invoicePage(): OcrWord[] {
  nextIdx = 0;
  return [
    word('Instal·lacions', 60, 100, 200, 120),
    word('Exemple', 205, 100, 280, 120),
    word('S.L.', 285, 100, 320, 120),
    word('Base', 60, 400, 110, 420),
    word('imponible', 115, 400, 210, 420),
    word('2.940,00', 820, 400, 920, 420),
    word('IVA', 60, 440, 90, 460),
    word('313,80', 840, 440, 920, 460),
    word('TOTAL', 60, 480, 130, 500),
    word('3.253,80', 820, 480, 930, 500),
    word('€', 935, 480, 950, 500),
    word('Anterior', 60, 900, 140, 920),
    word('3.253,80', 820, 900, 930, 920),
  ];
}

const TOTAL_BBOX: Bbox = [810, 470, 960, 510];

describe('folding text for comparison', () => {
  it('keeps digits and separators, drops currency symbols and accents', () => {
    expect(foldForMatch('3.253,80 €')).toBe('3.253,80');
    expect(foldForMatch('Instal·lacions')).toBe('instal lacions');
  });

  it('scores identical strings 1 and unrelated ones near 0', () => {
    expect(similarity('3.253,80', '3.253,80')).toBe(1);
    expect(similarity('3.253,80', '9.111,11')).toBeLessThan(0.5);
  });
});

describe('locating a quote in the OCR words', () => {
  it('finds the amount inside the box the model returned', () => {
    const match = locateQuote(invoicePage(), '3.253,80 €', TOTAL_BBOX);
    expect(match).not.toBeNull();
    expect(match?.scope).toBe('bbox');
    expect(match?.insideBbox).toBe(true);
    expect(foldForMatch(match?.text ?? '')).toBe('3.253,80');
  });

  it('prefers the box over an identical amount printed elsewhere on the page', () => {
    const match = locateQuote(invoicePage(), '3.253,80 €', TOTAL_BBOX);
    expect(match?.words.every((w) => w.y0 < 600)).toBe(true);
  });

  it('falls back to the whole page when the box holds nothing', () => {
    const match = locateQuote(invoicePage(), '2.940,00', [10, 10, 40, 40]);
    expect(match).not.toBeNull();
    expect(match?.scope).toBe('page');
    expect(match?.insideBbox).toBe(false);
  });

  it('finds a quote the OCR split across several words', () => {
    const words = [word('Base', 60, 400), word('2.940,00', 820, 400), word('€', 930, 400)];
    const match = locateQuote(words, '2.940,00 €', null);
    expect(foldForMatch(match?.text ?? '')).toBe('2.940,00');
  });

  it('tolerates a single misread character', () => {
    const words = [word('3.253,8O', 820, 480, 930, 500)];
    const match = locateQuote(words, '3.253,80', TOTAL_BBOX);
    expect(match).not.toBeNull();
    expect(match?.score).toBeGreaterThan(0.82);
  });

  it('reports nothing when the quote is not on the page', () => {
    expect(locateQuote(invoicePage(), '9.999,99', null)).toBeNull();
    expect(locateQuote(invoicePage(), null, null)).toBeNull();
    expect(locateQuote([], '3.253,80', null)).toBeNull();
  });

  it('treats a word as inside the box when its centre falls within the grown box', () => {
    expect(insideBbox(word('x', 820, 480, 930, 500), TOTAL_BBOX)).toBe(true);
    expect(insideBbox(word('x', 60, 900, 130, 920), TOTAL_BBOX)).toBe(false);
  });
});

describe('crop status', () => {
  it('is anchored only when the located words sit inside the model box', () => {
    const anchored = locateQuote(invoicePage(), '3.253,80 €', TOTAL_BBOX);
    expect(cropStatusFor(anchored, TOTAL_BBOX)).toBe('anchored');
  });

  it('is approximate when the words were found outside the box', () => {
    const found = locateQuote(invoicePage(), '2.940,00', [10, 10, 40, 40]);
    expect(cropStatusFor(found, [10, 10, 40, 40])).toBe('approximate');
  });

  it('is page_only when nothing was located', () => {
    expect(cropStatusFor(null, TOTAL_BBOX)).toBe('page_only');
    expect(cropStatusFor(null, null)).toBe('page_only');
  });
});

describe('the two-source rule', () => {
  it('accepts a field only when the validators of its family passed and the readers agree', () => {
    expect(twoSourceStatus(true, true)).toBe('auto_accepted');
    expect(twoSourceStatus(false, true)).toBe('needs_review');
    expect(twoSourceStatus(true, false)).toBe('needs_review');
    expect(twoSourceStatus(false, false)).toBe('needs_review');
  });

  it('never accepts a field whose validators or OCR result are unknown', () => {
    expect(twoSourceStatus(null, true)).toBe('needs_review');
    expect(twoSourceStatus(true, null)).toBe('needs_review');
  });

  it('compares the two readings after normalising both, so 3.253,80 € equals 3253.80', () => {
    const modelValue = normaliseValue(valueKindOf('amount'), 3253.8);
    const ocrValue = normaliseValue(valueKindOf('amount'), '3.253,80 €');
    expect(modelValue).toBe('3253.80');
    expect(ocrValue).toBe(modelValue);
    expect(twoSourceStatus(true, modelValue === ocrValue)).toBe('auto_accepted');
  });

  it('sees a genuine disagreement between the readers', () => {
    const modelValue = normaliseValue(valueKindOf('amount'), 3253.8);
    const ocrValue = normaliseValue(valueKindOf('amount'), '3.263,80');
    expect(twoSourceStatus(true, modelValue === ocrValue)).toBe('needs_review');
  });
});

describe('the third opinion', () => {
  it('demotes an accepted field when Sonnet reads something else', () => {
    expect(statusAfterVerify('auto_accepted', false)).toBe('needs_review');
  });

  it('never promotes: agreement leaves a field where it was', () => {
    expect(statusAfterVerify('needs_review', true)).toBe('needs_review');
    expect(statusAfterVerify('auto_accepted', true)).toBe('auto_accepted');
    expect(statusAfterVerify('unreadable', true)).toBe('unreadable');
  });

  it('leaves a field alone when the third reading returned nothing for it', () => {
    expect(statusAfterVerify('auto_accepted', null)).toBe('auto_accepted');
  });
});
