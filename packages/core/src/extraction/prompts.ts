/**
 * Versioned prompts of the extraction module.
 *
 * Every string here is a transcription instruction: what to copy, how to normalise it, when to
 * return null, how to cite the page. Nothing here describes what anyone expects to find in the
 * documents. Keep the system prompts byte-stable between deployments (they are cached with a
 * 1-hour TTL and are part of `prompt_version`); bump {@link PROMPT_VERSION} when they change.
 */
import { DOC_TYPES, type DocType, type Language, type SchemaKey } from './types.ts';

/** Bump when any prompt text changes. Recorded on every `extraction_runs` row. */
export const PROMPT_VERSION = 'p1';
/** Bump when any schema shape changes. Part of the batch `custom_id`. */
export const SCHEMA_VERSION = 's1';

/** Label written before each page image. `n` is the 0-based page index. */
export const pageLabel = (index: number): string => `Page ${index}:`;
/** Label of a preceding context page in the classifier window. */
export const contextPrevLabel = (index: number): string => `Context (previous) page ${index}:`;
/** Label of a following context page in the classifier window. */
export const contextNextLabel = (index: number): string => `Context (next) page ${index}:`;

/** Catalan / Spanish vocabulary the model will meet, with the meaning used by the schemas. */
export const GLOSSARY: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['factura / factura', 'invoice'],
  ['factura simplificada', 'simplified invoice (ticket, no recipient block)'],
  ['factura rectificativa / abonament / abono', 'rectifying or credit invoice'],
  ['pressupost / presupuesto', 'quote or budget'],
  ['partida', 'item of a quote, certification or budget'],
  ['capítol / capítulo', 'chapter (group of items)'],
  ['PEM (pressupost d\'execució material)', 'material execution budget, sum of chapters'],
  ['GG (despeses generals / gastos generales)', 'overheads percentage on PEM'],
  ['BI (benefici industrial / beneficio industrial)', 'contractor margin percentage on PEM'],
  ['pressupost de contracta / presupuesto de contrata', 'contract price before VAT (PEM + GG + BI)'],
  ['partida alçada / partida alzada (PA)', 'lump sum without quantity × unit price'],
  ['certificació d\'obra / certificación de obra', 'works certification'],
  ['a origen', 'cumulative amount since the start of the works'],
  ['anterior', 'amount certified in previous certifications'],
  ['actual / present', 'amount certified in this period'],
  ['retenció de garantia / retención de garantía', 'retention withheld as guarantee'],
  ['derrama', 'extraordinary levy on the owners'],
  ['quota / cuota', 'owner\'s periodic contribution'],
  ['coeficient / coeficiente (de participació)', 'participation quota of a unit, in percent'],
  ['entitat / entidad / departament', 'unit of the building (flat, premises, parking)'],
  ['rebut / recibo', 'receipt; on bank statements, a direct-debit item'],
  ['liquidació / liquidación (de comptes / de cuentas)', 'annual statement of accounts'],
  ['ingressos / ingresos', 'income'],
  ['despeses / gastos', 'expenses'],
  ['saldo', 'balance'],
  ['fons de reserva / fondo de reserva', 'reserve fund'],
  ['romanent / remanente', 'carry-over balance'],
  ['deutors / deudores', 'owners with pending amounts'],
  ['creditors / acreedores', 'creditors, pending invoices'],
  ['acta', 'minutes of an owners\' meeting'],
  ['junta (ordinària / extraordinària)', 'owners\' meeting'],
  ['convocatòria / convocatoria', 'notice calling a meeting'],
  ['ordre del dia / orden del día', 'agenda'],
  ['acord / acuerdo', 'resolution adopted'],
  ['unanimitat / unanimidad; per majoria / por mayoría', 'vote outcome wording'],
  ['delegació / delegación', 'delegation of authority to a role'],
  ['president/a, vicepresident/a, secretari/ària, administrador/a de finques, vocal', 'offices of the community'],
  ['extracte / extracto (bancari / bancario)', 'bank statement'],
  ['càrrec / cargo / adeudo', 'debit (negative amount)'],
  ['abonament / abono / ingrés', 'credit (positive amount)'],
  ['saldo anterior / saldo inicial', 'opening balance'],
  ['saldo final / saldo actual', 'closing balance'],
  ['data valor / fecha valor', 'value date'],
  ['concepte / concepto', 'concept text of a movement'],
  ['domiciliació / domiciliación', 'direct debit'],
  ['transferència / transferencia', 'bank transfer'],
  ['IVA', 'VAT'],
  ['IRPF (retenció / retención)', 'income-tax withholding on the invoice'],
  ['base imposable / base imponible', 'taxable base'],
  ['quota d\'IVA / cuota de IVA', 'VAT amount'],
  ['suplits / suplidos', 'amounts paid on behalf of the client, outside the VAT base'],
  ['inversió del subjecte passiu / inversión del sujeto pasivo', 'reverse-charge mention'],
  ['venciment / vencimiento', 'due date'],
  ['forma de pagament / forma de pago', 'payment method'],
  ['NIF / CIF / DNI / NIE', 'tax identifiers (DNI/NIE belong to natural persons)'],
  ['IBAN / CCC', 'bank account identifiers'],
  ['manuscrit / manuscrito', 'handwritten'],
  ['il·legible / ilegible', 'illegible'],
  ['segell / sello; signatura / firma', 'stamp; signature'],
]);

