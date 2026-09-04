/**
 * The one works contract: rehabilitation of the rear façade and balconies, awarded to
 * Construccions Model S.L. under the extraordinary meeting's delegation. Its price and
 * payment schedule (40% advance, milestones, retention) are the basis for the planted A4
 * "paid exceeds certified amount at the suspension date" item — recorded in expected.json via
 * `CERTIFICATION_NOTE` below; the certification itself is deliberately never rendered as a
 * PDF (a real certificado de obra is issued by the site director, not the contractor).
 */
import { Doc, MUTED } from './pdfdraw.ts';
import { COMMUNITY, PRESIDENT_UNIT, VENDORS } from './fixtures.ts';
import { eur, round2 } from './money.ts';

export const CONTRACT = {
  id: 'contracte-facana-posterior',
  worksPackage: 'REAR_FACADE',
  worksPackageLabel: 'Rehabilitació de la façana posterior i balcons',
  contractor: VENDORS.construccions!,
  signatureDate: '2026-05-16',
  authorisingResolution: { actaId: 'acta-extraordinaria-2026-05-14', punto: '2' },
  priceBase: 42000.0,
  ivaPct: 21,
  get priceIva(): number {
    return round2(this.priceBase * (this.ivaPct / 100));
  },
  get priceTotal(): number {
    return round2(this.priceBase + this.priceIva);
  },
  advancePct: 40,
  get advanceAmount(): number {
    return round2(this.priceTotal * (this.advancePct / 100));
  },
  progressPct: 55,
  get progressAmount(): number {
    return round2(this.priceTotal * (this.progressPct / 100));
  },
  retentionPct: 5,
  get retentionAmount(): number {
    return round2(this.priceTotal * (this.retentionPct / 100));
  },
  startDate: '2026-05-20',
  deadlineDays: 90,
  deadlineDate: '2026-08-18',
  penaltyPerDay: 150.0,
  penaltyCapPct: 10,
  suspensionDate: '2026-07-01',
  suspensionReason: 'seasonal',
} as const;

/**
 * Synthetic ground truth for the planted A4 item. No certificate PDF is generated (the
 * catalogue's `certificacion_obra` doc type is out of scope for this corpus) — the fact is
 * recorded here so the harness/rule-engine tests have a number to compare against the bank
 * evidence (advance + `inv-facade-progress` payment, both real movements in the statements).
 */
export const CERTIFICATION_NOTE = {
  worksPackage: 'REAR_FACADE',
  asOfDate: '2026-06-28',
  certifiedAmountGross: 18000.0,
  note:
    'Import certificat per la direcció facultativa (síntesi, sense PDF de certificació generat en aquest corpus).',
};

export const MILESTONES = [
  {
    label: 'Avançament a la signatura del contracte',
    pct: CONTRACT.advancePct,
    amount: CONTRACT.advanceAmount,
    dueOn: 'A la signatura del contracte',
  },
  {
    label: "Certificacions mensuals d'obra fins al 95% del preu",
    pct: CONTRACT.progressPct,
    amount: CONTRACT.progressAmount,
    dueOn: "Mensual, segons amidament de la direcció facultativa",
  },
  {
    label: 'Retenció de garantia',
    pct: CONTRACT.retentionPct,
    amount: CONTRACT.retentionAmount,
    dueOn: 'Alliberable 12 mesos després de la recepció de l\'obra',
  },
];

function frDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export async function renderContract(): Promise<Uint8Array> {
  const c = CONTRACT;
  const doc = await Doc.create({
    title: 'Contracte d\'execució d\'obres — façana posterior i balcons',
    author: COMMUNITY.name,
    subject: c.worksPackageLabel,
    isoDate: c.signatureDate,
  });

  doc.text("CONTRACTE D'EXECUCIÓ D'OBRES", { font: doc.fonts.bold, size: 15 });
  doc.moveDown(22);
  doc.paragraph(`Objecte: ${c.worksPackageLabel}.`, { size: 10, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`Data de signatura: ${frDate(c.signatureDate)}.`, { size: 10, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(
    `Aprovat per acord de la junta extraordinària de ${frDate('2026-05-14')} (acta ${c.authorisingResolution.actaId}, punt ${c.authorisingResolution.punto}), amb delegació de la signatura en el/la president/a.`,
    { size: 9, maxWidth: doc.width - 2 * doc.margin, color: MUTED },
  );
  doc.moveDown(8);
  doc.hr();
  doc.moveDown(16);

  doc.text('Parts', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  doc.paragraph(`Comitent: ${COMMUNITY.name} (${COMMUNITY.nif}), representada pel/per la president/a (càrrec de la unitat ${PRESIDENT_UNIT}).`, {
    size: 9.5,
    maxWidth: doc.width - 2 * doc.margin,
  });
  doc.paragraph(`Contractista: ${c.contractor.name} (${c.contractor.nif}), amb domicili a ${c.contractor.address}.`, {
    size: 9.5,
    maxWidth: doc.width - 2 * doc.margin,
  });
  doc.moveDown(8);
  doc.hr();
  doc.moveDown(16);

  doc.text('Preu', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  doc.paragraph(`Base: ${eur(c.priceBase)}. IVA ${c.ivaPct}%: ${eur(c.priceIva)}. Preu total: ${eur(c.priceTotal)}.`, {
    size: 9.5,
    maxWidth: doc.width - 2 * doc.margin,
  });
  doc.moveDown(8);
  doc.hr();
  doc.moveDown(16);

  doc.text('Forma de pagament', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  const cols = [
    { header: 'Concepte', width: 260 },
    { header: '%', width: 45, align: 'right' as const },
    { header: 'Import', width: 90, align: 'right' as const },
    { header: 'Meritació', width: 104 },
  ];
  const rows = MILESTONES.map((m) => [m.label, `${m.pct}%`, eur(m.amount), m.dueOn]);
  doc.table(cols, rows, { rowHeight: 24, fontSize: 8.5 });
  doc.moveDown(10);

  doc.text('Termini, penalització i garantia', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  doc.paragraph(
    `Termini d'execució: ${c.deadlineDays} dies naturals des de l'inici (inici previst ${frDate(c.startDate)}; termini ${frDate(c.deadlineDate)}).`,
    { size: 9.5, maxWidth: doc.width - 2 * doc.margin },
  );
  doc.paragraph(
    `Clàusula penal: ${eur(c.penaltyPerDay)} per dia natural de retard no justificat imputable al contractista, amb un màxim del ${c.penaltyCapPct}% del preu del contracte (${eur(round2((c.priceTotal * c.penaltyCapPct) / 100))}).`,
    { size: 9.5, maxWidth: doc.width - 2 * doc.margin },
  );
  doc.paragraph(
    `Retenció de garantia: ${c.retentionPct}% del preu (${eur(c.retentionAmount)}), alliberable 12 mesos després de la recepció de l'obra.`,
    { size: 9.5, maxWidth: doc.width - 2 * doc.margin },
  );

  doc.moveDown(20);
  doc.hr();
  doc.moveDown(20);
  doc.text('__________________________          __________________________', { size: 10 });
  doc.moveDown(14);
  doc.text('President/a (per la comunitat)', { size: 9, color: MUTED });
  doc.drawAt(doc.margin + 260, doc.y, `${c.contractor.name} (contractista)`, { size: 9, color: MUTED });

  doc.footer(`${COMMUNITY.name} — ${c.contractor.name} — ${c.id}`);
  return doc.bytes();
}
