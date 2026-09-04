import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import exifr from 'exifr';
import heicConvert from 'heic-convert';
import { recognize } from 'node-tesseract-ocr';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import sharpPhashDefault from 'sharp-phash';

/** sharp-phash ships a CommonJS default export; bind it to its documented call signature. */
const sharpPhash = sharpPhashDefault as unknown as (image: Buffer) => Promise<string>;

/**
 * Pure helpers for the render/OCR pipeline: hashing, format sniffing, metadata read from the
 * untouched bytes, deterministic renders and Tesseract word boxes.
 *
 * Every function here takes bytes and returns bytes or plain data; nothing touches the database or
 * the object store, so the same code runs in tests and in the worker.
 */

/** Default long edge of a page render (≈2,240 image tokens per page). */
export const DEFAULT_LONG_EDGE = 1568;
/** Long edge used with `--hires` (handwriting, dense tables). */
export const HIRES_LONG_EDGE = 2576;
/** Long edge of the thumbnails used by the grouping/classification pass. */
export const THUMB_LONG_EDGE = 768;
/** JPEG quality of renders and thumbnails. */
export const RENDER_QUALITY = 88;

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.eml': 'message/rfc822',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'application/pdf': 'pdf',
  'message/rfc822': 'eml',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** HEIF brand codes, mapped to the MIME type they are usually served as. */
const HEIF_BRANDS: Record<string, string> = {
  heic: 'image/heic',
  heix: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  hevm: 'image/heic',
  hevs: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
  avif: 'image/avif',
  avis: 'image/avif',
};

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

/**
 * Content type from magic bytes, falling back to the file extension. The stored `mime` must describe
 * the bytes as received, not what the sender called them.
 */
export function sniffMime(buffer: Buffer, filename?: string): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && ascii(buffer, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12).toLowerCase();
    const mapped = HEIF_BRANDS[brand];
    if (mapped) return mapped;
    // some cameras put the brand only in the compatible-brands list
    const compatible = ascii(buffer, 16, Math.min(buffer.length, 64)).toLowerCase();
    for (const [b, m] of Object.entries(HEIF_BRANDS)) if (compatible.includes(b)) return m;
  }
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 4) {
    const tiff = ascii(buffer, 0, 4);
    if (tiff === 'II\x2a\x00' || tiff === 'MM\x00\x2a') return 'image/tiff';
  }
  // %PDF- may sit behind a few junk bytes; the spec allows it within the first 1 KiB
  const head = ascii(buffer, 0, Math.min(buffer.length, 1024));
  if (head.includes('%PDF-')) return 'application/pdf';

  const ext = filename ? path.extname(filename).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** Extension used in the `originals` key, from the sniffed type, else from the supplied name. */
