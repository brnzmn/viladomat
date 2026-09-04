# Expected prices

For every invoice line, quote partida, certification item and contract, the system computes what
the figure would be expected to be, and how far the figure actually recorded sits from it. The
output is an instruction to look, never a conclusion: a deviation is a **discrepancy to verify**,
printed with the layers it rests on, the sources of each layer and the version of the method and
the parameters used.

Implementation: `packages/core/src/pricing/` (`expected.ts`, `indexation.ts`, `seed-benchmarks.ts`,
`d5b.ts`); taxonomy in `packages/core/src/taxonomy/`; storage in `public.expected_prices`,
`public.benchmark_records`, `public.benchmark_sources`, `public.benchmark_categories` and
`public.index_series` (migration `0010_m4_extension.sql`).

## 1. The four layers

Each layer proposes a point estimate and a band for the same line. A layer that cannot apply is
still recorded, with the reason it was skipped, so a report can state what the expectation rests on.

| Layer | Where the figure comes from | Band | Weight |
|---|---|---|---|
| `CONTRACT` | the matched quote or contract partida (same code, else trigram similarity ≥ 0.85 and the same unit) | closed price: none of its own; `+10%` with a signed change order; open price: `±10%` | 0.45 |
| `BUDGET` | the amount approved by the assembly for this scope (`resolutions.importe_aprobado`) | `± tolerance` (10% by default) | 0.25 |
| `BENCHMARK` | a `benchmark_records` row for the category, region (BCN → CAT → ES) and period, brought to the date of the line by an index factor | `[low, high] × quantity × index factor` | 0.30 official tier, 0.20 otherwise |
| `HISTORY` | the community's own prior-period figure for the same vendor and category | `± (index variation + 3 points)` | 0.10, or 0.35 for a recurring service with no contract on file |

**E** is the weighted mean of the contributing points, with the weights renormalised over the layers
that actually contributed. The **band** is the union of the contributing bands. When only one layer
contributes, the band is widened to at least `±5%` around its point, so a closed contract price is
not a knife edge on which every cent becomes a deviation.

**A delegation without an explicit cap is a ceiling, not a price.** A budget layer marked
`isCeiling` does not move E and does not enter the union; it only caps the top of the band. If it is
the only thing known about a line, no expectation is produced at all — an amount above a cap is a
question about authority (rules E1, A1), not about price.

## 2. Severities

`D = actual − E`. `outsideBy` is the relative distance from the nearest edge of the band, and 0 when
the figure sits inside it.

| Severity | Condition |
|---|---|
| `INFO` | inside the band |
| `REVIEW` | outside the band, but not all the MATERIAL conditions hold |
| `MATERIAL` | `outsideBy ≥ 25%` **and** `\|D\| ≥ pm_works` **and** confidence ≥ medium **and** at least one contributing source is not trade tier |
| `NON_BENCHMARKABLE` | no layer could produce an expectation |

Confidence is `high` when a contract layer and at least one other layer contributed (or the raw
weights sum to ≥ 0.65), `medium` at ≥ 0.25, `low` below that. A trade-tier benchmark on its own
weighs 0.20, so it lands on `low` confidence and fails the non-trade condition as well: **a
trade-tier benchmark alone can never yield MATERIAL.** This is deliberate double-guarding — the
trade ranges in the register come from marketplaces and firm pages and were gathered from
search-engine summaries.

`pm_works` is the works materiality (1% of the works spend under review), read from `parameters` at
the date of the line; the version used is stored on the row.

## 3. The non-benchmarkable policy

Three categories are marked `comparable_default = false` in `benchmark_categories` and are skipped
in the BENCHMARK layer in v1:

- `ELEV_INSTALL` — lift installation (equipment)
- `ELEV_CIVIL` — lift civil works
- `STAIR_REHAB` — staircase rehabilitation

No source in the register describes a 6–7-stop lift inserted into the stairwell of a protected
pre-1965 Eixample building with a pit, slab cutting, structural reinforcement and heritage
conditions, or the rehabilitation of such a stairwell. Quoting a generic database against one would
produce a number that looks precise and is not comparable, which is exactly what the report must not
do. For these categories the CONTRACT and BUDGET layers still apply, and the report prints "no
comparable benchmark". Whole-project trade ranges feed only the order-of-magnitude envelope of the
funding-gap rule (D0), never a price deviation.

