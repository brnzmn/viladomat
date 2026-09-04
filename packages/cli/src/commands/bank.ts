import {
  cccToIban,
  classifyTransaction,
  detectRecurringDirectDebits,
  ibanLast4,
  normaliseCompanyName,
  parseAmountEs,
  parseCamt053,
  parseDateEs,
  parseNorma43,
  type BankMovement,
} from '@viladomat/core';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommunity } from '../lib/community.ts';
import { maybeOne, query, transaction } from '../lib/db.ts';
import { PIPELINE_VERSION } from '../lib/env.ts';
import { sha256, sniffMime } from '../lib/images.ts';
import { ObjectExistsError, putObject } from '../lib/storage.ts';
import { ibanPseudonym, transactionDedupeKey } from '../extract/persist.ts';

/**
 * `vx bank import` — a native bank export becomes movements, deterministically.
 *
 * Norma 43, camt.053 and CSV are parsed by code, never by a model: the figures are already
 * machine-readable, and a bank export read by a parser is the one leg of the evidence that does not
 * depend on either the administrator or an extraction model. That is also why the file is taken
 * into custody like any other original — hashed on this machine, stored immutably, recorded in
 * `files` with `source = bank_export` — before a single movement is written.
 *
 * Confidence follows the format: 1.0 for the two banking standards, 0.95 for a CSV, whose column
 * meanings are inferred from a header rather than fixed by a specification.
 */

export const BANK_SOURCES = ['norma43', 'camt053', 'csv'] as const;
export type BankSource = (typeof BANK_SOURCES)[number];

