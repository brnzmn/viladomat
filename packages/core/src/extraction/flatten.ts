/**
 * Flatten a parsed document into field-value seeds (one row per scalar), joined with the model's
 * evidence items by dot path. The result feeds `field_revisions` (source `model`) and, through
 * {@link criticalFieldPaths}, tells the caller which fields are subject to the two-source rule.
 */
import { sanitiseBbox, type EvidenceItem } from './schemas/common.ts';
import { schemaKeyFor, type DocType, type SchemaKey } from './types.ts';

/** Kind of a field value; drives `normaliseValue` and the review UI. */
export type FieldValueKind = 'amount' | 'date' | 'nif' | 'iban' | 'text' | 'bool' | 'int';

/** One scalar of a parsed document with its provenance. */
export interface FieldValueSeed {
  /** Dot path with 0-based indexes, e.g. `lineas[3].base`. */
  field_path: string;
  value: string | number | boolean | null;
  value_kind: FieldValueKind;
  page_index: number | null;
  bbox: [number, number, number, number] | null;
  /** Verbatim printed text from the evidence item, when one exists. */
  quote: string | null;
  /** Model confidence from the evidence item, when one exists. */
  model_conf: number | null;
  /** Monetary/identity field subject to the two-source rule. */
  is_critical: boolean;
  /** Where the page/bbox came from: an evidence item, the enclosing row, or nothing. */
  provenance: 'evidence' | 'row' | 'none';
}

export interface FlattenOptions {
  /** Which null values to emit: only critical fields (default), all, or none. */
  includeNulls?: 'critical' | 'all' | 'none';
  /** Leaf keys that are provenance, not values (default: page_index, bbox). */
  skipLeafKeys?: readonly string[];
  /** Top-level keys not flattened (default: evidence). */
  skipTopKeys?: readonly string[];
}

const DEFAULT_SKIP_LEAF = ['page_index', 'bbox'] as const;
const DEFAULT_SKIP_TOP = ['evidence'] as const;

/** `a.0.b` → `a[0].b`; trims whitespace. Idempotent on already-canonical paths. */
export function normaliseFieldPath(path: string): string {
  return path
    .trim()
    .replace(/\.(\d+)(?=\.|\[|$)/g, '[$1]')
    .replace(/\[\s*(\d+)\s*\]/g, '[$1]');
}

/** Match a path against a pattern where `[*]` stands for any index. */
export function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('[*]')) return pattern === path;
  const re = new RegExp(
    `^${pattern
      .split('[*]')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\[\\d+\\]')}$`,
  );
  return re.test(path);
}

