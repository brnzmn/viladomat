/**
 * Rule registry: every rule module exports `Record<code, Rule>` and they are merged here,
 * so the runner has one place to read. Codes must exist in `public.rules` (0009 catalogue).
 */
import type { Rule } from './engine.ts';
import { M0_RULES } from './m0.ts';
import { M3_RULES } from './m3.ts';
import { M5_RULES } from './m5.ts';

export const ALL_RULES: Record<string, Rule> = { ...M0_RULES, ...M3_RULES, ...M5_RULES };

export { M0_RULES, M3_RULES, M5_RULES };
