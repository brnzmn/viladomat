/**
 * Minimal ISO 20022 camt.053 (bank-to-customer statement) mapper without external XML
 * dependencies. A small tolerant tag walker builds a tree; namespaces are ignored and
 * unknown elements are skipped. Produces the same movement shape as the Norma 43 parser.
 */
import { roundCents, toCents, type BankMovement } from './types.ts';

/** Minimal XML element tree used by the walker. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function localName(qualified: string): string {
  const idx = qualified.indexOf(':');
  return idx >= 0 ? qualified.slice(idx + 1) : qualified;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[localName(m[1] ?? '')] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/**
 * Tolerant XML parser: handles comments, CDATA, processing instructions, self-closing tags
 * and entities. Mismatched closing tags pop to the nearest matching ancestor; unmatched
 * ones are ignored. Returns a synthetic root whose children are the top-level elements.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1] ?? root;
    if (lt < 0) {
      top.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      top.text += xml.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    const body = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = localName(body.slice(1).trim());
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]?.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const spaceIdx = inner.search(/\s/);
    const rawName = spaceIdx < 0 ? inner : inner.slice(0, spaceIdx);
    const node: XmlNode = {
      name: localName(rawName),
      attrs: spaceIdx < 0 ? {} : parseAttrs(inner.slice(spaceIdx)),
      children: [],
      text: '',
    };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** First child element with the given local name. */
export function xmlChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** All child elements with the given local name. */
export function xmlChildren(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Follow a `/`-separated path of local names, returning the first match at each step. */
export function xmlPath(node: XmlNode | undefined, path: string): XmlNode | undefined {
  let cur = node;
  for (const step of path.split('/')) {
    cur = xmlChild(cur, step);
    if (!cur) return undefined;
  }
  return cur;
}

/** Trimmed text of a node (or of a path under it); empty string when absent. */
export function xmlText(node: XmlNode | undefined, path?: string): string {
  const target = path ? xmlPath(node, path) : node;
  return target ? target.text.replace(/\s+/g, ' ').trim() : '';
}

/** Depth-first search for the first descendant with a local name. */
export function xmlFind(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deeper = xmlFind(c, name);
    if (deeper) return deeper;
  }
  return undefined;
}

/** Depth-first collection of all descendants with a local name. */
export function xmlFindAll(
  node: XmlNode | undefined,
  name: string,
  out: XmlNode[] = [],
): XmlNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    xmlFindAll(c, name, out);
  }
  return out;
}

/** One balance entry of a statement. */
export interface CamtBalance {
  /** `OPBD`, `CLBD`, `PRCD`, `ITBD`, … */
  type: string;
  amount: number;
  currency: string;
  date: string;
}

/** One statement (`Stmt`) of a camt.053 document. */
export interface CamtStatement {
  statementId: string;
  iban: string;
  currency: string;
  holderName: string;
  periodFrom: string;
  periodTo: string;
  /** `OPBD` amount (signed), or null when absent. */
  openingBalance: number | null;
  /** `CLBD` amount (signed), or null when absent. */
  closingBalance: number | null;
  balances: CamtBalance[];
  movements: BankMovement[];
  /** True when opening + Σ movements = closing (requires both balances). */
  selfCheckOk: boolean;
}

/** Result of {@link parseCamt053}. */
export interface CamtFile {
  statements: CamtStatement[];
  warnings: string[];
}

function parseAmountNode(node: XmlNode | undefined): { amount: number; currency: string } | null {
  if (!node) return null;
  const amount = Number(node.text.trim());
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: node.attrs['Ccy'] ?? '' };
}

/** `Dt` or `DtTm` child reduced to an ISO date. */
function dateOf(node: XmlNode | undefined): string {
  if (!node) return '';
  const dt = xmlText(node, 'Dt') || xmlText(node, 'DtTm') || xmlText(node);
  const m = /(\d{4}-\d{2}-\d{2})/.exec(dt);
  return m?.[1] ?? '';
}

/** Party name: camt.053 v2 uses `Dbtr/Nm`; later versions wrap it as `Dbtr/Pty/Nm`. */
function partyName(party: XmlNode | undefined): string {
  return xmlText(party, 'Nm') || xmlText(party, 'Pty/Nm');
}

function accountIban(acct: XmlNode | undefined): string {
  return xmlText(acct, 'Id/IBAN') || xmlText(acct, 'Id/Othr/Id');
}

function signFor(cdtDbtInd: string): number {
  return cdtDbtInd.toUpperCase() === 'DBIT' ? -1 : 1;
}

