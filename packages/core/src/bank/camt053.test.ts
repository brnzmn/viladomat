import { describe, expect, it } from 'vitest';
import { parseCamt053, parseXml, xmlFindAll, xmlPath, xmlText } from './camt053.ts';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- synthetic statement -->
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-1</MsgId><CreDtTm>2023-02-01T06:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-2023-01</Id>
      <FrToDt><FrDtTm>2023-01-01T00:00:00</FrDtTm><ToDtTm>2023-01-31T23:59:59</ToDtTm></FrToDt>
      <Acct>
        <Id><IBAN>ES91 2100 0418 4502 0005 1332</IBAN></Id>
        <Ccy>EUR</Ccy>
        <Ownr><Nm>COM PROP EXEMPLE 25</Nm></Ownr>
      </Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">5000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2023-01-01</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">3376.54</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2023-01-31</Dt></Dt>
      </Bal>
      <Ntry>
        <NtryRef>NREF-1</NtryRef>
        <Amt Ccy="EUR">2500.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2023-01-05</Dt></BookgDt>
        <ValDt><Dt>2023-01-05</Dt></ValDt>
        <AcctSvcrRef>SVC-0001</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn><Prtry><Cd>025</Cd></Prtry></BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>E2E-FRA-2023-001</EndToEndId></Refs>
            <RltdPties>
              <Cdtr><Nm>Vendor A Obres &amp; Reformes, S.L.</Nm></Cdtr>
              <CdtrAcct><Id><IBAN>ES9121000418450200051332</IBAN></Id></CdtrAcct>
            </RltdPties>
            <RmtInf><Ustrd>FRA 2023-001</Ustrd><Ustrd>REFORMA VESTIBUL</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">876.54</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><DtTm>2023-01-20T10:00:00</DtTm></BookgDt>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Dbtr><Pty><Nm>PROPIETARI UNITAT 3A</Nm></Pty></Dbtr>
              <DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>
            </RltdPties>
            <RmtInf><Ustrd><![CDATA[QUOTA GENER <3A>]]></Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
        <AddtlNtryInf>TRANSFERENCIA RECIBIDA</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">0.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2023-01-25</Dt></BookgDt>
        <AddtlNtryInf>COMISION MANTENIMIENTO</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('parseXml', () => {
  it('builds a tree with namespaces stripped, entities decoded and CDATA kept', () => {
    const root = parseXml(XML);
    expect(xmlPath(root, 'Document/BkToCstmrStmt/GrpHdr/MsgId')?.text).toBe('MSG-1');
    const nm = xmlFindAll(root, 'Cdtr')[0];
    expect(xmlText(nm, 'Nm')).toBe('Vendor A Obres & Reformes, S.L.');
    expect(xmlFindAll(root, 'Ustrd').map((u) => xmlText(u))).toContain('QUOTA GENER <3A>');
  });
  it('tolerates self-closing tags, attributes with single quotes and mismatched closers', () => {
    const root = parseXml(`<a x='1' y="2"><b/><c>t</c></wrong></a><d>z</d>`);
    const a = xmlPath(root, 'a');
    expect(a?.attrs).toEqual({ x: '1', y: '2' });
    expect(a?.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(xmlText(root, 'd')).toBe('z');
  });
  it('strips namespace prefixes from names and attributes', () => {
    const root = parseXml(`<ns:Doc ns:k="v"><ns:Amt Ccy="EUR">1.50</ns:Amt></ns:Doc>`);
    expect(xmlPath(root, 'Doc/Amt')?.attrs['Ccy']).toBe('EUR');
    expect(xmlPath(root, 'Doc')?.attrs['k']).toBe('v');
  });
});

describe('parseCamt053', () => {
  const result = parseCamt053(XML);
  const stmt = result.statements[0]!;

  it('maps the statement header and balances', () => {
    expect(result.statements).toHaveLength(1);
    expect(stmt).toMatchObject({
      statementId: 'STMT-2023-01',
      iban: 'ES9121000418450200051332',
      currency: 'EUR',
      holderName: 'COM PROP EXEMPLE 25',
      periodFrom: '2023-01-01',
      periodTo: '2023-01-31',
      openingBalance: 5000,
      closingBalance: 3376.54,
    });
    expect(stmt.balances.map((b) => b.type)).toEqual(['OPBD', 'CLBD']);
  });

  it('maps a debit entry with creditor party, IBAN, references and remittance lines', () => {
    const mv = stmt.movements[0]!;
    expect(mv).toMatchObject({
      opDate: '2023-01-05',
      valueDate: '2023-01-05',
      amount: -2500,
      conceptoComun: '',
      conceptoPropio: '025',
      documentNumber: 'E2E-FRA-2023-001',
      ref1: 'NREF-1',
      ref2: 'SVC-0001',
      counterpartyText: 'Vendor A Obres & Reformes, S.L.',
      counterpartyIban: 'ES9121000418450200051332',
      bankTxCode: 'PMNT/ICDT/ESCT',
    });
    expect(mv.extraConcepts).toEqual(['FRA 2023-001', 'REFORMA VESTIBUL']);
  });

  it('maps a credit entry with debtor party under Pty, a DtTm booking date and CDATA text', () => {
    const mv = stmt.movements[1]!;
    expect(mv).toMatchObject({
      opDate: '2023-01-20',
      valueDate: '2023-01-20',
      amount: 876.54,
      counterpartyText: 'PROPIETARI UNITAT 3A',
      counterpartyIban: 'DE89370400440532013000',
    });
    expect(mv.extraConcepts).toEqual(['QUOTA GENER <3A>', 'TRANSFERENCIA RECIBIDA']);
  });

  it('falls back to the additional entry info when no party is present', () => {
    const mv = stmt.movements[2]!;
    expect(mv.amount).toBe(-0);
    expect(mv.counterpartyText).toBe('COMISION MANTENIMIENTO');
    expect(mv.counterpartyIban).toBeUndefined();
  });

  it('passes the balance self-check', () => {
    expect(stmt.selfCheckOk).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('fails the self-check when the closing balance differs', () => {
    const altered = XML.replace('3376.54', '3376.55');
    const r = parseCamt053(altered);
    expect(r.statements[0]!.selfCheckOk).toBe(false);
    expect(r.warnings.some((w) => /differs from closing balance/.test(w))).toBe(true);
  });

  it('warns about missing statements and unreadable amounts', () => {
    expect(parseCamt053('<Document/>').warnings).toContain('no Stmt element found');
    const r = parseCamt053(
      '<Document><BkToCstmrStmt><Stmt><Id>X</Id><Ntry><Amt Ccy="EUR">abc</Amt></Ntry></Stmt></BkToCstmrStmt></Document>',
    );
    expect(r.statements[0]!.movements).toHaveLength(0);
    expect(r.warnings.some((w) => /amount missing or unreadable/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /opening or closing balance missing/.test(w))).toBe(true);
  });
});
