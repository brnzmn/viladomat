import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestCommand, type IngestSummary } from '../commands/ingest.ts';
import { processCommand } from '../commands/process.ts';
import { closeDb, one, query, transaction } from '../lib/db.ts';
import { loadEnv, REPO_ROOT } from '../lib/env.ts';
import { sha256 } from '../lib/images.ts';
import { getObject, ObjectExistsError, putObject, resetStorageClient, storageMode } from '../lib/storage.ts';
import { ingestStep, ocrStep, renderStep } from './index.ts';

/**
 * End-to-end check of the M1 pipeline against a local database and the filesystem object store:
 * `vx ingest` on a small synthetic batch, then the ingest → render → ocr steps drained by the
 * worker loop. It asserts the custody invariants (one hash per file, verified server-side, originals
 * immutable), the page renders and the OCR words, and that every step can be re-run without effect.
 *
 * Skipped unless DATABASE_URL points at a database with the migrations applied.
 */
loadEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

type CountRow = { n: number };
type JobRow = { step: string; status: string; idempotency_key: string; last_error: string | null };
type FileRow = {
  id: string;
  original_name: string;
  sha256: string;
  client_sha256: string | null;
  server_sha256: string | null;
  hash_verified: boolean | null;
  status: string;
  page_count: number | null;
  mime: string | null;
  storage_path: string;
  capture_time: Date | null;
  batch_label: string | null;
};
type PageRow = {
  id: string;
  file_id: string;
  page_no: number;
  render_path: string | null;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  long_edge: number | null;
  has_text_layer: boolean | null;
  text_layer: string | null;
  phash_hex: string | null;
  dedupe_of_page_id: string | null;
  render_source: string | null;
  original_name: string;
};

const BATCH = `test-ingest-${process.pid}`;
const SAMPLE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample');

let storageDir = '';
let batchDir = '';
let communityId = '';
let summary: IngestSummary;

async function pagesOf(): Promise<PageRow[]> {
  return query<PageRow>(
    `select p.id, p.file_id, p.page_no, p.render_path, p.thumb_path, p.width, p.height, p.long_edge,
            p.has_text_layer, p.text_layer, encode(p.phash, 'hex') as phash_hex, p.dedupe_of_page_id,
            p.render_params ->> 'source' as render_source, f.original_name
       from public.pages p join public.files f on f.id = p.file_id
      where p.community_id = $1 order by f.original_name, p.page_no`,
    [communityId],
  );
}

