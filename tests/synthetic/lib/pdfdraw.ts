/**
 * Minimal deterministic A4 page-layout helper on top of pdf-lib. No auto-flow magic beyond
 * what each document model needs: a cursor, wrapped paragraphs, and a simple ruled table with
 * page-break support. Every document sets its dates explicitly (never `new Date()`) so the
 * PDF bytes are stable across re-runs of `pnpm synth`.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, degrees, type RGB } from 'pdf-lib';

export { rgb, degrees };

export const A4: [number, number] = [595.28, 841.89];
export const MARGIN = 48;

export const INK = rgb(0.09, 0.09, 0.11);
export const MUTED = rgb(0.42, 0.42, 0.46);
export const RULE = rgb(0.75, 0.75, 0.78);
export const HEAD_BG = rgb(0.92, 0.93, 0.95);
export const HANDWRITE = rgb(0.11, 0.16, 0.55);

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

export interface TextOpts {
  font?: PDFFont;
  size?: number;
  color?: RGB;
  align?: 'left' | 'right' | 'center';
  /** Width to align within, from `x` (needed for `right`/`center`). */
  boxWidth?: number;
}

/** Wrap `text` (single logical paragraph; explicit `\n` also breaks lines) to `maxWidth`. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Truncate `text` with an ellipsis so it fits within `maxWidth` at `size`; never wraps. */
export function truncateToWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? ellipsis : text.slice(0, lo) + ellipsis;
}

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

export class Doc {
  pdf!: PDFDocument;
  fonts!: Fonts;
  page!: PDFPage;
  width = A4[0];
  height = A4[1];
  margin = MARGIN;
  x = MARGIN;
  y = A4[1] - MARGIN;
  pageNo = 0;

  static async create(meta: {
    title: string;
    author: string;
    subject: string;
    isoDate: string; // yyyy-mm-dd — fixes CreationDate/ModDate for determinism
  }): Promise<Doc> {
    const d = new Doc();
    d.pdf = await PDFDocument.create();
    d.fonts = {
      regular: await d.pdf.embedFont(StandardFonts.Helvetica),
      bold: await d.pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await d.pdf.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await d.pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    d.pdf.setTitle(meta.title);
    d.pdf.setAuthor(meta.author);
    d.pdf.setSubject(meta.subject);
    d.pdf.setProducer('Generador de corpus sintètic (tests/synthetic)');
    d.pdf.setCreator('Generador de corpus sintètic (tests/synthetic)');
    const fixed = new Date(`${meta.isoDate}T10:00:00.000Z`);
    d.pdf.setCreationDate(fixed);
    d.pdf.setModificationDate(fixed);
    d.newPage();
    return d;
  }

  newPage(): PDFPage {
    this.page = this.pdf.addPage(A4);
    this.pageNo += 1;
    this.y = this.height - this.margin;
    return this.page;
  }

  /** Reserve `h` points of vertical space, breaking to a new page first if it won't fit. */
  ensureSpace(h: number): void {
    if (this.y - h < this.margin) this.newPage();
  }

  moveDown(pt: number): void {
    this.y -= pt;
  }

  text(str: string, opts: TextOpts = {}): void {
    this.drawAt(this.x, this.y, str, opts);
  }

  drawAt(x: number, y: number, str: string, opts: TextOpts = {}): void {
    const font = opts.font ?? this.fonts.regular;
    const size = opts.size ?? 10;
    const color = opts.color ?? INK;
    let drawX = x;
    if (opts.align === 'right' && opts.boxWidth != null) {
      drawX = x + opts.boxWidth - font.widthOfTextAtSize(str, size);
    } else if (opts.align === 'center' && opts.boxWidth != null) {
      drawX = x + (opts.boxWidth - font.widthOfTextAtSize(str, size)) / 2;
    }
    this.page.drawText(str, { x: drawX, y, size, font, color });
  }

  /** Draw a wrapped paragraph at the cursor, advancing `y`. Returns the number of lines drawn. */
  paragraph(txt: string, opts: TextOpts & { maxWidth: number; lineGap?: number } = { maxWidth: 0 }): number {
    const font = opts.font ?? this.fonts.regular;
    const size = opts.size ?? 10;
    const lineGap = opts.lineGap ?? size * 1.35;
    const lines = wrapText(font, txt, size, opts.maxWidth);
    for (const line of lines) {
      this.ensureSpace(lineGap);
      this.text(line, { ...opts, font, size });
      this.moveDown(lineGap);
    }
    return lines.length;
  }

  hr(widthPt?: number, color: RGB = RULE): void {
    const w = widthPt ?? this.width - 2 * this.margin;
    this.page.drawLine({
      start: { x: this.x, y: this.y },
      end: { x: this.x + w, y: this.y },
      thickness: 0.75,
      color,
    });
  }

  rect(x: number, y: number, w: number, h: number, opts: { border?: RGB; fill?: RGB; thickness?: number } = {}): void {
    this.page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: opts.border,
      borderWidth: opts.border ? (opts.thickness ?? 0.75) : undefined,
      color: opts.fill,
    });
  }

  /** A simple ruled table with a shaded header row. Breaks pages between rows as needed. */
  table(cols: Column[], rows: string[][], opts: { rowHeight?: number; fontSize?: number; zebra?: boolean } = {}): void {
    const rowH = opts.rowHeight ?? 16;
    const size = opts.fontSize ?? 9;
    const totalWidth = cols.reduce((a, c) => a + c.width, 0);

    const drawHeader = (): void => {
      this.ensureSpace(rowH * 2);
      this.rect(this.x, this.y - rowH, totalWidth, rowH, { fill: HEAD_BG });
      let cx = this.x;
      for (const c of cols) {
        this.drawAt(cx + 3, this.y - rowH + 4, truncateToWidth(this.fonts.bold, c.header, size, c.width - 6), {
          font: this.fonts.bold,
          size,
          align: c.align,
          boxWidth: c.width - 6,
        });
        cx += c.width;
      }
      this.moveDown(rowH);
      this.hr(totalWidth);
    };

    drawHeader();
    let zebraOn = false;
    const pageTop = this.height - this.margin;
    for (const row of rows) {
      const before = this.y;
      this.ensureSpace(rowH + 2);
      if (this.y !== before && this.y === pageTop) drawHeader(); // page broke: repeat header
      if (opts.zebra && zebraOn) {
        this.rect(this.x, this.y - rowH, totalWidth, rowH, { fill: rgb(0.965, 0.965, 0.97) });
      }
      zebraOn = !zebraOn;
      let cx = this.x;
      row.forEach((cell, i) => {
        const c = cols[i];
        if (!c) return;
        this.drawAt(cx + 3, this.y - rowH + 4, truncateToWidth(this.fonts.regular, cell, size, c.width - 6), {
          size,
          align: c.align,
          boxWidth: c.width - 6,
        });
        cx += c.width;
      });
      this.moveDown(rowH);
      this.hr(totalWidth, rgb(0.88, 0.88, 0.9));
    }
  }

  footer(text: string, size = 8): void {
    this.drawAt(this.margin, this.margin - 22, text, { size, color: MUTED });
  }

  async bytes(): Promise<Uint8Array> {
    return this.pdf.save();
  }
}
