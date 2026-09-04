/**
 * Works certification schema (certificación de obra / certificació d'obra), including the final
 * certification. Items carry a_origen / anterior / actual columns.
 */
import { z } from 'zod';
import {
  anotacionManuscrita,
  docTypeConfirmed,
  evidenceArray,
  ndate,
  nnum,
  nstr,
  partyRef,
  pctImporte,
  periodo,
  selfChecks,
  trailingFields,
} from './common.ts';

export const CertificacionPartidaSchema = z.object({
  orden: z.number().int(),
  codigo: nstr(),
  descripcion: z.string(),
  unidad: nstr(),
  cantidad_contrato: nnum().describe('Contracted quantity when printed'),
  precio_unitario: nnum(),
  importe_contrato: nnum().describe('Contracted amount for the item when printed'),
  a_origen: nnum().describe('Cumulative certified amount (a origen) as printed'),
  anterior: nnum().describe('Previously certified amount as printed'),
  actual: nnum().describe('Amount certified in this period as printed'),
  pct_ejecutado: nnum().describe('Percentage executed when printed'),
  es_extra: z.boolean().describe('The item is marked as additional/extra to the contract'),
});

export const CertificacionSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['certificacion_obra', 'certificat_final_obra']),
  numero_certificacion: nstr().describe('Certification number as printed'),
  fecha: ndate(),
  periodo: periodo().describe('Period certified when printed'),
  obra: nstr().describe('Works title / site as printed'),
  contratista: partyRef(),
  propiedad: partyRef().describe('Owner/promoter as printed (usually the community)'),
  importe_contrato: nnum().describe('Contract total when printed on the certification'),
  partidas: z.array(CertificacionPartidaSchema),
  totales: z.object({
    a_origen: nnum(),
    anterior: nnum(),
    actual: nnum(),
  }),
  retencion_garantia: pctImporte().nullable().describe('Retention line when printed'),
  base_certificacion: nnum().describe('Amount to invoice before VAT as printed'),
  iva: pctImporte().nullable(),
  total_certificacion: nnum(),
  firmas: z.object({
    contratista: z.boolean().describe('Contractor signature/stamp visible'),
    direccion_facultativa: z.boolean().describe('Site management (arquitecte/aparellador) signature visible'),
    propiedad: z.boolean().describe('Owner/community signature visible'),
  }),
  firmas_roles: z
    .array(z.string())
    .describe('Roles written next to the signatures (never names of natural persons)'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks(['actual_es_origen_menos_anterior', 'partidas_suman_totales']),
  ...trailingFields(),
});

export type Certificacion = z.infer<typeof CertificacionSchema>;
export type CertificacionPartida = z.infer<typeof CertificacionPartidaSchema>;
