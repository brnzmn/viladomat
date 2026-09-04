/**
 * Transaction classification from statement text, with the Norma 43 `concepto común`
 * as a secondary signal. Output kinds and flags are descriptive labels used by the
 * reconciliation rules; they carry no judgement about the transaction.
 */
import { stripDiacritics } from '../text/amounts.ts';

/** Transaction kinds. */
export type TxKind =
  | 'transfer_out'
  | 'transfer_in'
  | 'direct_debit'
  | 'fee'
  | 'tax'
  | 'card'
  | 'cash'
  | 'cheque'
  | 'bizum'
  | 'internal'
  | 'interest'
  | 'loan'
  | 'subsidy'
  | 'quota_in'
  | 'refund'
  | 'returned'
  | 'other';

/** Input of {@link classifyTransaction}. */
export interface ClassifyInput {
  /** Signed amount (negative = debit). */
  amount: number;
  /** Norma 43 `concepto común`, when available. */
  conceptoComun?: string;
  /** Description / remittance text. */
  conceptText?: string;
  /** Text naming the other party. */
  counterpartyText?: string;
  /** Other party's IBAN, when available. */
  counterpartyIban?: string;
}

/** Result of {@link classifyTransaction}. */
export interface Classification {
  txKind: TxKind;
  flags: string[];
}