function mapEntry(ntry: XmlNode, warnings: string[], index: number): BankMovement | null {
  const amt = parseAmountNode(xmlChild(ntry, 'Amt'));
  if (!amt) {
    warnings.push(`entry ${index + 1}: amount missing or unreadable; skipped`);
    return null;
  }
  const sign = signFor(xmlText(ntry, 'CdtDbtInd'));
  const opDate = dateOf(xmlChild(ntry, 'BookgDt'));
  const valueDate = dateOf(xmlChild(ntry, 'ValDt')) || opDate;
  if (!opDate) warnings.push(`entry ${index + 1}: booking date missing`);

  const bkTxCd = xmlChild(ntry, 'BkTxCd');
  const domain = [
    xmlText(bkTxCd, 'Domn/Cd'),
    xmlText(bkTxCd, 'Domn/Fmly/Cd'),
    xmlText(bkTxCd, 'Domn/Fmly/SubFmlyCd'),
  ].filter(Boolean);
  const proprietary = xmlText(bkTxCd, 'Prtry/Cd');

  const txDetails = xmlFindAll(xmlChild(ntry, 'NtryDtls'), 'TxDtls');
  const ustrd: string[] = [];
  let counterpartyText = '';
  let counterpartyIban = '';
  let endToEndId = '';
  for (const tx of txDetails) {
    for (const u of xmlFindAll(xmlChild(tx, 'RmtInf'), 'Ustrd')) {
      const t = xmlText(u);
      if (t) ustrd.push(t);
    }
    const parties = xmlChild(tx, 'RltdPties');
    if (parties && !counterpartyText) {
      counterpartyText =
        sign < 0
          ? partyName(xmlChild(parties, 'Cdtr')) || partyName(xmlChild(parties, 'UltmtCdtr'))
          : partyName(xmlChild(parties, 'Dbtr')) || partyName(xmlChild(parties, 'UltmtDbtr'));
      counterpartyIban =
        sign < 0
          ? accountIban(xmlChild(parties, 'CdtrAcct'))
          : accountIban(xmlChild(parties, 'DbtrAcct'));
    }
    if (!endToEndId) endToEndId = xmlText(tx, 'Refs/EndToEndId');
  }
  const addtl = xmlText(ntry, 'AddtlNtryInf');
  if (addtl && !ustrd.includes(addtl)) ustrd.push(addtl);

  const movement: BankMovement = {
    opDate,
    valueDate,
    conceptoComun: '',
    conceptoPropio: proprietary,
    amount: roundCents(sign * amt.amount),
    documentNumber: endToEndId,
    ref1: xmlText(ntry, 'NtryRef'),
    ref2: xmlText(ntry, 'AcctSvcrRef'),
    extraConcepts: ustrd,
    counterpartyText: counterpartyText || ustrd.join(' '),
  };
  if (counterpartyIban)
    movement.counterpartyIban = counterpartyIban.replace(/\s+/g, '').toUpperCase();
  if (domain.length > 0) movement.bankTxCode = domain.join('/');
  return movement;
}

function mapStatement(stmt: XmlNode, warnings: string[]): CamtStatement {
  const acct = xmlChild(stmt, 'Acct');
  const balances: CamtBalance[] = [];
  for (const bal of xmlChildren(stmt, 'Bal')) {
    const type = xmlText(bal, 'Tp/CdOrPrtry/Cd') || xmlText(bal, 'Tp/CdOrPrtry/Prtry');
    const amt = parseAmountNode(xmlChild(bal, 'Amt'));
    if (!amt) {
      warnings.push(`balance ${type || '?'}: amount unreadable`);
      continue;
    }
    balances.push({
      type,
      amount: roundCents(signFor(xmlText(bal, 'CdtDbtInd')) * amt.amount),
      currency: amt.currency,
      date: dateOf(xmlChild(bal, 'Dt')),
    });
  }
  const opening =
    balances.find((b) => b.type === 'OPBD') ?? balances.find((b) => b.type === 'PRCD');
  const closing = balances.find((b) => b.type === 'CLBD');

  const movements: BankMovement[] = [];
  xmlChildren(stmt, 'Ntry').forEach((ntry, index) => {
    const mv = mapEntry(ntry, warnings, index);
    if (mv) movements.push(mv);
  });

  let selfCheckOk = false;
  if (opening && closing) {
    const derived = movements.reduce(
      (acc, mv) => acc + toCents(mv.amount),
      toCents(opening.amount),
    );
    selfCheckOk = derived === toCents(closing.amount);
    if (!selfCheckOk) {
      warnings.push(
        `statement ${xmlText(stmt, 'Id') || '?'}: opening balance plus movements (${(derived / 100).toFixed(2)}) differs from closing balance (${closing.amount.toFixed(2)})`,
      );
    }
  } else {
    warnings.push(`statement ${xmlText(stmt, 'Id') || '?'}: opening or closing balance missing`);
  }

  return {
    statementId: xmlText(stmt, 'Id'),
    iban: accountIban(acct).replace(/\s+/g, '').toUpperCase(),
    currency: xmlText(acct, 'Ccy') || opening?.currency || closing?.currency || '',
    holderName: xmlText(acct, 'Ownr/Nm'),
    periodFrom: dateOf(xmlChild(xmlChild(stmt, 'FrToDt'), 'FrDtTm')),
    periodTo: dateOf(xmlChild(xmlChild(stmt, 'FrToDt'), 'ToDtTm')),
    openingBalance: opening ? opening.amount : null,
    closingBalance: closing ? closing.amount : null,
    balances,
    movements,
    selfCheckOk,
  };
}

/**
 * Map a camt.053 XML document to statements and movements. Amounts are signed by
 * `CdtDbtInd` (DBIT negative). Counterparty name/IBAN come from `RltdPties`
 * (creditor for debits, debtor for credits); remittance `Ustrd` lines are joined into
 * `extraConcepts` and used as counterparty text when no party name is present.
 */
export function parseCamt053(xml: string): CamtFile {
  const warnings: string[] = [];
  const root = parseXml(xml);
  const stmts = xmlFindAll(root, 'Stmt');
  if (stmts.length === 0) warnings.push('no Stmt element found');
  const statements = stmts.map((s) => mapStatement(s, warnings));
  return { statements, warnings };
}
