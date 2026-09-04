#!/usr/bin/env -S node
/**
 * `pnpm synth` — generates the synthetic document-verification test corpus.
 *
 * Writes the full corpus to `tests/synthetic/out/` (git-ignored), a small deterministic
 * subset to `tests/synthetic/sample/` (committed), and the ground truth to
 * `tests/synthetic/expected.json` (committed). See tests/synthetic/README.md for the
 * narrative, the planted-discrepancy list, and how the harness is meant to be used.
 *
 * Determinism: every date, amount, vendor and planted fact below is a literal value, not a
 * random draw — the corpus's substance cannot drift between runs. The seeded PRNG in
 * lib/prng.ts only drives cosmetic rendering variation (JPEG grain/skew, handwriting jitter).
 * See README.md "Design notes" for the renderer caveat (Chromium screenshot antialiasing).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MASTER_SEED, rngFor } from './lib/prng.ts';
import { COMMUNITY, PRESIDENT_UNIT, UNITS, VENDORS, FUSTERIA_IBAN_ACTUAL } from './lib/fixtures.ts';
import { round2 } from './lib/money.ts';
import { INVOICES, renderInvoice } from './lib/invoice-model.ts';
import { renderInvoicePhoto } from './lib/photo.ts';
import {
  STATEMENTS,
  renderStatementPdf,
  toNorma43,
  toCsv,
  closingBalance,
  type Movement,
} from './lib/statement-model.ts';
import { ACTAS, renderActa, type Resolution, type AttendanceRow } from './lib/acta-model.ts';
import { CONTRACT, MILESTONES, CERTIFICATION_NOTE, renderContract } from './lib/contract-model.ts';
import {
  LIQUIDACION,
  totalIngresos,
  totalDespesas,
  resultado,
  reserveFinal,
  unitQuotaTable,
  renderLiquidacion,
} from './lib/liquidacion-model.ts';
import { parseNorma43 } from '../../packages/core/src/bank/norma43.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out');
const SAMPLE = join(ROOT, 'sample');

/** Bytes written this run, keyed by path relative to `ROOT` — reused for the sample copy so
 * nothing is re-rendered (re-rendering a photo would re-spawn Chromium for no reason). */
const written = new Map<string, Uint8Array>();