/** Upper-case, accent-free, single-spaced text for regex matching. */
export function normaliseTxText(...parts: (string | undefined)[]): string {
  return stripDiacritics(parts.filter(Boolean).join(' ').normalize('NFKC'))
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const RE_BIZUM = /\bBIZUM\b/;
const RE_CASH =
  /\bREINTEGR|\bEFECTIU\b|\bEFECTIVO\b|\bDISP\.? ?EFECTIVO|\bCAJERO\b|\bCAIXER\b|\bRETIRADA\b|\bINGRESO (EN )?EFECTIVO|\bINGRES (EN )?EFECTIU/;
const RE_CHEQUE = /\bCHEQUE|\bTALON\b|\bXEC\b|\bPAGARE\b/;
const RE_FEE =
  /\bCOMISION|\bCOMISSIO|\bGASTOS DE (MANTENIMIENTO|ADMINISTRACION)|\bCUOTA (DE )?MANTENIMIENTO|\bQUOTA (DE )?MANTENIMENT|\bLIQ\.? ?COMISION|\bSERVICIO DE CUENTA/;
const RE_INTEREST = /\bINTERES(ES)?\b|\bINTERESSOS\b|\bLIQ(UIDACION)? ?INT(ERESES)?\b/;
const RE_TAX =
  /\bIMPUEST|\bIMPOST|\bAEAT\b|\bHACIENDA\b|\bAGENCIA TRIBUTARIA|\bAJUNTAMENT\b|\bAYUNTAMIENTO\b|\bIBI\b|\bTRIBUT|\bTGSS\b|\bSEGURIDAD SOCIAL|\bSEGURETAT SOCIAL|\bMODELO \d{3}\b|\bTAXA\b|\bTASA\b/;
const RE_LOAN =
  /\bPRESTAMO|\bPRESTEC\b|\bAMORTIZACION|\bAMORTITZACIO|\bHIPOTECA|\bCUOTA PRESTAMO|\bQUOTA PRESTEC/;
const RE_SUBSIDY =
  /\bSUBVENCIO|\bCONSORCI\b|\bGENERALITAT\b|\bAJUT\b|\bAYUDA\b|\bINSTITUT MUNICIPAL|\bFONDOS NEXT|\bNEXT GENERATION/;
const RE_RETURNED =
  /\bDEVOL|\bIMPAGAD|\bRETORN|\bDEVUELT|\bRECHAZ|\bREBUT RETORNAT|\bRECIBO DEVUELTO/;
const RE_REFUND = /\bDEVOL|\bRETROCES|\bREEMBOLS|\bREINTEGRO DE\b/;
const RE_CARD =
  /\bTARJETA|\bTARGETA|\bCARD\b|\bTPV\b|\bCOMPRA (EN|A)\b|\bPAGO CON TARJETA|\bVISA\b|\bMASTERCARD\b/;
const RE_INTERNAL =
  /\bTRASPAS|\bTRANSFERENCIA INTERNA|\bCUENTA PROPIA|\bENTRE CUENTAS|\bCOMPTE PROPI|\bENTRE COMPTES/;
const RE_TRANSFER =
  /\bTRANSF|\bTRANSFERENCIA|\bORDEN DE PAGO|\bORDRE DE PAGAMENT|\bSEPA CREDIT|\bABONO POR TRANSF|\bEMITIDA\b/;
const RE_DIRECT_DEBIT =
  /\bRECIBO|\bREBUT|\bADEUDO|\bDOMICILIAC|\bSEPA DIRECT|\bSDD\b|\bCORE\b|\bCARREC\b|\bDOMICILIAT/;
const RE_QUOTA_IN =
  /\bCUOTA|\bQUOTA|\bCOMUNIDAD|\bCOMUNITAT|\bDERRAMA|\bREMESA|\bPROPIETARI|\bPROPIETARIO|\bVECINO|\bVEI\b/;

/** Legal-form tokens that mark a counterparty as an entity rather than a natural person. */
const RE_LEGAL_FORM =
  /\b(S\.?L\.?U?\.?|S\.?A\.?U?\.?|S\.?C\.?P\.?|S\.?C\.?C\.?L\.?P?\.?|C\.?B\.?|S\.?L\.?L\.?|S\.?COOP\.?|COOP|AIE|UTE|SRL|LTD|GMBH|INC|PLC|BV|NV|SARL)\b/;
/** Organisation words that also rule out a natural person. */
const RE_ORGANISATION =
  /\b(BANCO|BANK|BANCA|CAIXA|CAJA|AJUNTAMENT|AYUNTAMIENTO|AEAT|AGENCIA|GENERALITAT|CONSORCI|DIPUTACIO|MINISTERIO|SEGUROS|ASSEGURANCES|MUTUA|COMPANYIA|COMPAÑIA|COMPANIA|COMUNIDAD|COMUNITAT|ASCENSOR|ASCENSORS|ASCENSORES|INSTALACION|INSTALLACIONS|INSTALACIONES|SERVICIOS|SERVEIS|FUNDACIO|FUNDACION|ASSOCIACIO|ASOCIACION|COOPERATIVA|ENERGIA|ELECTRICA|GAS|AIGUES|AGUAS|TELEFONICA|ADMINISTRACION|ADMINISTRADOR|ADMINISTRADORES|FINQUES|FINCAS|CONSTRUCCIONS|CONSTRUCCIONES|OBRES|OBRAS|REFORMES|REFORMAS|NETEJA|LIMPIEZA|LIMPIEZAS|MANTENIMENT|MANTENIMIENTO|SUMINISTROS|SUBMINISTRAMENTS|TECNIC|TECNICO|GRUP|GRUPO|COMERCIAL|INDUSTRIAL|EMPRESA|COMPANY|BIZUM)\b/;

/** True when the counterparty text looks like a natural person's name. */
export function looksLikePersonName(text: string | undefined): boolean {
  const t = normaliseTxText(text);
  if (!t) return false;
  if (RE_LEGAL_FORM.test(t) || RE_ORGANISATION.test(t)) return false;
  const tokens = t.split(' ');
  if (tokens.length < 2 || tokens.length > 6) return false;
  return tokens.every((tk) => /^[A-Z][A-Z'-]*$/.test(tk));
}

/** True for amounts that are a multiple of 100 and at least 500 in absolute value. */
export function isRoundAmount(amount: number): boolean {
  const abs = Math.abs(amount);
  return abs >= 500 && Math.abs(abs / 100 - Math.round(abs / 100)) < 1e-9;
}

/** Kinds for which a person-looking counterparty is worth flagging (debits only). */
const PERSON_FLAG_KINDS: ReadonlySet<TxKind> = new Set([
  'transfer_out',
  'direct_debit',
  'bizum',
  'card',
  'cheque',
  'other',
  'loan',
  'returned',
]);

/** Secondary classification from the Norma 43 `concepto común` code. */
function kindFromConcepto(code: string | undefined, amount: number): TxKind | undefined {
  const debit = amount < 0;
  switch (code) {
    case '01':
      return 'cash';
    case '03':
      return debit ? 'direct_debit' : 'quota_in';
    case '04':
    case '13':
      return debit ? 'transfer_out' : 'transfer_in';
    case '05':
      return 'loan';
    case '10':
      return 'cheque';
    case '12':
      return 'card';
    case '14':
      return debit ? 'returned' : 'refund';
    case '16':
      return 'tax';
    case '17':
      return debit ? 'fee' : 'interest';
    case '08':
      return 'interest';
    default:
      return undefined;
  }
}

/**
 * Classify a transaction from its text (primary signal) and its `concepto común`
 * (secondary). Text regexes are evaluated in priority order (Bizum, cash, cheque, fee,
 * interest, tax, loan, subsidy, returned/refund, card, internal, transfers, direct debits,
 * quota credits). Flags: `cash`, `bizum`, `card`, `person_beneficiary`, `foreign_iban`,
 * `round_amount`, `reversal`.
 */
export function classifyTransaction(input: ClassifyInput): Classification {
  const text = normaliseTxText(input.conceptText, input.counterpartyText);
  const debit = input.amount < 0;
  const credit = input.amount > 0;
  const flags: string[] = [];
  let kind: TxKind | undefined;

  if (RE_BIZUM.test(text)) kind = 'bizum';
  else if (RE_CASH.test(text) && !RE_REFUND.test(text)) kind = 'cash';
  else if (RE_CHEQUE.test(text)) kind = 'cheque';
  else if (RE_FEE.test(text)) kind = 'fee';
  else if (RE_INTEREST.test(text)) kind = 'interest';
  else if (RE_TAX.test(text)) kind = 'tax';
  else if (RE_LOAN.test(text)) kind = 'loan';
  else if (credit && RE_SUBSIDY.test(text)) kind = 'subsidy';
  else if (debit && RE_RETURNED.test(text)) kind = 'returned';
  else if (credit && RE_REFUND.test(text)) kind = 'refund';
  else if (RE_CARD.test(text)) kind = 'card';
  else if (RE_INTERNAL.test(text)) kind = 'internal';
  else if (credit && RE_QUOTA_IN.test(text)) kind = 'quota_in';
  else if (RE_TRANSFER.test(text)) kind = debit ? 'transfer_out' : 'transfer_in';
  else if (RE_DIRECT_DEBIT.test(text)) kind = debit ? 'direct_debit' : 'quota_in';

  if (!kind) kind = kindFromConcepto(input.conceptoComun, input.amount);
  if (!kind) kind = 'other';

  if (kind === 'cash') flags.push('cash');
  if (kind === 'bizum') flags.push('bizum');
  if (kind === 'card') flags.push('card');
  if (input.conceptoComun === '98') flags.push('reversal');
  if (debit && PERSON_FLAG_KINDS.has(kind) && looksLikePersonName(input.counterpartyText)) {
    flags.push('person_beneficiary');
  }
  const iban = (input.counterpartyIban ?? '').replace(/\s+/g, '').toUpperCase();
  if (iban && !iban.startsWith('ES')) flags.push('foreign_iban');
  if (isRoundAmount(input.amount)) flags.push('round_amount');

  return { txKind: kind, flags };
}

/** Minimal shape accepted by {@link detectRecurringDirectDebits}. */
export interface ClassifiedTransaction {
  amount: number;
  counterpartyText?: string;
  txKind: TxKind;
  flags: string[];
}

/** Key identifying a direct-debit issuer: alphabetic tokens of the counterparty text. */
export function counterpartyKey(text: string | undefined): string {
  return normaliseTxText(text)
    .split(' ')
    .filter((tk) => /^[A-Z][A-Z'-]*$/.test(tk) && !RE_DIRECT_DEBIT.test(tk))
    .slice(0, 4)
    .join(' ');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Mark recurring direct debits: transactions of kind `direct_debit` sharing a counterparty
 * key at least three times form a series; members within ±30% of the series' median
 * absolute amount receive the flag `direct_debit_recurring`. Returns new objects; the
 * input is not mutated.
 */
export function detectRecurringDirectDebits<T extends ClassifiedTransaction>(
  transactions: readonly T[],
): T[] {
  const groups = new Map<string, number[]>();
  transactions.forEach((tx, index) => {
    if (tx.txKind !== 'direct_debit') return;
    const key = counterpartyKey(tx.counterpartyText);
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push(index);
    groups.set(key, list);
  });
  const recurring = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 3) continue;
    const med = median(indexes.map((i) => Math.abs(transactions[i]?.amount ?? 0)));
    if (med <= 0) continue;
    for (const i of indexes) {
      const abs = Math.abs(transactions[i]?.amount ?? 0);
      if (abs >= med * 0.7 && abs <= med * 1.3) recurring.add(i);
    }
  }
  return transactions.map((tx, index) => {
    if (!recurring.has(index) || tx.flags.includes('direct_debit_recurring')) {
      return { ...tx, flags: [...tx.flags] };
    }
    return { ...tx, flags: [...tx.flags, 'direct_debit_recurring'] };
  });
}
