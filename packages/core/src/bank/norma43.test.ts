import { describe, expect, it } from 'vitest';
import { N43_CONCEPTO_COMUN, parseN43Date, parseNorma43 } from './norma43.ts';

// ---- fixture builder: every record is assembled from its fields, padded to 80 chars ----

const ENTIDAD = '2100';
const OFICINA = '0418';
const CUENTA = '0200051332';

function cents(n: number): string {
  return String(Math.round(Math.abs(n) * 100)).padStart(14, '0');
}

function rec11(opening: number, from = '230101', to = '230131'): string {
  const line =
    '11' +
    ENTIDAD +
    OFICINA +
    CUENTA +
    from +
    to +
    (opening < 0 ? '1' : '2') +
    cents(opening) +
    '978' +
    '2' +
    'COM PROP EXEMPLE 25'.padEnd(26, ' ') +
    '   ';
  return line.padEnd(80, ' ');
}

interface Mv {
  op: string;
  val: string;
  comun: string;
  propio: string;
  amount: number; // signed
  doc?: string;
  ref1?: string;
  ref2?: string;
  extras?: [string, string?][];
}

function rec22(m: Mv): string {
  const line =
    '22' +
    '    ' +
    OFICINA +
    m.op +
    m.val +
    m.comun +
    m.propio +
    (m.amount < 0 ? '1' : '2') +
    cents(m.amount) +
    (m.doc ?? '').padStart(10, '0') +
    (m.ref1 ?? '').padEnd(12, ' ') +
    (m.ref2 ?? '').padEnd(16, ' ');
  if (line.length !== 80) throw new Error(`rec22 length ${line.length}`);
  return line;
}

function rec23(index: number, c1: string, c2 = ''): string {
  const line = '23' + String(index).padStart(2, '0') + c1.padEnd(38, ' ') + c2.padEnd(38, ' ');
  if (line.length !== 80) throw new Error(`rec23 length ${line.length}`);
  return line;
}

function rec33(
  movements: Mv[],
  opening: number,
  overrides: Partial<{ debitTotal: number; closing: number }> = {},
): string {
  const debits = movements.filter((m) => m.amount < 0);
  const credits = movements.filter((m) => m.amount > 0);
  const debitTotal = overrides.debitTotal ?? debits.reduce((a, m) => a + -m.amount, 0);
  const creditTotal = credits.reduce((a, m) => a + m.amount, 0);
  const closing = overrides.closing ?? Math.round((opening - debitTotal + creditTotal) * 100) / 100;
  const line =
    '33' +
    ENTIDAD +
    OFICINA +
    CUENTA +
    String(debits.length).padStart(5, '0') +
    cents(debitTotal) +
    String(credits.length).padStart(5, '0') +
    cents(creditTotal) +
    (closing < 0 ? '1' : '2') +
    cents(closing) +
    '978' +
    '    ';
  if (line.length !== 80) throw new Error(`rec33 length ${line.length}`);
  return line;
}

function rec88(count: number): string {
  return ('88' + '9'.repeat(18) + String(count).padStart(6, '0')).padEnd(80, ' ');
}

const OPENING = 12345.67;
const MOVEMENTS: Mv[] = [
  {
    op: '230105',
    val: '230105',
    comun: '04',
    propio: '025',
    amount: -2500,
    doc: '12',
    ref1: 'REF1TRANSF',
    ref2: 'FRA 2023-001',
    extras: [
      ['TRANSFERENCIA A VENDOR A OBRES SL', 'FRA 2023-001'],
      ['REFORMA VESTIBUL', ''],
    ],
  },
  {
    op: '230110',
    val: '230110',
    comun: '03',
    propio: '011',
    amount: -123.45,
    extras: [['RECIBO COMPANYIA ELECTRICA C SA', 'REF 000123456']],
  },
  {
    op: '230115',
    val: '230115',
    comun: '01',
    propio: '001',
    amount: -600,
    extras: [['REINTEGRO EFECTIVO OFICINA']],
  },
  {
    op: '230120',
    val: '230121',
    comun: '04',
    propio: '030',
    amount: 876.54,
    extras: [['TRANSFERENCIA DE PROPIETARI UNITAT 3A', 'QUOTA GENER']],
  },
];

