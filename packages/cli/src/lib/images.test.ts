import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LONG_EDGE,
  exifCaptureTime,
  extensionFor,
  hamming,
  isRenderable,
  ocrWords,
  openPdf,
  parseTesseractTsv,
  pdfPageCount,
  pdfTextLayer,
  phash,
  phashFromBuffer,
  phashToBuffer,
  readExif,
  readPdfMeta,
  renderImage,
  renderPdfPage,
  rotationForOrientation,
  sha256,
  sniffMime,
  tesseractVersion,
  thumbnail,
} from './images.ts';

/** Fixtures are generated here so the unit tests need nothing on disk. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="40" y="120" font-family="DejaVu Sans" font-size="64" fill="#000000">COMUNITAT DE PROPIETARIS</text>
  <text x="40" y="240" font-family="DejaVu Sans" font-size="52" fill="#000000">Total 121,00 EUR</text>
</svg>`;

let jpeg: Buffer;
let png: Buffer;
let pdf: Buffer;

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setProducer('viladomat-tests');
  doc.setCreator('images.test');
  doc.setCreationDate(new Date('2024-03-04T09:15:00Z'));
  doc.setModificationDate(new Date('2024-03-05T09:15:00Z'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([420, 595]);
  first.drawText('Document de prova - pagina 1', { x: 40, y: 500, size: 18, font, color: rgb(0, 0, 0) });
  first.drawText('Total: 121,00 EUR', { x: 40, y: 460, size: 14, font, color: rgb(0, 0, 0) });
  doc.addPage([420, 595]).drawText('Document de prova - pagina 2', { x: 40, y: 500, size: 18, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

beforeAll(async () => {
  png = await sharp(Buffer.from(SVG)).png({ compressionLevel: 9 }).toBuffer();
  jpeg = await sharp(png).jpeg({ quality: 90 }).toBuffer();
  pdf = await makePdf();
}, 60_000);

const hasTesseract = (await tesseractVersion()) !== 'unknown';

describe('sha256', () => {
  it('matches the published vector', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is stable across equal buffers and differs on one flipped byte', () => {
    const a = Buffer.from([1, 2, 3, 4]);
    expect(sha256(a)).toBe(sha256(Buffer.from([1, 2, 3, 4])));
    expect(sha256(a)).not.toBe(sha256(Buffer.from([1, 2, 3, 5])));
  });
});

describe('sniffMime', () => {
  it('reads the magic bytes of the formats the intake accepts', () => {
    expect(sniffMime(jpeg, 'photo.HEIC')).toBe('image/jpeg'); // bytes win over the name
    expect(sniffMime(png, 'x')).toBe('image/png');
    expect(sniffMime(pdf, 'x')).toBe('application/pdf');
    expect(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]), 'x')).toBe('image/heic');
    expect(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1'), Buffer.alloc(8)]), 'x')).toBe('image/heif');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'x')).toBe('image/webp');
    expect(sniffMime(Buffer.from('II\x2a\x00rest'), 'x')).toBe('image/tiff');
    expect(sniffMime(Buffer.from('MM\x00\x2arest'), 'x')).toBe('image/tiff');
  });

  it('falls back to the extension for formats without magic bytes', () => {
    expect(sniffMime(Buffer.from('From: a\r\nSubject: b\r\n'), 'mail.eml')).toBe('message/rfc822');
    expect(sniffMime(Buffer.from('a;b;c\n'), 'movements.csv')).toBe('text/csv');
    expect(sniffMime(Buffer.from('note'), 'note.txt')).toBe('text/plain');
    expect(sniffMime(Buffer.from('note'), 'unknown.bin')).toBe('application/octet-stream');
  });

  it('maps types to the extension used in the originals key', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('image/heic')).toBe('heic');
    expect(extensionFor('application/octet-stream', 'scan.dat')).toBe('dat');
    expect(isRenderable('application/pdf')).toBe(true);
    expect(isRenderable('message/rfc822')).toBe(false);
  });
});

describe('EXIF', () => {
  it('reads the capture tags and never returns location data', async () => {
    const withExif = await sharp(png)
      .jpeg()
      .withExif({
        IFD0: { Make: 'TestMake', Model: 'TestModel', Software: 'fixture' },
        IFD2: { DateTimeOriginal: '2024:03:04 11:22:33', OffsetTimeOriginal: '+02:00' },
      })
      .toBuffer();
    const exif = await readExif(withExif);
    expect(exif).toMatchObject({ Make: 'TestMake', Model: 'TestModel', Software: 'fixture', DateTimeOriginal: '2024:03:04 11:22:33' });
    for (const key of Object.keys(exif ?? {})) expect(key.toLowerCase()).not.toContain('gps');
    expect(exifCaptureTime(exif)).toBe('2024-03-04T09:22:33.000Z');
  }, 30_000);

  it('returns null when the file carries no EXIF', async () => {
    expect(await readExif(await sharp(png).jpeg().toBuffer())).toBeNull();
    expect(exifCaptureTime(null)).toBeNull();
    expect(exifCaptureTime({ Make: 'x' })).toBeNull();
  }, 30_000);

  it('reads a capture time without an offset as UTC (ordering only)', () => {
    expect(exifCaptureTime({ DateTimeOriginal: '2024:03:04 11:22:33' })).toBe('2024-03-04T11:22:33.000Z');
  });

  it('maps the orientation tag to the rotation sharp bakes in', () => {
    expect(rotationForOrientation(1)).toBe(0);
    expect(rotationForOrientation(3)).toBe(180);
    expect(rotationForOrientation(6)).toBe(90);
    expect(rotationForOrientation(8)).toBe(270);
    expect(rotationForOrientation(undefined)).toBe(0);
  });
});

describe('PDF', () => {
  it('reads producer metadata and the page count', async () => {
    const meta = await readPdfMeta(pdf);
    expect(meta.producer).toBe('viladomat-tests');
    expect(meta.creator).toBe('images.test');
    expect(meta.creation_date).toBe('2024-03-04T09:15:00.000Z');
    expect(meta.mod_date).toBe('2024-03-05T09:15:00.000Z');
    expect(meta.page_count).toBe(2);
    expect(await pdfPageCount(pdf)).toBe(2);
  }, 60_000);

  it('renders a page at the requested long edge', async () => {
    const rendered = await renderPdfPage(pdf, 0, 800);
    expect(Math.max(rendered.width, rendered.height)).toBe(800);
    expect(sniffMime(rendered.jpeg)).toBe('image/jpeg');
    expect(rendered.dpiEst).toBeGreaterThan(0);
  }, 60_000);

  it('reports the text layer of a native PDF page', async () => {
    const layer = await pdfTextLayer(pdf, 0);
    expect(layer.hasTextLayer).toBe(true);
    expect(layer.text).toContain('Document de prova');
    const handle = await openPdf(pdf);
    try {
      expect(handle.pageCount).toBe(2);
      expect(handle.textLayer(1).text).toContain('pagina 2');
    } finally {
      handle.close();
    }
  }, 60_000);
});

describe('renders', () => {
  it('resizes to the long edge and never enlarges', async () => {
    const big = await renderImage(png, 600);
    expect(Math.max(big.width, big.height)).toBe(600);
    const small = await renderImage(png, DEFAULT_LONG_EDGE);
    expect(small.width).toBe(1200); // source is 1200 px wide; withoutEnlargement
    const thumb = await thumbnail(small.jpeg, 768);
    const meta = await sharp(thumb).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(768);
  }, 60_000);
});

describe('perceptual hash', () => {
  it('is a 64-bit hex string that survives re-encoding', async () => {
    const a = await phash(jpeg);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    const reencoded = await phash(await sharp(jpeg).jpeg({ quality: 60 }).toBuffer());
    expect(hamming(a, reencoded)).toBeLessThanOrEqual(4);
    const resized = await phash(await sharp(jpeg).resize({ width: 600 }).jpeg().toBuffer());
    expect(hamming(a, resized)).toBeLessThanOrEqual(4);
  }, 60_000);

  it('separates a different page', async () => {
    const a = await phash(jpeg);
    const other = await sharp(Buffer.from(SVG.replace('Total 121,00 EUR', 'Un altre document ben diferent'))).jpeg().toBuffer();
    expect(hamming(a, await phash(other))).toBeGreaterThan(4);
  }, 60_000);

  it('round-trips through the bytea column representation', async () => {
    const hex = await phash(jpeg);
    expect(phashFromBuffer(phashToBuffer(hex))).toBe(hex);
  }, 60_000);

  it('counts differing bits and refuses mismatched hashes', () => {
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
    expect(hamming('0000000000000000', '000000000000000f')).toBe(4);
    expect(hamming('ff', '00')).toBe(8);
    expect(() => hamming('ff', 'fff')).toThrow(/length/);
    expect(() => hamming('zz', '00')).toThrow(/hex/);
  });
});

describe('parseTesseractTsv', () => {
  const TSV = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1200\t400\t-1\t',
    '4\t1\t1\t1\t1\t0\t51\t46\t655\t35\t-1\t',
    '5\t1\t1\t1\t1\t1\t51\t46\t267\t35\t96.06\tCOMUNITAT',
    '5\t1\t1\t1\t1\t2\t337\t46\t57\t34\t93.30\tDE',
    '5\t1\t1\t1\t1\t3\t416\t46\t290\t35\t90.37\t   ',
    '5\t1\t1\t1\t2\t1\t51\t129\t152\t22\t92.46\tTotal',
    '5\t1\t1\t1\t2\t2\t210\t129\t180\t22\t-1\t121,00',
  ].join('\n');

  it('keeps word rows with boxes and drops empty ones', () => {
    const words = parseTesseractTsv(TSV);
    expect(words.map((w) => w.text)).toEqual(['COMUNITAT', 'DE', 'Total', '121,00']);
    expect(words[0]).toEqual({ idx: 0, text: 'COMUNITAT', x0: 51, y0: 46, x1: 318, y1: 81, confidence: 96.06 });
    expect(words.map((w) => w.idx)).toEqual([0, 1, 2, 3]);
    expect(words[3]?.confidence).toBeNull(); // -1 means "no confidence reported"
  });

  it('survives an empty or header-only document', () => {
    expect(parseTesseractTsv('')).toEqual([]);
    expect(parseTesseractTsv('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n')).toEqual([]);
  });
});

describe.skipIf(!hasTesseract)('ocrWords', () => {
  it('reads the words of a rendered page with their boxes', async () => {
    const rendered = await renderImage(png, DEFAULT_LONG_EDGE);
    const words = await ocrWords(rendered.jpeg, 'spa+cat');
    const text = words.map((w) => w.text).join(' ');
    expect(text).toContain('COMUNITAT');
    expect(text).toContain('121,00');
    for (const word of words) {
      expect(word.x1).toBeGreaterThan(word.x0);
      expect(word.y1).toBeGreaterThan(word.y0);
      expect(word.x1).toBeLessThanOrEqual(rendered.width);
      expect(word.y1).toBeLessThanOrEqual(rendered.height);
    }
  }, 120_000);
});
