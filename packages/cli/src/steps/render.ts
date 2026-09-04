import { maybeOne, one, query } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import {
  heicToJpeg,
  hamming,
  isHeicMime,
  isRenderable,
  openPdf,
  phash,
  phashToBuffer,
  renderImage,
  rotationForOrientation,
  thumbnail,
  type ExifData,
} from '../lib/images.ts';
import { getObject, parseStoragePath, putObject } from '../lib/storage.ts';
import type { StepJob, StepResult } from './types.ts';
import { longEdgeFrom } from './types.ts';

/**
 * Step `render` — one reproducible page image per page of a file.
 *
 * HEIC becomes JPEG, EXIF orientation is baked into the pixels, PDF pages are rasterised with
 * PDFium, and every render is written next to a 768 px thumbnail under `derived/`. The parameters
 * that produced the image are stored with it (`pages.render_params`), because every later crop and
 * OCR box is expressed in the pixel coordinates of exactly this render.
 *
 * Near-duplicate frames of the same page (two shots of one sheet) are linked, not deleted:
 * `dedupe_of_page_id` is set only for the safe case — perceptual distance ≤ 4 **and** capture times
 * within 10 s inside the same batch. Everything else is left for the grouping screen to decide.
 *
 * Idempotent: renders are re-written under the same keys and `pages` is keyed by (file_id, page_no).
 */

/** Perceptual distance at which two frames of the same batch are treated as the same page. */
export const DEDUPE_MAX_DISTANCE = 4;
/** Capture-time window for that automatic link, in seconds. */
export const DEDUPE_MAX_SECONDS = 10;

type FileRow = {
  id: string;
  community_id: string;
  sha256: string;
  storage_path: string;
  mime: string | null;
  original_name: string;
  batch_label: string | null;
  status: string;
  hash_verified: boolean | null;
  exif: ExifData | null;
  capture_epoch: number | null;
  uploaded_epoch: number | null;
};

type PageRender = {
  pageNo: number;
  jpeg: Buffer;
  width: number;
  height: number;
  dpiEst: number | null;
  source: 'pdfium' | 'sharp';
  text: string;
  hasTextLayer: boolean;
};

type CandidateRow = {
  id: string;
  phash_hex: string;
  page_no: number;
  dedupe_of_page_id: string | null;
  capture_epoch: number;
  uploaded_epoch: number;
};

/** Order used to decide which frame of a near-duplicate pair is the one kept as the original. */
function isEarlier(a: { capture: number; uploaded: number; pageNo: number }, b: { capture: number; uploaded: number; pageNo: number }): boolean {
  if (a.capture !== b.capture) return a.capture < b.capture;
  if (a.uploaded !== b.uploaded) return a.uploaded < b.uploaded;
  return a.pageNo < b.pageNo;
}

/** Pages are yielded one at a time so a long PDF never holds every render in memory at once. */
async function* pageRenders(bytes: Buffer, mime: string, longEdge: number): AsyncGenerator<PageRender> {
  if (mime === 'application/pdf') {
    const pdf = await openPdf(bytes);
    try {
      for (let i = 0; i < pdf.pageCount; i++) {
        const rendered = await pdf.renderPage(i, longEdge);
        const layer = pdf.textLayer(i);
        yield {
          pageNo: i + 1,
          jpeg: rendered.jpeg,
          width: rendered.width,
          height: rendered.height,
          dpiEst: rendered.dpiEst,
          source: 'pdfium',
          text: layer.text,
          hasTextLayer: layer.hasTextLayer,
        };
      }
    } finally {
      pdf.close();
    }
    return;
  }
  const source = isHeicMime(mime) ? await heicToJpeg(bytes) : bytes;
  const rendered = await renderImage(source, longEdge);
  yield {
    pageNo: 1,
    jpeg: rendered.jpeg,
    width: rendered.width,
    height: rendered.height,
    dpiEst: null,
    source: 'sharp',
    text: '',
    hasTextLayer: false,
  };
}

async function linkNearDuplicates(
  file: FileRow,
  pages: { id: string; pageNo: number; phashHex: string }[],
): Promise<{ page_id: string; dedupe_of_page_id: string }[]> {
  const links: { page_id: string; dedupe_of_page_id: string }[] = [];
  if (!file.batch_label || file.capture_epoch === null || file.uploaded_epoch === null) return links;
  const candidates = await query<CandidateRow>(
    `select p.id, encode(p.phash, 'hex') as phash_hex, p.page_no, p.dedupe_of_page_id,
            extract(epoch from f.capture_time)::float8 as capture_epoch,
            extract(epoch from f.uploaded_at)::float8 as uploaded_epoch
       from public.pages p
       join public.files f on f.id = p.file_id
      where f.community_id = $1 and f.batch_label = $2 and f.capture_time is not null
        and p.phash is not null and p.file_id <> $3
        and abs(extract(epoch from f.capture_time) - $4::float8) <= $5`,
    [file.community_id, file.batch_label, file.id, file.capture_epoch, DEDUPE_MAX_SECONDS],
  );
  if (candidates.length === 0) return links;

  for (const page of pages) {
    const self = { capture: file.capture_epoch, uploaded: file.uploaded_epoch, pageNo: page.pageNo };
    const match = candidates
      .filter((c) => c.dedupe_of_page_id === null && c.phash_hex.length === page.phashHex.length)
      .filter((c) => isEarlier({ capture: c.capture_epoch, uploaded: c.uploaded_epoch, pageNo: c.page_no }, self))
      .filter((c) => hamming(c.phash_hex, page.phashHex) <= DEDUPE_MAX_DISTANCE)
      .sort((a, b) => a.capture_epoch - b.capture_epoch || a.uploaded_epoch - b.uploaded_epoch || a.page_no - b.page_no)[0];
    if (!match) continue;
    await query('update public.pages set dedupe_of_page_id = $2 where id = $1 and dedupe_of_page_id is distinct from $2', [page.id, match.id]);
    links.push({ page_id: page.id, dedupe_of_page_id: match.id });
  }
  return links;
}

