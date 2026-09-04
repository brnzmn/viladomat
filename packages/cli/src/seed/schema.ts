import { z } from 'zod';

/**
 * Seed file schema (YAML). Everything here is hand-transcribed from documents and must carry a
 * page reference; extraction later overwrites seed rows only through field revisions.
 * Roles only — never a person's name.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.number().finite();

export const seedUnit = z.object({
  label: z.string().min(1),
  floor: z.string().optional(),
  door: z.string().optional(),
  use: z.string().optional(),
  quota_pct: z.number().min(0).max(100).optional(),
  holder_role: z.enum(['president', 'requesting_owner', 'other_owner', 'unknown']).default('unknown'),
  notes: z.string().optional(),
});

export const seedResolution = z.object({
  punto: z.string().optional(),
  texto_literal: z.string().min(1),
  kind: z
    .enum(['works_approval', 'contractor_choice', 'budget', 'accounts', 'derrama', 'delegation', 'election', 'loan', 'subsidy', 'audit', 'info', 'other'])
    .default('other'),
  resultado: z.enum(['aprobado', 'rechazado', 'informado', 'pendiente']).default('aprobado'),
  importe_aprobado: money.optional(),
  tolerance_pct: z.number().optional(),
  works_package: z.string().optional(), // label of a works package in this file
  delegation_to_role: z.string().optional(),
  delegation_scope: z.string().optional(),
  delegation_cap: money.optional(),
  cap_explicit: z.boolean().optional(),
  voters_favor: z.number().int().optional(),
  voters_total: z.number().int().optional(),
  quotas_favor_pct: z.number().optional(),
  page_no: z.number().int().optional(),
});

export const seedMeeting = z.object({
  tipo: z.enum(['ordinaria', 'extraordinaria']),
  fecha: isoDate,
  convocatoria_fecha: isoDate.optional(),
  fecha_firma: isoDate.optional(),
  fecha_notificacion: isoDate.optional(),
  lugar: z.string().optional(),
  convened_by_role: z.string().optional(),
  quorum_pct: z.number().optional(),
  cuentas_aprobadas: z.boolean().optional(),
  presupuesto_aprobado: money.optional(),
  source_document_sha256: z.string().length(64).optional(),
  notes: z.string().optional(),
  resolutions: z.array(seedResolution).default([]),
});

export const seedWorksPackage = z.object({
  code: z.enum(['ELEVATOR', 'STAIRCASE', 'ENTRANCE_DOOR', 'INTERCOM', 'WINDOWS', 'PAINT_INT', 'REAR_FACADE', 'SEWER', 'DRAIN', 'OTHER']),
  label: z.string().min(1),
  status: z.enum(['planned', 'approved', 'contracted', 'in_progress', 'suspended', 'completed', 'unknown']).default('unknown'),
  architect_pem: money.optional(),
  permit_pem: money.optional(),
  subsidy_protegible: money.optional(),
  contract_price: money.optional(),
  suspension_date: isoDate.optional(),
  suspension_reason: z.enum(['seasonal', 'contractual', 'dispute', 'permit', 'unknown']).optional(),
  notes: z.string().optional(),
});

export const seedDerrama = z.object({
  objeto: z.string().min(1),
  works_package: z.string().optional(),
  resolution_ref: z.object({ meeting_fecha: isoDate, punto: z.string() }).optional(),
  criterio: z.enum(['coeficiente', 'partes_iguales', 'otro']).default('coeficiente'),
  importe_total: money.optional(),
  per_unit_amount: money.optional(),
  starts_on: isoDate.optional(),
  months: z.number().int().positive().optional(),
  bank_account: z.string().optional(),
});

export const seedBankAccount = z.object({
  label: z.string().min(1),
  iban_last4: z.string().length(4).optional(),
  bank_name: z.string().optional(),
  holder_kind: z.enum(['community', 'administrator_pooled', 'other', 'unknown']).default('unknown'),
  purpose: z.enum(['ordinary', 'reserve', 'works', 'unknown']).default('unknown'),
  titled_to_community: z.boolean().optional(),
  signatory_roles: z.array(z.string()).optional(),
});

export const seedLiquidation = z.object({
  ejercicio: z.number().int(),
  periodo_desde: isoDate.optional(),
  periodo_hasta: isoDate.optional(),
  total_ingresos: money.optional(),
  total_gastos: money.optional(),
  resultado: money.optional(),
  saldo_inicial: money.optional(),
  saldo_final: money.optional(),
  fondo_reserva_final: money.optional(),
  saldo_en_poder_administrador: money.optional(),
  deudores_total: money.optional(),
  basis: z.enum(['cash', 'accrual', 'mixed', 'unknown']).default('unknown'),
  lines: z
    .array(
      z.object({
        side: z.enum(['ingreso', 'gasto']),
        concepto: z.string(),
        proveedor_text: z.string().optional(),
        importe: money,
        presupuestado: money.optional(),
        capitulo: z.string().optional(),
      }),
    )
    .default([]),
});

export const seedParameter = z.object({
  key: z.string(),
  value_num: z.number().optional(),
  value_text: z.string().optional(),
  unit: z.string().optional(),
  basis_text: z.string().optional(),
  valid_from: isoDate.optional(),
});

export const seedRequest = z.object({
  class: z.enum([
    'accounts', 'budget', 'derrama_statement', 'invoices', 'bank_statements', 'bank_statements_norma43',
    'bank_holder_certificate', 'contracts', 'elevator_contract', 'certifications', 'permit', 'subsidy',
    'modelo_347', 'insurance_policy', 'related_party_declaration', 'statutes', 'other',
  ]),
  fiscal_year: z.number().int().optional(),
  description: z.string().optional(),
  requested_on: isoDate.optional(),
  requested_via: z.string().optional(),
  status: z.enum(['planned', 'requested', 'partial', 'received', 'inspected_only', 'refused']).default('planned'),
  legal_basis: z.string().optional(),
});

export const seedFile = z.object({
  community: z.object({
    name: z.string().min(1),
    nif: z.string().optional(),
    address: z.string().optional(),
    fy_start_month: z.number().int().min(1).max(12).default(1),
    ordinary_budget_default: money.optional(),
    catastro_rc: z.string().optional(),
  }),
  request_clock: z
    .object({
      request_date: isoDate.optional(),
      quotas_pct_requesting: z.number().optional(),
      units_requesting: z.number().int().optional(),
      convocation_date: isoDate.optional(),
      junta_date: isoDate.optional(),
      docs_available_from: isoDate.optional(),
      status: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  parameters: z.array(seedParameter).default([]),
  parameter_basis: z
    .object({ works_spend_under_review: money.optional(), ordinary_budget: money.optional() })
    .optional(),
  units: z.array(seedUnit).default([]),
  community_rules: z
    .array(z.object({ topic: z.enum(['quota_criterion', 'works_threshold', 'delegation_limit', 'reserve_fund', 'meeting', 'other']), text_literal: z.string(), page_no: z.number().int().optional() }))
    .default([]),
  works_packages: z.array(seedWorksPackage).default([]),
  bank_accounts: z.array(seedBankAccount).default([]),
  meetings: z.array(seedMeeting).default([]),
  derramas: z.array(seedDerrama).default([]),
  liquidations: z.array(seedLiquidation).default([]),
  document_requests: z.array(seedRequest).default([]),
});

export type SeedFile = z.infer<typeof seedFile>;
