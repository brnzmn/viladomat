/**
 * The two meeting minutes (actas): one ordinary (accounts, budget, derrama continuation,
 * attendance by unit label + quota) and one extraordinary (works approval + a delegation to
 * the president role, with recorded vote counts). Everything here is clean — no planted
 * discrepancy targets an acta directly — except that the extraordinary meeting's date is the
 * anchor the planted "payment 10 days before the approving acta" (D4/E2) is measured against.
 */
import { Doc, MUTED } from './pdfdraw.ts';
import { COMMUNITY, PRESIDENT_UNIT, UNITS } from './fixtures.ts';
import { eur, num } from './money.ts';

export type Attendance = 'present' | 'represented' | 'absent';

export interface AttendanceRow {
  unit: string;
  quotaPct: number;
  status: Attendance;
}

export interface VoteTally {
  favorUnits: number;
  favorQuotaPct: number;
  contraUnits: number;
  contraQuotaPct: number;
  abstencioUnits: number;
  abstencioQuotaPct: number;
}

export interface Resolution {
  punto: string;
  kind: 'accounts' | 'budget' | 'derrama' | 'works_approval' | 'delegation' | 'other';
  worksPackage?: string;
  importeAprobado?: number;
  delegationToRole?: string;
  delegationScope?: string;
  votes?: VoteTally;
  textoLiteral: string;
  pageNo: number;
}

export interface ActaSpec {
  id: string;
  tipo: 'ordinaria' | 'extraordinaria';
  language: 'es' | 'ca';
  fecha: string; // ISO
  hora: string;
  lugar: string;
  convenedByRole: string;
  convocationNoticeDate?: string; // extraordinaria: shows E6 >=8-day compliance
  attendance: AttendanceRow[];
  resolutions: Resolution[];
  signedDate: string;
  sentDate: string;
}

function quotaOf(status: Attendance, rows: AttendanceRow[]): number {
  return rows.filter((r) => r.status === status).reduce((a, r) => a + r.quotaPct, 0);
}

// ---------------------------------------------------------------------------------------
// Ordinaria — Catalan
// ---------------------------------------------------------------------------------------

const ORDINARIA_ATTENDANCE: AttendanceRow[] = UNITS.map((u) => {
  const absent: Record<string, Attendance> = { '2n 2a': 'absent' };
  const represented: Record<string, Attendance> = { 'Bxs 2a': 'represented', '1r 2a': 'represented' };
  const status: Attendance = absent[u.label] ?? represented[u.label] ?? 'present';
  return { unit: u.label, quotaPct: u.quotaPct, status };
});

export const ACTA_ORDINARIA: ActaSpec = {
  id: 'acta-ordinaria-2026-03-30',
  tipo: 'ordinaria',
  language: 'ca',
  fecha: '2026-03-30',
  hora: '19:00',
  lugar: "Despatx de l'administrador, Carrer de l'Administració 14, 08013 Barcelona",
  convenedByRole: 'president',
  attendance: ORDINARIA_ATTENDANCE,
  resolutions: [
    {
      punto: '1',
      kind: 'accounts',
      textoLiteral:
        "S'aprova la liquidació d'ingressos i despeses de l'exercici 2025, amb un resultat favorable de 5.180,40 €. El fons de reserva a 31/12/2025 és de 7.200,00 €.",
      pageNo: 1,
    },
    {
      punto: '2',
      kind: 'budget',
      importeAprobado: 6850.0,
      textoLiteral: "S'aprova el pressupost ordinari per a l'exercici 2026, per import de 6.850,00 €.",
      pageNo: 1,
    },
    {
      punto: '3',
      kind: 'derrama',
      importeAprobado: 60.0,
      textoLiteral:
        "Es manté la quota extraordinària de 60,00 €/mes per unitat per finançar les obres en curs (ascensor, façana posterior, escala, porta d'entrada, videoporter i pintura interior), sense modificacions.",
      pageNo: 2,
      votes: { favorUnits: 11, favorQuotaPct: 81.5, contraUnits: 1, contraQuotaPct: 8.5, abstencioUnits: 1, abstencioQuotaPct: 9.25 },
    },
    {
      punto: '4',
      kind: 'other',
      textoLiteral: 'Precs i preguntes. No es proposen acords.',
      pageNo: 2,
    },
  ],
  signedDate: '2026-04-02',
  sentDate: '2026-04-07',
};

// ---------------------------------------------------------------------------------------
// Extraordinària — Spanish
// ---------------------------------------------------------------------------------------

