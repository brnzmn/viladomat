# Synthetic test corpus

A fully invented document set for one fictional community — **Comunitat de Propietaris Carrer
Exemple 1** (NIF `H00000000`, per `docs/neutrality.md`) — used to (1) measure field-level
extraction accuracy against known ground truth and (2) regression-test the rule catalogue
against a fixed set of planted discrepancies. Nothing here refers to a real person, company,
bank or building; see "Neutrality" below.

## Regenerating

```
pnpm install        # once; installs tsx, pdf-lib, sharp at the repo root
pnpm synth          # runs tests/synthetic/generate.ts
```

This writes:

- `tests/synthetic/out/**` — the full corpus (15 invoices as PDF, 3 of them also as a
  photo-like JPEG; 2 bank statements as PDF + Norma 43 + CSV; 2 actas; 1 works contract; 1
  annual liquidación). **Git-ignored** (`tests/synthetic/.gitignore`) — always regenerate it
  locally rather than expecting it to be checked out.
- `tests/synthetic/expected.json` — ground truth for every document above. **Committed.**
- `tests/synthetic/sample/**` — a small, fixed subset of the corpus above, copied byte-for-byte
  from the same run (see "Sample set" below). **Committed.**

Generation is deterministic: every substantive fact (vendor, amount, date, planted
discrepancy) is a literal value in `lib/*-model.ts`, not a random draw, so it cannot drift
between runs. Re-running `pnpm synth` twice in this environment produces byte-identical files
in both `out/` and `sample/` (verified while building this corpus). The one intentional exit
from pure literal data is described in "Design notes" below.

## What is planted

Every other rule in `docs/rule-catalog.md` should find **nothing** on this corpus — that is
the point of a golden set: false positives are as visible as false negatives. Exactly ten
discrepancies are planted, each recorded in `expected.json`'s `planted` array with an `id`,
the rule code(s) it should trigger, an `event_key`, the documents it rests on, and the
identifying `facts` a rule implementation needs:

| id | rule(s) | what | key documents |
|---|---|---|---|
| `C3-duplicate-invoice` | C3 | Ascensors Exemple S.A. invoices `AI-2026-0301` / `AI-2026-0344`: same total (4.598,00 €), different numbers, 20 days apart — both actually paid | `inv-elev-install-a/b.pdf`, May statement |
| `C4-split-under-threshold` | C4 | Instal·lacions Exemple S.L. invoices `F-2026-0110` (550,00 €) / `F-2026-0115` (600,00 €), 4 days apart, each under €1.000, summing to €1.150,00 | `inv-windows-1/2.pdf` |
| `B4B5-iban-mismatch` | B4, B5 | Fusteria Referència S.L. invoice `FR-2026-0045` prints one IBAN; the matching transfer reached a different one | `inv-entrance-door.pdf`, June statement |
| `D4E2-advance-before-acta` | D4, E2 | The 40% contract advance (20.328,00 €) to Construccions Model S.L. was transferred 2026-05-04 — 10 days before the 2026-05-14 extraordinary acta approving the rear-façade works, and before the contract's own 2026-05-16 signature | May statement, extraordinary acta, contract |
| `D5R6-missing-derrama-credit` | D5, R6 | Unit **3r 1a** has no derrama credit in June 2026, unlike every other unit (and unlike itself in May) | June statement |
| `C11-private-element` | C11 | A windows invoice's second line reads "Sustitución ventana dormitorio Pral 1a" — a private element — next to a common-element line | `inv-windows-3.pdf` (+ its photo JPEG) |
| `D1R2-unmatched-debit` | D1, R2 | A 480,00 € transfer to "Jardineria Exemple" has no invoice anywhere in the corpus | May statement |
| `D2-cash-withdrawal` | D2 | A 1.200,00 € cash withdrawal exceeds the €1.000 cash limit (Ley 7/2012 art. 7, in effect since 2021-07-11) | May statement |
| `C2-arithmetic-mismatch` | C2 | Invoice `AI-2026-0290`'s printed base (450,00 €) is €10,00 short of its own line sum (460,00 €) | `inv-elev-inspect.pdf` |
| `A4-paid-exceeds-certified` | A4 | By the 2026-07-01 suspension date, progress payments beyond the advance (21.780,00 €) exceed what the site direction had certified (18.000,00 €, as of 2026-06-28) — a 3.780,00 € excess | contract, `inv-facade-progress.pdf`, June statement |