function glossaryText(): string {
  return GLOSSARY.map(([term, meaning]) => `- ${term} → ${meaning}`).join('\n');
}

/**
 * System prompt of every document extraction. Stable text; the document type specific part is sent
 * as the user instruction after the images so that this block is shared across document types.
 */
export const EXTRACTION_SYSTEM_PROMPT: string = [
  'You transcribe documents of an owners\' community in Catalonia (comunitat de propietaris) into a JSON object that follows the schema supplied with the request. You are a transcriber: you copy what is printed; you do not interpret it, complete it or evaluate it.',
  '',
  '## What you receive',
  'Photographs, scans and PDF pages in Spanish or Catalan (often mixed): invoices, quotes, works certifications, contracts, bank statements, annual accounts of the administrator, minutes of owners\' meetings, levy notices and receipts. Each page image is preceded by the label "Page n:" where n is the 0-based page index. The instruction after the images names the document type expected and gives field-specific guidance.',
  '',
  '## Glossary (Catalan / Spanish → meaning used by the schema)',
  glossaryText(),
  '',
  '## Rules',
  '1. Transcribe verbatim. Copy every value exactly as printed. Never compute, complete, round or correct a value. If a total is not printed it is null, even when it could be calculated from other figures.',
  '2. Null over guess. When a field is not on the document, is illegible, or you cannot tell which printed value belongs to it, return null (or an empty array) and describe the doubt in `notes`. Do not fill from context and do not assume a usual value.',
  '3. Numbers. Number fields hold normalised numbers: dot as decimal separator, no thousands separator, no currency symbol or percent sign ("1.234,56 €" → 1234.56; "1 234,56" → 1234.56; "12,5 %" → 12.5). The text exactly as printed goes into `evidence[].quote`. Amounts on bank statements are signed: debits (càrrecs / cargos) negative, credits (abonaments / abonos) positive.',
  '4. Dates. Date fields hold ISO `yyyy-mm-dd`. "3 de març de 2023", "03/03/23" and "3-3-2023" all become 2023-03-03. When a row prints only day and month, take the year from the page header or the statement period; when no year is available anywhere, return null and say so in `notes`.',
  '5. Text. Keep the original language, spelling, abbreviations and capitalisation. Do not translate.',
  '6. Handwriting. Mark handwritten content (`es_manuscrito`, `anotaciones_manuscritas`). When a printed value and a handwritten value exist for the same field, the field holds the printed value and the handwritten one goes to `anotaciones_manuscritas`.',
  '7. Evidence. For every monetary field (amounts, totals, rates, balances), every identity field (document numbers, dates, NIF/CIF, IBAN, names of legal entities) and every unit label, add one item to `evidence[]`: `field_path` as a dot path with 0-based indexes (`total_factura`, `lineas[3].base`, `movimientos[12].importe`); `page_index` equal to the n of the "Page n:" label; `bbox` as [x0, y0, x1, y1] pixel coordinates of that page image as sent (origin top-left, x0 < x1, y0 < y1, tight around the printed value, null when you cannot locate it); `quote` exactly as printed; `confidence` between 0 and 1. Rows that carry their own `page_index` and `bbox` (bank movements, agenda items, account lines) do not need one evidence item per cell.',
  '8. Persons. Natural persons are never transcribed by name. Refer to them by role (president, secretary, administrator, owner, representative, technician) or by unit label ("3r 2a", "Pral 1a", "local 2"). Do not transcribe DNI/NIE numbers, personal phone numbers, personal e-mail addresses or home addresses of natural persons. Where a field would hold a person\'s name, return null and use the companion role field when one exists. Names, NIF/CIF, addresses, phones and e-mails of legal entities (companies, banks, administrator firms, public bodies) and of the community itself are transcribed as printed. Inside verbatim text (`concepto`, `texto_literal`, `descripcion`) replace a person\'s name with "[persona]" or with the role in brackets and keep everything else unchanged.',
  '9. Self-checks. Compare printed figures with each other (lines against base, base plus VAT against total, opening balance plus movements against closing balance, cumulative minus previous against current). Report the outcome in `self_checks` and the largest difference in `discrepancia_eur`. Never change a transcribed value to make a check pass.',
  '10. Document type. `doc_type_confirmed` states which of the listed types the pages actually are; choose "otro" when none fits and explain in `notes`. Pages that clearly belong to a different document (another number, another issuer) are described in `notes` and their values are not merged into the fields.',
  '11. Output. Return only the JSON object required by the schema, with every property present (null or empty array when absent). No text before or after it.',
].join('\n');