function buildFile(
  options: {
    badDebitTotal?: boolean;
    badClosing?: boolean;
    omit33?: boolean;
    omit88?: boolean;
  } = {},
): string {
  const lines: string[] = [rec11(OPENING)];
  for (const m of MOVEMENTS) {
    lines.push(rec22(m));
    (m.extras ?? []).forEach((e, i) => lines.push(rec23(i + 1, e[0], e[1] ?? '')));
  }
  if (!options.omit33) {
    const overrides: Partial<{ debitTotal: number; closing: number }> = {};
    if (options.badDebitTotal) overrides.debitTotal = 3223.46;
    if (options.badClosing) overrides.closing = 9000;
    lines.push(rec33(MOVEMENTS, OPENING, overrides));
  }
  const recordCount = lines.length;
  if (!options.omit88) lines.push(rec88(recordCount));
  return lines.join('\r\n') + '\r\n';
}

describe('parseN43Date', () => {
  it('applies the century rule', () => {
    expect(parseN43Date('230105')).toBe('2023-01-05');
    expect(parseN43Date('691231')).toBe('2069-12-31');
    expect(parseN43Date('700101')).toBe('1970-01-01');
    expect(parseN43Date('230230')).toBeNull();
    expect(parseN43Date('23010')).toBeNull();
  });
});

describe('parseNorma43 — synthetic statement', () => {
  const result = parseNorma43(buildFile());

  it('parses the header', () => {
    expect(result.accounts).toHaveLength(1);
    const a = result.accounts[0]!;
    expect(a).toMatchObject({
      entidad: '2100',
      oficina: '0418',
      cuenta: '0200051332',
      periodFrom: '2023-01-01',
      periodTo: '2023-01-31',
      openingBalance: 12345.67,
      currency: 'EUR',
      holderName: 'COM PROP EXEMPLE 25',
      modalidad: '2',
    });
    expect(a.iban).toBeUndefined();
  });

  it('parses movements with signed amounts, dates and references', () => {
    const mv = result.accounts[0]!.movements;
    expect(mv).toHaveLength(4);
    expect(mv[0]).toMatchObject({
      opDate: '2023-01-05',
      valueDate: '2023-01-05',
      conceptoComun: '04',
      conceptoPropio: '025',
      amount: -2500,
      documentNumber: '0000000012',
      ref1: 'REF1TRANSF',
      ref2: 'FRA 2023-001',
    });
    expect(mv[0]!.extraConcepts).toEqual([
      'TRANSFERENCIA A VENDOR A OBRES SL',
      'FRA 2023-001',
      'REFORMA VESTIBUL',
    ]);
    expect(mv[0]!.counterpartyText).toBe(
      'TRANSFERENCIA A VENDOR A OBRES SL FRA 2023-001 REFORMA VESTIBUL',
    );
    expect(mv[1]).toMatchObject({ conceptoComun: '03', amount: -123.45 });
    expect(mv[2]).toMatchObject({
      conceptoComun: '01',
      amount: -600,
      counterpartyText: 'REINTEGRO EFECTIVO OFICINA',
    });
    expect(mv[3]).toMatchObject({ opDate: '2023-01-20', valueDate: '2023-01-21', amount: 876.54 });
  });

  it('reads record 33 totals and passes the self-check', () => {
    const a = result.accounts[0]!;
    expect(a.totals).toEqual({
      debitCount: 3,
      debitTotal: 3223.45,
      creditCount: 1,
      creditTotal: 876.54,
    });
    expect(a.closingBalance).toBe(9998.76);
    expect(a.selfCheckOk).toBe(true);
  });

  it('counts records and matches record 88', () => {
    // 1 header + 4 movements + 5 complementary records + 1 trailer
    expect(result.recordCount).toBe(11);
    expect(result.declaredRecordCount).toBe(11);
    expect(result.warnings).toEqual([]);
  });
});

