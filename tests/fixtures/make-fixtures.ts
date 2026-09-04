/**
 * Regenerate the committed ingestion fixtures.
 *
 *   pnpm --filter @viladomat/cli exec tsx ../../tests/fixtures/make-fixtures.ts
 *
 * The two files under `tests/fixtures/sample/` are synthetic and neutral: a receipt-shaped image
 * that Tesseract can read, and a two-page PDF that carries a text layer and producer metadata.
 * They exercise both render paths (sharp for images, PDFium for PDFs) and stay well under 100 KB,
 * so the ingest → render → ocr pipeline has something to run against without any real document.
 *
 * Dependencies are resolved from `packages/cli`, the workspace that owns sharp and pdf-lib.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', '..', 'packages', 'cli', 'package.json'));
/* eslint-disable @typescript-eslint/no-var-requires */
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUT_DIR = path.join(here, 'sample');
const FIXED_DATE = new Date('2024-03-04T09:15:00Z');

const RECEIPT_LINES = [
  ['COMUNITAT DE PROPIETARIS', 46],
  ['Document de prova (sintetic)', 30],
  ['Concepte: subministrament', 30],
  ['Base imposable      100,00 EUR', 30],
  ['IVA 21%              21,00 EUR', 30],
  ['Total               121,00 EUR', 34],
  ['Data: 04/03/2024', 30],
] as const;

function receiptSvg(): string {
  let y = 80;
  const rows = RECEIPT_LINES.map(([text, size]) => {
    const line = `<text x="48" y="${y}" font-family="DejaVu Sans" font-size="${size}" fill="#111111">${text}</text>`;
    y += Math.round(size * 1.55);
    return line;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="${y + 40}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="24" y="24" width="832" height="${y - 16}" fill="none" stroke="#333333" stroke-width="3"/>
  ${rows}
</svg>`;
}

async function makeReceiptPng(): Promise<void> {
  const png = await sharp(Buffer.from(receiptSvg())).png({ compressionLevel: 9, palette: true }).toBuffer();
  await writeFile(path.join(OUT_DIR, 'receipt-sample.png'), png);
  console.log(`receipt-sample.png  ${png.length} bytes`);
}

async function makeTwoPagePdf(): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle('Document de prova');
  doc.setProducer('viladomat-fixtures');
  doc.setCreator('make-fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages: string[][] = [
    ['Document de prova - pagina 1', 'Comunitat de propietaris (exemple sintetic)', 'Concepte: acta de prova', 'Import: 121,00 EUR'],
    ['Document de prova - pagina 2', 'Continuacio del document sintetic', 'Total: 121,00 EUR'],
  ];
  for (const lines of pages) {
    const page = doc.addPage([420, 595]);
    page.drawRectangle({ x: 24, y: 24, width: 372, height: 547, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
    let y = 500;
    lines.forEach((line, i) => {
      page.drawText(line, { x: 48, y, size: i === 0 ? 18 : 13, font: i === 0 ? bold : font, color: rgb(0.05, 0.05, 0.05) });
      y -= i === 0 ? 40 : 26;
    });
  }
  const bytes: Uint8Array = await doc.save({ useObjectStreams: false });
  await writeFile(path.join(OUT_DIR, 'note-two-pages.pdf'), bytes);
  console.log(`note-two-pages.pdf  ${bytes.length} bytes`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await makeReceiptPng();
  await makeTwoPagePdf();
  console.log(`written to ${OUT_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