/** Field-specific transcription guidance per schema, sent as the user instruction after the images. */
export const DOC_TYPE_INSTRUCTIONS: Readonly<Record<SchemaKey, string>> = Object.freeze({
  factura: [
    'Transcribe this invoice (factura, factura simplificada or factura rectificativa) into the schema.',
    '- `serie` and `numero`: as printed. When the number is printed as one string ("F-2023/017") put it whole in `numero` and leave `serie` null unless a separate "Serie" label is printed.',
    '- `emisor` is the party issuing the invoice (letterhead, stamp, "Datos del emisor"); `destinatario` is the party invoiced ("Cliente", "Facturar a", "Client"). When the issuer is a natural person, `emisor.nombre`, `emisor.nif`, `emisor.email` and `emisor.telefono` are null.',
    '- `lineas`: one entry per printed line in printed order, including lines without an amount; do not merge or split lines. `base` is the line amount before VAT as printed; when only quantity and unit price are printed, `base` is null.',
    '- `resumen_iva`: the VAT summary rows as printed (base, %, cuota), one per rate.',
    '- `retencion_irpf` only when a withholding line is printed; `suplidos` only when a "suplidos" line is printed.',
    '- `menciones`: true only when the corresponding wording is printed.',
    '- `element_scope`: `private_unit` when the line text names a specific flat, floor/door, garage or premises; `common` when it names common elements (façade, staircase, lift, roof, entrance, community); `unknown` otherwise. `unit_hint` is the unit label as printed.',
    '- `forma_pago`, `iban_mostrado`, `vencimiento`: as printed on the invoice; null when absent.',
    '- `rectifica_factura`: for a rectifying invoice, the number of the invoice it rectifies, as printed.',
  ].join('\n'),
  presupuesto: [
    'Transcribe this quote / budget (pressupost, presupuesto) into the schema.',
    '- `capitulos`: one entry per chapter as printed; when the quote has no chapters, use a single chapter with `codigo` null and `titulo` null holding all items.',
    '- `partidas`: one entry per printed item in printed order; `importe` is the item amount as printed; `es_partida_alzada` for lump sums.',
    '- `pem`, `gastos_generales`, `beneficio_industrial`, `presupuesto_contrata_sin_iva`, `iva`, `total_con_iva`: only the values printed in the summary; null when a line is not printed.',
    '- `condiciones_pago`, `plazo_ejecucion`, `exclusiones`, `validez_dias`: as written in the conditions block.',
    '- `firmado_por_comunidad`: true when a signature, stamp or "acceptat / aceptado / conforme" mark from the community side is visible; `firmado_por_comunidad_rol` is the role written next to it (never a name).',
  ].join('\n'),
  certificacion: [
    'Transcribe this works certification (certificació d\'obra, certificación de obra, certificat final d\'obra) into the schema.',
    '- `partidas`: one entry per printed item with the columns as printed: `a_origen` (cumulative), `anterior` (previous), `actual` (this period); null for columns not printed.',
    '- `totales`: the totals row as printed, same three columns.',
    '- `retencion_garantia`, `base_certificacion`, `iva`, `total_certificacion`: only the printed summary lines.',
    '- `firmas`: true when a signature or stamp is visible for the contractor, the site management (direcció facultativa: arquitecte, aparellador, enginyer) and the owner/community; `firmas_roles` lists the roles written next to signatures (never names).',
  ].join('\n'),
  contrato: [
    'Transcribe this contract into the schema.',
    '- `kind`: obra (construction works), ascensor_instalacion (lift installation), mantenimiento_ascensor (lift maintenance), prestamo (loan), servicio (other recurring service), otro.',
    '- `partes`: one entry per party as written in the "comparecen / reunidos" block: `rol` (contratista, comunidad, prestamista, prestatario, mantenedor …); `nombre`, `nif`, `domicilio` only for legal entities; `representante_rol` is the role of the person signing for the party (president, administrator, gerent, apoderat), never a name.',
    '- `precio`: the amounts as written in the price clause; `es_precio_cerrado` true only when the text says the price is fixed / closed ("preu tancat", "precio cerrado", "a tanto alzado").',
    '- `calendario_pagos`: one entry per payment milestone as written, with percentage and/or amount as printed; `es_anticipo` true for payments due at signature or before the works start.',
    '- `plazo`, `penalizaciones`, `retencion_garantia`, `garantia_meses`, `permanencia_meses`, `revision_precios`, `licencia_a_cargo_de`, `prl_cae_mencion`: from the corresponding clauses, as written; null when absent.',
    '- `elevator_spec` only for lift contracts; `prestamo_spec` only for loans; otherwise null.',
    '- `clausulas_relevantes`: short verbatim excerpts of clauses about payments, term, penalties, guarantee, termination, permits, insurance and subcontracting, each with its page.',
    '- `firmas`: one entry per signature line with the role written next to it and whether a signature is visible.',
  ].join('\n'),
  extracto: [
    'Transcribe this bank statement (extracte bancari, extracto bancario) into the schema.',
    '- `movimientos`: one entry per printed row in printed order, including fees, interest and returned items. `importe` is signed: debits negative, credits positive. Use the statement\'s own sign convention (separate Debe/Haber or Càrrec/Abonament columns, a minus sign, "D"/"H" markers).',
    '- `saldo_tras` when a running balance column is printed. `fecha_valor` when a value-date column is printed.',
    '- `concepto`: the concept text as printed. Replace a natural person\'s name inside it with "[persona]" and keep the rest unchanged (references, unit labels, months).',
    '- `contraparte_nombre` only for legal entities; for a natural person set `contraparte_es_persona_fisica` true and leave the name null. `contraparte_iban` as printed when shown. `unit_hint` is a unit label printed inside the concept.',
    '- Each row carries `page_index` and `bbox` of the whole row; statement-level fields (balances, IBAN, holder, period) go to `evidence[]`.',
    '- `saldo_inicial` is the opening balance printed ("saldo anterior", "saldo inicial"); `saldo_final` the closing balance printed. When a page continues from a previous page and prints only a carried balance, transcribe it as `saldo_inicial` and note it.',
    '- `titular`: the holder as printed when it is a legal entity (the community, an administrator firm); for a natural person set `titular_es_persona_fisica` true and leave `titular` null.',
  ].join('\n'),
  liquidacion: [
    'Transcribe this annual statement of accounts (liquidació, liquidación anual) or community budget into the schema.',
    '- `ingresos` and `gastos`: one entry per printed line in printed order with its chapter heading; `presupuestado` when a budget column is printed. `proveedor` only when a vendor name (legal entity) is printed on the line.',
    '- `totales`, `saldos`, `fondo_reserva`, `saldo_en_poder_administrador`, `pendientes`: only the printed summary values.',
    '- `deudores` and `cuotas_por_unidad`: by unit label as printed (floor/door, "local", "pàrquing"); never an owner\'s name. When the statement lists owners by name without a unit label, use the position in the list as the label ("fila 3") and say so in `notes`.',
    '- `acreedores`: legal entity names as printed; `derramas`: levy summary lines as printed.',
    '- `criterio_contable`: cash when the statement reports collections and payments, accrual when it reports invoices issued/received and pending amounts, mixed when both, unknown when it cannot be told from the wording.',
    '- `administrador_nombre` only when the administrator is a firm; for a natural person set `administrador_es_persona_fisica` true.',
  ].join('\n'),
  acta: [
    'Transcribe these minutes of an owners\' meeting (acta de la junta) or notice of meeting (convocatòria) into the schema.',
    '- `asistentes`: one entry per unit listed as present or represented, by unit label only; `coeficiente_pct` when printed next to the unit. Never transcribe owner names: when the minutes list names without unit labels, use "[persona] n" (n = position in the list) as the label and say so in `notes`.',
    '- `orden_del_dia`: the agenda items as printed, in order.',
    '- `acuerdos`: one entry per agenda item discussed. `texto_literal` is the resolution wording verbatim (original language) with natural persons\' names replaced by their role in brackets. `resultado` as written; `votos` only when counts are printed; `unanimidad_declarada` true when the text says unanimity; `coeficientes_favor_pct` when a quota percentage is printed; `importes_mencionados` every amount written in the item; `proveedor_mencionado` a company named in the item; `delegacion` when the item delegates a decision to a role, with the scope and cap as written (null cap when none is written); `plazo` any deadline written; `page_index` the page where the item starts.',
    '- `cargos_elegidos`: offices elected or confirmed, by unit label of the person elected (or firm name for an administrator company).',
    '- `cuentas_aprobadas`, `presupuesto_aprobado`, `derramas_aprobadas`: only when the minutes say so, with amounts as written.',
    '- `firmas`: true when a signature is visible for the president, the secretary and the administrator; `fecha_cierre_acta` the closing date printed next to the signatures.',
  ].join('\n'),
  derrama: [
    'Transcribe this levy notice (avís de derrama, aviso de derrama) or community receipt (rebut, recibo) into the schema.',
    '- `junta_que_aprueba`: the meeting reference as written (date or wording). `objeto`, `importe_total`, `criterio_reparto`, `periodicidad`, `numero_plazos`: as written; null when absent.',
    '- `cuotas`: one entry per unit as printed, by unit label only (never an owner\'s name), with the unit\'s coefficient, total amount and instalments when printed.',
    '- `cuenta_destino_iban`: the account to pay into, exactly as printed.',
    '- `recibo`: only for a receipt addressed to one unit: the unit label, period, ordinary and extraordinary amounts, total, payment method and whether it is marked as paid; null for a levy notice.',
    '- `emisor_rol`: the role issuing the document as written (administrador, president); never a name.',
  ].join('\n'),
});

