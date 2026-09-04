/**
 * Administrator's annual accounts (liquidación anual / liquidació) and community budget schema.
 * Maps to `public.liquidations`, `public.liquidation_lines` and `public.liquidation_unit_rows`.
 * Owners appear only as unit labels.
 */
import { z } from 'zod';
import {
  anotacionManuscrita,
  comunidadRef,
  docTypeConfirmed,
  evidenceArray,
  nbool,
  ndate,
  nint,
  nnum,
  nstr,
  periodo,
  selfChecks,
  trailingFields,
} from './common.ts';

export const CriterioContableEnum = z.enum(['cash', 'accrual', 'mixed', 'unknown']);

export const LiquidacionIngresoSchema = z.object({
  concepto: z.string().describe('Income line text as printed'),
  importe: nnum(),
  presupuestado: nnum().describe('Budgeted amount when the statement prints a budget column'),
  capitulo: nstr().describe('Section/chapter heading the line sits under'),
  page_index: z.number().int(),
});

export const LiquidacionGastoSchema = z.object({
  concepto: z.string().describe('Expense line text as printed'),
  proveedor: nstr().describe('Vendor name when printed and a legal entity; null for a natural person'),
  importe: nnum(),
  presupuestado: nnum(),
  capitulo: nstr(),
  page_index: z.number().int(),
});

export const LiquidacionSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['liquidacion_anual', 'presupuesto_comunidad']),
  ejercicio: nint().describe('Fiscal year as printed (e.g. 2024)'),
  periodo: periodo(),
  administrador_nombre: nstr().describe('Administrator firm name as printed; null when the administrator is a natural person'),
  administrador_es_persona_fisica: nbool(),
  comunidad: comunidadRef(),
  criterio_contable: CriterioContableEnum.describe(
    'cash when the statement reports payments/collections; accrual when invoices/receivables; mixed; unknown when it cannot be told',
  ),
  ingresos: z.array(LiquidacionIngresoSchema),
  gastos: z.array(LiquidacionGastoSchema),
  totales: z.object({
    total_ingresos: nnum(),
    total_gastos: nnum(),
    resultado: nnum().describe('Result (income − expenses) as printed'),
  }),
  saldos: z.object({
    inicial: nnum().describe('Opening balance/treasury as printed'),
    final: nnum().describe('Closing balance/treasury as printed'),
    en_banco: nnum().describe('Bank balance when printed separately'),
    en_caja: nnum().describe('Cash balance when printed separately'),
  }),
  fondo_reserva: z.object({
    inicial: nnum(),
    dotacion: nnum(),
    disposiciones: nnum(),
    final: nnum(),
  }),
  saldo_en_poder_administrador: nnum().describe('Funds held by the administrator when printed'),
  pendientes: z.object({
    facturas_pendientes_pago: nnum(),
    retenciones_pendientes: nnum(),
    acreedores_total: nnum(),
    deudores_total: nnum(),
  }),
  deudores: z
    .array(
      z.object({
        entidad_label: z.string().describe('Unit label as printed (e.g. "3º 2ª"); never an owner name'),
        importe: nnum(),
      }),
    )
    .describe('Owners with pending amounts, by unit label only'),
  acreedores: z.array(
    z.object({
      nombre: nstr().describe('Creditor legal entity name; null for a natural person'),
      importe: nnum(),
    }),
  ),
  derramas: z.array(
    z.object({
      concepto: z.string(),
      importe_total: nnum(),
      recaudado: nnum(),
      aplicado: nnum(),
      pendiente: nnum(),
    }),
  ),
  cuotas_por_unidad: z.array(
    z.object({
      entidad_label: z.string().describe('Unit label as printed; never an owner name'),
      coeficiente_pct: nnum(),
      cuota_ordinaria: nnum(),
      cuota_extraordinaria: nnum(),
      deuda_pendiente: nnum(),
    }),
  ),
  aprobada_en_junta: ndate().describe('Date of the meeting that approved the accounts when printed'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks([
    'ingresos_suman_total',
    'gastos_suman_total',
    'resultado_es_ingresos_menos_gastos',
    'saldo_inicial_mas_resultado_es_final',
    'fondo_reserva_cuadra',
  ]),
  ...trailingFields(),
});

export type Liquidacion = z.infer<typeof LiquidacionSchema>;
