/**
 * The community's bank timeline: two consecutive monthly statements (May and June 2026),
 * modelled once as a list of movements and rendered three ways — a PDF table, a Norma 43
 * export and a bank CSV export — so all three formats describe exactly the same facts.
 * Closing balances are *computed*, never hand-typed, so opening(period N+1) = closing(period N)
 * holds by construction (this is what a clean D7 balance-continuity check needs).
 */
import { Doc } from './pdfdraw.ts';
import { COMMUNITY, COMMUNITY_BANK, UNITS, VENDORS, FUSTERIA_IBAN_ACTUAL } from './fixtures.ts';
import { round2, eur, num } from './money.ts';
import { writeNorma43, impliedClosing, type N43WriteAccount } from './norma43-writer.ts';

export interface Movement {
  opDate: string;
  valueDate?: string;
  concept: string;
  conceptDetail?: string;
  amount: number;
  conceptoComun: string;
  documentNumber?: string;
  counterpartyIban?: string;
  unitLabel?: string;
  linkedInvoiceId?: string;
  recurring?: boolean;
  plantTags?: string[];
}

export interface StatementPeriod {
  id: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number;
  movements: Movement[];
}

function derramaCredits(dateIso: string, excludeUnit?: string): Movement[] {
  return UNITS.filter((u) => u.label !== excludeUnit).map((u) => ({
    opDate: dateIso,
    concept: `Rebut domiciliat quota derrama ${u.label}`,
    conceptDetail: 'Comunitat de Propietaris — derrama obres',
    amount: 60.0,
    conceptoComun: '03',
    unitLabel: u.label,
    recurring: true,
  }));
}

const MAY: StatementPeriod = {
  id: 'statement-2026-05',
  periodFrom: '2026-05-01',
  periodTo: '2026-05-31',
  openingBalance: 78500.0,
  movements: [
    ...derramaCredits('2026-05-02'),
    {
      opDate: '2026-05-02',
      concept: 'Rebut domiciliat manteniment ascensor',
      conceptDetail: 'Ascensors Exemple S.A.',
      amount: -145.2,
      conceptoComun: '03',
      linkedInvoiceId: 'inv-elev-maint',
      recurring: true,
    },
    {
      opDate: '2026-05-04',
      concept: 'Transferència — avançament contracte façana posterior',
      conceptDetail: 'Construccions Model S.L.',
      amount: -20328.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.construccions!.iban,
      plantTags: ['D4E2-advance-before-acta'],
    },
    {
      opDate: '2026-05-04',
      concept: 'Transferència factura F-2026-0110',
      conceptDetail: "Instal·lacions Exemple S.L.",
      amount: -575.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.installacions!.iban,
      linkedInvoiceId: 'inv-windows-1',
      plantTags: ['C4-split-a-payment'],
    },
    {
      opDate: '2026-05-07',
      concept: 'Transferència factura AI-2026-0301',
      conceptDetail: 'Ascensors Exemple S.A.',
      amount: -4598.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.ascensors!.iban,
      linkedInvoiceId: 'inv-elev-install-a',
      plantTags: ['C3-duplicate-a-payment'],
    },
    {
      opDate: '2026-05-08',
      concept: 'Transferència factura F-2026-0115',
      conceptDetail: "Instal·lacions Exemple S.L.",
      amount: -575.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.installacions!.iban,
      linkedInvoiceId: 'inv-windows-2',
      plantTags: ['C4-split-b-payment'],
    },
    {
      opDate: '2026-05-10',
      concept: 'Transferència factura CM-2026-0088',
      conceptDetail: 'Construccions Model S.L.',
      amount: -423.5,
      conceptoComun: '04',
      counterpartyIban: VENDORS.construccions!.iban,
      linkedInvoiceId: 'inv-masonry',
    },
    {
      opDate: '2026-05-12',
      concept: 'Transferència factura F-2026-0130',
      conceptDetail: "Instal·lacions Exemple S.L.",
      amount: -874.5,
      conceptoComun: '04',
      counterpartyIban: VENDORS.installacions!.iban,
      linkedInvoiceId: 'inv-windows-3',
    },
    {
      opDate: '2026-05-12',
      concept: 'Pagament targeta — Ferreteria Exemple',
      amount: -85.4,
      conceptoComun: '12',
    },
    {
      opDate: '2026-05-15',
      concept: 'Transferència factura AI-2026-0290',
      conceptDetail: 'Ascensors Exemple S.A.',
      amount: -544.5,
      conceptoComun: '04',
      counterpartyIban: VENDORS.ascensors!.iban,
      linkedInvoiceId: 'inv-elev-inspect',
    },
    {
      opDate: '2026-05-18',
      concept: 'Transferència manteniment jardí',
      conceptDetail: 'Jardineria Exemple',
      amount: -480.0,
      conceptoComun: '04',
      plantTags: ['D1R2-unmatched-debit'],
    },
    {
      opDate: '2026-05-20',
      concept: 'Reintegre caixer',
      amount: -1200.0,
      conceptoComun: '01',
      plantTags: ['D2-cash-withdrawal'],
    },
    {
      opDate: '2026-05-22',
      concept: 'Bizum — subministrament material neteja',
      amount: -150.0,
      conceptoComun: '12',
    },
    {
      opDate: '2026-05-27',
      concept: 'Transferència factura AI-2026-0344',
      conceptDetail: 'Ascensors Exemple S.A.',
      amount: -4598.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.ascensors!.iban,
      linkedInvoiceId: 'inv-elev-install-b',
      plantTags: ['C3-duplicate-b-payment'],
    },
    {
      opDate: '2026-05-29',
      concept: 'Rebut domiciliat assegurança comunitat',
      conceptDetail: 'Asseguradora Exemple',
      amount: -210.0,
      conceptoComun: '03',
      recurring: true,
    },
  ],
};