/** User instruction sent after the page images of an extraction request. */
export function extractionInstruction(
  docType: DocType | SchemaKey,
  schemaKey: SchemaKey,
  language?: Language,
): string {
  const parts = [
    `Expected document type: ${docType}.`,
    language ? `Expected language of the printed text: ${language}.` : null,
    DOC_TYPE_INSTRUCTIONS[schemaKey],
    'Return only the JSON object.',
  ];
  return parts.filter((p): p is string => p !== null).join('\n');
}

/** Short gloss per document type for the classifier. */
export const DOC_TYPE_GLOSSES: Readonly<Record<DocType, string>> = Object.freeze({
  factura: 'invoice issued by a vendor with a recipient block',
  factura_simplificada: 'simplified invoice / ticket without a recipient block',
  factura_rectificativa: 'rectifying or credit invoice (factura rectificativa, abonament)',
  presupuesto: 'quote or budget from a vendor (pressupost, presupuesto, oferta)',
  contrato_obra: 'works contract between the community and a contractor',
  contrato_ascensor: 'lift installation contract',
  contrato_mantenimiento: 'maintenance or recurring service contract (lift, cleaning, insurance broker …)',
  contrato_prestamo: 'loan or credit contract',
  certificacion_obra: 'works certification with a origen / anterior / actual columns',
  certificat_final_obra: 'final works certificate (certificat final d\'obra, CFO)',
  albaran: 'delivery note (albarà, albarán)',
  justificante_pago: 'proof of payment issued by a vendor or the administrator',
  justificant_transferencia: 'bank transfer confirmation (justificant de transferència)',
  certificat_titularitat_bancaria: 'bank certificate of account ownership',
  extracto_bancario: 'bank statement with movements and balances',
  liquidacion_anual: 'annual statement of accounts of the administrator (liquidació)',
  presupuesto_comunidad: 'annual budget of the community (pressupost ordinari)',
  acta: 'minutes of an owners\' meeting (acta de la junta)',
  convocatoria: 'notice calling an owners\' meeting (convocatòria)',
  aviso_derrama: 'notice of an extraordinary levy (avís de derrama)',
  recibo_comunidad: 'community fee receipt addressed to one unit (rebut)',
  estatuts_titol_constitutiu: 'statutes or constitutive title of the community',
  requeriment_burofax: 'formal demand or burofax letter',
  permiso_obras: 'works permit or licence (llicència d\'obres, comunicat d\'obres)',
  autoliquidacion_icio: 'ICIO tax self-assessment form',
  iit: 'informe d\'idoneïtat tècnica (technical suitability report)',
  ite: 'inspecció tècnica de l\'edifici (building technical inspection)',
  solicitud_subvencion: 'subsidy application form',
  resolucio_subvencion: 'subsidy resolution or grant notification',
  declaracio_responsable_ascensor: 'lift responsible declaration / registration with the authority',
  full_encarrec: 'architect or technician engagement sheet (full d\'encàrrec)',
  poliza_seguro: 'insurance policy or policy schedule',
  modelo_111_190_347: 'tax forms 111, 190 or 347',
  email: 'printed e-mail message',
  chat_export: 'messaging app export or screenshot',
  nota_manuscrita: 'handwritten note',
  otro: 'readable document of another kind',
  ilegible: 'unreadable page, blank page or photo without a document',
});

