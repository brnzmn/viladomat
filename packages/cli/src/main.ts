#!/usr/bin/env node
import { Command } from 'commander';
import { closeDb } from './lib/db.ts';

const program = new Command();
program
  .name('vx')
  .description('Operator CLI and worker for the community accounts verification system')
  .version('0.1.0');

program
  .command('seed')
  .description('Load a YAML seed file (units, meetings, resolutions, derramas, works packages, requests) with page references')
  .argument('<file>', 'seed YAML file')
  .option('--owner-user <uuid>', 'auth user id to register as owner_reviewer of the community')
  .option('--dry-run', 'validate and print the plan without writing')
  .action(async (file: string, opts: { ownerUser?: string; dryRun?: boolean }) => {
    const { seedCommand } = await import('./commands/seed.ts');
    await seedCommand(file, opts);
  });

program
  .command('ingest')
  .description('Take a delivery of originals into custody: hash on this machine, store the untouched bytes, record the batch')
  .argument('<path>', 'file or directory of originals')
  .requiredOption('--source <source>', 'local | admin_delivery | bank_export | phone_transfer | onsite | drive')
  .requiredOption('--supplied-by <role>', 'role that supplied the batch (administrator, president, requesting_owner, ...)')
  .requiredOption('--supplied-on <date>', 'date the documents were handed over, YYYY-MM-DD')
  .requiredOption('--batch <label>', 'batch label, e.g. entrega-2026-09-12')
  .option('--transport <note>', 'how the files travelled (airdrop, drive, usb, email-attachment, whatsapp, onsite) and any caveat')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .option('--hires', 'render at 2576 px instead of 1568 px (handwriting, dense tables)')
  .option('--dry-run', 'walk and hash only; write nothing')
  .action(
    async (
      target: string,
      opts: { source: string; suppliedBy: string; suppliedOn: string; batch: string; transport?: string; community?: string; hires?: boolean; dryRun?: boolean },
    ) => {
      const { ingestCommand } = await import('./commands/ingest.ts');
      await ingestCommand(target, opts);
    },
  );

program
  .command('manifest')
  .description('Export a custody manifest (CSV + SHA-256) for a delivery batch')
  .requiredOption('--batch <label>', 'batch label used at upload/ingest time')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .option('--out <dir>', 'output directory', 'exports/manifests')
  .action(async (opts: { batch: string; community?: string; out: string }) => {
    const { manifestCommand } = await import('./commands/manifest.ts');
    await manifestCommand(opts);
  });

program
  .command('rules')
  .description('Run the rule engine on the current data and store findings')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .option('--only <codes>', 'comma-separated rule codes to run')
  .option('--dry-run', 'compute and print, do not store')
  .action(async (opts: { community?: string; only?: string; dryRun?: boolean }) => {
    const { rulesCommand } = await import('./commands/rules.ts');
    await rulesCommand(opts);
  });

program
  .command('match')
  .description('Reconcile invoices, bank movements, liquidación lines, resolutions and contracts; print control totals and residuals R1-R7')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .option('--dry-run', 'compute and print, do not store')
  .action(async (opts: { community?: string; dryRun?: boolean }) => {
    const { matchCommand } = await import('./commands/match.ts');
    await matchCommand(opts);
  });

program
  .command('letters')
  .description('Render the "Solicitud de aclaraciones" letter for one finding and record the request')
  .requiredOption('--finding <uuid>', 'finding id')
  .option('--lang <lang>', 'es | en', 'es')
  .option('--out <dir>', 'output directory', 'exports/letters')
  .action(async (opts: { finding: string; lang: string; out: string }) => {
    const { lettersCommand } = await import('./commands/letters.ts');
    await lettersCommand(opts);
  });

program
  .command('report')
  .description('Render a pack (pre-junta v0) to HTML and, when Chromium is available, PDF')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .option('--pack <kind>', 'pre-junta', 'pre-junta')
  .option('--lang <lang>', 'es | en', 'es')
  .option('--out <dir>', 'output directory', 'exports/packs')
  .action(async (opts: { community?: string; pack: string; lang: string; out: string }) => {
    const { reportCommand } = await import('./commands/report.ts');
    await reportCommand(opts);
  });

program
  .command('process')
  .description('Worker: drain the jobs queue (ingest, render, ocr, ...)')
  .option('--watch', 'keep polling')
  .option('--steps <steps>', 'comma-separated steps to handle')
  .option('--worker <name>', 'worker name', `cli-${process.pid}`)
  .action(async (opts: { watch?: boolean; steps?: string; worker: string }) => {
    const { processCommand } = await import('./commands/process.ts');
    await processCommand(opts);
  });

program
  .command('status')
  .description('Show queue, corpus and findings counters')
  .option('--community <uuid>', 'community id (defaults to the only community)')
  .action(async (opts: { community?: string }) => {
    const { statusCommand } = await import('./commands/status.ts');
    await statusCommand(opts);
  });

program
  .hook('postAction', async () => {
    await closeDb();
  });

program.parseAsync(process.argv).catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await closeDb();
  process.exit(1);
});
