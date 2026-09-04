import type { Command } from 'commander';

/**
 * Commands added by M2: `vx bank`, `vx extract`, `vx batch`.
 *
 * Kept out of `main.ts` so the command surface of a milestone lives with the milestone; the
 * integrator calls `register(program)` once.
 */
export function register(program: Command): void {
  const bank = program.command('bank').description('Native bank exports: parse, take into custody and store movements');

  bank
    .command('import')
    .description('Import a Norma 43, camt.053 or CSV export: hash and store the file, then write the statement and its movements')
    .argument('<file>', 'export file')
    .requiredOption('--account <label>', 'bank account label to import into (created when it does not exist)')
    .option('--source <source>', 'norma43 | camt053 | csv (detected from the bytes when omitted)')
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--batch <label>', 'custody batch label (defaults to bank-<date>)')
    .option('--supplied-on <date>', 'date the export was obtained, YYYY-MM-DD (defaults to today)')
    .option('--dry-run', 'parse and print, write nothing')
    .action(async (file: string, opts: { account: string; source?: string; community?: string; batch?: string; suppliedOn?: string; dryRun?: boolean }) => {
      const { bankImportCommand } = await import('./bank.ts');
      await bankImportCommand(file, opts);
    });

  program
    .command('extract')
    .description('Read grouped documents with the extraction model: queue jobs, run them here, or submit one Batch')
    .option('--document <uuid>', 'one document')
    .option('--batch <label>', 'every document of a delivery batch')
    .option('--pending', 'every grouped document without a succeeded extraction run (the default)')
    .option('--sync', 'run the extraction here instead of queueing it')
    .option('--batch-api', 'submit the selection as one Message Batch (half price, collected later)')
    .option('--limit <n>', 'stop after n documents')
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--dry-run', 'print the selection and stop')
    .action(async (opts: { document?: string; batch?: string; pending?: boolean; sync?: boolean; batchApi?: boolean; limit?: string; community?: string; dryRun?: boolean }) => {
      const { extractCommand } = await import('./extract.ts');
      await extractCommand(opts);
    });

  const batch = program.command('batch').description('Message Batches submitted by `vx extract --batch-api`');

  batch
    .command('collect')
    .description('Collect an ended batch: store the runs, write the rows, re-queue what expired and flag what errored')
    .argument('<batch_id>', 'batch id returned by `vx extract --batch-api`')
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--dry-run', 'report the outcome of every request and write nothing')
    .action(async (batchId: string, opts: { community?: string; dryRun?: boolean }) => {
      const { batchCollectCommand } = await import('./batch.ts');
      await batchCollectCommand(batchId, opts);
    });
}
