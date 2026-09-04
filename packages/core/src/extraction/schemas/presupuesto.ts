/**
 * Vendor quote / budget schema (presupuesto / pressupost). Chapters and items with PEM,
 * gastos generales, beneficio industrial, contract price and VAT.
 */
import { z } from 'zod';
import {
  ElementScopeEnum,
  FormaPagoEnum,
  anotacionManuscrita,
  docTypeConfirmed,
  evidenceArray,
  ndate,
  nint,
  nnum,
  nstr,
  partyRef,
  pctImporte,
  selfChecks,
  trailingFields,
} from './common.ts';

export const PresupuestoPartidaSchema = z.object({
  orden: z.number().int().describe('1-based position within the chapter'),
  codigo: nstr(),
  descripcion: z.string().describe('Item text as printed (original language)'),
  cantidad: nnum(),
  unidad: nstr(),
  precio_unitario: nnum(),
  importe: nnum().describe('Item amount as printed'),
  es_manuscrito: z.boolean(),
  es_partida_alzada: z.boolean().describe('Lump sum without quantity × price'),
  element_scope: ElementScopeEnum,
  unit_hint: nstr().describe('Unit label exactly as printed when the item names one; else null'),
});

export const PresupuestoCapituloSchema = z.object({
  codigo: nstr().describe('Chapter code as printed (e.g. "01")'),
  titulo: nstr().describe('Chapter title as printed'),
  partidas: z.array(PresupuestoPartidaSchema),
  importe_capitulo: nnum().describe('Chapter subtotal as printed'),
});

export const PresupuestoSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['presupuesto']),
  numero_presupuesto: nstr().describe('Quote number/reference as printed'),
  fecha: ndate(),
  emisor: partyRef().describe('Issuing company'),
  destinatario: partyRef().describe('Addressee as printed (usually the community)'),
  objeto: nstr().describe('Title / object of the works as printed'),
  referencia_obra: nstr().describe('Site address or works reference as printed'),
  capitulos: z.array(PresupuestoCapituloSchema),
  pem: nnum().describe('Presupuesto de ejecución material (sum of chapters) as printed'),
  gastos_generales: pctImporte().nullable().describe('GG line when printed'),
  beneficio_industrial: pctImporte().nullable().describe('BI line when printed'),
  presupuesto_contrata_sin_iva: nnum().describe('Contract price before VAT as printed'),
  iva: pctImporte().nullable(),
  total_con_iva: nnum(),
  condiciones_pago: nstr().describe('Payment terms text as printed'),
  forma_pago: FormaPagoEnum.nullable(),
  plazo_ejecucion: nstr().describe('Execution period text as printed'),
  exclusiones: z.array(z.string()).describe('Exclusions listed, one per entry, as printed'),
  firmado_por_comunidad: z
    .boolean()
    .describe('A signature or "acceptat/aceptado" mark from the community side is visible'),
  firmado_por_comunidad_rol: nstr().describe('Role of the community signer when stated (president, administrator …)'),
  validez_dias: nint().describe('Validity in days when printed'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks([
    'partidas_suman_pem',
    'pem_mas_gg_bi_es_contrata',
    'contrata_mas_iva_es_total',
  ]),
  ...trailingFields(),
});

export type Presupuesto = z.infer<typeof PresupuestoSchema>;
export type PresupuestoPartida = z.infer<typeof PresupuestoPartidaSchema>;
