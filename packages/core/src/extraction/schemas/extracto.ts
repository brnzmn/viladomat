/**
 * Bank statement schema (extracto bancario / extracte bancari) for photographed or PDF statements.
 * Native exports (Norma 43, camt.053, CSV) are parsed deterministically in `../bank/` and never
 * pass through here. Maps to `public.bank_statements` and `public.bank_transactions`.
 *
 * Data minimisation: counterparty names are transcribed only for legal entities. A natural person
 * is reported through `contraparte_es_persona_fisica` and, when visible in the concept, the unit
 * label (`unit_hint`); the IBAN (pseudonymised downstream) remains the matching key.
 */
import { z } from 'zod';
import {
  BBOX_DESCRIPTION,
  anotacionManuscrita,
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

export const MovimientoSchema = z.object({
  fecha_operacion: ndate().describe('Operation date, ISO (year taken from the statement header when the row shows only day/month)'),
  fecha_valor: ndate().describe('Value date when printed'),
  concepto: z
    .string()
    .describe(
      'Concept text as printed, original language. A natural person\'s name inside it is replaced by "[persona]"; everything else verbatim.',
    ),
  importe: z
    .number()
    .describe('Signed amount: negative for debits (cargos), positive for credits (abonos)'),
  saldo_tras: nnum().describe('Balance after the movement when the statement prints a running balance'),
  contraparte_nombre: nstr().describe('Counterparty name when it is a legal entity (company, administration, bank, community); null for a natural person'),
  contraparte_es_persona_fisica: nbool().describe('true when the counterparty is a natural person; null when unknown'),
  contraparte_iban: nstr().describe('Counterparty IBAN/account as printed, when shown'),
  referencia: nstr().describe('Reference / mandate / document number printed with the movement'),
  unit_hint: nstr().describe('Unit label exactly as printed inside the concept (e.g. "3º 2ª", "Pral 1a"); else null'),
  page_index: z.number().int().describe('0-based page where the row is printed'),
  bbox: z.array(z.number()).nullable().describe(`Box of the whole row: ${BBOX_DESCRIPTION}`),
});

export const ExtractoSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['extracto_bancario']),
  banco: nstr().describe('Bank name as printed'),
  iban_o_cuenta_mostrada: nstr().describe('Account identifier exactly as printed (full or masked IBAN, CCC)'),
  titular: nstr().describe('Account holder as printed when it is a legal entity (community, administrator firm); null for a natural person'),
  titular_es_persona_fisica: nbool(),
  periodo: periodo().describe('Statement period as printed'),
  fecha_emision: ndate().describe('Statement issue date when printed'),
  moneda: nstr().describe('Currency as printed (EUR)'),
  paginacion: z
    .object({
      pagina: nint().describe('Page number printed on the statement'),
      de: nint().describe('Total pages printed on the statement'),
    })
    .describe('Statement pagination when printed'),
  saldo_inicial: nnum().describe('Opening balance as printed ("saldo anterior", "saldo inicial")'),
  saldo_final: nnum().describe('Closing balance as printed'),
  movimientos: z.array(MovimientoSchema),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray().describe(
    'Statement-level fields (balances, IBAN, holder, period). Rows carry their own page_index and bbox.',
  ),
  self_checks: selfChecks([
    'saldo_inicial_mas_movimientos_es_saldo_final',
    'saldos_intermedios_consistentes',
  ]),
  ...trailingFields(),
});

export type Extracto = z.infer<typeof ExtractoSchema>;
export type Movimiento = z.infer<typeof MovimientoSchema>;
