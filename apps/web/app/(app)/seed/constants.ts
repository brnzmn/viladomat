import type { Enums } from '@/lib/database.types';

export const SEED_TABS = [
  { key: 'community', label: 'Community' },
  { key: 'units', label: 'Units' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'resolutions', label: 'Resolutions' },
  { key: 'works_packages', label: 'Works packages' },
  { key: 'derramas', label: 'Derramas' },
  { key: 'bank_accounts', label: 'Bank accounts' },
  { key: 'request_clock', label: 'Request clock' },
  { key: 'parameters', label: 'Parameters' },
  { key: 'community_rules', label: 'Community rules' },
] as const;

export type SeedTab = (typeof SEED_TABS)[number]['key'];

export const HOLDER_ROLES: readonly Enums<'holder_role'>[] = ['president', 'requesting_owner', 'other_owner', 'unknown'];
export const MEETING_KINDS: readonly Enums<'meeting_kind'>[] = ['ordinaria', 'extraordinaria'];
export const RESOLUTION_KINDS: readonly Enums<'resolution_kind'>[] = [
  'works_approval',
  'contractor_choice',
  'budget',
  'accounts',
  'derrama',
  'delegation',
  'election',
  'loan',
  'subsidy',
  'audit',
  'info',
  'other',
];
export const RESOLUTION_RESULTS: readonly Enums<'resolution_result'>[] = ['aprobado', 'rechazado', 'informado', 'pendiente'];
export const WORKS_CODES: readonly Enums<'works_code'>[] = [
  'ELEVATOR',
  'STAIRCASE',
  'ENTRANCE_DOOR',
  'INTERCOM',
  'WINDOWS',
  'PAINT_INT',
  'REAR_FACADE',
  'SEWER',
  'DRAIN',
  'OTHER',
];
export const WORKS_STATUSES: readonly Enums<'works_status'>[] = [
  'planned',
  'approved',
  'contracted',
  'in_progress',
  'suspended',
  'completed',
  'unknown',
];
export const SUSPENSION_REASONS: readonly Enums<'suspension_reason'>[] = ['seasonal', 'contractual', 'dispute', 'permit', 'unknown'];
export const DERRAMA_CRITERIOS: readonly Enums<'derrama_criterio'>[] = ['coeficiente', 'partes_iguales', 'otro'];
export const HOLDER_KINDS: readonly Enums<'holder_kind'>[] = ['community', 'administrator_pooled', 'other', 'unknown'];
export const ACCOUNT_PURPOSES: readonly Enums<'account_purpose'>[] = ['ordinary', 'reserve', 'works', 'unknown'];
export const RULE_TOPICS: readonly Enums<'rule_topic'>[] = [
  'quota_criterion',
  'works_threshold',
  'delegation_limit',
  'reserve_fund',
  'meeting',
  'other',
];
export const DELEGATION_ROLES = ['president', 'administrator', 'president_and_administrator', 'works_committee', 'other'] as const;
export const REQUEST_CLOCK_STATUSES = ['drafted', 'sent', 'acknowledged', 'convened', 'held', 'unanswered'] as const;

/** Parameter keys known to the rules engine (free text is also accepted). */
export const PARAMETER_KEYS = [
  'pm_works',
  'pm_ordinary',
  'trivial_floor',
  'outflow_min',
  'authority_threshold',
  'funding_gap_min',
  'upfront_max_pct_obra',
  'upfront_max_pct_ascensor',
  'cash_limit',
  'reserve_fund_min_pct',
] as const;
