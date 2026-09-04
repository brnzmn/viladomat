/**
 * The 15 synthetic invoices: specs (literal, hand-designed data — see tests/synthetic/README.md
 * for the narrative) plus the renderer that turns a spec into a realistic A4 PDF.
 */
import { Doc, rgb, degrees, HANDWRITE, MUTED } from './pdfdraw.ts';
import { COMMUNITY, VENDORS, FUSTERIA_IBAN_ACTUAL, type Vendor } from './fixtures.ts';
import { computeInvoiceTotals, eur, num, type Line } from './money.ts';
import { formatIbanPrinted } from './core-ids.ts';
import { rngFor } from './prng.ts';
import { drawHandwrittenNote } from './handwriting.ts';

export type Lang = 'es' | 'ca';

export interface InvoiceLine extends Line {
  elementScope?: 'common' | 'private_unit';
}

export interface InvoiceSpec {
  id: string;
  vendor: Vendor;
  categoryCode: string;
  categoryLabel: string;
  series: string;
  date: string; // ISO
  language: Lang;
  lines: InvoiceLine[];
  ivaPct: number;
  irpfPct?: number;
  printedBaseOverride?: number; // planted C2 arithmetic mismatch
  paymentMethod: 'transfer' | 'direct_debit';
  handwritten?: string;
  photoLike?: boolean;
  plantTags?: string[];
  notes?: string;
}

export const LABELS: Record<Lang, Record<string, string>> = {
  es: {
    title: 'FACTURA',
    number: 'Nº factura',
    date: 'Fecha',
    issuer: 'Datos del emisor',
    recipient: 'Datos del cliente',
    nif: 'NIF',
    address: 'Domicilio',
    desc: 'Descripción',
    qty: 'Cant.',
    unit: 'Ud.',
    unitPrice: 'Precio unit.',
    amount: 'Importe',
    base: 'Base imponible',
    ivaRate: 'Tipo IVA',
    quota: 'Cuota IVA',
    irpf: 'Retención IRPF',
    total: 'TOTAL FACTURA',
    paymentTerms: 'Forma de pago',
    transfer: 'Transferencia bancaria al IBAN',
    directDebit: 'Domiciliación bancaria (recibo)',
    dueDate: 'Vencimiento',
    days30: '30 días fecha factura',
    onReceipt: 'A la recepción de la factura',
  },
  ca: {
    title: 'FACTURA',
    number: 'Núm. factura',
    date: 'Data',
    issuer: "Dades de l'emissor",
    recipient: 'Dades del client',
    nif: 'NIF',
    address: 'Domicili',
    desc: 'Descripció',
    qty: 'Quant.',
    unit: 'Ut.',
    unitPrice: 'Preu unit.',
    amount: 'Import',
    base: 'Base imposable',
    ivaRate: 'Tipus IVA',
    quota: 'Quota IVA',
    irpf: 'Retenció IRPF',
    total: 'TOTAL FACTURA',
    paymentTerms: 'Forma de pagament',
    transfer: "Transferència bancària a l'IBAN",
    directDebit: 'Domiciliació bancària (rebut)',
    dueDate: 'Venciment',
    days30: '30 dies data factura',
    onReceipt: 'A la recepció de la factura',
  },
};

// ---------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------