function docTypeListText(): string {
  return DOC_TYPES.map((t) => `- ${t}: ${DOC_TYPE_GLOSSES[t]}`).join('\n');
}

/**
 * System prompt of the page classifier (Sonnet on thumbnails). Sliding-window convention: context
 * pages surround the target pages and are never classified.
 */
export const CLASSIFIER_SYSTEM_PROMPT: string = [
  'You classify page thumbnails of documents belonging to an owners\' community in Catalonia so that pages can be grouped into documents. You describe what is visible; you do not interpret it.',
  '',
  '## Input',
  'Thumbnails in reading order. Pages labelled "Page n:" are the pages to classify (n is the 0-based page index across the whole batch). Pages labelled "Context (previous) page n:" and "Context (next) page n:" are shown only so that continuity can be judged; they are not classified and must not appear in the output.',
  '',
  '## Output',
  'One entry per "Page n:" page, in the same order, with: `page_index` (the n), `doc_type`, `page_role`, `issuer_name_hint`, `doc_number_hint`, `date_hint`, `page_marker`, `language`, `legibility`, `is_handwritten_mostly`, `continues_previous`, `continues_previous_confidence`, `reason`.',
  '',
  '## Document types',
  docTypeListText(),
  '',
  '## Continuity',
  '`continues_previous` is true when the page continues the page immediately before it (the previous target page or the last "Context (previous)" page): same letterhead or footer, a running page marker ("2/5", "pàgina 2 de 5"), carried totals ("suma i segueix", "suma y sigue"), the same table columns continuing without a new header, the same document number. A fresh header with a different number, date or issuer means false. `continues_previous_confidence` is your confidence in that judgement, 0 to 1. The first page of the batch with no previous context page has `continues_previous` false.',
  '',
  '## Page role',
  '`single` when the page is a complete document; `first` when it starts a document that continues on the next page; `continuation` for middle pages; `last` for the page that closes a document (totals, signatures, "pàgina 5 de 5").',
  '',
  '## Hints',
  '`issuer_name_hint`: the issuing legal entity as printed (company, bank, administrator firm, public body, the community). Never a natural person\'s name: use null. `doc_number_hint`: the document number printed (invoice, quote, certification, contract, policy). `date_hint`: the main printed date, ISO when unambiguous, otherwise as printed. `page_marker`: printed pagination as printed. `language`: language of the printed text. `legibility`: fraction of the page that can be read, 0 to 1. `is_handwritten_mostly`: true when most of the content is handwritten.',
  '',
  '## Edge cases',
  'Blank pages, photos without a document or unreadable pages: `doc_type` "ilegible" with the matching legibility. Readable pages of a kind not listed: "otro". Two different documents on one page: classify by the larger one and mention the other in `reason`. Rotated or upside-down pages are still classified.',
  '',
  'Return only the JSON object.',
].join('\n');