No `certificacion_obra` PDF is generated for the last item (that document type is out of scope
for this corpus); the certified amount lives only in `expected.json`'s `planted[].facts` and in
`CERTIFICATION_NOTE` in `lib/contract-model.ts`, exactly as the task asked.

One item's `notes` field flags a genuine, honestly-documented edge case: the D4/E2 advance
transfer has no linked invoice (it is a contractual advance, paid per the contract's own 40%
clause), so a rule engine that does not recognise that clause as sufficient authority may also
raise D1/R2 on the *same* transfer. That is the same underlying event, not an eleventh planted
discrepancy — treat any such hit as sharing the `tx:advance-facana-posterior:2026-05-04` event
key.

## How the harness is meant to be used

`harness.ts` exports two pure functions (no filesystem, no network, no database):

- **`compareFields(expected, extracted)`** — feed it `expected.json`'s per-document fields
  (reshaped into `{doc, path, type, value}` triples — `type` is `amount | date | nif | iban |
  text`, the same vocabulary `@viladomat/core/text/amounts.ts` uses) and whatever an extraction
  run produced in the same shape. It normalises both sides with that module's own
  `normaliseValue` before comparing — the two-source-rule's own equality test — and returns
  accuracy **and a Wilson 95% lower confidence bound** per field type plus overall, along with
  every mismatch. Report the lower bound, not the raw fraction, exactly as
  `packages/core/src/rules/scoring.ts` does for `extraction_quality`: on a corpus this size a
  handful of NIF fields is a small sample, and the point estimate alone overstates confidence.
  A missing extracted field counts as wrong, never as skipped, so a silent omission cannot
  inflate the score.
- **`checkPlanted(planted, findings)`** — feed it `expected.json`'s `planted` array and a rule
  run's findings (anything shaped like `{ruleCode, eventKey}` — a real `RuleHit` from
  `packages/cli/src/rules/engine.ts` works unmodified). It returns `{detected, missed, extra}`:
  `detected` entries carry `collapsedToOne` — false means a planted event still produced more
  than one finding, i.e. event-key collapse (docs/rule-catalog.md §8) did not do its job;
  `missed` are planted items no finding touched; `extra` are findings on event keys outside the
  planted list, which on this corpus are false positives by construction, since every other
  document was built clean.

A passing regression run, on this corpus, looks like: `missed = []`, `extra = []`, and every
`detected[i].collapsedToOne === true`.

Run the harness's own unit tests (canned inputs, no corpus needed) from the repo root:

```
pnpm --filter @viladomat/core exec vitest run --config ../../tests/synthetic/vitest.config.ts --root ../../tests/synthetic
```

(`tests/` is intentionally not a pnpm workspace package — see `docs/interfaces.md`'s package
list — so `harness.test.ts` borrows whichever workspace package's vitest binary is at hand via
`--config`/`--root` rather than adding a new root dependency beyond the tsx/pdf-lib/sharp this
generator needs.)

## Sample set

`tests/synthetic/sample/` commits a small, fixed slice of the corpus above (≈115 KB total, well
under the 1.5 MB budget) so the repository carries at least one example of every format without
requiring `pnpm synth` first:

- `invoices/inv-elev-maint.pdf` — a clean invoice with a handwritten margin note.
- `invoices/inv-entrance-door.pdf` — the B4/B5 IBAN-mismatch invoice (the mismatch itself is
  only visible against the bank statement, not from this file alone).
- `invoices/inv-windows-3-photo.jpg` — the C11 private-element invoice's photo-like rendering
  (no separate PDF is committed for this one, to keep the sample to exactly three invoice
  files as specified — the full PDF is in `out/` after `pnpm synth`).
- `statements/statement-2026-05.pdf` + `.n43` + `.csv` — the May bank statement in all three
  formats.
- `actas/acta-ordinaria-2026-03-30.pdf` — the ordinary meeting (accounts, budget, derrama
  continuation, attendance table).

`tests/synthetic/.gitignore` ignores `out/` and carries one narrow un-ignore
(`!sample/**/*.n43`) because the repo-root `.gitignore` blanket-excludes `*.n43` everywhere (to
keep a real bank export from ever being committed by accident); the sample file is fake data
and is deliberately exempted.

