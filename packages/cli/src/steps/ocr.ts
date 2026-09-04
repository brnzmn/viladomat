import { maybeOne, transaction } from '../lib/db.ts';
import { OCR_LANG, ocrWords, tesseractVersion } from '../lib/images.ts';
import { getObject, parseStoragePath } from '../lib/storage.ts';
import type { StepJob, StepResult } from './types.ts';

/**
 * Step `ocr` — Tesseract word boxes for one page render.
 *
 * The words are the second reader of the two-source rule and the anchor for every printed crop, so
 * they must be expressed in the coordinates of the stored render. Native PDF pages keep their text
 * layer in `pages.text_layer`, but the PDFium binding used here returns that text without glyph
 * positions; word boxes therefore still come from Tesseract, which also keeps the second reader
 * independent of the PDF producer.
 *
 * Idempotent: the page's existing words are deleted and re-inserted in one transaction.
 */
type PageRow = {
  id: string;
  community_id: string;
  file_id: string;
  page_no: number;
  render_path: string | null;
  has_text_layer: boolean | null;
  text_layer: string | null;
  render_source: string | null;
  original_name: string;
};

export async function ocrStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const pageId = typeof payload.page_id === 'string' ? payload.page_id : '';
  if (!pageId) throw new Error('ocr: payload.page_id is required');
  const lang = typeof payload.lang === 'string' && payload.lang !== '' ? payload.lang : OCR_LANG;

  const page = await maybeOne<PageRow>(
    `select p.id, p.community_id, p.file_id, p.page_no, p.render_path, p.has_text_layer, p.text_layer,
            p.render_params ->> 'source' as render_source, f.original_name
       from public.pages p join public.files f on f.id = p.file_id
      where p.id = $1`,
    [pageId],
  );
  if (!page) throw new Error(`ocr: page ${pageId} not found`);
  if (!page.render_path) throw new Error(`ocr: page ${pageId} has no render yet`);

  const nativeText = page.has_text_layer === true && (page.text_layer ?? '').trim() !== '' && page.render_source === 'pdfium';
  const { bucket, key } = parseStoragePath(page.render_path);
  const jpeg = await getObject(bucket, key);
  const words = await ocrWords(jpeg, lang);
  const engineVersion = await tesseractVersion();

  await transaction(async (client) => {
    await client.query('delete from public.ocr_words where page_id = $1', [page.id]);
    if (words.length === 0) return;
    await client.query(
      `insert into public.ocr_words (page_id, idx, text, x0, y0, x1, y1, confidence, engine, engine_version, lang)
       select $1, t.idx, t.text, t.x0, t.y0, t.x1, t.y1, t.confidence, 'tesseract', $9, $10
         from unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::numeric[])
              as t(idx, text, x0, y0, x1, y1, confidence)`,
      [
        page.id,
        words.map((w) => w.idx),
        words.map((w) => w.text),
        words.map((w) => w.x0),
        words.map((w) => w.y0),
        words.map((w) => w.x1),
        words.map((w) => w.y1),
        words.map((w) => w.confidence),
        engineVersion,
        lang,
      ],
    );
  });

  const mean = words.length > 0 ? words.reduce((s, w) => s + (w.confidence ?? 0), 0) / words.length : 0;
  console.log(
    `ocr ${page.original_name} p${page.page_no}: ${words.length} word(s), mean confidence ${mean.toFixed(1)}` +
      `${nativeText ? ' (page also carries a PDF text layer)' : ''}`,
  );
  return {
    page_id: page.id,
    words: words.length,
    lang,
    engine_version: engineVersion,
    has_text_layer: page.has_text_layer === true,
    text_layer_source: nativeText ? 'pdfium' : null,
  };
}
