# Reports, gates and the verification register

Four packs are produced from the same normalised data. They differ in audience, not in facts:
every figure carries the same reference, and nothing is stated as a conclusion anywhere.

| Pack | Command | Audience (see `legal/retention-and-sharing.md` §2.1) | Contents |
|---|---|---|---|
| Pre-junta | `vx report --pack pre-junta` | assembly of owners | calendar and request clock, document matrix, verbatim quotations from the minutes, questions, draft resolutions, vendor fact sheet |
| Auditor | `vx report --pack auditor` | independent reviewer commissioned by the assembly; requesting owners | *informe de comprobación de cantidades*: scope and method, governance, control totals with the cut-off bridge, income, the supported-spend headline, the items that are not reconciled, works packages, checks on the contracted companies, the document matrix, and six annexes |
| Lawyer annex | `vx report --pack lawyer` | legal counsel | per item: basis, amount, bank movements, authorising resolution or its absence, resolving document, challenge and limitation dates, custody manifests, and the related-party detail |
| Data room | `vx report --pack data-room` | independent reviewer and counsel, under a controller–processor contract | every normalised ledger as a hashed CSV (plus JSON where jsonb columns matter) and `manifest.json` |

`--lang es` (default) and `--lang en` render the same templates and the same item references, so a
figure can be quoted from either version. `--out <dir>` defaults to `exports/packs`; the data room
is written under `exports/packs/<date>/data-room/` and, when Supabase Storage is configured,
uploaded to `exports/<community>/packs/<date>/data-room/`.

Every export writes a `report_exports` row: the storage path, the SHA-256 of the distributed
artefact (the PDF where Chromium produced one, otherwise the HTML), the SHA-256 of the canonical
body, and a manifest carrying the gate statistics. Every export is logged through
`public.log_access`.

## The five gates

The gates are pure functions in `packages/cli/src/report/gates.ts`; the packs call them, they are
not re-implemented per pack.

**(a) Right of reply.** A Tier-1 or Tier-2 item enters the body of a distributed pack only when
its status is `explained`, `confirmed_discrepancy` or `needs_document` **and**
`explanation_requested_on` is set — or a dated refusal is recorded in the reason of the latest
`finding_reviews` row. Everything else is counted, never described: the pack prints
"pendiente de derecho de respuesta — no distribuido" with a number and nothing more. When a reply
was received it is printed verbatim next to the item, with the attachments listed by hash.

`vx report --pack auditor` **refuses to run** when any Tier-1/2 item is still `new` or
`in_review`: the right of reply has not even been started. Pass `--allow-pending` to withhold and
count those items instead — the manifest then records `allow_pending: true`.

**(b) Legal citation.** An article number prints only when the rule's `legal_basis_kind` is
`statutory` or `subsidy_bases` **and** every id in `rules.legal_source_ids` has a
`legal_sources.archived_at`. Otherwise the pack prints *"referencia normativa pendiente de
archivo"* / *"legal reference pending archive"*. A rule that declares no source id is treated as
unarchived: the register has nothing to point at. The same rule applies to citations inside
`parameters.basis_text`, which the schema gives no way to attach to a source, so they are always
withheld today (see "Schema notes" below).

**(c) Tier.** Tier 1 needs `findings.four_eyes_ok`, or machine two-source fields —
`extraction_quality ≥ 0.99` and `independence ≥ 1.0`. A single reviewer's human confirmation caps
the item at Tier 2, and the annex says so.

**(d) Base-rate rules.** Rules with `rules.never_t1t2` (E4, B8, C6, E3 bare quorum) appear only in
the annex, with the note "expected in most small communities".

**(e) Scores.** `hit_score`, `specificity`, `independence` and `confidence` — and the
`extraction_quality` behind them — never appear in a pack. They go to the data room, where the
methodology note travels with them.

The gate statistics land in the pack itself and in the manifest:

```json
"gates": {
  "findings_total": 19, "findings_distributed": 1, "withheld_pending_reply": 1,
  "withheld_pending_legal_source": 17, "annex_only": 17, "tier_capped": 0,
  "pending_by_status": { "new": 1 }, "unreviewed_t1t2": 1
}
```

`withheld_pending_legal_source` counts items whose **article citation** was withheld, not items
withheld from the pack.

## Redaction

`packages/cli/src/report/redact.ts` runs over pack text, evidence rows and data-room CSVs alike:

- a natural-person counterparty on a bank row becomes `[particular]` / `[private individual]`;
  a counterparty is treated as a person unless it resolved to a business party row or its name
  carries a legal form, and the matcher's `person_beneficiary` flag always wins;