/** Confidence attributed to a movement by the format it was parsed from. */
export const SOURCE_CONFIDENCE: Readonly<Record<BankSource, number>> = Object.freeze({
  norma43: 1,
  camt053: 1,
  csv: 0.95,
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Header words that identify each column of a bank CSV, in Spanish, Catalan and English. */
export const CSV_HEADERS: Readonly<Record<'fecha' | 'valor' | 'concepto' | 'importe' | 'saldo', readonly string[]>> = Object.freeze({
  fecha: ['fecha', 'fecha operacion', 'f. operacion', 'data', 'data operacio', 'date', 'fecha contable', 'fecha_operacion'],
  valor: ['fecha valor', 'f. valor', 'valor', 'data valor', 'value date', 'fecha_valor'],
  concepto: ['concepto', 'concepte', 'descripcion', 'descripcio', 'description', 'detalle', 'detall', 'observaciones'],
  importe: ['importe', 'import', 'amount', 'importe eur', 'cantidad', 'quantitat'],
  saldo: ['saldo', 'saldo eur', 'balance', 'saldo posterior'],
});

function foldHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a delimiter-separated line, honouring double quotes. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Delimiter of a CSV: whichever of `;`, `,` or tab appears most often on the header line. */
export function detectDelimiter(line: string): string {
  const counts = [';', ',', '\t'].map((d) => ({ d, n: line.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ';';
}

export interface CsvStatement {
  movements: BankMovement[];
  /** Closing balance of the last row that printed one. */
  closingBalance: number | null;
  /** Balance before the first movement, derived from the first row's running balance. */
  openingBalance: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  columns: Record<string, number>;
  warnings: string[];
}

/**
 * Parse a bank CSV: the header line names the columns (date, value date, concept, amount, balance)
 * and the amounts are Spanish (`1.234,56`, and a separate debit/credit column when the bank splits
 * them). Rows without a date or an amount are skipped and counted.
 */
export function parseBankCsv(text: string): CsvStatement {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { movements: [], closingBalance: null, openingBalance: null, periodFrom: null, periodTo: null, columns: {}, warnings: ['empty file'] };

  const delimiter = detectDelimiter(lines[0] as string);
  let headerIndex = -1;
  let columns: Record<string, number> = {};
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cells = splitCsvLine(lines[i] as string, delimiter).map(foldHeader);
    const found: Record<string, number> = {};
    for (const [key, aliases] of Object.entries(CSV_HEADERS)) {
      const at = cells.findIndex((c) => aliases.includes(c));
      if (at >= 0) found[key] = at;
    }
    if (found['fecha'] !== undefined && (found['importe'] !== undefined || cells.some((c) => /debe|haber|cargo|abono/.test(c)))) {
      headerIndex = i;
      columns = found;
      if (found['importe'] === undefined) {
        const debit = cells.findIndex((c) => /^(debe|cargo|carrec|deute)$/.test(c));
        const credit = cells.findIndex((c) => /^(haber|abono|abonament|ingres)$/.test(c));
        if (debit >= 0) columns['debe'] = debit;
        if (credit >= 0) columns['haber'] = credit;
      }
      break;
    }
  }
  if (headerIndex < 0) {
    return { movements: [], closingBalance: null, openingBalance: null, periodFrom: null, periodTo: null, columns: {}, warnings: ['no header row with a date and an amount column'] };
  }

  const cell = (cells: string[], key: string): string => {
    const at = columns[key];
    return at === undefined ? '' : (cells[at] ?? '');
  };

  const movements: BankMovement[] = [];
  let skipped = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] as string, delimiter);
    const opDate = parseDateEs(cell(cells, 'fecha'));
    if (!opDate) {
      skipped += 1;
      continue;
    }
    let amount = parseAmountEs(cell(cells, 'importe'));
    if (amount === null) {
      const debit = parseAmountEs(cell(cells, 'debe'));
      const credit = parseAmountEs(cell(cells, 'haber'));
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amount = Math.abs(credit);
    }
    if (amount === null) {
      skipped += 1;
      continue;
    }
    const concept = cell(cells, 'concepto');
    movements.push({
      opDate,
      valueDate: parseDateEs(cell(cells, 'valor')) ?? opDate,
      conceptoComun: '',
      conceptoPropio: '',
      amount,
      documentNumber: '',
      ref1: '',
      ref2: '',
      extraConcepts: concept ? [concept] : [],
      counterpartyText: concept,
    });
  }
  if (skipped > 0) warnings.push(`${skipped} row(s) without a readable date or amount were skipped`);

  const balances = lines
    .slice(headerIndex + 1)
    .map((l) => parseAmountEs(cell(splitCsvLine(l, delimiter), 'saldo')))
    .filter((n): n is number => n !== null);
  const firstBalance = balances[0] ?? null;
  const closingBalance = balances.length > 0 ? (balances[balances.length - 1] ?? null) : null;
  const firstAmount = movements[0]?.amount ?? null;
  const openingBalance = firstBalance !== null && firstAmount !== null ? Math.round((firstBalance - firstAmount) * 100) / 100 : null;
  const dates = movements.map((m) => m.opDate).sort();

  return {
    movements,
    closingBalance,
    openingBalance,
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
    columns,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** Guess the export format from the bytes: XML is camt.053, fixed-width `11`/`03` records Norma 43. */
export function detectSource(text: string, filename: string): BankSource {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<?xml') || /<Document[\s>]/.test(trimmed.slice(0, 2000))) return 'camt053';
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  const looksFixed = lines.slice(0, 5).filter((l) => /^(11|22|23|24|33|88|03)\d/.test(l) && l.length >= 40).length >= 1;
  if (looksFixed) return 'norma43';
  if (/\.(n43|q43|aeb43)$/i.test(filename)) return 'norma43';
  return 'csv';
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface BankImportOptions {
  account: string;
  source?: string;
  community?: string;
  /** Batch label for the custody row (defaults to `bank-<yyyy-mm-dd>`). */
  batch?: string;
  /** Date the export was obtained (defaults to today). */
  suppliedOn?: string;
  dryRun?: boolean;
}

export interface BankImportSummary {
  communityId: string;
  file: string;
  sha256: string;
  source: BankSource;
  accountId: string | null;
  accountLabel: string;
  statements: number;
  movements: number;
  inserted: number;
  duplicates: number;
  recurring: number;
  selfCheckOk: boolean | null;
  continuityOk: boolean | null;
  warnings: string[];
  dryRun: boolean;
}

interface ParsedAccount {
  iban: string | null;
  last4: string;
  holder: string;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  selfCheckOk: boolean | null;
  movements: BankMovement[];
}

function n43Accounts(text: string): { accounts: ParsedAccount[]; warnings: string[] } {
  const parsed = parseNorma43(text);
  return {
    warnings: parsed.warnings,
    accounts: parsed.accounts.map((a) => {
      const iban = a.iban ?? (/^\d{4}$/.test(a.entidad) && /^\d{4}$/.test(a.oficina) && /^\d{10}$/.test(a.cuenta) ? cccToIban(a.entidad, a.oficina, a.cuenta) : null);
      return {
        iban,
        last4: a.cuenta.slice(-4),
        holder: a.holderName,
        periodFrom: a.periodFrom || null,
        periodTo: a.periodTo || null,
        openingBalance: a.openingBalance,
        closingBalance: a.closingBalance,
        selfCheckOk: a.selfCheckOk,
        movements: a.movements,
      };
    }),
  };
}

function camtAccounts(text: string): { accounts: ParsedAccount[]; warnings: string[] } {
  const parsed = parseCamt053(text);
  return {
    warnings: parsed.warnings,
    accounts: parsed.statements.map((s) => ({
      iban: s.iban || null,
      last4: ibanLast4(s.iban),
      holder: s.holderName,
      periodFrom: s.periodFrom || null,
      periodTo: s.periodTo || null,
      openingBalance: s.openingBalance,
      closingBalance: s.closingBalance,
      selfCheckOk: s.selfCheckOk,
      movements: s.movements,
    })),
  };
}

function csvAccounts(text: string): { accounts: ParsedAccount[]; warnings: string[] } {
  const parsed = parseBankCsv(text);
  const sum = parsed.movements.reduce((s, m) => s + m.amount, 0);
  const selfCheckOk =
    parsed.openingBalance !== null && parsed.closingBalance !== null
      ? Math.abs(parsed.openingBalance + sum - parsed.closingBalance) <= 0.01
      : null;
  return {
    warnings: parsed.warnings,
    accounts: [
      {
        iban: null,
        last4: '',
        holder: '',
        periodFrom: parsed.periodFrom,
        periodTo: parsed.periodTo,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
        selfCheckOk,
        movements: parsed.movements,
      },
    ],
  };
}

/** Parse an export into one entry per account block. */
export function parseBankExport(text: string, source: BankSource): { accounts: ParsedAccount[]; warnings: string[] } {
  if (source === 'norma43') return n43Accounts(text);
  if (source === 'camt053') return camtAccounts(text);
  return csvAccounts(text);
}

export async function bankImportCommand(target: string, opts: BankImportOptions): Promise<BankImportSummary> {
  const file = path.resolve(target);
  const info = await stat(file).catch(() => {
    throw new Error(`file not found: ${target}`);
  });
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  const name = path.basename(file);
  const source = (opts.source as BankSource | undefined) ?? detectSource(text, name);
  if (!BANK_SOURCES.includes(source)) throw new Error(`--source must be one of: ${BANK_SOURCES.join(', ')}`);
  const community = await resolveCommunity(opts.community);
  const sha = sha256(bytes);
  const suppliedOn = opts.suppliedOn ?? new Date().toISOString().slice(0, 10);
  const batch = opts.batch ?? `bank-${suppliedOn}`;

  const { accounts, warnings } = parseBankExport(text, source);
  const movements = accounts.reduce((n, a) => n + a.movements.length, 0);
  const summary: BankImportSummary = {
    communityId: community.id,
    file,
    sha256: sha,
    source,
    accountId: null,
    accountLabel: opts.account,
    statements: accounts.length,
    movements,
    inserted: 0,
    duplicates: 0,
    recurring: 0,
    selfCheckOk: accounts.every((a) => a.selfCheckOk === true) ? true : accounts.some((a) => a.selfCheckOk === false) ? false : null,
    continuityOk: null,
    warnings,
    dryRun: Boolean(opts.dryRun),
  };

  console.log(`bank import ${name}: ${source}, ${accounts.length} account block(s), ${movements} movement(s), sha ${sha.slice(0, 12)}`);
  for (const w of warnings) console.log(`  note  ${w}`);
  if (opts.dryRun) {
    console.log('dry run: nothing was written to storage or the database.');
    return summary;
  }

  // custody first: the untouched bytes under a key derived from their hash, then the files row
  const mime = sniffMime(bytes, name);
  const ext = path.extname(name).replace('.', '') || 'txt';
  const key = `${community.id}/${sha.slice(0, 2)}/${sha}.${ext}`;
  const storagePath = `originals/${key}`;
  try {
    await putObject('originals', key, bytes, mime, { immutable: true });
  } catch (e) {
    if (!(e instanceof ObjectExistsError)) throw e;
    console.log(`note  the original is already stored at ${storagePath}`);
  }
  const insertedFile = await maybeOne<{ id: string }>(
    `insert into public.files (community_id, sha256, client_sha256, storage_path, original_name, mime, bytes, source,
                               supplied_by_role, supplied_on, batch_label, transport_note)
     values ($1, $2, $2, $3, $4, $5, $6, 'bank_export', 'bank', $7::date, $8, $9)
     on conflict (community_id, sha256) do nothing
     returning id`,
    [community.id, sha, storagePath, name, mime, info.size, suppliedOn, batch, `native ${source} export imported with vx bank import`],
  );
  const fileId =
    insertedFile?.id ?? (await maybeOne<{ id: string }>('select id from public.files where community_id = $1 and sha256 = $2', [community.id, sha]))?.id ?? null;
  if (fileId) {
    await query(
      `insert into public.jobs (community_id, idempotency_key, step, payload)
       values ($1, $2, 'ingest', $3::jsonb) on conflict (idempotency_key) do nothing`,
      [community.id, `${sha}:ingest:${PIPELINE_VERSION()}`, JSON.stringify({ file_id: fileId })],
    );
  }

  const confidence = SOURCE_CONFIDENCE[source];
  await transaction(async (client) => {
    for (const account of accounts) {
      const last4 = account.last4 || ibanLast4(account.iban) || '';
      const { hmac } = ibanPseudonym(account.iban);
      const accountRow = await client.query<{ id: string }>(
        `insert into public.bank_accounts (community_id, label, iban_hmac, iban_last4, holder_as_shown, holder_kind, purpose)
         values ($1, $2, $3, $4, $5, 'unknown', 'unknown')
         on conflict (community_id, label) do update
            set iban_hmac = coalesce(public.bank_accounts.iban_hmac, excluded.iban_hmac),
                iban_last4 = coalesce(public.bank_accounts.iban_last4, excluded.iban_last4),
                holder_as_shown = coalesce(public.bank_accounts.holder_as_shown, excluded.holder_as_shown)
         returning id`,
        [community.id, opts.account, hmac, last4 || null, account.holder || null],
      );
      const accountId = String(accountRow.rows[0]?.id);
      summary.accountId = accountId;

      const sum = account.movements.reduce((s, m) => s + m.amount, 0);
      const continuityOk =
        account.openingBalance !== null && account.closingBalance !== null
          ? Math.abs(account.openingBalance + sum - account.closingBalance) <= 0.01
          : null;
      summary.continuityOk = summary.continuityOk === false ? false : continuityOk;

      // re-importing the same export updates its statement instead of adding a second one
      const existing = await client.query<{ id: string }>(
        `select id from public.bank_statements
          where bank_account_id = $1 and file_id is not distinct from $2
            and periodo_desde is not distinct from $3::date and periodo_hasta is not distinct from $4::date
          limit 1`,
        [accountId, fileId, account.periodFrom, account.periodTo],
      );
      const discrepancy =
        account.openingBalance !== null && account.closingBalance !== null
          ? Math.round((account.closingBalance - account.openingBalance - sum) * 100) / 100
          : null;
      const statement = existing.rows[0]
        ? await client.query<{ id: string }>(
            `update public.bank_statements
                set source = $2::public.statement_source, saldo_inicial = $3, saldo_final = $4,
                    continuity_ok = $5, self_check_ok = $6, discrepancy_eur = $7, parser_version = $8
              where id = $1 returning id`,
            [
              existing.rows[0].id,
              source,
              account.openingBalance,
              account.closingBalance,
              continuityOk,
              account.selfCheckOk,
              discrepancy,
              `${source}@core`,
            ],
          )
        : await client.query<{ id: string }>(
        `insert into public.bank_statements (community_id, bank_account_id, file_id, source, periodo_desde, periodo_hasta,
                                             saldo_inicial, saldo_final, continuity_ok, self_check_ok, discrepancy_eur, parser_version)
         values ($1, $2, $3, $4::public.statement_source, $5::date, $6::date, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          community.id,
          accountId,
          fileId,
          source,
          account.periodFrom,
          account.periodTo,
          account.openingBalance,
          account.closingBalance,
          continuityOk,
          account.selfCheckOk,
          discrepancy,
          `${source}@core`,
        ],
      );
      const statementId = String(statement.rows[0]?.id);

      const classified = account.movements.map((m) => {
        // Norma 43 and CSV put the same text in both fields; camt.053 puts the name in one and the
        // remittance lines in the other, so the parts are joined once each
        const conceptText = [...new Set([m.counterpartyText, ...m.extraConcepts].map((t) => (t ?? '').trim()).filter(Boolean))].join(' ');
        const c = classifyTransaction({
          amount: m.amount,
          conceptoComun: m.conceptoComun,
          conceptText,
          counterpartyText: m.counterpartyText,
          ...(m.counterpartyIban ? { counterpartyIban: m.counterpartyIban } : {}),
        });
        return { movement: m, conceptText, amount: m.amount, counterpartyText: m.counterpartyText, txKind: c.txKind, flags: c.flags };
      });
      const withRecurring = detectRecurringDirectDebits(classified);

      for (const row of withRecurring) {
        const m = row.movement;
        const recurring = row.flags.includes('direct_debit_recurring');
        if (recurring) summary.recurring += 1;
        const kind = recurring && row.txKind === 'direct_debit' ? 'direct_debit_recurring' : row.txKind;
        const { hmac: cpHmac, last4: cpLast4 } = ibanPseudonym(m.counterpartyIban ?? null);
        const inserted = await client.query<{ inserted: boolean }>(
          `insert into public.bank_transactions (community_id, bank_account_id, statement_id, fecha_operacion, fecha_valor, importe,
                                                 concepto_comun, concepto_propio, concepto_text, counterparty_name_norm,
                                                 counterparty_iban_hmac, counterparty_iban_last4, ref1, ref2, num_documento,
                                                 tx_kind, flags, confidence, dedupe_key)
           values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::public.tx_kind, $17::text[], $18, $19)
           on conflict (bank_account_id, dedupe_key) do update
              set statement_id = excluded.statement_id, tx_kind = excluded.tx_kind, flags = excluded.flags,
                  confidence = greatest(public.bank_transactions.confidence, excluded.confidence)
           returning (xmax = 0) as inserted`,
          [
            community.id,
            accountId,
            statementId,
            m.opDate,
            m.valueDate || m.opDate,
            m.amount,
            m.conceptoComun || null,
            m.conceptoPropio || null,
            row.conceptText || null,
            normaliseCompanyName(m.counterpartyText) || null,
            cpHmac,
            cpLast4,
            m.ref1 || null,
            m.ref2 || null,
            m.documentNumber || null,
            kind,
            row.flags,
            confidence,
            transactionDedupeKey(accountId, m.opDate, m.amount, row.conceptText),
          ],
        );
        if (inserted.rows[0]?.inserted === true) summary.inserted += 1;
        else summary.duplicates += 1;
      }
    }
  });

  console.log(
    `  account "${opts.account}": ${summary.inserted} new movement(s), ${summary.duplicates} already held, ` +
      `${summary.recurring} recurring direct debit(s), confidence ${confidence}`,
  );
  console.log(
    `  self-check ${summary.selfCheckOk === null ? 'not applicable' : summary.selfCheckOk ? 'passed' : 'not satisfied'}; ` +
      `opening + movements = closing ${summary.continuityOk === null ? 'not checkable' : summary.continuityOk ? 'holds' : 'differs'}`,
  );
  return summary;
}