export async function renderStep(payload: Record<string, unknown>, _job: StepJob): Promise<StepResult> {
  const fileId = typeof payload.file_id === 'string' ? payload.file_id : '';
  if (!fileId) throw new Error('render: payload.file_id is required');
  const longEdge = longEdgeFrom(payload);

  const file = await maybeOne<FileRow>(
    `select id, community_id, sha256, storage_path, mime, original_name, batch_label, status, hash_verified, exif,
            extract(epoch from capture_time)::float8 as capture_epoch,
            extract(epoch from uploaded_at)::float8 as uploaded_epoch
       from public.files where id = $1`,
    [fileId],
  );
  if (!file) throw new Error(`render: file ${fileId} not found`);
  if (file.status !== 'stored') {
    console.log(`render ${file.original_name}: skipped (status ${file.status})`);
    return { file_id: file.id, skipped: `status ${file.status}` };
  }
  if (file.hash_verified !== true) {
    console.log(`render ${file.original_name}: skipped (hash not verified yet)`);
    return { file_id: file.id, skipped: 'hash not verified' };
  }
  const mime = file.mime ?? 'application/octet-stream';
  if (!isRenderable(mime)) {
    console.log(`render ${file.original_name}: no page images for ${mime}`);
    return { file_id: file.id, skipped: `mime ${mime}`, pages: 0 };
  }

  const { bucket, key } = parseStoragePath(file.storage_path);
  const bytes = await getObject(bucket, key);
  const rotation = mime === 'application/pdf' ? 0 : rotationForOrientation(file.exif?.Orientation as number | undefined);

  const pages: { id: string; pageNo: number; phashHex: string }[] = [];
  let renderSource: PageRender['source'] | null = null;
  for await (const page of pageRenders(bytes, mime, longEdge)) {
    renderSource = page.source;
    const renderKey = `${file.community_id}/${file.sha256}/p${page.pageNo}_${page.width}x${page.height}.jpg`;
    const thumbKey = `${file.community_id}/${file.sha256}/t${page.pageNo}.jpg`;
    const thumb = await thumbnail(page.jpeg);
    // derived objects are re-writable: a re-run at the same long edge replaces them in place, and a
    // re-run at another long edge writes a new key (the previous render stays, unreferenced)
    await putObject('derived', renderKey, page.jpeg, 'image/jpeg');
    await putObject('derived', thumbKey, thumb, 'image/jpeg');
    const phashHex = await phash(page.jpeg);
    const renderParams = {
      long_edge: longEdge,
      dpi_est: page.dpiEst,
      source: page.source,
      pipeline_version: PIPELINE_VERSION(),
    };
    const row = await one<{ id: string }>(
      `insert into public.pages (community_id, file_id, page_no, render_path, width, height, long_edge, render_params,
                                 thumb_path, phash, has_text_layer, text_layer, rotation_applied)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
       on conflict (file_id, page_no) do update
          set render_path = excluded.render_path, width = excluded.width, height = excluded.height,
              long_edge = excluded.long_edge, render_params = excluded.render_params, thumb_path = excluded.thumb_path,
              phash = excluded.phash, has_text_layer = excluded.has_text_layer, text_layer = excluded.text_layer,
              rotation_applied = excluded.rotation_applied
       returning id`,
      [
        file.community_id,
        file.id,
        page.pageNo,
        `derived/${renderKey}`,
        page.width,
        page.height,
        longEdge,
        JSON.stringify(renderParams),
        `derived/${thumbKey}`,
        phashToBuffer(phashHex),
        page.hasTextLayer,
        page.text === '' ? null : page.text,
        rotation,
      ],
    );
    pages.push({ id: row.id, pageNo: page.pageNo, phashHex });
  }

  const links = await linkNearDuplicates(file, pages);

  for (const page of pages) {
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'ocr', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [file.community_id, `${page.id}:ocr:${PIPELINE_VERSION()}`, JSON.stringify({ page_id: page.id })],
    );
  }
  if (file.batch_label) {
    // one grouping job per batch; the `group` step belongs to the next milestone and is not
    // registered yet, so this job simply waits in the queue
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'group', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [file.community_id, `batch:${file.batch_label}:group:${PIPELINE_VERSION()}`, JSON.stringify({ batch_label: file.batch_label })],
    );
  }

  console.log(
    `render ${file.original_name}: ${pages.length} page(s) at ${longEdge} px (${renderSource ?? '-'})` +
      `${links.length > 0 ? `, ${links.length} near-duplicate link(s)` : ''}, ${pages.length} ocr job(s) queued`,
  );
  return {
    file_id: file.id,
    pages: pages.length,
    long_edge: longEdge,
    source: renderSource,
    near_duplicates: links,
  };
}