## Design notes

- **Amounts, NIFs, IBANs**: every invented NIF/CIF/DNI and IBAN (`lib/fixtures.ts`,
  `lib/core-ids.ts`) is constructed with `@viladomat/core`'s own checksum math (`cifControlDigit`,
  `dniLetter`, `cccToIban`) and self-checked with `validateNif`/`validateIban` at module load —
  a bug here fails the generator loudly rather than shipping an invalid identifier inside a
  document meant to be "clean". Bank entity codes are fictitious four-digit numbers outside the
  real Banco de España table (`packages/core/src/ids/iban.ts`'s `ES_BANKS`), so no real bank's
  name is ever implied; every printed bank name (`Banc Exemple`, `Caixa Model`, ...) is invented
  separately from the numeric code that makes the IBAN checksum valid.
- **Norma 43**: `lib/norma43-writer.ts` mirrors `packages/core/src/bank/norma43.ts`'s reader
  field-for-field. `generate.ts` round-trips every `.n43` it writes back through that reader and
  fails the build if `selfCheckOk` is false or there are any warnings — the file is not just
  "plausible-looking", it is verified parseable by the real parser. Free-text fields are
  transliterated to plain ASCII, matching how real (legacy, byte-oriented, fixed-width) Norma 43
  exports usually carry names — not because our writer couldn't emit UTF-8, but because a
  strict fixed-width reader assuming one byte per character would misalign on a multi-byte
  accented character otherwise.
- **Handwriting**: no cursive/handwriting font ships in this environment and only
  tsx/pdf-lib/sharp were added as dependencies, so a "handwritten" annotation
  (`lib/handwriting.ts`) is approximated with the closest standard-14 shape available — an
  oblique (italic) face — drawn word-by-word with a jittered rotation and baseline in a
  pen-blue colour, rather than as one mechanically straight line. It is meant to exercise the
  extraction pipeline's "mark handwriting" / low-confidence path, not to look like a scan of
  real ink.
- **Photo-like JPEGs**: rather than fight headless Chromium's PDF viewer in screenshot mode
  (it did not render reliably in this sandbox), `lib/photo.ts` builds a plain HTML twin of the
  invoice, screenshots it with the Chromium already bundled at `/opt/pw-browsers`, then distorts
  the screenshot with `sharp`: rotate onto a desk-coloured background (2–4°, sign and exact
  angle from the seeded PRNG), a radial vignette, deterministic film grain, and a slight blur,
  before JPEG-encoding. The seeded PRNG (`lib/prng.ts`) only drives this cosmetic distortion;
  re-running produced byte-identical JPEGs in this environment, but a future Chromium/sharp
  upgrade changing antialiasing at the pixel level is the one plausible way a re-run could stop
  being byte-identical — hence "where the renderer allows" in the top-level task description.
- **Why a getter-based `CONTRACT` object**: `lib/contract-model.ts`'s `CONTRACT` exposes derived
  figures (`priceIva`, `advanceAmount`, ...) as getters over two literal inputs (`priceBase`,
  `advancePct`) instead of separately hand-typed numbers, specifically so the contract PDF, the
  `A4-paid-exceeds-certified` planted item and `expected.json` cannot silently drift apart from
  each other after an edit — they all read the same computation.
- **Not generated**: quotes/`presupuesto` documents, work certifications
  (`certificacion_obra`), permits and subsidies are out of scope for this corpus (the task's
  document list is invoices, statements, actas, one contract and one liquidación); rules that
  depend on those document types (A1, A8/A9, G3/G4, ...) have nothing to fire on here one way
  or the other and are not part of this golden set's regression claim.

## Neutrality

Generated content follows `docs/neutrality.md`: invented vendor names ("Instal·lacions Exemple
S.L.", "Construccions Model S.L.", ...), the standard placeholder community and unit labels
("Comunitat de Propietaris Carrer Exemple 1", "Pral 1a", ...), and roles rather than person
names throughout (the architect's issuer name is "Arquitecte Tècnic Exemple", not a person's
name; the president appears only as "president/a" attached to unit **Entl 1a**). Run
`node scripts/neutrality-check.mjs` from the repo root after any edit here — it scans untracked
files too, so it catches a slip in this directory before the first commit.