describe.skipIf(!hasDb)('ingest → render → ocr', () => {
  beforeAll(async () => {
    // filesystem object store in a temporary directory: no Supabase credentials needed
    storageDir = await mkdtemp(path.join(os.tmpdir(), 'vx-storage-'));
    process.env.VX_STORAGE_DIR = storageDir;
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    resetStorageClient();
    expect(storageMode()).toBe('filesystem');

    communityId = (await one<{ id: string }>("insert into public.communities (name) values ('Fixture community') returning id")).id;

    batchDir = await mkdtemp(path.join(os.tmpdir(), 'vx-batch-'));
    await mkdir(path.join(batchDir, 'binder-1'), { recursive: true });
    await copyFile(path.join(SAMPLE_DIR, 'receipt-sample.png'), path.join(batchDir, 'receipt-sample.png'));
    await copyFile(path.join(SAMPLE_DIR, 'note-two-pages.pdf'), path.join(batchDir, 'binder-1', 'note-two-pages.pdf'));
    // the very same bytes under a second name, walked after the original: an exact duplicate,
    // logged and not re-stored
    await copyFile(path.join(SAMPLE_DIR, 'receipt-sample.png'), path.join(batchDir, 'zz-receipt-copy.png'));
    // two frames of one page, same capture second: the near-duplicate case
    const source = await readFile(path.join(SAMPLE_DIR, 'receipt-sample.png'));
    const exif = { IFD0: { Make: 'Fixture', Model: 'Camera' }, IFD2: { DateTimeOriginal: '2026:09:01 10:00:00', OffsetTimeOriginal: '+02:00' } };
    await writeFile(path.join(batchDir, 'frame-a.jpg'), await sharp(source).jpeg({ quality: 92 }).withExif(exif).toBuffer());
    await writeFile(
      path.join(batchDir, 'frame-b.jpg'),
      await sharp(source).modulate({ brightness: 1.03 }).jpeg({ quality: 86 }).withExif(exif).toBuffer(),
    );
    // not ingested: unsupported extension, and a hidden file
    await writeFile(path.join(batchDir, 'notes.md'), '# index sheet, transcribed later\n');
    await writeFile(path.join(batchDir, '.hidden.png'), 'not an image');

    summary = await ingestCommand(batchDir, {
      source: 'onsite',
      suppliedBy: 'administrator',
      suppliedOn: '2026-09-01',
      batch: BATCH,
      transport: 'usb',
      community: communityId,
    });
    await processCommand({ worker: 'pipeline-test', steps: 'ingest,render,ocr' });
  }, 600_000);

  afterAll(async () => {
    if (communityId) {
      // append-only guards protect the custody tables; the fixture rows are removed with the
      // triggers off, which is possible only on this local test database
      await transaction(async (client) => {
        await client.query('set session_replication_role = replica');
        await client.query('delete from public.ocr_words where page_id in (select id from public.pages where community_id = $1)', [communityId]);
        await client.query('delete from public.pages where community_id = $1', [communityId]);
        await client.query('delete from public.jobs where community_id = $1', [communityId]);
        await client.query('delete from public.audit_log where community_id = $1', [communityId]);
        await client.query('delete from public.files where community_id = $1', [communityId]);
        await client.query('delete from public.communities where id = $1', [communityId]);
        await client.query('set session_replication_role = origin');
      });
    }
    await closeDb();
    for (const dir of [storageDir, batchDir]) if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('hashes every candidate, stores the originals once and reports the duplicate', async () => {
    expect(summary.stored.map((f) => f.name).sort()).toEqual(['frame-a.jpg', 'frame-b.jpg', 'note-two-pages.pdf', 'receipt-sample.png']);
    expect(summary.duplicates).toHaveLength(1);
    expect(summary.duplicates[0]?.path).toContain('zz-receipt-copy.png');
    expect(summary.skipped.map((s) => path.basename(s.path))).toEqual(['notes.md']);

    const files = await query<FileRow>(
      `select id, original_name, sha256, client_sha256, server_sha256, hash_verified, status, page_count, mime, storage_path,
              capture_time, batch_label
         from public.files where community_id = $1 order by original_name`,
      [communityId],
    );
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect(file.batch_label).toBe(BATCH);
      expect(file.client_sha256).toBe(file.sha256);
      expect(file.storage_path).toBe(`originals/${communityId}/${file.sha256.slice(0, 2)}/${file.sha256}.${file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg'}`);
    }
    // the stored bytes are the bytes that were hashed on this machine
    const png = files.find((f) => f.original_name === 'receipt-sample.png');
    expect(png).toBeDefined();
    const stored = await getObject('originals', png!.storage_path.replace(/^originals\//, ''));
    expect(sha256(stored)).toBe(png!.sha256);
  });

  it('verifies the hash server-side and records the page count', async () => {
    const files = await query<FileRow>(
      'select id, original_name, sha256, client_sha256, server_sha256, hash_verified, status, page_count, mime, storage_path, capture_time, batch_label from public.files where community_id = $1 order by original_name',
      [communityId],
    );
    for (const file of files) {
      expect(file.server_sha256).toBe(file.sha256);
      expect(file.hash_verified).toBe(true);
      expect(file.status).toBe('stored');
    }
    expect(files.find((f) => f.original_name === 'note-two-pages.pdf')?.page_count).toBe(2);
    expect(files.find((f) => f.original_name === 'receipt-sample.png')?.page_count).toBe(1);
  });

  it('drains the queue: every M1 job succeeded and the grouping job waits for its milestone', async () => {
    const jobs = await query<JobRow>('select step, status, idempotency_key, last_error from public.jobs where community_id = $1 order by created_at', [communityId]);
    const failed = jobs.filter((j) => j.step !== 'group' && j.status !== 'succeeded');
    expect(failed.map((j) => `${j.idempotency_key}: ${j.last_error ?? j.status}`)).toEqual([]);
    expect(jobs.filter((j) => j.step === 'ingest')).toHaveLength(4);
    expect(jobs.filter((j) => j.step === 'render')).toHaveLength(4);
    expect(jobs.filter((j) => j.step === 'ocr')).toHaveLength(5);
    const group = jobs.filter((j) => j.step === 'group');
    expect(group).toHaveLength(1);
    expect(group[0]?.status).toBe('queued'); // no handler registered in M1, so it is never claimed
  });

  it('writes one reproducible render and thumbnail per page', async () => {
    const pages = await pagesOf();
    expect(pages).toHaveLength(5);
    for (const page of pages) {
      expect(page.render_path).toMatch(new RegExp(`^derived/${communityId}/[0-9a-f]{64}/p${page.page_no}_${page.width}x${page.height}\\.jpg$`));
      expect(page.thumb_path).toMatch(new RegExp(`^derived/${communityId}/[0-9a-f]{64}/t${page.page_no}\\.jpg$`));
      expect(page.long_edge).toBe(1568);
      expect(Math.max(page.width ?? 0, page.height ?? 0)).toBeLessThanOrEqual(1568);
      expect(page.phash_hex).toMatch(/^[0-9a-f]{16}$/);
      const render = await getObject('derived', page.render_path!.replace(/^derived\//, ''));
      const meta = await sharp(render).metadata();
      expect(meta.width).toBe(page.width);
      const thumb = await sharp(await getObject('derived', page.thumb_path!.replace(/^derived\//, ''))).metadata();
      expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBeLessThanOrEqual(768);
    }
    const pdfPages = pages.filter((p) => p.original_name === 'note-two-pages.pdf');
    expect(pdfPages.map((p) => p.page_no)).toEqual([1, 2]);
    expect(pdfPages.every((p) => p.render_source === 'pdfium')).toBe(true);
    expect(pdfPages[0]?.has_text_layer).toBe(true);
    expect(pdfPages[0]?.text_layer).toContain('Document de prova');
    const imagePages = pages.filter((p) => p.original_name !== 'note-two-pages.pdf');
    expect(imagePages.every((p) => p.render_source === 'sharp')).toBe(true);
    expect(imagePages.every((p) => p.has_text_layer === false)).toBe(true);
  }, 120_000);

  it('links the second frame of a page to the first, and leaves everything else to the grouping screen', async () => {
    const pages = await pagesOf();
    const a = pages.find((p) => p.original_name === 'frame-a.jpg');
    const b = pages.find((p) => p.original_name === 'frame-b.jpg');
    expect(a?.dedupe_of_page_id).toBeNull();
    expect(b?.dedupe_of_page_id).toBe(a?.id);
    for (const page of pages.filter((p) => p.original_name !== 'frame-b.jpg')) expect(page.dedupe_of_page_id).toBeNull();
  });

  it('stores OCR word boxes inside the render for every page', async () => {
    const pages = await pagesOf();
    for (const page of pages) {
      const words = await query<{ text: string; x0: number; y0: number; x1: number; y1: number; engine_version: string; lang: string; confidence: string | null }>(
        'select text, x0, y0, x1, y1, engine_version, lang, confidence from public.ocr_words where page_id = $1 order by idx',
        [page.id],
      );
      expect(words.length).toBeGreaterThan(0);
      expect(words[0]?.lang).toBe('spa+cat');
      expect(words[0]?.engine_version).toMatch(/tesseract/i);
      for (const word of words) {
        expect(word.x1).toBeGreaterThan(word.x0);
        expect(word.x1).toBeLessThanOrEqual(page.width ?? 0);
        expect(word.y1).toBeLessThanOrEqual(page.height ?? 0);
      }
    }
    const receipt = pages.find((p) => p.original_name === 'receipt-sample.png');
    const text = (
      await query<{ text: string }>('select text from public.ocr_words where page_id = $1 order by idx', [receipt!.id])
    )
      .map((w) => w.text)
      .join(' ');
    expect(text).toContain('COMUNITAT');
    expect(text).toContain('121,00');
  }, 120_000);

  it('refuses to overwrite an original', async () => {
    const file = await one<FileRow>(
      "select id, original_name, sha256, client_sha256, server_sha256, hash_verified, status, page_count, mime, storage_path, capture_time, batch_label from public.files where community_id = $1 and original_name = 'receipt-sample.png'",
      [communityId],
    );
    const key = file.storage_path.replace(/^originals\//, '');
    await expect(putObject('originals', key, Buffer.from('different bytes'), 'image/png', { immutable: true })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(sha256(await getObject('originals', key))).toBe(file.sha256);
  });

  it('is idempotent: re-running the steps changes nothing', async () => {
    const before = await pagesOf();
    const file = await one<FileRow>(
      "select id, original_name, sha256, client_sha256, server_sha256, hash_verified, status, page_count, mime, storage_path, capture_time, batch_label from public.files where community_id = $1 and original_name = 'note-two-pages.pdf'",
      [communityId],
    );
    const job = { id: '', community_id: communityId, idempotency_key: 'test', step: 'ingest', attempts: 1, max_attempts: 5, payload: null };
    const again = await ingestStep({ file_id: file.id }, job);
    expect(again.skipped).toBe('already verified'); // the files guard allows one verification only
    await renderStep({ file_id: file.id }, { ...job, step: 'render' });
    const pageId = before.find((p) => p.original_name === 'note-two-pages.pdf' && p.page_no === 1)?.id;
    const wordsBefore = (await one<CountRow>('select count(*)::int as n from public.ocr_words where page_id = $1', [pageId])).n;
    await ocrStep({ page_id: pageId }, { ...job, step: 'ocr' });
    const wordsAfter = (await one<CountRow>('select count(*)::int as n from public.ocr_words where page_id = $1', [pageId])).n;
    expect(wordsAfter).toBe(wordsBefore);

    const after = await pagesOf();
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect((await one<CountRow>('select count(*)::int as n from public.files where community_id = $1', [communityId])).n).toBe(4);

    // ingesting the same directory again stores nothing new
    const second = await ingestCommand(batchDir, {
      source: 'onsite',
      suppliedBy: 'administrator',
      suppliedOn: '2026-09-01',
      batch: BATCH,
      community: communityId,
    });
    expect(second.stored).toHaveLength(0);
    expect(second.duplicates).toHaveLength(5);
  }, 300_000);

  it('quarantines a file whose stored bytes no longer match the hash taken at intake', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tamper-'));
    try {
      const source = await readFile(path.join(SAMPLE_DIR, 'receipt-sample.png'));
      await writeFile(path.join(dir, 'single-frame.jpg'), await sharp(source).resize({ width: 640 }).jpeg({ quality: 70 }).toBuffer());
      const ingested = await ingestCommand(dir, {
        source: 'phone_transfer',
        suppliedBy: 'other_owner',
        suppliedOn: '2026-09-02',
        batch: `${BATCH}-tamper`,
        community: communityId,
      });
      const file = ingested.stored[0];
      expect(file?.fileId).toBeDefined();

      // replace the stored object behind the object store's back, as a transfer error would
      await writeFile(path.join(storageDir, 'originals', communityId, file!.sha256.slice(0, 2), `${file!.sha256}.jpg`), Buffer.from('truncated'));
      const result = await ingestStep(
        { file_id: file!.fileId },
        { id: '', community_id: communityId, idempotency_key: 'test', step: 'ingest', attempts: 1, max_attempts: 5, payload: null },
      );
      expect(result.hash_verified).toBe(false);
      expect(result.status).toBe('quarantined');

      const row = await one<{ status: string; hash_verified: boolean | null; server_sha256: string | null }>(
        'select status, hash_verified, server_sha256 from public.files where id = $1',
        [file!.fileId],
      );
      expect(row.status).toBe('quarantined');
      expect(row.hash_verified).toBe(false);
      expect(row.server_sha256).toBe(sha256(Buffer.from('truncated')));
      const renderJobs = await query<CountRow>('select count(*)::int as n from public.jobs where idempotency_key like $1', [`${file!.sha256}:render:%`]);
      expect(renderJobs[0]?.n).toBe(0); // the pipeline stops at the mismatch
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