export const INVOICES: InvoiceSpec[] = [
  {
    id: 'inv-elev-maint',
    vendor: VENDORS.ascensors!,
    categoryCode: 'ELEV_MAINT',
    categoryLabel: 'Manteniment ascensor',
    series: 'AM-2026-0512',
    date: '2026-05-01',
    language: 'ca',
    lines: [{ desc: 'Manteniment mensual ascensor — maig 2026', qty: 1, unit: 'mes', unitPrice: 120.0 }],
    ivaPct: 21,
    paymentMethod: 'direct_debit',
    handwritten: 'Revisat i conforme — maig 2026',
    photoLike: true,
  },
  {
    id: 'inv-elev-install-a',
    vendor: VENDORS.ascensors!,
    categoryCode: 'ELEV_INSTALL',
    categoryLabel: 'Instal·lació ascensor',
    series: 'AI-2026-0301',
    date: '2026-05-05',
    language: 'es',
    lines: [
      {
        desc: 'Certificación de obra civil ascensor — fase 1 (hueco y foso)',
        qty: 1,
        unit: 'ud',
        unitPrice: 3800.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    plantTags: ['C3-duplicate-a'],
  },
  {
    id: 'inv-elev-install-b',
    vendor: VENDORS.ascensors!,
    categoryCode: 'ELEV_INSTALL',
    categoryLabel: 'Instal·lació ascensor',
    series: 'AI-2026-0344',
    date: '2026-05-25',
    language: 'es',
    lines: [
      {
        desc: 'Certificación de obra civil ascensor — fase 1 (hueco y foso)',
        qty: 1,
        unit: 'ud',
        unitPrice: 3800.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    plantTags: ['C3-duplicate-b'],
  },
  {
    id: 'inv-elev-inspect',
    vendor: VENDORS.ascensors!,
    categoryCode: 'ELEV_INSPECT',
    categoryLabel: 'Inspecció periòdica ascensor',
    series: 'AI-2026-0290',
    date: '2026-05-13',
    language: 'es',
    lines: [
      {
        desc: 'Inspección periódica OCA ascensor (organismo de control autorizado)',
        qty: 1,
        unit: 'ud',
        unitPrice: 460.0,
      },
    ],
    ivaPct: 21,
    printedBaseOverride: 450.0,
    paymentMethod: 'transfer',
    plantTags: ['C2-arithmetic'],
    notes: 'Base imponible impresa (450,00) no coincide con la suma de líneas (460,00): -10,00 €.',
  },
  {
    id: 'inv-windows-1',
    vendor: VENDORS.installacions!,
    categoryCode: 'WINDOWS',
    categoryLabel: 'Finestres (element comú)',
    series: 'F-2026-0110',
    date: '2026-05-02',
    language: 'ca',
    lines: [
      {
        desc: "Substitució de 2 finestres alumini RPT al replà de l'escala (element comú)",
        qty: 1,
        unit: 'pa',
        unitPrice: 522.73,
        elementScope: 'common',
      },
    ],
    ivaPct: 10,
    paymentMethod: 'transfer',
    plantTags: ['C4-split-a'],
    notes: 'El cost dels materials no supera el 40% del total (tipus reduït 10%).',
  },
  {
    id: 'inv-windows-2',
    vendor: VENDORS.installacions!,
    categoryCode: 'WINDOWS',
    categoryLabel: 'Finestres (element comú)',
    series: 'F-2026-0115',
    date: '2026-05-06',
    language: 'ca',
    lines: [
      {
        desc: "Substitució de 2 finestres alumini RPT al replà de l'escala — 2a fase (element comú)",
        qty: 1,
        unit: 'pa',
        unitPrice: 522.73,
        elementScope: 'common',
      },
    ],
    ivaPct: 10,
    paymentMethod: 'transfer',
    plantTags: ['C4-split-b'],
    notes: 'El cost dels materials no supera el 40% del total (tipus reduït 10%).',
  },
  {
    id: 'inv-windows-3',
    vendor: VENDORS.installacions!,
    categoryCode: 'WINDOWS',
    categoryLabel: 'Finestres',
    series: 'F-2026-0130',
    date: '2026-05-10',
    language: 'es',
    lines: [
      {
        desc: 'Sustitución ventana escalera — rellano 2º piso (elemento común)',
        qty: 1,
        unit: 'ud',
        unitPrice: 410.0,
        elementScope: 'common',
      },
      {
        desc: 'Sustitución ventana dormitorio Pral 1a',
        qty: 1,
        unit: 'ud',
        unitPrice: 385.0,
        elementScope: 'private_unit',
      },
    ],
    ivaPct: 10,
    paymentMethod: 'transfer',
    photoLike: true,
    plantTags: ['C11-private-element'],
    notes: 'La segona línia identifica un element privatiu (dormitori Pral 1a).',
  },
  {
    id: 'inv-intercom',
    vendor: VENDORS.installacions!,
    categoryCode: 'INTERCOM',
    categoryLabel: 'Videoporter',
    series: 'F-2026-0142',
    date: '2026-06-08',
    language: 'ca',
    lines: [
      {
        desc: 'Renovació del quadre de trucada i telefonillos (12 unitats)',
        qty: 1,
        unit: 'pa',
        unitPrice: 1300.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
  },
  {
    id: 'inv-facade-progress',
    vendor: VENDORS.construccions!,
    categoryCode: 'FACADE_REHAB',
    categoryLabel: 'Rehabilitació façana',
    series: 'CM-2026-0210',
    date: '2026-06-25',
    language: 'ca',
    lines: [
      {
        desc: 'Certificació núm. 2 — rehabilitació de la façana posterior i balcons (amidament segons direcció facultativa)',
        qty: 1,
        unit: 'pa',
        unitPrice: 18000.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    notes: 'Certificació emesa sota el contracte d\'obres de la façana posterior i balcons.',
  },
  {
    id: 'inv-entrance-door',
    vendor: VENDORS.fusteria!,
    categoryCode: 'ENTRANCE_DOOR',
    categoryLabel: 'Porta d\'entrada',
    series: 'FR-2026-0045',
    date: '2026-06-05',
    language: 'es',
    lines: [
      {
        desc: 'Suministro e instalación de puerta de entrada al portal, cierrapuertas y cerradura de seguridad',
        qty: 1,
        unit: 'ud',
        unitPrice: 4200.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    photoLike: true,
    plantTags: ['B4B5-iban-mismatch'],
  },
  {
    id: 'inv-architect',
    vendor: VENDORS.arquitecte!,
    categoryCode: 'ARCH_DO',
    categoryLabel: "Direcció d'obra",
    series: 'AR-2026-0012',
    date: '2026-06-01',
    language: 'es',
    lines: [
      {
        desc: 'Dirección de obra y certificaciones — rehabilitación fachada posterior (mayo-junio 2026)',
        qty: 1,
        unit: 'pa',
        unitPrice: 3000.0,
      },
    ],
    ivaPct: 21,
    irpfPct: 15,
    paymentMethod: 'transfer',
  },
  {
    id: 'inv-paint',
    vendor: VENDORS.pintures!,
    categoryCode: 'PAINT_INT',
    categoryLabel: 'Pintura interior',
    series: 'PM-2026-0077',
    date: '2026-06-10',
    language: 'ca',
    lines: [
      {
        desc: 'Pintat de vestíbul, replans i sostres de l\'escala (2 mans de pintura plàstica)',
        qty: 175,
        unit: 'm2',
        unitPrice: 12.0,
      },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
  },
  {
    id: 'inv-cleaning',
    vendor: VENDORS.neteges!,
    categoryCode: 'CLEANING',
    categoryLabel: 'Neteja',
    series: 'NX-2026-0033',
    date: '2026-06-01',
    language: 'es',
    lines: [{ desc: 'Limpieza de escalera y portal — junio 2026', qty: 1, unit: 'mes', unitPrice: 180.0 }],
    ivaPct: 21,
    paymentMethod: 'transfer',
  },
  {
    id: 'inv-admin',
    vendor: VENDORS.administracio!,
    categoryCode: 'ADMIN_FEE',
    categoryLabel: 'Honoraris administració',
    series: 'AE-2026-0089',
    date: '2026-06-01',
    language: 'es',
    lines: [
      { desc: 'Honorarios de administración de fincas — 2º trimestre 2026', qty: 1, unit: 'pa', unitPrice: 900.0 },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    handwritten: 'Conforme — revisat per secretaria',
  },
  {
    id: 'inv-masonry',
    vendor: VENDORS.construccions!,
    categoryCode: 'MASONRY',
    categoryLabel: 'Paleteria',
    series: 'CM-2026-0088',
    date: '2026-05-08',
    language: 'es',
    lines: [
      { desc: 'Reparación de humedades y repicado puntual en zona común de escalera', qty: 8, unit: 'h', unitPrice: 35.0 },
      { desc: 'Material de albañilería (yeso, mortero)', qty: 1, unit: 'pa', unitPrice: 70.0 },
    ],
    ivaPct: 21,
    paymentMethod: 'transfer',
    handwritten: 'Revisat, correcte',
  },
];

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

export interface RenderedInvoice {
  spec: InvoiceSpec;
  totals: ReturnType<typeof computeInvoiceTotals>;
  bytes: Uint8Array;
}

export async function renderInvoice(spec: InvoiceSpec): Promise<RenderedInvoice> {
  const t = LABELS[spec.language];
  const totals = computeInvoiceTotals(spec.lines, spec.ivaPct, spec.irpfPct ?? 0, spec.printedBaseOverride);

  const doc = await Doc.create({
    title: `${t.title} ${spec.series}`,
    author: spec.vendor.name,
    subject: spec.categoryLabel,
    isoDate: spec.date,
  });

  // Header: issuer (left) / title+number+date (right)
  const colW = (doc.width - 2 * doc.margin) / 2;
  doc.text(spec.vendor.name, { font: doc.fonts.bold, size: 13 });
  doc.moveDown(16);
  doc.paragraph(`${t.nif}: ${spec.vendor.nif}`, { size: 9, maxWidth: colW });
  doc.paragraph(`${t.address}: ${spec.vendor.address}`, { size: 9, maxWidth: colW });

  const rightX = doc.margin + colW + 10;
  doc.drawAt(rightX, doc.height - doc.margin, t.title, { font: doc.fonts.bold, size: 18, align: 'right', boxWidth: colW - 10 });
  doc.drawAt(rightX, doc.height - doc.margin - 22, `${t.number}: ${spec.series}`, { size: 10, align: 'right', boxWidth: colW - 10 });
  doc.drawAt(rightX, doc.height - doc.margin - 36, `${t.date}: ${frDate(spec.date, spec.language)}`, {
    size: 10,
    align: 'right',
    boxWidth: colW - 10,
  });

  doc.moveDown(14);
  doc.hr();
  doc.moveDown(16);

  // Recipient block
  doc.text(t.recipient, { font: doc.fonts.bold, size: 10 });
  doc.moveDown(14);
  doc.paragraph(COMMUNITY.name, { size: 10, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.nif}: ${COMMUNITY.nif}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.address}: ${COMMUNITY.address}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.moveDown(6);
  doc.hr();
  doc.moveDown(14);

  // Line items table
  const cols = [
    { header: t.desc, width: 260 },
    { header: t.qty, width: 45, align: 'right' as const },
    { header: t.unit, width: 40, align: 'center' as const },
    { header: t.unitPrice, width: 80, align: 'right' as const },
    { header: t.amount, width: 74, align: 'right' as const },
  ];
  const rows = spec.lines.map((l) => [
    l.desc,
    num(l.qty),
    l.unit,
    num(l.unitPrice),
    num(l.qty * l.unitPrice),
  ]);
  doc.table(cols, rows, { rowHeight: 18, zebra: true });
  doc.moveDown(10);

  // Totals block, right-aligned
  const totalsX = doc.width - doc.margin - 220;
  const totalsW = 220;
  const totalLine = (label: string, value: string, opts: { bold?: boolean; muted?: boolean } = {}): void => {
    doc.ensureSpace(16);
    doc.drawAt(totalsX, doc.y, label, {
      font: opts.bold ? doc.fonts.bold : doc.fonts.regular,
      size: 10,
      color: opts.muted ? MUTED : undefined,
    });
    doc.drawAt(totalsX, doc.y, value, {
      font: opts.bold ? doc.fonts.bold : doc.fonts.regular,
      size: 10,
      align: 'right',
      boxWidth: totalsW,
      color: opts.muted ? MUTED : undefined,
    });
    doc.moveDown(16);
  };
  totalLine(t.base, eur(totals.base));
  totalLine(`${t.ivaRate} ${spec.ivaPct}%`, eur(totals.iva));
  if (spec.irpfPct) totalLine(`${t.irpf} ${spec.irpfPct}%`, `-${eur(totals.irpf)}`);
  doc.hr(220);
  doc.moveDown(4);
  totalLine(t.total, eur(totals.total), { bold: true });

  doc.moveDown(12);
  doc.hr();
  doc.moveDown(14);

  // Payment terms
  doc.text(`${t.paymentTerms}:`, { font: doc.fonts.bold, size: 10 });
  doc.moveDown(14);
  if (spec.paymentMethod === 'transfer') {
    doc.paragraph(`${t.transfer} ${formatIbanPrinted(spec.vendor.iban)} (${spec.vendor.bankLabel}).`, {
      size: 9,
      maxWidth: doc.width - 2 * doc.margin,
    });
    doc.paragraph(`${t.dueDate}: ${t.onReceipt}.`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  } else {
    doc.paragraph(`${t.directDebit}. IBAN de domiciliació: ${formatIbanPrinted(spec.vendor.iban)}.`, {
      size: 9,
      maxWidth: doc.width - 2 * doc.margin,
    });
  }

  if (spec.notes) {
    doc.moveDown(6);
    doc.paragraph(spec.notes, { size: 8, maxWidth: doc.width - 2 * doc.margin, color: MUTED, font: doc.fonts.italic });
  }

  doc.footer(`${spec.vendor.name} — ${spec.vendor.nif} — ${spec.series}`);

  if (spec.handwritten) {
    const rng = rngFor(`handwriting:${spec.id}`);
    drawHandwrittenNote(doc, spec.handwritten, rng);
  }

  return { spec, totals, bytes: await doc.bytes() };
}

export function frDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