async function put(relPath: string, bytes: Uint8Array | string): Promise<void> {
  const abs = join(ROOT, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  await writeFile(abs, buf);
  written.set(relPath, buf);
}

async function copyToSample(relOutPath: string, relSamplePath: string): Promise<void> {
  const bytes = written.get(relOutPath);
  if (!bytes) throw new RangeError(`copyToSample: ${relOutPath} was not written this run`);
  const abs = join(ROOT, relSamplePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

function movementForExpected(m: Movement, runningBalance: number) {
  return {
    date: m.opDate,
    value_date: m.valueDate ?? m.opDate,
    concept: m.concept,
    concept_detail: m.conceptDetail ?? null,
    amount: m.amount,
    balance_after: runningBalance,
    conceptoComun: m.conceptoComun,
    counterparty_iban: m.counterpartyIban ?? null,
    unit: m.unitLabel ?? null,
    linked_invoice: m.linkedInvoiceId ?? null,
    recurring: !!m.recurring,
    plant_tags: m.plantTags ?? [],
  };
}

function attendanceForExpected(rows: AttendanceRow[]) {
  return rows.map((r) => ({ unit: r.unit, quota_pct: r.quotaPct, status: r.status }));
}

function resolutionForExpected(r: Resolution) {
  return {
    punto: r.punto,
    kind: r.kind,
    works_package: r.worksPackage ?? null,
    importe_aprobado: r.importeAprobado ?? null,
    delegation_to_role: r.delegationToRole ?? null,
    delegation_scope: r.delegationScope ?? null,
    votes: r.votes ?? null,
    texto_literal: r.textoLiteral,
    page_no: r.pageNo,
  };
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await rm(SAMPLE, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(SAMPLE, { recursive: true });

  const documents: unknown[] = [];

  // -----------------------------------------------------------------------------------
  // Invoices
  // -----------------------------------------------------------------------------------
  for (const spec of INVOICES) {
    const rendered = await renderInvoice(spec);
    const relPdf = `out/invoices/${spec.id}.pdf`;
    await put(relPdf, rendered.bytes);

    let relPhoto: string | null = null;
    if (spec.photoLike) {
      const rng = rngFor(`photo:${spec.id}`);
      const jpg = await renderInvoicePhoto(spec, rendered.totals, rng);
      relPhoto = `out/invoices/${spec.id}-photo.jpg`;
      await put(relPhoto, jpg);
    }

    documents.push({
      file: relPdf,
      doc_type: 'factura',
      language: spec.language,
      category_code: spec.categoryCode,
      issuer_name: spec.vendor.name,
      issuer_nif: spec.vendor.nif,
      issuer_iban: spec.vendor.iban,
      recipient_name: COMMUNITY.name,
      recipient_nif: COMMUNITY.nif,
      series_number: spec.series,
      date: spec.date,
      payment_method: spec.paymentMethod,
      lines: spec.lines.map((l, i) => ({
        index: i,
        desc: l.desc,
        qty: l.qty,
        unit: l.unit,
        unit_price: l.unitPrice,
        amount: round2(l.qty * l.unitPrice),
        element_scope: l.elementScope ?? 'common',
      })),
      line_sum: rendered.totals.lineSum,
      base: rendered.totals.base,
      iva_pct: rendered.totals.ivaPct,
      iva: rendered.totals.iva,
      irpf_pct: rendered.totals.irpfPct || null,
      irpf: rendered.totals.irpf || null,
      total: rendered.totals.total,
      handwritten: !!spec.handwritten,
      photo_file: relPhoto,
      plant_tags: spec.plantTags ?? [],
      notes: spec.notes ?? null,
    });
  }

  // -----------------------------------------------------------------------------------
  // Bank statements: PDF + Norma 43 + CSV, all describing the same movements
  // -----------------------------------------------------------------------------------
  for (const [index, period] of STATEMENTS.entries()) {
    const pdf = await renderStatementPdf(period, index);
    const relPdf = `out/statements/${period.id}.pdf`;
    await put(relPdf, pdf);

    const n43Text = toNorma43(period);
    const relN43 = `out/statements/${period.id}.n43`;
    await put(relN43, n43Text);

    // Self-check: the file this script just wrote must round-trip through the real parser.
    const parsed = parseNorma43(n43Text);
    const acct = parsed.accounts[0];
    if (parsed.warnings.length > 0 || !acct || !acct.selfCheckOk) {
      throw new Error(
        `Norma 43 self-check failed for ${period.id}: warnings=${JSON.stringify(parsed.warnings)} selfCheckOk=${acct?.selfCheckOk}`,
      );
    }

    const csvText = toCsv(period);
    const relCsv = `out/statements/${period.id}.csv`;
    await put(relCsv, csvText);

    let running = period.openingBalance;
    const movements = period.movements.map((m) => {
      running = round2(running + m.amount);
      return movementForExpected(m, running);
    });
    const closing = closingBalance(period);

    for (const [file, format] of [
      [relPdf, 'pdf'],
      [relN43, 'norma43'],
      [relCsv, 'csv'],
    ] as const) {
      documents.push({
        file,
        doc_type: 'extracto_bancario',
        format,
        holder_name: COMMUNITY.name,
        holder_nif: COMMUNITY.nif,
        iban: COMMUNITY.iban,
        period_from: period.periodFrom,
        period_to: period.periodTo,
        opening_balance: period.openingBalance,
        closing_balance: closing,
        movement_count: movements.length,
        movements,
      });
    }
  }

  // -----------------------------------------------------------------------------------
  // Actas
  // -----------------------------------------------------------------------------------
  for (const acta of ACTAS) {
    const bytes = await renderActa(acta);
    const rel = `out/actas/${acta.id}.pdf`;
    await put(rel, bytes);
    documents.push({
      file: rel,
      doc_type: 'acta',
      tipo: acta.tipo,
      language: acta.language,
      date: acta.fecha,
      hora: acta.hora,
      lugar: acta.lugar,
      convened_by_role: acta.convenedByRole,
      convocation_notice_date: acta.convocationNoticeDate ?? null,
      attendance: attendanceForExpected(acta.attendance),
      resolutions: acta.resolutions.map(resolutionForExpected),
      signed_date: acta.signedDate,
      sent_date: acta.sentDate,
    });
  }

  // -----------------------------------------------------------------------------------
  // Works contract
  // -----------------------------------------------------------------------------------
  {
    const bytes = await renderContract();
    const rel = `out/contract/${CONTRACT.id}.pdf`;
    await put(rel, bytes);
    documents.push({
      file: rel,
      doc_type: 'contrato_obra',
      works_package: CONTRACT.worksPackage,
      works_package_label: CONTRACT.worksPackageLabel,
      client_name: COMMUNITY.name,
      client_nif: COMMUNITY.nif,
      contractor_name: CONTRACT.contractor.name,
      contractor_nif: CONTRACT.contractor.nif,
      signature_date: CONTRACT.signatureDate,
      authorising_resolution: CONTRACT.authorisingResolution,
      price_base: CONTRACT.priceBase,
      iva_pct: CONTRACT.ivaPct,
      price_iva: CONTRACT.priceIva,
      price_total: CONTRACT.priceTotal,
      milestones: MILESTONES,
      start_date: CONTRACT.startDate,
      deadline_days: CONTRACT.deadlineDays,
      deadline_date: CONTRACT.deadlineDate,
      penalty_per_day: CONTRACT.penaltyPerDay,
      penalty_cap_pct: CONTRACT.penaltyCapPct,
      retention_pct: CONTRACT.retentionPct,
      retention_amount: CONTRACT.retentionAmount,
      suspension_date: CONTRACT.suspensionDate,
      suspension_reason: CONTRACT.suspensionReason,
    });
  }

  // -----------------------------------------------------------------------------------
  // Liquidación anual
  // -----------------------------------------------------------------------------------
  {
    const bytes = await renderLiquidacion();
    const rel = `out/liquidacion/${LIQUIDACION.id}.pdf`;
    await put(rel, bytes);
    documents.push({
      file: rel,
      doc_type: 'liquidacion_anual',
      ejercicio: LIQUIDACION.ejercicio,
      period_from: LIQUIDACION.periodoDesde,
      period_to: LIQUIDACION.periodoHasta,
      ingresos: LIQUIDACION.ingresos,
      despesas: LIQUIDACION.despesas,
      total_ingresos: totalIngresos(),
      total_despesas: totalDespesas(),
      resultado: resultado(),
      reserve_opening: LIQUIDACION.reserveOpening,
      reserve_dotacio: LIQUIDACION.reserveDotacio,
      reserve_aplicaciones: LIQUIDACION.reserveAplicacions,
      reserve_final: reserveFinal(),
      saldo_final_comptes: LIQUIDACION.saldoFinalComptes,
      unit_quota_table: unitQuotaTable(),
    });
  }

  // -----------------------------------------------------------------------------------
  // Planted discrepancies — ground truth for the rule-regression half of the harness.
  // Every entry names the rule code(s) it must trigger, the documents it rests on, and the
  // identifying facts a rule implementation needs to detect it. See README.md for the table.
  // -----------------------------------------------------------------------------------
  const planted = [
    {
      id: 'C3-duplicate-invoice',
      rules: ['C3'],
      event_key: 'dup:ascensors:4598.00',
      description: 'Same vendor and total under two different invoice numbers, 20 days apart; both were paid.',
      documents: [
        'out/invoices/inv-elev-install-a.pdf',
        'out/invoices/inv-elev-install-b.pdf',
        'out/statements/statement-2026-05.pdf',
      ],
      facts: {
        vendor_nif: VENDORS.ascensors!.nif,
        total: 4598.0,
        invoice_a: { series: 'AI-2026-0301', date: '2026-05-05' },
        invoice_b: { series: 'AI-2026-0344', date: '2026-05-25' },
        days_apart: 20,
        payments: [
          { date: '2026-05-07', amount: -4598.0 },
          { date: '2026-05-27', amount: -4598.0 },
        ],
      },
    },
    {
      id: 'C4-split-under-threshold',
      rules: ['C4'],
      event_key: 'split:installacions:2026-05',
      description:
        "Two invoices from the same vendor within 5 days, each under the €1,000 authority threshold, summing to €1.150,00.",
      documents: ['out/invoices/inv-windows-1.pdf', 'out/invoices/inv-windows-2.pdf'],
      facts: {
        vendor_nif: VENDORS.installacions!.nif,
        invoice_a: { series: 'F-2026-0110', date: '2026-05-02', total: 550.0 },
        invoice_b: { series: 'F-2026-0115', date: '2026-05-06', total: 600.0 },
        days_apart: 4,
        sum_total: 1150.0,
      },
    },
    {
      id: 'B4B5-iban-mismatch',
      rules: ['B4', 'B5'],
      event_key: 'iban-mismatch:fusteria:FR-2026-0045',
      description:
        'The IBAN printed on the invoice differs from the IBAN the matching bank transfer actually reached.',
      documents: [
        'out/invoices/inv-entrance-door.pdf',
        'out/statements/statement-2026-06.pdf',
        'out/statements/statement-2026-06.n43',
        'out/statements/statement-2026-06.csv',
      ],
      facts: {
        vendor_nif: VENDORS.fusteria!.nif,
        invoice_series: 'FR-2026-0045',
        invoice_date: '2026-06-05',
        total: 5082.0,
        iban_printed: VENDORS.fusteria!.iban,
        iban_actual_transfer: FUSTERIA_IBAN_ACTUAL,
        payment_date: '2026-06-08',
      },
    },
    {
      id: 'D4E2-advance-before-acta',
      rules: ['D4', 'E2'],
      event_key: 'tx:advance-facana-posterior:2026-05-04',
      description:
        "A 20.328,00 € advance transfer under the rear-façade works contract was paid 10 days before the extraordinary meeting that approved those works, and before the contract's own signature date.",
      documents: [
        'out/statements/statement-2026-05.pdf',
        'out/statements/statement-2026-05.n43',
        'out/statements/statement-2026-05.csv',
        'out/actas/acta-extraordinaria-2026-05-14.pdf',
        'out/contract/contracte-facana-posterior.pdf',
      ],
      facts: {
        payment_date: '2026-05-04',
        amount: 20328.0,
        acta_date: '2026-05-14',
        days_before_acta: 10,
        contract_signature_date: '2026-05-16',
        days_before_contract: 12,
        works_package: 'REAR_FACADE',
      },
      notes:
        'The same transfer has no linked invoice (it is a contractual advance). A rule engine that does not treat the contract\'s own 40% advance clause as sufficient authority may additionally raise D1/R2 on it — that is the same underlying event, not a second finding.',
    },
    {
      id: 'D5R6-missing-derrama-credit',
      rules: ['D5', 'R6'],
      event_key: 'derrama:3r-1a:2026-06',
      description:
        "Unit '3r 1a' has no derrama credit in June 2026, while it was credited in May and every other unit is credited in both months.",
      documents: ['out/statements/statement-2026-06.pdf', 'out/statements/statement-2026-06.n43', 'out/statements/statement-2026-06.csv'],
      facts: { unit: '3r 1a', expected_month: '2026-06', expected_amount: 60.0, present_in_may: true, present_in_june: false },
    },
    {
      id: 'C11-private-element',
      rules: ['C11'],
      event_key: 'doc:inv-windows-3:line1',
      description:
        'A windows invoice includes a line naming a specific unit\'s bedroom window (a private element) alongside a common-element line.',
      documents: ['out/invoices/inv-windows-3.pdf'],
      facts: {
        vendor_nif: VENDORS.installacions!.nif,
        invoice_series: 'F-2026-0130',
        line_index: 1,
        line_desc: 'Sustitución ventana dormitorio Pral 1a',
        unit: 'Pral 1a',
        element_scope: 'private_unit',
        line_amount: 385.0,
      },
    },
    {
      id: 'D1R2-unmatched-debit',
      rules: ['D1', 'R2'],
      event_key: 'tx:jardineria:2026-05-18',
      description: 'A €480,00 transfer above the outflow minimum (€300) has no matching invoice anywhere in the corpus.',
      documents: ['out/statements/statement-2026-05.pdf', 'out/statements/statement-2026-05.n43', 'out/statements/statement-2026-05.csv'],
      facts: { date: '2026-05-18', amount: 480.0, counterparty: 'Jardineria Exemple', linked_invoice: null },
    },
    {
      id: 'D2-cash-withdrawal',
      rules: ['D2'],
      event_key: 'tx:cash:2026-05-20',
      description: 'A €1.200,00 cash withdrawal exceeds the €1.000 cash-payment limit in effect since 2021-07-11.',
      documents: ['out/statements/statement-2026-05.pdf', 'out/statements/statement-2026-05.n43', 'out/statements/statement-2026-05.csv'],
      facts: { date: '2026-05-20', amount: 1200.0, limit_applicable: 1000.0, limit_valid_from: '2021-07-11' },
    },
    {
      id: 'C2-arithmetic-mismatch',
      rules: ['C2'],
      event_key: 'doc:inv-elev-inspect:base',
      description:
        "The invoice's printed base (450,00 €) does not equal the sum of its own lines (460,00 €) — a €10,00 difference.",
      documents: ['out/invoices/inv-elev-inspect.pdf'],
      facts: { vendor_nif: VENDORS.ascensors!.nif, invoice_series: 'AI-2026-0290', printed_base: 450.0, line_sum: 460.0, difference: 10.0 },
    },
    {
      id: 'A4-paid-exceeds-certified',
      rules: ['A4'],
      event_key: 'package:REAR_FACADE:paid-vs-certified:2026-07-01',
      description:
        'By the suspension date, progress payments to the contractor beyond the contractual advance exceed the amount the site direction had certified.',
      documents: [
        'out/contract/contracte-facana-posterior.pdf',
        'out/invoices/inv-facade-progress.pdf',
        'out/statements/statement-2026-06.pdf',
        'out/statements/statement-2026-06.n43',
        'out/statements/statement-2026-06.csv',
      ],
      facts: {
        works_package: 'REAR_FACADE',
        suspension_date: CONTRACT.suspensionDate,
        advance_amount: CONTRACT.advanceAmount,
        progress_payments_total: 21780.0,
        certified_amount_gross: CERTIFICATION_NOTE.certifiedAmountGross,
        certified_as_of: CERTIFICATION_NOTE.asOfDate,
        excess: round2(21780.0 - CERTIFICATION_NOTE.certifiedAmountGross),
        note: 'No certification PDF is generated in this corpus; the certified amount is recorded only here (see CERTIFICATION_NOTE in lib/contract-model.ts).',
      },
    },
  ];

  const expected = {
    generator: {
      seed: MASTER_SEED,
      generated_by: 'tests/synthetic/generate.ts',
      note: 'All content is fixed/literal; the seed only drives cosmetic photo/handwriting rendering. See README.md.',
    },
    community: { ...COMMUNITY },
    units: UNITS,
    president_unit: PRESIDENT_UNIT,
    vendors: Object.values(VENDORS).map((v) => ({
      key: v.key,
      name: v.name,
      nif: v.nif,
      address: v.address,
      iban: v.iban,
      bank_label: v.bankLabel,
      is_natural_person: !!v.isNaturalPerson,
    })),
    documents,
    planted,
  };
  await put('expected.json', JSON.stringify(expected, null, 2) + '\n');

  // -----------------------------------------------------------------------------------
  // Committed sample subset (see README.md "Sample set")
  // -----------------------------------------------------------------------------------
  await copyToSample('out/invoices/inv-elev-maint.pdf', 'sample/invoices/inv-elev-maint.pdf');
  await copyToSample('out/invoices/inv-entrance-door.pdf', 'sample/invoices/inv-entrance-door.pdf');
  await copyToSample('out/invoices/inv-windows-3-photo.jpg', 'sample/invoices/inv-windows-3-photo.jpg');
  await copyToSample('out/statements/statement-2026-05.pdf', 'sample/statements/statement-2026-05.pdf');
  await copyToSample('out/statements/statement-2026-05.n43', 'sample/statements/statement-2026-05.n43');
  await copyToSample('out/statements/statement-2026-05.csv', 'sample/statements/statement-2026-05.csv');
  await copyToSample('out/actas/acta-ordinaria-2026-03-30.pdf', 'sample/actas/acta-ordinaria-2026-03-30.pdf');

  // expected.json itself is not moved to out/ — it already lives at the top level.
  console.log(`Wrote ${documents.length} document records to expected.json`);
  console.log(`Corpus: ${written.size} files under tests/synthetic/out and tests/synthetic/sample`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
