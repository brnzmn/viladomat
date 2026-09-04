/**
 * Extraordinary levy notice (aviso de derrama) and community receipt (recibo/rebut) schema.
 * Maps to `public.derramas` / `public.derrama_ledger`. Units appear as labels only.
 */
import { z } from 'zod';
import {
  FormaPagoEnum,
  anotacionManuscrita,
  comunidadRef,
  docTypeConfirmed,
  evidenceArray,
  nbool,
  ndate,
  nint,
  nnum,
  nstr,
  selfChecks,
  trailingFields,
} from './common.ts';

export const CriterioRepartoEnum = z.enum(['coeficiente', 'partes_iguales', 'otro']);

export const DerramaCuotaSchema = z.object({
  entidad_label: z.string().describe('Unit label as printed; never an owner name'),
  coeficiente_pct: nnum(),
  importe: nnum().describe('Total amount for the unit as printed'),
  plazos: z
    .array(
      z.object({
        fecha: ndate(),
        importe: nnum(),
      }),
    )
    .describe('Instalments for the unit when printed'),
});

export const DerramaSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['aviso_derrama', 'recibo_comunidad']),
  fecha: ndate().describe('Date of the notice/receipt'),
  emisor_rol: nstr().describe('Role issuing the document: administrador, presidente …'),
  comunidad: comunidadRef(),
  junta_que_aprueba: nstr().describe('Reference to the meeting that approved the levy, as written (date or text)'),
  objeto: nstr().describe('Purpose of the levy as written'),
  importe_total: nnum().describe('Total levy amount when printed'),
  criterio_reparto: CriterioRepartoEnum.nullable().describe('Distribution criterion when stated; null when not stated'),
  periodicidad: nstr().describe('Periodicity as written (mensual, trimestral, único …)'),
  numero_plazos: nint(),
  cuotas: z.array(DerramaCuotaSchema),
  cuenta_destino_iban: nstr().describe('IBAN to pay into, as printed'),
  recibo: z
    .object({
      entidad_label: nstr().describe('Unit label the receipt is addressed to; never an owner name'),
      periodo: nstr().describe('Period covered as written'),
      cuota_ordinaria: nnum(),
      cuota_extraordinaria: nnum(),
      total: nnum(),
      forma_pago: FormaPagoEnum.nullable(),
      pagado: nbool().describe('true when the receipt is marked as paid'),
    })
    .nullable()
    .describe('Filled only for a receipt addressed to one unit; null for a levy notice'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks(['cuotas_suman_total']),
  ...trailingFields(),
});

export type Derrama = z.infer<typeof DerramaSchema>;
