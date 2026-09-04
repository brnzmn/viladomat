/**
 * Registration of the `vendors` command group on the `vx` program.
 *
 * Kept in its own module so `main.ts` gains one line (`register(program)`) instead of a block,
 * and so the group can be wired by the integrator without touching the other milestones.
 */
import type { Command } from 'commander';

export function register(program: Command): void {
  const vendors = program
    .command('vendors')
    .description(
      'Vendor due diligence: public-registry checks, officers, related-party signals and the registry fact sheet',
    );

  vendors
    .command('check')
    .description(
      'Run the public-registry checks for one vendor or for all of them; every run appends an external_checks row',
    )
    .option('--vendor <party_id>', 'party id of a single vendor')
    .option('--all', 'every vendor party, plus the checks that concern the community itself')
    .option(
      '--only <types>',
      'comma-separated check types (nif_validate, iban_validate, company_profile, bdns_grants, raisc_grants, rasic, catastro_units, surname_frequency, rea, rasic_manual, aeat_census, registro_mercantil_nota, insolvency)',
    )
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--dry-run', 'print the checks that would run and write nothing')
    .action(
      async (opts: {
        vendor?: string;
        all?: boolean;
        only?: string;
        community?: string;
        dryRun?: boolean;
      }) => {
        const { vendorsCheckCommand } = await import('./vendors.ts');
        await vendorsCheckCommand(opts);
      },
    );

  vendors
    .command('links')
    .description(
      'Score the related-party signals S1-S11 and store them as party_links (reviewer and legal counsel only)',
    )
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--dry-run', 'compute and print, do not store')
    .action(async (opts: { community?: string; dryRun?: boolean }) => {
      const { vendorsLinksCommand } = await import('./vendors.ts');
      await vendorsLinksCommand(opts);
    });

  vendors
    .command('evidence')
    .description('File the screenshot or PDF a reviewer captured for a manual check')
    .requiredOption('--check <id>', 'id of the manual_pending external_checks row')
    .requiredOption('--file <path>', 'screenshot, PDF or saved page')
    .option('--note <text>', 'what the evidence shows, in one line')
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .action(async (opts: { check: string; file: string; note?: string; community?: string }) => {
      const { vendorsEvidenceCommand } = await import('./vendors.ts');
      await vendorsEvidenceCommand(opts);
    });

  vendors
    .command('factsheet')
    .description(
      'Print the vendor fact sheet: registry facts only, officers as initials, no scores',
    )
    .option('--community <uuid>', 'community id (defaults to the only community)')
    .option('--json', 'print the structure the pre-junta pack renders')
    .action(async (opts: { community?: string; json?: boolean }) => {
      const { vendorsFactsheetCommand } = await import('./vendors.ts');
      await vendorsFactsheetCommand(opts);
    });
}