const EXTRA_ATTENDANCE: AttendanceRow[] = UNITS.map((u) => {
  const absent: Record<string, Attendance> = { 'Entl 2a': 'absent', '3r 1a': 'absent' };
  const represented: Record<string, Attendance> = { 'Sot 2': 'represented', 'Bxs 2a': 'represented' };
  const status: Attendance = absent[u.label] ?? represented[u.label] ?? 'present';
  return { unit: u.label, quotaPct: u.quotaPct, status };
});

export const ACTA_EXTRAORDINARIA: ActaSpec = {
  id: 'acta-extraordinaria-2026-05-14',
  tipo: 'extraordinaria',
  language: 'es',
  fecha: '2026-05-14',
  hora: '19:00',
  lugar: 'Despacho del administrador, Carrer de l\'Administració 14, 08013 Barcelona',
  convenedByRole: 'president',
  convocationNoticeDate: '2026-05-01',
  attendance: EXTRA_ATTENDANCE,
  resolutions: [
    {
      punto: '1',
      kind: 'works_approval',
      worksPackage: 'REAR_FACADE',
      importeAprobado: 50820.0,
      textoLiteral:
        'Se aprueba la ejecución de las obras de rehabilitación de la fachada posterior y balcones, adjudicadas a Construccions Model S.L. por un precio de 50.820,00 € (IVA incluido), con inicio previsto en las semanas siguientes.',
      pageNo: 1,
      votes: { favorUnits: 10, favorQuotaPct: 72.75, contraUnits: 1, contraQuotaPct: 9.25, abstencioUnits: 0, abstencioQuotaPct: 0 },
    },
    {
      punto: '2',
      kind: 'delegation',
      worksPackage: 'REAR_FACADE',
      delegationToRole: 'president',
      delegationScope: "Selección final entre los presupuestos presentados y firma del contrato de obras de la fachada posterior y balcones, en las condiciones aprobadas en el punto anterior",
      textoLiteral:
        'Se delega en el/la presidente/a la selección final entre los presupuestos presentados y la firma del contrato de obras en las condiciones aprobadas en el punto anterior.',
      pageNo: 2,
      votes: { favorUnits: 10, favorQuotaPct: 72.75, contraUnits: 0, contraQuotaPct: 0, abstencioUnits: 1, abstencioQuotaPct: 9.25 },
    },
  ],
  signedDate: '2026-05-17',
  sentDate: '2026-05-21',
};

export const ACTAS: ActaSpec[] = [ACTA_ORDINARIA, ACTA_EXTRAORDINARIA];

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

const T = {
  es: {
    title: (t: string) => (t === 'ordinaria' ? 'ACTA DE LA REUNIÓN ORDINARIA' : 'ACTA DE LA REUNIÓN EXTRAORDINARIA'),
    subtitle: 'Comunidad de Propietarios',
    date: 'Fecha', time: 'Hora', place: 'Lugar', convenedBy: 'Convocada por', notice: 'Convocatoria enviada el',
    attendance: 'Asistencia', unit: 'Unidad', quota: 'Cuota %', status: 'Asistencia',
    present: 'Presente', represented: 'Representado', absent: 'Ausente',
    quorumLine: (q: number) => `Quórum: ${num(q)}% de las cuotas presentes o representadas.`,
    agenda: 'Acuerdos', point: 'Punto', votesLine: (v: VoteTally) =>
      `Votos — a favor: ${v.favorUnits} unidad(es) (${num(v.favorQuotaPct)}%); en contra: ${v.contraUnits} (${num(v.contraQuotaPct)}%); abstenciones: ${v.abstencioUnits} (${num(v.abstencioQuotaPct)}%).`,
    signed: 'Firmada el', sent: 'Remitida a los propietarios el', president: 'Presidente/a (cargo)', secretary: 'Administrador/a — secretario/a (cargo)',
  },
  ca: {
    title: (t: string) => (t === 'ordinaria' ? 'ACTA DE LA REUNIÓ ORDINÀRIA' : 'ACTA DE LA REUNIÓ EXTRAORDINÀRIA'),
    subtitle: 'Comunitat de Propietaris',
    date: 'Data', time: 'Hora', place: 'Lloc', convenedBy: 'Convocada per', notice: 'Convocatòria enviada el',
    attendance: 'Assistència', unit: 'Unitat', quota: 'Quota %', status: 'Assistència',
    present: 'Present', represented: 'Delegat', absent: 'Absent',
    quorumLine: (q: number) => `Quòrum: ${num(q)}% de les quotes presents o representades.`,
    agenda: 'Acords', point: 'Punt', votesLine: (v: VoteTally) =>
      `Vots — a favor: ${v.favorUnits} unitat(s) (${num(v.favorQuotaPct)}%); en contra: ${v.contraUnits} (${num(v.contraQuotaPct)}%); abstencions: ${v.abstencioUnits} (${num(v.abstencioQuotaPct)}%).`,
    signed: 'Signada el', sent: 'Tramesa als propietaris el', president: 'President/a (càrrec)', secretary: "Administrador/a — secretari/ària (càrrec)",
  },
} as const;

function frDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

const KIND_LABEL: Record<Resolution['kind'], { es: string; ca: string }> = {
  accounts: { es: 'Aprobación de cuentas', ca: 'Aprovació de comptes' },
  budget: { es: 'Aprobación de presupuesto', ca: 'Aprovació de pressupost' },
  derrama: { es: 'Derrama extraordinaria', ca: 'Derrama extraordinària' },
  works_approval: { es: 'Aprobación de obras', ca: "Aprovació d'obres" },
  delegation: { es: 'Delegación', ca: 'Delegació' },
  other: { es: 'Otros', ca: 'Altres' },
};

export async function renderActa(spec: ActaSpec): Promise<Uint8Array> {
  const t = T[spec.language];
  const doc = await Doc.create({
    title: t.title(spec.tipo),
    author: COMMUNITY.name,
    subject: 'Acta de reunió',
    isoDate: spec.fecha,
  });

  doc.text(t.title(spec.tipo), { font: doc.fonts.bold, size: 15 });
  doc.moveDown(20);
  doc.paragraph(`${t.subtitle}: ${COMMUNITY.name} (${COMMUNITY.nif})`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.date}: ${frDate(spec.fecha)} — ${t.time}: ${spec.hora}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.place}: ${spec.lugar}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.convenedBy}: ${spec.convenedByRole}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  if (spec.convocationNoticeDate) {
    doc.paragraph(`${t.notice}: ${frDate(spec.convocationNoticeDate)}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  }
  doc.moveDown(6);
  doc.hr();
  doc.moveDown(14);

  doc.text(t.attendance, { font: doc.fonts.bold, size: 11 });
  doc.moveDown(16);
  const cols = [
    { header: t.unit, width: 140 },
    { header: t.quota, width: 90, align: 'right' as const },
    { header: t.status, width: 269 },
  ];
  const rows = spec.attendance.map((r) => [
    r.unit + (r.unit === PRESIDENT_UNIT ? ' (president)' : ''),
    num(r.quotaPct),
    r.status === 'present' ? t.present : r.status === 'represented' ? t.represented : t.absent,
  ]);
  doc.table(cols, rows, { rowHeight: 15, fontSize: 9, zebra: true });
  doc.moveDown(6);
  const quorum = quotaOf('present', spec.attendance) + quotaOf('represented', spec.attendance);
  doc.text(t.quorumLine(quorum), { size: 9, color: MUTED });
  doc.moveDown(20);

  doc.text(t.agenda, { font: doc.fonts.bold, size: 12 });
  doc.moveDown(18);
  for (const r of spec.resolutions) {
    doc.ensureSpace(60);
    const label = KIND_LABEL[r.kind][spec.language];
    doc.text(`${t.point} ${r.punto} — ${label} (p. ${r.pageNo})`, { font: doc.fonts.bold, size: 10 });
    doc.moveDown(14);
    doc.paragraph(`«${r.textoLiteral}»`, { size: 9.5, maxWidth: doc.width - 2 * doc.margin, font: doc.fonts.italic });
    if (r.importeAprobado != null) {
      doc.paragraph(`Import: ${eur(r.importeAprobado)}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
    }
    if (r.votes) {
      doc.paragraph(t.votesLine(r.votes), { size: 9, maxWidth: doc.width - 2 * doc.margin, color: MUTED });
    }
    doc.moveDown(10);
  }

  doc.moveDown(10);
  doc.hr();
  doc.moveDown(14);
  doc.paragraph(`${t.signed}: ${frDate(spec.signedDate)}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.paragraph(`${t.sent}: ${frDate(spec.sentDate)}`, { size: 9, maxWidth: doc.width - 2 * doc.margin });
  doc.moveDown(20);
  doc.text(`__________________________          __________________________`, { size: 10 });
  doc.moveDown(14);
  doc.text(t.president, { size: 9, color: MUTED });
  doc.drawAt(doc.margin + 260, doc.y, t.secretary, { size: 9, color: MUTED });

  doc.footer(`${COMMUNITY.name} — ${spec.id}`);
  return doc.bytes();
}
