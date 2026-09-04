/**
 * "Photo-like" JPEG rendering for a handful of invoices, to exercise the OCR / geometry path
 * (perspective/rotation, blur, uneven lighting) the same way a phone photo of a printed
 * invoice would. Pipeline: build a plain HTML twin of the invoice content -> screenshot it
 * with the headless Chromium already bundled in this environment (/opt/pw-browsers) -> distort
 * with sharp (rotate onto a "desk" background, vignette, grain, blur) -> encode as JPEG.
 *
 * Determinism: Chromium renders the same fixed HTML/CSS (system fonts only, no network) the
 * same way run to run in this environment; the cosmetic distortion (angle, grain, vignette
 * strength) is drawn from a seeded RNG. See tests/synthetic/README.md "Design notes" for the
 * caveat that a renderer upgrade could still shift antialiasing at the pixel level.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Rng } from './prng.ts';
import { LABELS, frDate, type InvoiceSpec } from './invoice-model.ts';
import type { InvoiceTotals } from './money.ts';
import { num, eur } from './money.ts';
import { COMMUNITY } from './fixtures.ts';
import { formatIbanPrinted } from './core-ids.ts';

const CHROMIUM = '/opt/pw-browsers/chromium';
const SHOT_W = 1000;
const SHOT_H = 1414;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function invoiceHtml(spec: InvoiceSpec, totals: InvoiceTotals): string {
  const t = LABELS[spec.language];
  const rows = spec.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.desc)}</td><td class="r">${num(l.qty)}</td><td>${esc(l.unit)}</td><td class="r">${num(l.unitPrice)}</td><td class="r">${num(l.qty * l.unitPrice)}</td></tr>`,
    )
    .join('\n');
  const irpfRow = spec.irpfPct
    ? `<div class="tline"><span>${t.irpf} ${spec.irpfPct}%</span><span>-${eur(totals.irpf)}</span></div>`
    : '';
  const payment =
    spec.paymentMethod === 'transfer'
      ? `${t.transfer} ${formatIbanPrinted(spec.vendor.iban)} (${spec.vendor.bankLabel}).`
      : `${t.directDebit}. IBAN de domiciliació: ${formatIbanPrinted(spec.vendor.iban)}.`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${SHOT_W}px;min-height:${SHOT_H}px;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;padding:70px 64px;box-sizing:border-box;}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #ccc;padding-bottom:18px;}
  .hd h1{font-size:30px;margin:0;letter-spacing:1px;}
  .hd .r{text-align:right;font-size:13px;color:#333;}
  .issuer{font-size:15px;font-weight:bold;margin-bottom:4px;}
  .meta{font-size:12px;color:#333;line-height:1.5;}
  .client{margin-top:22px;font-size:12px;line-height:1.6;}
  .client b{display:block;font-size:13px;margin-bottom:4px;}
  table{width:100%;border-collapse:collapse;margin-top:26px;font-size:13px;}
  th{text-align:left;background:#edeef1;padding:8px 6px;border-bottom:1px solid #ccc;font-size:12px;}
  td{padding:8px 6px;border-bottom:1px solid #eee;}
  .r{text-align:right;}
  .totals{margin-top:14px;width:280px;margin-left:auto;font-size:13px;}
  .tline{display:flex;justify-content:space-between;padding:4px 0;}
  .tline.total{font-weight:bold;border-top:1px solid #333;margin-top:4px;padding-top:8px;font-size:15px;}
  .pay{margin-top:26px;font-size:12px;color:#222;}
  .note{margin-top:10px;font-size:11px;color:#666;font-style:italic;}
  </style></head><body>
  <div class="hd">
    <div><div class="issuer">${esc(spec.vendor.name)}</div>
    <div class="meta">${t.nif}: ${spec.vendor.nif}<br>${t.address}: ${esc(spec.vendor.address)}</div></div>
    <div class="r"><h1>${t.title}</h1>${t.number}: ${spec.series}<br>${t.date}: ${frDate(spec.date, spec.language)}</div>
  </div>
  <div class="client"><b>${t.recipient}</b>${esc(COMMUNITY.name)}<br>${t.nif}: ${COMMUNITY.nif}<br>${t.address}: ${esc(COMMUNITY.address)}</div>
  <table><tr><th>${t.desc}</th><th class="r">${t.qty}</th><th>${t.unit}</th><th class="r">${t.unitPrice}</th><th class="r">${t.amount}</th></tr>
  ${rows}</table>
  <div class="totals">
    <div class="tline"><span>${t.base}</span><span>${eur(totals.base)}</span></div>
    <div class="tline"><span>${t.ivaRate} ${spec.ivaPct}%</span><span>${eur(totals.iva)}</span></div>
    ${irpfRow}
    <div class="tline total"><span>${t.total}</span><span>${eur(totals.total)}</span></div>
  </div>
  <div class="pay"><b>${t.paymentTerms}:</b><br>${payment}</div>
  ${spec.notes ? `<div class="note">${esc(spec.notes)}</div>` : ''}
  </body></html>`;
}

/** Build a deterministic radial-vignette SVG (white centre fading to a warm grey edge). */
function vignetteSvg(w: number, h: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><radialGradient id="g" cx="50%" cy="45%" r="75%">
      <stop offset="55%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#9a9488"/>
    </radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
  </svg>`;
  return Buffer.from(svg);
}

/** Deterministic monochrome film-grain layer, generated from the seeded RNG (no I/O). */
function grainBuffer(w: number, h: number, rng: Rng, amplitude: number): Buffer {
  const channels = 3;
  const buf = Buffer.alloc(w * h * channels);
  for (let i = 0; i < w * h; i++) {
    const v = 128 + Math.round((rng.next() - 0.5) * 2 * amplitude);
    const clamped = Math.max(0, Math.min(255, v));
    const o = i * channels;
    buf[o] = clamped;
    buf[o + 1] = clamped;
    buf[o + 2] = clamped;
  }
  return buf;
}

export interface PhotoOptions {
  /** Rotation in degrees; sign and exact value drawn from `rng` within [2, 4]. */
  minAngle?: number;
  maxAngle?: number;
}

/** Render `spec` as a skewed, blurred, grainy JPEG that exercises the OCR path. */
export async function renderInvoicePhoto(
  spec: InvoiceSpec,
  totals: InvoiceTotals,
  rng: Rng,
  opts: PhotoOptions = {},
): Promise<Buffer> {
  const html = invoiceHtml(spec, totals);
  const dir = mkdtempSync(join(tmpdir(), 'vx-synth-'));
  const htmlPath = join(dir, 'doc.html');
  const pngPath = join(dir, 'shot.png');
  writeFileSync(htmlPath, html, 'utf8');
  let pageBuf: Buffer;
  try {
    execFileSync(
      CHROMIUM,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-software-rasterizer',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=4000',
        `--screenshot=${pngPath}`,
        `--window-size=${SHOT_W},${SHOT_H}`,
        `file://${htmlPath}`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    pageBuf = await sharp(pngPath).toBuffer();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const min = opts.minAngle ?? 2;
  const max = opts.maxAngle ?? 4;
  const angle = rng.sign() * rng.range(min, max);
  const deskColor = { r: 0x9a, g: 0x94, b: 0x88, alpha: 1 };

  const rotated = await sharp(pageBuf)
    .rotate(angle, { background: deskColor })
    .modulate({ brightness: 0.99, saturation: 0.88 })
    .toBuffer();
  const meta = await sharp(rotated).metadata();
  const w = meta.width ?? SHOT_W;
  const h = meta.height ?? SHOT_H;

  const vignette = vignetteSvg(w, h);
  const grain = grainBuffer(w, h, rng, 10);

  const withVignette = await sharp(rotated)
    .composite([{ input: vignette, blend: 'multiply' }])
    .toBuffer();

  const withGrain = await sharp(withVignette)
    .composite([{ input: grain, raw: { width: w, height: h, channels: 3 }, blend: 'overlay' }])
    .toBuffer();

  return sharp(withGrain).blur(0.6).jpeg({ quality: 78, chromaSubsampling: '4:2:0' }).toBuffer();
}
