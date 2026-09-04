/**
 * Rendering primitives shared by the auditor pack, the lawyer annex and the data-room index.
 *
 * Two properties matter more than looks:
 *
 *  - **Determinism.** Number and date formatting is written out by hand rather than delegated
 *    to `Intl`, so the same run renders the same bytes on any machine and ICU version. Every
 *    list the packs print is ordered explicitly by the caller.
 *  - **A canonical body.** The rendered document keeps its volatile parts (generation
 *    timestamp, output paths) inside `<header class="pack-header">` and everything reproducible
 *    inside `<main id="pack-body">`. `canonicalSha256` hashes that element alone, which is what
 *    `vx report --reproduce` compares and what `report_exports.canonical_sha256` stores.
 */
import { createHash } from 'node:crypto';
import type { Lang } from './i18n.ts';
import { m6Strings } from './i18n.ts';

export const CANONICAL_BODY_ID = 'pack-body';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fixed money formatting, independent of the host's ICU data:
 * `1.234,56 €` in Spanish, `€1,234.56` in English.
 */
export function fmtMoney(value: unknown, lang: Lang): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100).toString();
  const frac = (cents % 100).toString().padStart(2, '0');
  const groupSep = lang === 'es' ? '.' : ',';
  const decSep = lang === 'es' ? ',' : '.';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const body = `${grouped}${decSep}${frac}`;
  return lang === 'es' ? `${neg ? '−' : ''}${body} €` : `${neg ? '−' : ''}€${body}`;
}

/** Percentage with one decimal, same fixed formatting rules. */
export function fmtPct(value: unknown, lang: Lang, digits = 1): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(digits);
  return `${lang === 'es' ? fixed.replace('.', ',') : fixed} %`;
}

/** Plain integer with thousands separators. */
export function fmtInt(value: unknown, lang: Lang): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'es' ? '.' : ',');
}