export function extensionFor(mime: string, filename?: string): string {
  const known = MIME_EXT[mime];
  if (known) return known;
  const ext = filename ? path.extname(filename).toLowerCase().replace(/^\./, '') : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function isHeicMime(mime: string): boolean {
  return mime === 'image/heic' || mime === 'image/heif';
}

/** Types the render step can turn into page images. */
export function isRenderable(mime: string): boolean {
  return mime === 'application/pdf' || isImageMime(mime);
}

// ---------------------------------------------------------------------------
// Metadata (read from the untouched bytes; location data is never read or stored)
// ---------------------------------------------------------------------------

/** Tags kept from EXIF. Anything else — GPS above all — is neither requested nor stored. */
export const EXIF_KEYS = [
  'DateTimeOriginal',
  'OffsetTime',
  'OffsetTimeOriginal',
  'Make',
  'Model',
  'Software',
  'Orientation',
  'ImageUniqueID',
] as const;

export type ExifData = Partial<Record<(typeof EXIF_KEYS)[number], string | number>>;

/**
 * Capture metadata used for ordering and for the device columns of the custody record.
 * Values are kept unrevived (raw EXIF strings) so the stored JSON is exactly what the file carried.
 */
export async function readExif(buffer: Buffer): Promise<ExifData | null> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = (await exifr.parse(buffer, {
      tiff: true,
      exif: true,
      gps: false,
      interop: false,
      iptc: false,
      xmp: false,
      icc: false,
      jfif: false,
      makerNote: false,
      userComment: false,
      reviveValues: false,
      translateValues: false,
      mergeOutput: true,
      pick: [...EXIF_KEYS],
    })) as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  if (!raw) return null;
  const out: ExifData = {};
  for (const key of EXIF_KEYS) {
    const v = raw[key];
    if (typeof v === 'string') out[key] = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * ISO timestamp of the capture, from `DateTimeOriginal` (+ `OffsetTime*` when the camera wrote one).
 * Without an offset the value is read as UTC: EXIF time is used for ordering only and is never cited
 * as evidence, so a fixed reading keeps a batch internally consistent.
 */
export function exifCaptureTime(exif: ExifData | null | undefined): string | null {
  const raw = exif?.DateTimeOriginal;
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const offsetRaw = exif?.OffsetTimeOriginal ?? exif?.OffsetTime;
  const offset = typeof offsetRaw === 'string' && /^[+-]\d{2}:?\d{2}$/.test(offsetRaw.trim())
    ? offsetRaw.trim().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : 'Z';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface PdfMeta {
  producer: string | null;
  creator: string | null;
  creation_date: string | null;
  mod_date: string | null;
  page_count: number | null;
}

/**
 * Document-producer metadata of a PDF. Best effort: encrypted or damaged files return what could be
 * read and `null` for the rest. The page count comes from PDFium, which is also what renders it.
 */
export async function readPdfMeta(buffer: Buffer): Promise<PdfMeta> {
  const meta: PdfMeta = { producer: null, creator: null, creation_date: null, mod_date: null, page_count: null };
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    meta.producer = doc.getProducer() ?? null;
    meta.creator = doc.getCreator() ?? null;
    meta.creation_date = doc.getCreationDate()?.toISOString() ?? null;
    meta.mod_date = doc.getModificationDate()?.toISOString() ?? null;
    meta.page_count = doc.getPageCount();
  } catch {
    /* keep the nulls; the page count is retried through PDFium below */
  }
  if (meta.page_count === null) {
    try {
      meta.page_count = await pdfPageCount(buffer);
    } catch {
      /* not a readable PDF */
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let libraryPromise: Promise<PDFiumLibrary> | undefined;

async function pdfiumLibrary(): Promise<PDFiumLibrary> {
  libraryPromise ??= PDFiumLibrary.init();
  return libraryPromise;
}

export interface RenderedPage {
  jpeg: Buffer;
  width: number;
  height: number;
  /** Effective resolution of the render, from the PDF page size in points (72 pt = 1 inch). */
  dpiEst: number | null;
}

export interface TextLayer {
  text: string;
  hasTextLayer: boolean;
}

export interface PdfHandle {
  pageCount: number;
  renderPage(pageIndex: number, longEdge?: number): Promise<RenderedPage>;
  textLayer(pageIndex: number): TextLayer;
  close(): void;
}

/** A page counts as carrying a usable text layer above this many non-space characters. */
export const TEXT_LAYER_MIN_CHARS = 20;

/** Open a PDF once and render/read several pages from it. */
export async function openPdf(buffer: Buffer): Promise<PdfHandle> {
  const library = await pdfiumLibrary();
  const doc = await library.loadDocument(new Uint8Array(buffer));
  let closed = false;
  return {
    pageCount: doc.getPageCount(),
    async renderPage(pageIndex: number, longEdge: number = DEFAULT_LONG_EDGE): Promise<RenderedPage> {
      const page = doc.getPage(pageIndex);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const scale = longEdge / Math.max(originalWidth, originalHeight, 1);
      const bitmap = await page.render({ render: 'bitmap', scale });
      const jpeg = await sharp(Buffer.from(bitmap.data), { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: RENDER_QUALITY, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { jpeg, width: bitmap.width, height: bitmap.height, dpiEst: Math.round(scale * 72) };
    },
    textLayer(pageIndex: number): TextLayer {
      const text = doc.getPage(pageIndex).getText() ?? '';
      return { text, hasTextLayer: text.replace(/\s/g, '').length > TEXT_LAYER_MIN_CHARS };
    },
    close(): void {
      if (closed) return;
      closed = true;
      doc.destroy();
    },
  };
}

export async function pdfPageCount(buffer: Buffer): Promise<number> {
  const pdf = await openPdf(buffer);
  try {
    return pdf.pageCount;
  } finally {
    pdf.close();
  }
}

/** Render one PDF page to JPEG at the given long edge (PDFium → RGBA → sharp). */
export async function renderPdfPage(buffer: Buffer, pageIndex: number, longEdge: number = DEFAULT_LONG_EDGE): Promise<RenderedPage> {
  const pdf = await openPdf(buffer);
  try {
    return await pdf.renderPage(pageIndex, longEdge);
  } finally {
    pdf.close();
  }
}

/** Text of one PDF page, with the flag the render step stores in `pages.has_text_layer`. */
export async function pdfTextLayer(buffer: Buffer, pageIndex: number): Promise<TextLayer> {
  const pdf = await openPdf(buffer);
  try {
    return pdf.textLayer(pageIndex);
  } finally {
    pdf.close();
  }
}

/** HEIC/HEIF → JPEG, keeping full quality; the resize afterwards is the only lossy step. */
export async function heicToJpeg(buffer: Buffer): Promise<Buffer> {
  const out = await heicConvert({ buffer, format: 'JPEG', quality: 1 });
  return Buffer.from(out);
}

/** Bake the EXIF orientation into the pixels so every later crop uses page coordinates. */
export async function orientJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .jpeg({ quality: RENDER_QUALITY, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Clockwise rotation (degrees) that `sharp().rotate()` applies for an EXIF orientation value. */
export function rotationForOrientation(orientation: number | string | undefined | null): number {
  const o = typeof orientation === 'string' ? Number(orientation) : orientation;
  switch (o) {
    case 3:
    case 4:
      return 180;
    case 5:
    case 6:
      return 90;
    case 7:
    case 8:
      return 270;
    default:
      return 0;
  }
}

/** Resize an image so its long edge is at most `longEdge`, orientation baked in, JPEG q88. */
export async function renderImage(buffer: Buffer, longEdge: number = DEFAULT_LONG_EDGE): Promise<RenderedPage> {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: RENDER_QUALITY, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height, dpiEst: null };
}

export async function thumbnail(jpeg: Buffer, longEdge: number = THUMB_LONG_EDGE): Promise<Buffer> {
  return sharp(jpeg, { failOn: 'none' })
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Perceptual hash
// ---------------------------------------------------------------------------

/** 64-bit perceptual hash as 16 hex characters (`pages.phash` holds `Buffer.from(hex, 'hex')`). */
export async function phash(jpeg: Buffer): Promise<string> {
  const bits = await sharpPhash(jpeg);
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  return hex;
}

/** Hamming distance between two hashes of equal length (hex, or the raw 0/1 string). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`hamming: length mismatch (${a.length} vs ${b.length})`);
  if (!/^[0-9a-fA-F]*$/.test(a) || !/^[0-9a-fA-F]*$/.test(b)) throw new Error('hamming: not a hex string');
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

export function phashToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

export function phashFromBuffer(value: Buffer | Uint8Array | string): string {
  return typeof value === 'string' ? value.replace(/^\\x/, '') : Buffer.from(value).toString('hex');
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

export interface OcrWord {
  idx: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number | null;
}

/** Default OCR languages: Spanish plus Catalan, the two languages of the corpus. */
export const OCR_LANG = 'spa+cat';

/**
 * Parse Tesseract's TSV output (`level page block par line word left top width height conf text`)
 * into word boxes. Non-word rows and empty words are dropped; `idx` is the reading-order position.
 */
export function parseTesseractTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (!line || line.startsWith('level\t')) continue;
    const cells = line.split('\t');
    if (cells.length < 12) continue;
    if (cells[0] !== '5') continue; // level 5 = word
    const text = cells.slice(11).join('\t').trim();
    if (text === '') continue;
    const left = Number(cells[6]);
    const top = Number(cells[7]);
    const width = Number(cells[8]);
    const height = Number(cells[9]);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    const conf = Number(cells[10]);
    words.push({
      idx: words.length,
      text,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      confidence: Number.isFinite(conf) && conf >= 0 ? conf : null,
    });
  }
  return words;
}

const execFileAsync = promisify(execFile);

/** `tesseract --version` first line, stored as `ocr_words.engine_version`. */
export async function tesseractVersion(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('tesseract', ['--version']);
    const first = `${stdout}${stderr}`.split(/\r?\n/)[0] ?? '';
    return first.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Run Tesseract directly when the output is too large for the wrapper's `exec` buffer. */
async function tesseractTsvSpawn(jpeg: Buffer, lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tesseract', ['stdin', 'stdout', '-l', lang, '--psm', '6', '-c', 'tessedit_create_tsv=1']);
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errs.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`tesseract exited ${code}: ${Buffer.concat(errs).toString('utf8').slice(0, 500)}`));
    });
    child.stdin.end(jpeg);
  });
}

/**
 * Word boxes for one page render. Coordinates are pixels of that render, which is why the render is
 * reproducible (`pages.render_params`): a crop is only anchored when the words inside the box
 * contain the quoted text.
 */
export async function ocrWords(jpeg: Buffer, lang: string = OCR_LANG): Promise<OcrWord[]> {
  let tsv: string;
  try {
    tsv = await recognize(jpeg, { lang, psm: 6, tessedit_create_tsv: 1 });
  } catch (e) {
    // the wrapper reads stdout through exec (1 MiB); dense pages need a stream
    if (!(e instanceof Error) || !/maxBuffer|ENOBUFS/i.test(e.message)) throw e;
    tsv = await tesseractTsvSpawn(jpeg, lang);
  }
  return parseTesseractTsv(tsv);
}
