/**
 * The annual liquidación (fiscal year 2025) — income/expense lines, result, reserve fund and
 * a per-unit quota table. Deliberately self-contained and clean: its result (5.180,40 €) and
 * reserve-fund closing balance (7.200,00 €) are the same figures the ordinary acta's item 1
 * quotes verbatim, so the two documents corroborate each other; no planted discrepancy
 * targets this document or its fiscal year.
 */
import { Doc, MUTED } from './pdfdraw.ts';
import { COMMUNITY, UNITS, DERRAMA_MONTHLY } from './fixtures.ts';
import { eur, round2, num } from './money.ts';

export const LIQUIDACION = {
  id: 'liquidacio-2025',
  ejercicio: 2025,
  periodoDesde: '2025-01-01',
  periodoHasta: '2025-12-31',
  ordinaryBudget: 6700.0,
  ingresos: [
    { concepto: 'Quotes ordinàries (13 unitats)', importe: 6700.0 },
    { concepto: `Derrama extraordinària obres (${eur(DERRAMA_MONTHLY)}/mes x 13 unitats x 12 mesos)`, importe: 9360.0 },
    { concepto: 'Interessos bancaris', importe: 45.2 },
  ],
  despesas: [
    { concepto: 'Manteniment ascensor', importe: 1440.0 },
    { concepto: 'Neteja escala i portal', importe: 2160.0 },
    { concepto: 'Assegurança de la comunitat', importe: 980.0 },
    { concepto: 'Administració de finques', importe: 3600.0 },
    { concepto: 'Subministrament elèctric zones comunes', importe: 620.0 },
    { concepto: "Subministrament d'aigua zones comunes", importe: 210.0 },
    { concepto: 'Manteniment i reparacions diverses', importe: 1105.2 },
    { concepto: 'Despeses diverses', importe: 809.6 },
  ],
  reserveOpening: 6750.0,
  reserveDotacio: 450.0,
  reserveAplicacions: 0.0,
  saldoFinalComptes: 12450.0,
} as const;

export function totalIngresos(): number {
  return round2(LIQUIDACION.ingresos.reduce((a, l) => a + l.importe, 0));
}
export function totalDespesas(): number {
  return round2(LIQUIDACION.despesas.reduce((a, l) => a + l.importe, 0));
}
export function resultado(): number {
  return round2(totalIngresos() - totalDespesas());
}
export function reserveFinal(): number {
  return round2(LIQUIDACION.reserveOpening + LIQUIDACION.reserveDotacio - LIQUIDACION.reserveAplicacions);
}

export interface UnitQuotaRow {
  unit: string;
  quotaPct: number;
  ordinaryAnnual: number;
  derramaAnnual: number;
  totalAnnual: number;
}

export function unitQuotaTable(): UnitQuotaRow[] {
  return UNITS.map((u) => {
    const ordinaryAnnual = round2((LIQUIDACION.ordinaryBudget * u.quotaPct) / 100);
    const derramaAnnual = round2(DERRAMA_MONTHLY * 12);
    return { unit: u.label, quotaPct: u.quotaPct, ordinaryAnnual, derramaAnnual, totalAnnual: round2(ordinaryAnnual + derramaAnnual) };
  });
}

function frDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export async function renderLiquidacion(): Promise<Uint8Array> {
  const l = LIQUIDACION;
  const doc = await Doc.create({
    title: `Liquidació de l'exercici ${l.ejercicio}`,
    author: COMMUNITY.name,
    subject: 'Liquidació anual',
    isoDate: l.periodoHasta,
  });

  doc.text(`LIQUIDACIÓ DE L'EXERCICI ${l.ejercicio}`, { font: doc.fonts.bold, size: 15 });
  doc.moveDown(20);
  doc.paragraph(`${COMMUNITY.name} (${COMMUNITY.nif})`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`Període: ${frDate(l.periodoDesde)} — ${frDate(l.periodoHasta)}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(
    `Aprovada a la reunió ordinària de 30/03/2026 (acta acta-ordinaria-2026-03-30, punt 1).`,
    { size: 8.5, maxWidth: doc.width - 2 * doc.margin, color: MUTED },
  );
  doc.moveDown(8);
  doc.hr();
  doc.moveDown(16);

  doc.text('Ingressos', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  const colsMoney = [
    { header: 'Concepte', width: 380 },
    { header: 'Import', width: 119, align: 'right' as const },
  ];
  doc.table(colsMoney, l.ingresos.map((r) => [r.concepto, eur(r.importe)]), { rowHeight: 15, fontSize: 9 });
  doc.moveDown(4);
  doc.drawAt(doc.width - doc.margin - 199, doc.y, 'TOTAL INGRESSOS', { font: doc.fonts.bold, size: 9.5, align: 'left' });
  doc.drawAt(doc.width - doc.margin - 119, doc.y, eur(totalIngresos()), { font: doc.fonts.bold, size: 9.5, align: 'right', boxWidth: 119 });
  doc.moveDown(22);

  doc.text('Despeses', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  doc.table(colsMoney, l.despesas.map((r) => [r.concepto, eur(r.importe)]), { rowHeight: 15, fontSize: 9 });
  doc.moveDown(4);
  doc.drawAt(doc.width - doc.margin - 199, doc.y, 'TOTAL DESPESES', { font: doc.fonts.bold, size: 9.5, align: 'left' });
  doc.drawAt(doc.width - doc.margin - 119, doc.y, eur(totalDespesas()), { font: doc.fonts.bold, size: 9.5, align: 'right', boxWidth: 119 });
  doc.moveDown(24);

  doc.hr(280);
  doc.moveDown(4);
  doc.text(`RESULTAT DE L'EXERCICI: ${eur(resultado())}`, { font: doc.fonts.bold, size: 11 });
  doc.moveDown(22);

  doc.text('Fons de reserva', { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  doc.paragraph(
    `Saldo inicial (01/01/${l.ejercicio}): ${eur(l.reserveOpening)}. Dotació de l'exercici: ${eur(l.reserveDotacio)}. Aplicacions: ${eur(l.reserveAplicacions)}. Saldo final (31/12/${l.ejercicio}): ${eur(reserveFinal())} (${num((reserveFinal() / l.ordinaryBudget) * 100)}% del pressupost ordinari).`,
    { size: 9.5, maxWidth: doc.width - 2 * doc.margin },
  );
  doc.paragraph(`Saldo total en comptes a 31/12/${l.ejercicio}: ${eur(l.saldoFinalComptes)}.`, {
    size: 9.5,
    maxWidth: doc.width - 2 * doc.margin,
  });
  doc.moveDown(14);

  doc.newPage();
  doc.text('Quadre de quotes per unitat', { font: doc.fonts.bold, size: 12 });
  doc.moveDown(20);
  const cols = [
    { header: 'Unitat', width: 90 },
    { header: 'Quota %', width: 70, align: 'right' as const },
    { header: 'Quota ordinària anual', width: 120, align: 'right' as const },
    { header: 'Derrama anual', width: 100, align: 'right' as const },
    { header: 'Total anual', width: 99, align: 'right' as const },
  ];
  const rows = unitQuotaTable().map((r) => [r.unit, num(r.quotaPct), eur(r.ordinaryAnnual), eur(r.derramaAnnual), eur(r.totalAnnual)]);
  doc.table(cols, rows, { rowHeight: 15, fontSize: 8.5, zebra: true });
  doc.moveDown(8);
  doc.paragraph('Totes les unitats es troben al corrent de pagament a 31/12/2025.', {
    size: 8.5,
    color: MUTED,
    maxWidth: doc.width - 2 * doc.margin,
  });

  doc.footer(`${COMMUNITY.name} — ${l.id}`);
  return doc.bytes();
}
