/**
 * "Handwritten" margin annotations.
 *
 * No handwriting font ships in this environment (no network fetch, no extra npm
 * dependency beyond pdf-lib/sharp/tsx — see tests/synthetic/README.md "Design notes"), so a
 * handwritten note is approximated with the closest standard-14 shape available — an
 * oblique (italic) face — drawn word-by-word with a jittered rotation and baseline, in a
 * pen-blue ink colour, rather than as one straight, mechanically laid out line. It is not a
 * substitute for a real handwriting sample; it exists to exercise the "mark handwriting" /
 * low-confidence path in the extraction pipeline and the review-queue crop, not to fool a
 * human reader into thinking it is a scan of ink.
 */
import type { Doc } from './pdfdraw.ts';
import { HANDWRITE, degrees } from './pdfdraw.ts';
import type { Rng } from './prng.ts';

export function drawHandwrittenNote(doc: Doc, text: string, rng: Rng): void {
  const baseAngle = rng.range(-6, 6);
  const baseSize = 13;
  const font = doc.fonts.italic;
  let x = doc.margin + 40;
  let y = doc.margin + 54;
  const rad = (baseAngle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const word of text.split(' ')) {
    const jitterY = rng.range(-2.2, 2.2);
    const jitterAngle = baseAngle + rng.range(-3, 3);
    const size = baseSize + rng.range(-1, 1);
    doc.page.drawText(word, {
      x,
      y: y + jitterY,
      size,
      font,
      color: HANDWRITE,
      rotate: degrees(jitterAngle),
    });
    const w = font.widthOfTextAtSize(`${word} `, size);
    x += w * cos;
    y += w * sin;
  }

  // A short underline squiggle beneath the note, drawn as two slightly offset strokes.
  const underlineLen = 90;
  const ux = doc.margin + 40;
  const uy = doc.margin + 40;
  doc.page.drawLine({
    start: { x: ux, y: uy },
    end: { x: ux + underlineLen * cos, y: uy + underlineLen * sin - 3 },
    thickness: 1.1,
    color: HANDWRITE,
  });
  doc.page.drawLine({
    start: { x: ux + 6, y: uy - 3 },
    end: { x: ux + (underlineLen - 10) * cos, y: uy + (underlineLen - 10) * sin - 5 },
    thickness: 0.8,
    color: HANDWRITE,
  });
}