const JUNE: StatementPeriod = {
  id: 'statement-2026-06',
  periodFrom: '2026-06-01',
  periodTo: '2026-06-30',
  openingBalance: round2(impliedClosingOf(MAY)),
  movements: [
    // "3r 1a" deliberately has no June credit — planted D5/R6.
    ...derramaCredits('2026-06-02', '3r 1a'),
    {
      opDate: '2026-06-03',
      concept: 'Rebut domiciliat manteniment ascensor',
      conceptDetail: 'Ascensors Exemple S.A.',
      amount: -145.2,
      conceptoComun: '03',
      linkedInvoiceId: 'inv-elev-maint',
      recurring: true,
    },
    {
      opDate: '2026-06-04',
      concept: 'Comissió manteniment de compte',
      amount: -12.5,
      conceptoComun: '17',
    },
    {
      opDate: '2026-06-08',
      concept: 'Transferència factura FR-2026-0045',
      conceptDetail: 'Fusteria Referència S.L.',
      amount: -5082.0,
      conceptoComun: '04',
      counterpartyIban: FUSTERIA_IBAN_ACTUAL,
      linkedInvoiceId: 'inv-entrance-door',
      plantTags: ['B4B5-iban-mismatch-payment'],
    },
    {
      opDate: '2026-06-10',
      concept: 'Transferència factura F-2026-0142',
      conceptDetail: "Instal·lacions Exemple S.L.",
      amount: -1573.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.installacions!.iban,
      linkedInvoiceId: 'inv-intercom',
    },
    {
      opDate: '2026-06-12',
      concept: 'Transferència factura AR-2026-0012',
      conceptDetail: 'Arquitecte Tècnic Exemple',
      amount: -3180.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.arquitecte!.iban,
      linkedInvoiceId: 'inv-architect',
    },
    {
      opDate: '2026-06-15',
      concept: 'Transferència factura PM-2026-0077',
      conceptDetail: 'Pintures Mostra S.L.',
      amount: -2541.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.pintures!.iban,
      linkedInvoiceId: 'inv-paint',
    },
    {
      opDate: '2026-06-16',
      concept: 'Transferència factura NX-2026-0033',
      conceptDetail: 'Neteges Exemple S.L.',
      amount: -217.8,
      conceptoComun: '04',
      counterpartyIban: VENDORS.neteges!.iban,
      linkedInvoiceId: 'inv-cleaning',
    },
    {
      opDate: '2026-06-18',
      concept: 'Transferència honoraris administració',
      conceptDetail: 'Administracions Exemple S.L.',
      amount: -1089.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.administracio!.iban,
      linkedInvoiceId: 'inv-admin',
    },
    {
      opDate: '2026-06-20',
      concept: 'Pagament targeta — Electrodomèstics Exemple',
      amount: -62.3,
      conceptoComun: '12',
    },
    {
      opDate: '2026-06-22',
      concept: 'Bizum — quota associació de veïns',
      amount: -40.0,
      conceptoComun: '12',
    },
    {
      opDate: '2026-06-24',
      concept: 'Rebut domiciliat pòlissa de responsabilitat civil',
      conceptDetail: 'Asseguradora Exemple',
      amount: -180.0,
      conceptoComun: '03',
      recurring: true,
    },
    {
      opDate: '2026-06-26',
      concept: 'Rebut domiciliat subministrament elèctric zona comuna',
      amount: -280.0,
      conceptoComun: '03',
      recurring: true,
    },
    {
      opDate: '2026-06-28',
      concept: 'Rebut domiciliat subministrament aigua zona comuna',
      amount: -95.4,
      conceptoComun: '03',
      recurring: true,
    },
    {
      opDate: '2026-06-30',
      concept: 'Transferència factura CM-2026-0210',
      conceptDetail: 'Construccions Model S.L.',
      amount: -21780.0,
      conceptoComun: '04',
      counterpartyIban: VENDORS.construccions!.iban,
      linkedInvoiceId: 'inv-facade-progress',
      plantTags: ['A4-paid-exceeds-certified'],
    },
  ],
};

