/**
 * `dgsfp_manual` — the public registers of the insurance supervisor (Dirección General de
 * Seguros y Fondos de Pensiones): insurers on one portal, insurance distributors (agents,
 * brokers) on another (`MANUAL_SOURCES.dgsfp`).
 *
 * A manual check: the research report found no API and no confirmed identifier-keyed search, so
 * the reviewer opens the register that matches the party and captures the entry (clave
 * administrativa, situación, date). The situación vocabulary the report expects is Inscrita /
 * Revocada / En liquidación / Disuelta for insurers and Inscrito / Cancelado for distributors;
 * both lists are to verify.
 *
 * Scope: parties of kind `insurer`, and vendors that invoice insurance premiums or brokerage. The
 * check is registered but **not** in `VENDOR_DEFAULT_CHECKS`: `vx vendors check --all` runs on
 * every vendor, and a manual item for the insurance register on a builder or a lift maintainer
 * would be noise. Ask for it with `--only dgsfp_manual` on the party concerned.
 */
import { MANUAL_SOURCES } from '../config.ts';
import { manualCheck, nameAndNif } from './manual.ts';

/** Register of insurers (claves C####, E####, L####). */
export const DGSFP_INSURERS_URL = 'https://rrpp.dgsfp.mineco.es/';
/** Register of insurance distributors: agents, brokers (claves J####, F####, AV####, OV####). */
export const DGSFP_DISTRIBUTORS_URL = 'https://rrpp.dgsfp.mineco.es/Mediador';

export const dgsfpManual = manualCheck(
  'dgsfp_manual',
  'DGSFP — insurers and insurance distributors registers (manual lookup)',
  MANUAL_SOURCES.dgsfp,
  nameAndNif,
  {
    note:
      `For an insurance company open ${DGSFP_INSURERS_URL}; for an agent or a broker open ${DGSFP_DISTRIBUTORS_URL}. ` +
      'Capture the clave administrativa, the situación (Inscrita, Revocada, En liquidación, Disuelta; or Inscrito, Cancelado for a distributor) and the date. ' +
      'Applies to parties of kind insurer and to vendors invoicing insurance; not part of the default set.',
  },
);