Two further cases skip the layer for the same reason:

- the `benchmark_records` row is marked `comparable = false` for this works package (building age,
  protection, number of stops, pit or structural scope, new versus replacement — kept in `scope`);
- the line has no quantity in a recognised unit, so a unit price cannot be applied to it.

`MISC` carries no layer at all: an unclassified line goes to the review queue instead of being
priced.

## 4. Versioning and re-syncing benchmark records

`benchmark_records` is **append-only**. Facts never change:

- a `DELETE` is refused by the guard trigger;
- an `UPDATE` is refused for every column except `superseded_by`, which may be set exactly once;
- the app role has no `UPDATE` or `DELETE` policy at all, so the pointer is set by the worker
  (service role) as part of a re-sync.

A re-sync therefore inserts a new row with the new figures and a new `hash`, then sets
`superseded_by` on the row it replaces. The current record for a category is the one with
`superseded_by is null`; a finding computed last month still resolves to the exact row it used, and
the report prints its id. `hash` is the canonical hash of the record content, so the same capture
inserted twice is refused by the unique constraint rather than silently duplicated.

Every row cites one entry of `benchmark_sources` (the register in `docs/benchmark-sources.md`) and
an `evidence_file_id`: the archived PDF, JSON or screenshot in Storage. A source's `verified_at`
stays null until that archived copy has been read; the report gate refuses to print a figure whose
source is still unverified.

**Indexation.** `index_series` holds published index observations (`source`, `series_code`,
`base_period`, `period`, `value`). A base change starts a new segment — the IPC moved to `2025=100`
with the January 2026 release — and values on different bases cannot be divided. `chainIndex`
re-expresses every segment on the base of the most recent one, linking consecutive segments through
a period both publish, or through an explicit link factor when they do not overlap. `indexFactor`
then divides the two chained values and returns **null** when either end is missing or the segments
cannot be chained, so the line is reported as not indexable rather than quietly indexed by 1.

## 5. Official-tier seed

`seed-benchmarks.ts` holds the official-tier constants and nothing else. No trade price is baked
into the code.

- **ICIO** is parameterised by year (`ICIO_BY_YEAR`), never a constant: research packs disagreed on
  the rate, so both readings are carried per edition with `toVerify: true` until the ordinance for
  that year is archived. The accessibility bonus is recorded as reported and must be requested and
  granted to apply.
- **Ordinance 3.3** (planning-services fee) is stored as a shape with unset amounts: the figures
  found during research may belong to an earlier edition.
- **Subsidy caps** carry the percentage, the absolute caps and the call conditions, with the
  competing readings recorded. The caps are ceilings, not unit prices.
- **Lift periodicity** (RD 355/2024, ITC AEM 1) is not a price: it drives the expected number of
  maintenance and inspection documents per year, and stays unset because it depends on the
  installation class.
- The **administrator fee range** is the one literature figure kept in the module, marked `[L]`,
  with `usableAsBenchmark: false` and `severityCap: 2`. It exists to decide whether a fee is worth
  asking about; it never prices a line and never becomes a `benchmark_records` row.

`officialParameterSeeds()` turns these into `parameters` rows, inserting placeholders with a null
value where a figure has not been read, so a rule that needs it fails loudly instead of assuming a
default. `unverifiedConstants()` is the list the report gate checks before distribution.

## 6. Rules that read this engine

| Rule | Layers |
|---|---|
| P1a | CONTRACT and BUDGET only (`expectedPriceP1a`) — available in M4 |
| P1b | all four layers — M8, once archived benchmark records exist |
| A2 | unit-price outliers against official-tier benchmarks only |
| D5b | not a price layer: `quotaExpectation` derives the ordinary contribution from the approved budget and the unit's quota, and the extraordinary contribution from the derrama rule, per unit and period |

Every stored expectation carries `method_version` (`p1-1.0.0`) and `parameters_version`, and only one
row exists per `(target_type, target_id, method_version)`, so `vx report --reproduce` recomputes the
same figure from the same inputs.