function impliedClosingOf(p: StatementPeriod): number {
  return p.openingBalance + p.movements.reduce((acc, m) => acc + m.amount, 0);
}

export function closingBalance(p: StatementPeriod): number {
  return round2(impliedClosingOf(p));
}

export const STATEMENTS: StatementPeriod[] = [MAY, JUNE];

// ---------------------------------------------------------------------------------------
// Rendering: PDF
// ---------------------------------------------------------------------------------------

export async function renderStatementPdf(p: StatementPeriod, index: number): Promise<Uint8Array> {
  const doc = await Doc.create({
    title: `Extracte bancari ${p.periodFrom} — ${p.periodTo}`,
    author: COMMUNITY.bankName,
    subject: 'Extracte de compte',
    isoDate: p.periodTo,
  });

  doc.text(COMMUNITY.bankName, { font: doc.fonts.bold, size: 15 });
  doc.moveDown(20);
  doc.paragraph(`Titular: ${COMMUNITY.name} (${COMMUNITY.nif})`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`IBAN: ${COMMUNITY.iban}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`Període: ${frDate(p.periodFrom)} — ${frDate(p.periodTo)}`, {
    size: 9,
    maxWidth: doc.width - 2 * doc.margin,
  });
  doc.moveDown(4);
  doc.hr();
  doc.moveDown(14);

  doc.text(`Saldo inicial: ${eur(p.openingBalance)}`, { font: doc.fonts.bold, size: 10 });
  doc.moveDown(18);

  const cols = [
    { header: 'Data op.', width: 54 },
    { header: 'Data val.', width: 54 },
    { header: 'Concepte', width: 232 },
    { header: 'Import', width: 78, align: 'right' as const },
    { header: 'Saldo', width: 78, align: 'right' as const },
  ];

  let running = p.openingBalance;
  const rows = p.movements.map((m) => {
    running = round2(running + m.amount);
    const concept = m.conceptDetail ? `${m.concept} — ${m.conceptDetail}` : m.concept;
    return [frDate(m.opDate), frDate(m.valueDate ?? m.opDate), concept, num(m.amount), num(running)];
  });
  doc.table(cols, rows, { rowHeight: 15, fontSize: 8.5, zebra: true });

  doc.moveDown(10);
  doc.hr(210);
  doc.moveDown(4);
  doc.text(`Saldo final (${frDate(p.periodTo)}): ${eur(closingBalance(p))}`, { font: doc.fonts.bold, size: 11 });

  doc.footer(`${COMMUNITY.bankName} — extracte ${index + 1}/${STATEMENTS.length} — ${p.id}`);
  return doc.bytes();
}

function frDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------------------
// Rendering: Norma 43
// ---------------------------------------------------------------------------------------

export function toNorma43(p: StatementPeriod): string {
  const account: N43WriteAccount = {
    entidad: COMMUNITY_BANK.entidad,
    oficina: COMMUNITY_BANK.oficina,
    cuenta: COMMUNITY_BANK.cuenta,
    periodFrom: p.periodFrom,
    periodTo: p.periodTo,
    openingBalance: p.openingBalance,
    holderName: COMMUNITY.name,
    movements: p.movements.map((m) => ({
      opDate: m.opDate,
      valueDate: m.valueDate,
      conceptoComun: m.conceptoComun,
      conceptoPropio: '',
      amount: m.amount,
      documentNumber: m.documentNumber ?? '',
      ref1: m.unitLabel ?? '',
      ref2: '',
      concepts: [m.concept, m.conceptDetail ?? ''],
    })),
  };
  return writeNorma43([account]);
}

// ---------------------------------------------------------------------------------------
// Rendering: CSV
// ---------------------------------------------------------------------------------------

function csvField(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
function csvAmount(n: number): string {
  return num(n); // Spanish-notation decimal comma, as a real bank export would use
}

export function toCsv(p: StatementPeriod): string {
  const header = [
    'Fecha operación',
    'Fecha valor',
    'Concepto',
    'Concepto ampliado',
    'Importe',
    'Saldo',
    'Referencia',
  ]
    .map(csvField)
    .join(';');
  let running = p.openingBalance;
  const lines = [header];
  for (const m of p.movements) {
    running = round2(running + m.amount);
    lines.push(
      [
        csvField(frDate(m.opDate)),
        csvField(frDate(m.valueDate ?? m.opDate)),
        csvField(m.concept),
        csvField(m.conceptDetail ?? ''),
        csvAmount(m.amount),
        csvAmount(running),
        csvField(m.unitLabel ?? m.documentNumber ?? ''),
      ].join(';'),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
