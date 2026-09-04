# viladomat

Document intake, extraction and reconciliation tooling for the accounts of an owners'
community (comunitat de propietaris) in Barcelona, governed by Book Five of the Civil Code of
Catalonia.

The system ingests photos, scans and PDFs of the community's paper trail (invoices, quotes,
contracts, work certifications, bank statements, administrator liquidations, meeting minutes),
extracts them into page-cited records, reconciles them against each other and against
junta resolutions, and produces verification reports whose every figure is traceable to an
original file hash, a page, an extraction run and a versioned rule.

## Principles

- Outputs are **discrepancies to verify**, never conclusions. Wording is template-locked
  ("not reconciled", "no supporting document located", "verify whether"); people are referred
  to by role. See `docs/neutrality.md`. `pnpm neutrality` enforces a blocklist in CI.
- Every counterparty gets a **right of reply** before any finding is circulated.
- **Chain of custody** from the first machine that touches the bytes: client-side SHA-256,
  server re-hash, immutable originals bucket, per-batch manifests with a timestamp slot.
- A monetary/identity field is accepted only when two independent readers agree exactly
  (Claude + Tesseract) or a person confirms it.
- Every number in a report prints `[file · page · run · rule@version · parameters · benchmark]`
  and `vx report --reproduce` must diff empty before distribution.

## Layout

```
apps/web         Next.js app: auth, bulk upload, seed & governance, review, reconciliation, reports
packages/core    pure step functions, Zod schemas, validators, parsers, rules SQL, i18n templates
packages/cli     `vx` worker/CLI run on the operator's machine (ingest, process, seed, rules, report)
supabase/        migrations (schemas `public` and `restricted`), RLS, buckets, RPCs
docs/            protocols, rule catalog, taxonomy, source registers, legal/ (LIA, DPIA, notices)
tests/           integration and end-to-end tests
```

## Getting started

```bash
pnpm install
cp .env.example .env            # fill in Supabase + Anthropic keys (never commit .env)
pnpm db:local:up                # local Postgres for migration tests (see scripts/db-local.sh)
pnpm db:local:migrate
pnpm test
pnpm vx --help
```

## Data handling

Personal data of owners and vendors is processed under a documented legitimate-interest
assessment (`docs/legal/`). Originals never leave the EU-hosted storage except as page images
sent to the extraction API under its data-processing agreement. Exports mask third parties.
Do not commit any real document, bank data or `.env`. Seed files may carry community-level figures transcribed from minutes with page references, never personal data.