/** Monetary / identity paths per schema (patterns with `[*]`). */
export const CRITICAL_FIELD_PATTERNS: Readonly<Record<SchemaKey, readonly string[]>> = Object.freeze({
  factura: [
    'serie',
    'numero',
    'fecha_expedicion',
    'fecha_operacion',
    'vencimiento',
    'emisor.nombre',
    'emisor.nif',
    'destinatario.nombre',
    'destinatario.nif',
    'iban_mostrado',
    'rectifica_factura',
    'lineas[*].precio_unitario',
    'lineas[*].base',
    'lineas[*].cuota_iva',
    'lineas[*].total_linea',
    'resumen_iva[*].base',
    'resumen_iva[*].tipo_pct',
    'resumen_iva[*].cuota',
    'base_imponible_total',
    'iva_total',
    'retencion_irpf.pct',
    'retencion_irpf.importe',
    'suplidos',
    'total_factura',
  ],
  presupuesto: [
    'numero_presupuesto',
    'fecha',
    'emisor.nombre',
    'emisor.nif',
    'destinatario.nombre',
    'destinatario.nif',
    'capitulos[*].partidas[*].precio_unitario',
    'capitulos[*].partidas[*].importe',
    'capitulos[*].importe_capitulo',
    'pem',
    'gastos_generales.pct',
    'gastos_generales.importe',
    'beneficio_industrial.pct',
    'beneficio_industrial.importe',
    'presupuesto_contrata_sin_iva',
    'iva.pct',
    'iva.importe',
    'total_con_iva',
  ],
  certificacion: [
    'numero_certificacion',
    'fecha',
    'periodo.desde',
    'periodo.hasta',
    'contratista.nombre',
    'contratista.nif',
    'propiedad.nombre',
    'propiedad.nif',
    'importe_contrato',
    'partidas[*].importe_contrato',
    'partidas[*].a_origen',
    'partidas[*].anterior',
    'partidas[*].actual',
    'totales.a_origen',
    'totales.anterior',
    'totales.actual',
    'retencion_garantia.pct',
    'retencion_garantia.importe',
    'base_certificacion',
    'iva.pct',
    'iva.importe',
    'total_certificacion',
  ],
  contrato: [
    'fecha_firma',
    'partes[*].nombre',
    'partes[*].nif',
    'precio.sin_iva',
    'precio.iva_pct',
    'precio.con_iva',
    'calendario_pagos[*].pct',
    'calendario_pagos[*].importe',
    'plazo.fin_previsto',
    'retencion_garantia.pct',
    'retencion_garantia.importe',
    'garantia_meses',
    'permanencia_meses',
    'elevator_spec.precio_mantenimiento_anual',
    'prestamo_spec.principal',
    'prestamo_spec.tipo_interes_pct',
    'prestamo_spec.cuota_mensual',
    'prestamo_spec.comision_apertura',
    'prestamo_spec.cuenta_abono_iban',
    'firmas[*].fecha',
  ],
  extracto: [
    'banco',
    'iban_o_cuenta_mostrada',
    'titular',
    'periodo.desde',
    'periodo.hasta',
    'saldo_inicial',
    'saldo_final',
    'movimientos[*].fecha_operacion',
    'movimientos[*].fecha_valor',
    'movimientos[*].importe',
    'movimientos[*].saldo_tras',
    'movimientos[*].contraparte_iban',
    'movimientos[*].contraparte_nombre',
  ],
  liquidacion: [
    'ejercicio',
    'periodo.desde',
    'periodo.hasta',
    'administrador_nombre',
    'comunidad.nombre',
    'comunidad.nif',
    'ingresos[*].importe',
    'ingresos[*].presupuestado',
    'gastos[*].importe',
    'gastos[*].presupuestado',
    'gastos[*].proveedor',
    'totales.total_ingresos',
    'totales.total_gastos',
    'totales.resultado',
    'saldos.inicial',
    'saldos.final',
    'saldos.en_banco',
    'saldos.en_caja',
    'fondo_reserva.inicial',
    'fondo_reserva.dotacion',
    'fondo_reserva.disposiciones',
    'fondo_reserva.final',
    'saldo_en_poder_administrador',
    'pendientes.facturas_pendientes_pago',
    'pendientes.retenciones_pendientes',
    'pendientes.acreedores_total',
    'pendientes.deudores_total',
    'deudores[*].importe',
    'acreedores[*].nombre',
    'acreedores[*].importe',
    'derramas[*].importe_total',
    'derramas[*].recaudado',
    'derramas[*].aplicado',
    'derramas[*].pendiente',
    'cuotas_por_unidad[*].coeficiente_pct',
    'cuotas_por_unidad[*].cuota_ordinaria',
    'cuotas_por_unidad[*].cuota_extraordinaria',
    'cuotas_por_unidad[*].deuda_pendiente',
    'aprobada_en_junta',
  ],
  acta: [
    'fecha',
    'fecha_convocatoria',
    'fecha_cierre_acta',
    'comunidad.nombre',
    'comunidad.nif',
    'asistentes[*].coeficiente_pct',
    'quorum_pct',
    'acuerdos[*].votos.favor',
    'acuerdos[*].votos.contra',
    'acuerdos[*].votos.abstencion',
    'acuerdos[*].coeficientes_favor_pct',
    'acuerdos[*].importes_mencionados[*].importe',
    'acuerdos[*].proveedor_mencionado',
    'acuerdos[*].delegacion.limite_importe',
    'presupuesto_aprobado',
    'derramas_aprobadas[*].importe_total',
    'derramas_aprobadas[*].importe_por_unidad',
  ],
  derrama: [
    'fecha',
    'comunidad.nombre',
    'comunidad.nif',
    'importe_total',
    'cuotas[*].coeficiente_pct',
    'cuotas[*].importe',
    'cuotas[*].plazos[*].fecha',
    'cuotas[*].plazos[*].importe',
    'cuenta_destino_iban',
    'recibo.cuota_ordinaria',
    'recibo.cuota_extraordinaria',
    'recibo.total',
  ],
});

/** Monetary/identity path patterns for a document type (empty for types without a schema). */
export function criticalFieldPaths(docType: DocType | SchemaKey): readonly string[] {
  const key = schemaKeyFor(docType);
  return key ? CRITICAL_FIELD_PATTERNS[key] : [];
}

/** True when the path is a monetary/identity field of the document type. */
export function isCriticalPath(docType: DocType | SchemaKey, path: string): boolean {
  const p = normaliseFieldPath(path);
  return criticalFieldPaths(docType).some((pattern) => pathMatches(pattern, p));
}

const INT_KEYS = new Set([
  'orden',
  'page_index',
  'paradas',
  'ejercicio',
  'validez_dias',
  'numero_plazos',
  'favor',
  'contra',
  'abstencion',
  'quorum_unidades',
  'pagina',
  'de',
  'plazo_meses',
]);
const DATE_KEYS = new Set([
  'vencimiento',
  'desde',
  'hasta',
  'fin_previsto',
  'fecha_cierre_acta',
  'aprobada_en_junta',
  'fecha_convocatoria',
]);
const AMOUNT_KEY_RE =
  /(importe|total|base|cuota|saldo|precio|pct|pem|suplidos|cantidad|principal|carga_kg|limite|coeficiente|quorum|dotacion|disposiciones|inicial|final|recaudado|aplicado|pendiente|anterior|actual|a_origen|resultado|en_banco|en_caja|deuda)/;