/** ISO date, never a locale rendering: dates in a pack are references, not prose. */
export function fmtDate(value: unknown): string {
  if (value == null || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** A cell already containing markup starts with `<`; everything else is escaped. */
function cell(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.startsWith('<') ? s : esc(s);
}

export function table(cols: readonly string[], rows: readonly unknown[][], none: string): string {
  if (rows.length === 0) return `<p class="muted">${esc(none)}</p>`;
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function dl(pairs: ReadonlyArray<readonly [string, unknown]>): string {
  if (pairs.length === 0) return '';
  return `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${cell(v)}</dd>`).join('')}</dl>`;
}

export function h2(id: string, heading: string): string {
  return `<h2 id="${esc(id)}">${esc(heading)}</h2>`;
}

export function h3(heading: string): string {
  return `<h3>${esc(heading)}</h3>`;
}

export function note(text: string): string {
  return `<p class="note">${esc(text)}</p>`;
}

export function muted(text: string): string {
  return `<p class="muted">${esc(text)}</p>`;
}

export interface EvidenceRefParts {
  documentId?: string | null;
  pageNo?: number | null;
  runId?: string | null;
  ruleCode?: string | null;
  ruleVersion?: number | null;
  benchmarkRecordId?: string | null;
  parameterVersion?: number | null;
  fileSha256?: string | null;
}

/**
 * The reference every figure carries:
 * `[D-<doc8> p.<n> · run <run8> · rule <code>@v<n> · bm <rec8> · par v<n>]`.
 * Parts that are unknown are omitted rather than printed empty.
 */
export function evidenceRef(parts: EvidenceRefParts): string {
  const bits: string[] = [];
  if (parts.documentId) bits.push(`D-${parts.documentId.slice(0, 8)}`);
  if (parts.pageNo != null) bits.push(`p.${parts.pageNo}`);
  if (parts.fileSha256) bits.push(`sha ${parts.fileSha256.slice(0, 8)}`);
  if (parts.runId) bits.push(`run ${parts.runId.slice(0, 8)}`);
  if (parts.ruleCode) bits.push(`rule ${parts.ruleCode}${parts.ruleVersion != null ? `@v${parts.ruleVersion}` : ''}`);
  if (parts.benchmarkRecordId) bits.push(`bm ${parts.benchmarkRecordId.slice(0, 8)}`);
  if (parts.parameterVersion != null) bits.push(`par v${parts.parameterVersion}`);
  return bits.length === 0 ? '' : `[${bits.join(' · ')}]`;
}

/**
 * The detection scope-and-limits text, printed unchanged at the start of every distributed
 * pack (`docs/rule-catalog.md` §9). It is the honest statement of what community records can
 * and cannot show.
 */
export const SCOPE_AND_LIMITS: Record<Lang, string> = {
  es:
    'Este informe se basa exclusivamente en la documentación de la Comunidad puesta a disposición de los propietarios solicitantes y en registros públicos. ' +
    'A partir de esa documentación es posible comprobar: la correspondencia entre facturas, pagos bancarios, liquidaciones, contratos, certificaciones y acuerdos de junta; ' +
    'la continuidad de los saldos y la custodia de los fondos en cuentas a nombre de la Comunidad; la aplicación de derramas, subvenciones y préstamos; la existencia de los ' +
    'documentos obligatorios; y determinados datos registrales de las empresas contratadas y sus coincidencias con datos de los cargos de la Comunidad. ' +
    'No es posible comprobar, a partir de esta documentación: pagos o compensaciones realizados fuera de las cuentas de la Comunidad; la identidad real de las personas que ' +
    'controlan una sociedad cuando los cargos registrales son personas interpuestas; acuerdos verbales; ni la calidad o el grado de ejecución real de las obras, salvo por lo ' +
    'que resulte de las certificaciones y de fotografías fechadas. La ausencia de discrepancias en una prueba no acredita la regularidad de la partida correspondiente; la ' +
    'presencia de una discrepancia no acredita irregularidad alguna hasta que se verifique. Para las cuestiones no comprobables se indica, en cada caso, la prueba externa que ' +
    'sería necesaria: la contabilidad del proveedor, la nota informativa del Registro Mercantil, el diario de obra de la dirección facultativa, la confirmación de los ' +
    'licitadores no adjudicatarios, el certificado bancario de titularidad y personas autorizadas, o el expediente municipal o de subvención.',
  en:
    "This report relies exclusively on the Community's records made available to the requesting owners and on public registries. " +
    'From those records it is possible to check: the correspondence between invoices, bank payments, liquidations, contracts, certifications and assembly resolutions; ' +
    "the continuity of balances and the custody of funds in accounts held in the Community's name; the application of extraordinary contributions, subsidies and loans; " +
    "the existence of mandatory documents; and certain registry data of the contracted companies and their coincidences with data of the Community's office-holders. " +
    'It is not possible to check, from these records: payments or set-offs made outside the Community\'s accounts; the real identity of the persons controlling a company ' +
    'when the registered officers are nominees; verbal agreements; or the quality or actual degree of execution of the works, beyond what follows from certifications and ' +
    'dated photographs. The absence of discrepancies in a test does not establish the regularity of the corresponding item; the presence of a discrepancy does not establish ' +
    'any irregularity until it is verified. For the matters that cannot be checked, the external evidence that would be required is stated in each case: the vendor\'s own ' +
    'accounts, a Registro Mercantil information note, the site director\'s diary, confirmation from the unsuccessful bidders, the bank\'s certificate of account holder and ' +
    'authorised persons, or the municipal or subsidy file.',
};

export function scopeAndLimits(lang: Lang): string {
  const t = m6Strings(lang);
  return `${h3(t.scopeLimitsHeading)}<div class="scope">${esc(SCOPE_AND_LIMITS[lang])}</div>`;
}

const PACK_CSS = `
  body{font-family:Georgia,'Times New Roman',serif;font-size:11pt;line-height:1.4;margin:2cm;color:#111}
  h1{font-size:18pt;margin:0 0 .2em} h2{font-size:14pt;margin:1.6em 0 .4em;border-bottom:1px solid #999;padding-bottom:.2em}
  h3{font-size:12pt;margin:1em 0 .3em} h4{font-size:11pt;margin:.9em 0 .2em}
  .banner{border:1px solid #b00;color:#b00;padding:.5em .8em;margin:1em 0;font-family:Helvetica,Arial,sans-serif;font-size:9.5pt}
  .audience{border:1px solid #333;padding:.5em .8em;margin:1em 0;font-family:Helvetica,Arial,sans-serif;font-size:9.5pt}
  .scope,.note,.method{background:#f4f4f4;padding:.6em .8em;font-size:9.5pt}
  table{border-collapse:collapse;width:100%;margin:.4em 0;font-size:9pt} th,td{border:1px solid #bbb;padding:.3em .4em;vertical-align:top;text-align:left}
  th{background:#eee} blockquote{margin:.3em 0;font-style:italic;border-left:3px solid #999;padding-left:.8em}
  dl{display:grid;grid-template-columns:max-content 1fr;gap:.2em 1em} dt{font-weight:bold}
  .muted{color:#666;font-style:italic} .headline{font-size:13pt;font-weight:bold;margin:.4em 0}
  .finding{border:1px solid #ccc;padding:.6em .8em;margin:.8em 0;break-inside:avoid}
  .ref{font-family:'DejaVu Sans Mono',Menlo,monospace;font-size:8.5pt;color:#444}
  .pack-header{font-family:Helvetica,Arial,sans-serif;font-size:9pt;color:#333;border-bottom:1px solid #ccc;padding-bottom:.5em;margin-bottom:1em}
  footer{margin-top:2em;font-size:8.5pt;color:#555;font-family:Helvetica,Arial,sans-serif}
  @page{size:A4;margin:1.5cm}
`;

export interface PackDocumentOptions {
  lang: Lang;
  /** browser/PDF title; may carry the generation date, it is outside the canonical body */
  title: string;
  /** volatile lines: generated on, output paths, run ids */
  headerLines: ReadonlyArray<readonly [string, string]>;
  /** everything reproducible, in order */
  body: string;
}

/**
 * Wrap sections in the pack shell. Everything volatile stays in `<header>`; the canonical hash
 * covers `<main id="pack-body">` only, so two runs over the same data agree byte for byte.
 */
export function packDocument(opts: PackDocumentOptions): string {
  const header = opts.headerLines.map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(v)}</div>`).join('');
  return `<!doctype html>
<html lang="${opts.lang}"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
<style>${PACK_CSS}</style></head><body>
<header class="pack-header">${header}</header>
<main id="${CANONICAL_BODY_ID}">${opts.body}</main>
</body></html>`;
}

/**
 * The canonical part of a rendered pack: the `<main id="pack-body">` element with its tags.
 * Throws when the document was not built by `packDocument`, because hashing the wrong span
 * would silently make `--reproduce` meaningless.
 */
export function extractCanonicalBody(html: string): string {
  const open = html.indexOf(`<main id="${CANONICAL_BODY_ID}">`);
  const close = html.lastIndexOf('</main>');
  if (open < 0 || close < 0 || close < open) throw new Error('the document has no canonical body element');
  return html.slice(open, close + '</main>'.length);
}

/** SHA-256 of the canonical body. This is what `report_exports.canonical_sha256` stores. */
export function canonicalSha256(html: string): string {
  return createHash('sha256').update(extractCanonicalBody(html), 'utf8').digest('hex');
}

/** SHA-256 of arbitrary bytes or text, used for PDF, CSV and manifest hashes. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The gate statistics block every distributed pack prints about itself. */
export function gateStatsBlock(
  lang: Lang,
  stats: { findings_distributed: number; withheld_pending_reply: number; withheld_pending_legal_source: number; annex_only: number },
): string {
  const t = m6Strings(lang);
  return (
    h3(t.gatesHeading) +
    dl([
      [t.gateStatsDistributed, fmtInt(stats.findings_distributed, lang)],
      [`${t.gateStatsWithheldReply} (${t.gatePendingReply})`, fmtInt(stats.withheld_pending_reply, lang)],
      [t.gateStatsWithheldLegal, fmtInt(stats.withheld_pending_legal_source, lang)],
      [t.gateStatsAnnex, fmtInt(stats.annex_only, lang)],
    ]) +
    note(t.gatePendingReplyNote)
  );
}