/** User instruction of a classifier request, listing which page indexes to classify. */
export function classifierInstruction(
  targetIndexes: readonly number[],
  prevIndexes: readonly number[],
  nextIndexes: readonly number[],
): string {
  const parts = [
    `Classify the pages labelled "Page n:" with n in [${targetIndexes.join(', ')}]; return exactly ${targetIndexes.length} entries in that order.`,
  ];
  if (prevIndexes.length) {
    parts.push(`Context (previous) pages [${prevIndexes.join(', ')}] precede them and are not classified.`);
  }
  if (nextIndexes.length) {
    parts.push(`Context (next) pages [${nextIndexes.join(', ')}] follow them and are not classified.`);
  }
  parts.push('Return only the JSON object.');
  return parts.join('\n');
}

/** User message appended for the single repair attempt after an output that did not parse. */
export function repairInstruction(parseError: string): string {
  const trimmed = parseError.length > 1500 ? `${parseError.slice(0, 1500)} …` : parseError;
  return [
    'The previous output was not a valid JSON object for the schema. Validation error:',
    trimmed,
    'Return the complete JSON object again, following the schema exactly: every property present, null or an empty array where a value is absent, numbers as numbers, enum values from the allowed list, and no text before or after the object. Keep every transcribed value unchanged.',
  ].join('\n');
}
