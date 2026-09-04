/**
 * Meeting minutes schema (acta de junta / acta de la junta de propietaris) and convocation.
 * Maps to `public.meetings` and `public.resolutions`. Attendees and elected officers appear only as
 * unit labels and roles; no owner names.
 */
import { z } from 'zod';
import {
  anotacionManuscrita,
  comunidadRef,
  docTypeConfirmed,
  evidenceArray,
  importeMencionado,
  nbool,
  ndate,
  nint,
  nnum,
  nstr,
  selfChecks,
  trailingFields,
} from './common.ts';

export const ActaTipoEnum = z.enum(['ordinaria', 'extraordinaria', 'universal', 'no_consta']);
export const AsistenciaEnum = z.enum(['presente', 'representado', 'no_consta']);
export const ResultadoEnum = z.enum(['aprobado', 'rechazado', 'informado', 'pendiente', 'no_consta']);

export const AcuerdoSchema = z.object({
  punto: z.string().describe('Agenda item number/label as printed (e.g. "3", "Tercer")'),
  titulo: nstr().describe('Agenda item title as printed'),
  texto_literal: z
    .string()
    .describe('The resolution text verbatim (original language). Replace any natural person\'s name by their role in brackets, e.g. "[president]".'),
  resultado: ResultadoEnum,
  votos: z
    .object({
      favor: nint(),
      contra: nint(),
      abstencion: nint(),
    })
    .nullable()
    .describe('Vote counts when printed; null when the text only says "unanimidad" or nothing'),
  unanimidad_declarada: nbool().describe('true when the text states unanimity'),
  coeficientes_favor_pct: nnum().describe('Quota percentage in favour when printed'),
  importes_mencionados: z.array(importeMencionado()),
  proveedor_mencionado: nstr().describe('Company named in the resolution (legal entity), as printed'),
  delegacion: z
    .object({
      a_quien_rol: z.string().describe('Role receiving the delegation (president, administrator, junta de govern …)'),
      alcance: z.string().describe('Scope of the delegation as written'),
      limite_importe: nnum().describe('Amount cap when written; null when none is written'),
    })
    .nullable(),
  plazo: nstr().describe('Deadline or period stated in the resolution'),
  page_index: z.number().int(),
});

export const ActaSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['acta', 'convocatoria']),
  tipo: ActaTipoEnum,
  comunidad: comunidadRef(),
  fecha: ndate().describe('Meeting date'),
  hora: nstr().describe('Time as printed (e.g. "19:30", "segona convocatòria 19:00")'),
  lugar: nstr(),
  fecha_convocatoria: ndate().describe('Date of the convocation when printed'),
  convocada_por_rol: nstr().describe('Role convening the meeting (president, administrator, owners ≥ 1/4)'),
  segunda_convocatoria: nbool(),
  asistentes: z
    .array(
      z.object({
        entidad_label: z.string().describe('Unit label as printed (e.g. "Pral 1a", "3º 2ª"); never an owner name'),
        presente_o_representado: AsistenciaEnum,
        coeficiente_pct: nnum().describe('Quota of the unit when printed next to it'),
      }),
    )
    .describe('One entry per unit listed as attending or represented'),
  quorum_pct: nnum().describe('Quorum percentage as printed'),
  quorum_unidades: nint().describe('Number of units attending as printed'),
  orden_del_dia: z.array(z.string()).describe('Agenda items as printed, in order'),
  acuerdos: z.array(AcuerdoSchema),
  cargos_elegidos: z.array(
    z.object({
      cargo: z.string().describe('Office as printed: president, vicepresident, secretari, administrador, vocal …'),
      entidad_label: z.string().describe('Unit label of the person elected, or the firm name for an administrator company; never a person name'),
    }),
  ),
  cuentas_aprobadas: nbool().describe('true when the annual accounts are approved in this meeting'),
  presupuesto_aprobado: nnum().describe('Annual budget amount approved when printed'),
  derramas_aprobadas: z.array(
    z.object({
      objeto: z.string(),
      importe_total: nnum(),
      importe_por_unidad: nnum().describe('Per-unit or per-month amount when printed'),
      criterio: nstr().describe('Distribution criterion as written (coeficient, parts iguals …)'),
      periodicidad: nstr(),
      inicio: nstr().describe('Start as written'),
    }),
  ),
  firmas: z.object({
    presidente: z.boolean(),
    secretario: z.boolean(),
    administrador: z.boolean(),
  }),
  fecha_cierre_acta: ndate().describe('Date the minutes were closed/signed when printed'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks(['coeficientes_asistentes_le_100', 'quorum_coincide_con_asistentes']),
  ...trailingFields(),
});

export type Acta = z.infer<typeof ActaSchema>;
export type Acuerdo = z.infer<typeof AcuerdoSchema>;