function leafKey(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.replace(/\[\d+\]$/, '');
}

/** Value kind for a path, using the leaf key and the runtime value. */
export function kindForPath(path: string, value: unknown): FieldValueKind {
  const key = leafKey(path);
  if (typeof value === 'boolean') return 'bool';
  if (key === 'nif') return 'nif';
  if (key.includes('iban')) return 'iban';
  if (DATE_KEYS.has(key) || /^(fecha|data)(_|$)/.test(key)) return 'date';
  if (INT_KEYS.has(key) || /_meses$/.test(key)) return 'int';
  if (typeof value === 'number') return 'amount';
  if (typeof value === 'string') return 'text';
  // null: decide by key
  return AMOUNT_KEY_RE.test(key) ? 'amount' : 'text';
}

interface RowContext {
  page_index: number;
  bbox: [number, number, number, number] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Index evidence by normalised field path, keeping the most confident item per path. */
export function indexEvidence(evidence: readonly EvidenceItem[] | null | undefined): Map<string, EvidenceItem> {
  const map = new Map<string, EvidenceItem>();
  for (const item of evidence ?? []) {
    if (!item || typeof item.field_path !== 'string') continue;
    const path = normaliseFieldPath(item.field_path);
    const prev = map.get(path);
    if (!prev || (item.confidence ?? 0) > (prev.confidence ?? 0)) map.set(path, item);
  }
  return map;
}

/**
 * Flatten `parsed` into seeds. Evidence items are joined by path; scalars inside a row object that
 * carries `page_index` (and optionally `bbox`) inherit that provenance when no evidence item exists.
 */
export function flattenParsed(
  parsed: unknown,
  evidence: readonly EvidenceItem[] | null | undefined,
  docType: DocType | SchemaKey,
  options: FlattenOptions = {},
): FieldValueSeed[] {
  const includeNulls = options.includeNulls ?? 'critical';
  const skipLeaf = new Set(options.skipLeafKeys ?? DEFAULT_SKIP_LEAF);
  const skipTop = new Set(options.skipTopKeys ?? DEFAULT_SKIP_TOP);
  const evidenceByPath = indexEvidence(
    evidence ?? (isRecord(parsed) && Array.isArray(parsed['evidence']) ? (parsed['evidence'] as EvidenceItem[]) : []),
  );
  const patterns = criticalFieldPaths(docType);
  const out: FieldValueSeed[] = [];

  const emit = (path: string, value: unknown, row: RowContext | null): void => {
    const critical = patterns.some((p) => pathMatches(p, path));
    if (value === null) {
      if (includeNulls === 'none') return;
      if (includeNulls === 'critical' && !critical) return;
    }
    const ev = evidenceByPath.get(path);
    const seed: FieldValueSeed = {
      field_path: path,
      value: value as string | number | boolean | null,
      value_kind: kindForPath(path, value),
      page_index: null,
      bbox: null,
      quote: null,
      model_conf: null,
      is_critical: critical,
      provenance: 'none',
    };
    if (ev) {
      seed.page_index = Number.isInteger(ev.page_index) ? ev.page_index : null;
      seed.bbox = sanitiseBbox(ev.bbox);
      seed.quote = typeof ev.quote === 'string' ? ev.quote : null;
      seed.model_conf = typeof ev.confidence === 'number' ? Math.min(1, Math.max(0, ev.confidence)) : null;
      seed.provenance = 'evidence';
    } else if (row) {
      seed.page_index = row.page_index;
      seed.bbox = row.bbox;
      seed.provenance = 'row';
    }
    out.push(seed);
  };

  const walk = (node: unknown, path: string, row: RowContext | null, depth: number): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, row, depth + 1));
      return;
    }
    if (isRecord(node)) {
      let ctx = row;
      const pi = node['page_index'];
      if (typeof pi === 'number' && Number.isInteger(pi)) {
        ctx = { page_index: pi, bbox: sanitiseBbox(node['bbox']) };
      }
      for (const [key, value] of Object.entries(node)) {
        if (depth === 0 && skipTop.has(key)) continue;
        // provenance leaves (page_index, bbox) are carried by the row context, not emitted as values
        if (skipLeaf.has(key) && (value === null || typeof value !== 'object' || Array.isArray(value))) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (value !== null && typeof value === 'object') {
          walk(value, childPath, ctx, depth + 1);
        } else {
          emit(childPath, value, ctx);
        }
      }
      return;
    }
    if (path) emit(path, node, row);
  };

  walk(parsed, '', null, 0);
  return out;
}

/** Only the seeds subject to the two-source rule. */
export function criticalSeeds(seeds: readonly FieldValueSeed[]): FieldValueSeed[] {
  return seeds.filter((s) => s.is_critical);
}
