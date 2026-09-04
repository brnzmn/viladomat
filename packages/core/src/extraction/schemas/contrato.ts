/**
 * Contract schema: works, elevator installation, elevator maintenance, loan, service. Maps to
 * `public.contracts` and `public.contract_milestones` (`kind` matches `public.contract_kind`).
 */
import { z } from 'zod';
import {
  docTypeConfirmed,
  evidenceArray,
  ndate,
  nbool,
  nint,
  nnum,
  nstr,
  selfChecks,
  trailingFields,
} from './common.ts';

export const ContratoKindEnum = z.enum([
  'obra',
  'ascensor_instalacion',
  'mantenimiento_ascensor',
  'prestamo',
  'servicio',
  'otro',
]);

export const ContratoParteSchema = z.object({
  rol: z
    .string()
    .describe(
      'Role in the contract as written: contratista, comunidad, prestamista, prestatario, mantenedor, cliente …',
    ),
  nombre: nstr().describe('Legal entity name; null for a natural person'),
  nif: nstr().describe('NIF/CIF of the legal entity; null for a natural person'),
  representante_rol: nstr().describe(
    'Role of the person signing for this party (president, administrator, gerent …); never a name',
  ),
  domicilio: nstr().describe('Address of the legal entity; null for a natural person'),
});

export const CalendarioPagoSchema = z.object({
  hito: z.string().describe('Milestone text as written (a la firma, inicio de obra, final de obra …)'),
  pct: nnum().describe('Percentage of the price when printed'),
  importe: nnum().describe('Amount when printed'),
  condicion: nstr().describe('Condition attached to the payment when written'),
  es_anticipo: z.boolean().describe('The payment is due before or at signature / before works start'),
});

export const ElevatorSpecSchema = z.object({
  marca_modelo: nstr(),
  paradas: nint().describe('Number of stops'),
  carga_kg: nnum(),
  velocidad: nstr().describe('Speed as printed (e.g. "1 m/s")'),
  mantenimiento_incluido_meses: nint(),
  precio_mantenimiento_anual: nnum(),
});

export const PrestamoSpecSchema = z.object({
  principal: nnum(),
  tipo_interes_pct: nnum(),
  plazo_meses: nint(),
  cuota_mensual: nnum(),
  comision_apertura: nnum(),
  cuenta_abono_iban: nstr().describe('IBAN where the loan is paid out, as printed'),
});

export const ContratoSchema = z.object({
  doc_type_confirmed: docTypeConfirmed([
    'contrato_obra',
    'contrato_ascensor',
    'contrato_mantenimiento',
    'contrato_prestamo',
  ]),
  kind: ContratoKindEnum.describe('Nature of the contract'),
  titulo: nstr().describe('Title of the document as printed'),
  fecha_firma: ndate(),
  lugar_firma: nstr(),
  partes: z.array(ContratoParteSchema),
  objeto: nstr().describe('Object of the contract as written (summary allowed when very long)'),
  referencia_presupuesto: nstr().describe('Quote/offer reference incorporated in the contract'),
  precio: z.object({
    sin_iva: nnum(),
    iva_pct: nnum(),
    con_iva: nnum(),
  }),
  es_precio_cerrado: nbool().describe('true when the text states a fixed/closed price; null when not stated'),
  calendario_pagos: z.array(CalendarioPagoSchema),
  plazo: z.object({
    inicio: nstr().describe('Start as written (date or condition)'),
    duracion: nstr().describe('Duration as written'),
    fin_previsto: ndate().describe('Planned end date when printed as a date'),
  }),
  penalizaciones: z.array(
    z.object({
      concepto: z.string().describe('What is penalised, as written'),
      importe_o_pct: nstr().describe('Amount or percentage as written'),
      texto: nstr().describe('Clause text (short, verbatim)'),
    }),
  ),
  retencion_garantia: z
    .object({
      pct: nnum(),
      importe: nnum(),
      plazo_devolucion: nstr().describe('When the retention is returned, as written'),
    })
    .nullable(),
  garantia_meses: nint(),
  permanencia_meses: nint().describe('Minimum term (maintenance/service contracts)'),
  revision_precios: nstr().describe('Price revision clause as written (e.g. "IPC anual")'),
  licencia_a_cargo_de: nstr().describe('Which party obtains the permit/licence, as written'),
  prl_cae_mencion: z.boolean().describe('The text mentions PRL / CAE / coordinación de seguridad'),
  firmas: z.array(
    z.object({
      rol: z.string().describe('Role of the signer as written; never a name'),
      fecha: ndate(),
      presente: z.boolean().describe('A signature is visible for this role'),
    }),
  ),
  elevator_spec: ElevatorSpecSchema.nullable(),
  prestamo_spec: PrestamoSpecSchema.nullable(),
  clausulas_relevantes: z.array(
    z.object({
      tema: z
        .string()
        .describe('Topic: pagos, plazo, penalizaciones, garantia, rescision, licencias, seguros, subcontratacion, otro'),
      resumen: z.string().describe('Short verbatim excerpt of the clause'),
      page_index: z.number().int(),
    }),
  ),
  evidence: evidenceArray(),
  self_checks: selfChecks(['sin_iva_mas_iva_es_con_iva', 'calendario_suma_100pct']),
  ...trailingFields(),
});

export type Contrato = z.infer<typeof ContratoSchema>;
export type ContratoParte = z.infer<typeof ContratoParteSchema>;
export type CalendarioPago = z.infer<typeof CalendarioPagoSchema>;