describe('parseNorma43 — inconsistencies', () => {
  it('fails the self-check when the record 33 debit total differs from the movements', () => {
    const r = parseNorma43(buildFile({ badDebitTotal: true }));
    const a = r.accounts[0]!;
    expect(a.selfCheckOk).toBe(false);
    expect(a.totals.debitTotal).toBe(3223.46);
    expect(r.warnings.some((w) => /record 33 debit totals/.test(w))).toBe(true);
  });
  it('fails the self-check when opening + movements does not equal the closing balance', () => {
    const r = parseNorma43(buildFile({ badClosing: true }));
    expect(r.accounts[0]!.selfCheckOk).toBe(false);
    expect(r.accounts[0]!.closingBalance).toBe(9000);
    expect(r.warnings.some((w) => /opening balance plus movements/.test(w))).toBe(true);
  });
  it('derives totals and warns when record 33 is missing', () => {
    const r = parseNorma43(buildFile({ omit33: true }));
    const a = r.accounts[0]!;
    expect(a.selfCheckOk).toBe(false);
    expect(a.totals).toEqual({
      debitCount: 3,
      debitTotal: 3223.45,
      creditCount: 1,
      creditTotal: 876.54,
    });
    expect(a.closingBalance).toBe(9998.76);
    expect(r.warnings.some((w) => /record 33 missing/.test(w))).toBe(true);
  });
  it('warns when record 88 is missing or its count disagrees', () => {
    expect(
      parseNorma43(buildFile({ omit88: true })).warnings.some((w) => /record 88/.test(w)),
    ).toBe(true);
    const wrong = buildFile().replace(rec88(11), rec88(12));
    expect(parseNorma43(wrong).warnings.some((w) => /declares 12 records but 11/.test(w))).toBe(
      true,
    );
  });
  it('tolerates short lines, unknown record types and orphan records', () => {
    const text = [
      '99' + 'X'.repeat(10),
      rec23(1, 'ORPHAN'),
      rec11(100).trimEnd(),
      rec33([], 100),
      rec88(3),
    ].join('\n');
    const r = parseNorma43(text);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]!.selfCheckOk).toBe(true);
    expect(r.warnings.some((w) => /unknown record type/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /record 23 without a preceding record 22/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /length/.test(w))).toBe(true);
  });
  it('handles negative balances and a BOM', () => {
    const lines = [
      '﻿' + rec11(-50),
      rec22({ op: '230105', val: '230105', comun: '17', propio: '000', amount: -10 }),
      rec33([{ op: '', val: '', comun: '', propio: '', amount: -10 }], -50),
      rec88(3),
    ];
    const r = parseNorma43(lines.join('\n'));
    const a = r.accounts[0]!;
    expect(a.openingBalance).toBe(-50);
    expect(a.closingBalance).toBe(-60);
    expect(a.selfCheckOk).toBe(true);
  });
  it('parses several account blocks in one file', () => {
    const one = buildFile({ omit88: true });
    const text = `${one}${one}${rec88(22)}`;
    const r = parseNorma43(text);
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts.every((a) => a.selfCheckOk)).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('attaches record 24 foreign-currency data', () => {
    const r24 = ('24' + '01' + '840' + cents(110.25)).padEnd(80, ' ');
    const text = [
      rec11(0),
      rec22({ op: '230105', val: '230105', comun: '13', propio: '000', amount: -100 }),
      r24,
      rec33([{ op: '', val: '', comun: '', propio: '', amount: -100 }], 0),
      rec88(4),
    ].join('\n');
    const r = parseNorma43(text);
    expect(r.accounts[0]!.movements[0]!.foreignCurrency).toEqual({
      currency: 'USD',
      amount: 110.25,
    });
  });
});

describe('N43_CONCEPTO_COMUN', () => {
  it('lists the AEB codes', () => {
    expect(N43_CONCEPTO_COMUN['01']).toMatch(/Reintegros/);
    expect(N43_CONCEPTO_COMUN['03']).toMatch(/recibos/);
    expect(N43_CONCEPTO_COMUN['04']).toMatch(/transferencias/);
    expect(N43_CONCEPTO_COMUN['17']).toMatch(/comisiones/);
    expect(N43_CONCEPTO_COMUN['99']).toBe('Varios');
    expect(Object.keys(N43_CONCEPTO_COMUN)).toHaveLength(19);
  });
});