- vendor names are kept — an invoice issuer is business data and the fact under examination;
- IBANs keep their last four characters wherever they appear, including inside free-text concepts;
  pseudonymous HMACs are truncated to eight characters;
- other owners' units are named by unit label only; the units held by the presidency are labelled
  "unidad del rol de presidencia" / "unit of the presidency role", in tables and in prose.

Owner names never appear because the schema has no field for them.

## The reproducibility object

The rendered pack keeps everything volatile — the generation date, the output paths, the run id —
inside `<header class="pack-header">`, and everything reproducible inside
`<main id="pack-body">`. `report_exports.canonical_sha256` is the SHA-256 of that `<main>`
element; `sha256` is the hash of the distributed artefact. Ordering is fixed (fiscal year, then
rule code, then fingerprint) and money, percentages and integers are formatted by hand rather than
through `Intl`, so the same data renders the same bytes on any machine.

```
vx report --reproduce <report_export_id>
```

does three comparisons and prints each:

1. **Parameters** — the run's `parameters_snapshot` against the current rows. Parameters are
   versioned and append-only, so reading the current rows is equivalent as long as no newer
   version has been inserted; a newer version is reported, never silently used.
2. **Findings** — the rule engine runs again in dry mode inside a transaction that is rolled back,
   and the set of `(fingerprint, severity, tier, amount_at_stake, computed)` is compared with what
   the run stored.
3. **Document** — the pack is rendered again from the export's own `generated_on` date and the
   canonical hash compared. For the data room the comparison is `bundle_sha256`, a hash over the
   file names and their hashes, which does not move with the export date.

`reproduced_ok` and `reproduced_at` are written back to the export row. A non-empty diff is printed
and the command exits non-zero — that is the gate the sharing policy relies on before a pack
leaves the requesting owners.

Two views read `current_date` (`v_challengeable_resolutions`, and `v_limitation_clocks` through
the challenge columns it feeds), so a pack re-rendered on a **later** date can legitimately differ
in the list of resolutions whose challenge window is still open. Reproduce before distributing, on
the same day the pack was produced.

## Anchoring

```
vx anchors                          # compute, store and print a root
vx anchors --dry-run                # compute and print only
vx anchors --list                   # the anchors on record
vx anchors --token <id> --file <p>  # record the timestamp token obtained for anchor <id>
```

Each leaf is `public.row_hash(t)` — the SHA-256 of a row's canonical JSON, computed in the
database — read in primary-key order over `files`, `extraction_runs`, `field_revisions`,
`validator_results`, `finding_reviews`, `audit_log` and `external_checks`. The previous anchor's
root joins the leaves, chaining the anchors to each other, and the row counts per table are stored
alongside. Any later change to an anchored row changes the root.

The root is the short string an operator has timestamped:

> Obtain a qualified timestamp (RFC 3161) over the file holding the root from a qualified trust
> service provider, or deposit it before a notary, then record the token path with
> `vx anchors --token <id> --file <path>`.

The token file is hashed and stored under `exports/<community>/anchors/<anchor id>.<ext>`.

## The verification register

```
vx legal-sources status
vx legal-sources archive --id <id> --file <pdf> --url <url> --title <t> [--excerpt <text>]
```

`status` lists every id referenced by `rules.legal_source_ids` with a yes/no and the rules citing
it. That table is the gate readout: while an id says "no", every article of every rule citing it
prints as pending. `archive` hashes the PDF, stores it under
`exports/<community>/legal_sources/<id>.pdf` (or the filesystem mirror when Storage is not
configured), upserts the `legal_sources` row with `archived_at`, and reports which rules it just
unblocked. `docs/legal-references.md` records what each source is and what still has to be
confirmed in it.

## Wiring

`packages/cli/src/commands/m6.register.ts` exports `register(program)`, which adds the `anchors`
and `legal-sources` commands and the `--reproduce` and `--allow-pending` options on `report`. One
line in `main.ts` — `register(program)` before `parseAsync` — makes them reachable from the CLI;
`register` is idempotent.

## Schema notes

- `chain_anchors` is append-only by trigger, so `timestamp_token_path` cannot be filled after the
  row is written. `vx anchors --token` attempts the update, and when the trigger refuses it stores
  the token path and hash in `audit_log` — which is itself anchored — and says so.
- `parameters` has no `legal_source_ids` column, so a threshold's `basis_text` can never satisfy
  the citation gate; citations in it are withheld unconditionally.
