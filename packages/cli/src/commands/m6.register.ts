/**
 * M6 command wiring.
 *
 * `main.ts` stays as it is; one line there — `register(program)` before `parseAsync` — adds the
 * `anchors` and `legal-sources` commands and the two options the extended `vx report` needs
 * (`--reproduce`, `--allow-pending`). Keeping the wiring here means the milestone adds commands
 * without touching the entry point, and `register` is idempotent, so calling it twice is safe.
 */
import type { Command } from 'commander';

/** Add the M6 commands and options to an existing `vx` program. */
export function register(program: Command): void {
  if (!program.commands.some((c) => c.name() === 'anchors')) {
    program
      .command('anchors')
      .description('Write a Merkle root over the append-only tables, or record the timestamp token obtained for one')
      .option('--community <uuid>', 'community id (defaults to the only community)')
      .option('--lang <lang>', 'es | en (language of the printed instruction)', 'es')
      .option('--dry-run', 'compute and print the root, store nothing')
      .option('--list', 'list the anchors on record')
      .option('--token <id>', 'anchor id whose timestamp token is being recorded')
      .option('--file <path>', 'path to the timestamp token file (RFC 3161 .tsr, notarial receipt)')
      .action(async (opts: { community?: string; lang?: string; dryRun?: boolean; list?: boolean; token?: string; file?: string }) => {
        const { anchorsCommand } = await import('./anchors.ts');
        await anchorsCommand(opts);
      });
  }

  if (!program.commands.some((c) => c.name() === 'legal-sources')) {
    program
      .command('legal-sources')
      .description('Verification register: archive the primary text a rule cites, or read the gate status')
      .argument('<action>', 'archive | status')
      .option('--community <uuid>', 'community id (defaults to the only community)')
      .option('--id <id>', 'legal source id as referenced by rules.legal_source_ids, e.g. cccat-553-6')
      .option('--file <path>', 'archived copy of the primary text (PDF)')
      .option('--url <url>', 'canonical URL the copy was taken from')
      .option('--title <title>', 'title of the primary text')
      .option('--excerpt <text>', 'the paragraph the rule relies on, verbatim')
      .option('--notes <text>', 'note on the numbering or the edition')
      .action(async (action: string, opts: { community?: string; id?: string; file?: string; url?: string; title?: string; excerpt?: string; notes?: string }) => {
        const { legalSourcesCommand } = await import('./legal-sources.ts');
        await legalSourcesCommand(action, opts);
      });
  }

  const report = program.commands.find((c) => c.name() === 'report');
  if (report) {
    const optionNames = new Set(report.options.map((o) => o.long));
    if (!optionNames.has('--reproduce')) {
      report.option('--reproduce <report_id>', 'rebuild a stored export and diff it against what was recorded');
    }
    if (!optionNames.has('--allow-pending')) {
      report.option('--allow-pending', 'auditor pack: withhold and count items that have not completed the right of reply instead of refusing');
    }
  }
}
