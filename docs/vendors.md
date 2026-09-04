# Vendor due diligence (M5)

What the public registers say about the companies the Community contracted with, and which
coincidences between those companies and the Community's office-holders are **questions to put to
a register**. Nothing in this module concludes anything about a person.

Two audiences, two outputs:

| Output | Contains | Goes to |
|---|---|---|
| **Fact sheet** (`vx vendors factsheet`, `vendorFactSheet()`) | registry facts only: identifier validity and entity kind, incorporation date, officers as **initials**, REA/RASIC state, published grants, first document date | the pre-junta pack, i.e. the assembly of owners |
| **Links** (`vx vendors links`, `public.party_links`) | scored coincidences S1–S11 with the expected number of homonyms and the registry document that would settle them | the reviewer screen and the lawyer/auditor annex only |

The separation is a rule, not a convention: `docs/neutrality.md` says related-party material never
reaches the assembly as a whole, and the fact sheet is asserted by test to carry no score, no tier,
no link and no name of a natural person.

## 1. Wording

Every output uses the template the neutrality policy fixes:

> Possible link to verify: `<signals>`; expected homonyms: `N`; source: `<check type> <date>`;
> nota informativa not yet obtained.

- People are named by role: "the presidency", "the managing agent", "an officer of the vendor".
- A surname coincidence is always printed with the number of people who would be expected to
  produce the same coincidence by chance in a city of 1.6 million.
- Absence from a register is "not located", and it is stated as **non-exculpatory**: exemptions
  exist (a sole trader without employees is outside REA), registration may sit in another
  autonomous community, or may have lapsed after the works.
- A family-run contractor is lawful. What a meeting can ask about is disclosure and competition.

## 2. Checks

One module per check under `packages/cli/src/vendors/checks/`. Each returns
`{ type, status, normalised, raw, source_url, cost_cents }`, goes through `ctx.fetch` (injectable,
so tests run on recorded fixtures and never touch the network), waits on a per-source rate limiter
and gives up after **10 seconds**. Every run appends one `public.external_checks` row with the
request, the raw response and `fetched_at`; the table is append-only, so a re-run adds a row and
the earlier answer stays on the record. Payloads over 256 KB are archived in the `exports` bucket
and the row keeps the storage path.

| Check | Source | What it returns | Rate | Cost |
|---|---|---|---|---|
| `nif_validate` | local (`@viladomat/core`) | check digit, kind (DNI/NIE/CIF), entity letter and the legal form it implies | – | free |
| `iban_validate` | local (`@viladomat/core`) | mod-97, Spanish CCC control digits, bank code, bank name, absorbed-into code and the current entity, last four characters. The account number itself is never written to the row. Given a transcribed number it computes; given only what `party_ibans` stores (bank code, last four, the verdicts recorded when the number was read) it replays the entity resolution and marks the result `basis: 'stored_pseudonym'` | – | free |
| `company_profile` | OpenMercantil `/api/v1` (BORME aggregator) | officers, registered address, incorporation date, share capital, CNAE, gazette event timeline; searched by identifier, then by name at ≥ 0.85 token-set similarity | 60/min | free |
| `bdns_grants` | BDNS `concesiones/busqueda` | grants published for a beneficiary, with amounts granted and paid | 30/min | free |
| `raisc_grants` | Catalan open data (Socrata `s9xt-n979`) | the same, for the Catalan register | 60/min | free |
| `rasic` | Catalan open data (dataset id **placeholder**) | registration of lift, electrical, gas and thermal installers and maintainers | 60/min | free |
| `catastro_units` | Cadastre OVC callejero (JSON) | units at an address: cadastral reference, staircase, floor, door, use, built surface, participation coefficient, year | 20/min | free |
| `surname_frequency` | Idescat onomàstica | frequency of a surname in ‰, cached in `external_checks` for a year | 30/min | free |

### Manual checks

Four sources have no usable machine route — a web form, a service behind the operator's own Cl@ve,
or a document that is bought. They append a `manual_pending` row that carries the exact page, the
search terms and the evidence to capture, and the CLI prints them:

| Check | Page | Evidence to upload | Cost |
|---|---|---|---|
| `rea` | REA public lookup (mites.gob.es) | result page with the search terms and date; registration number and validity dates, or the empty result | free |
| `rasic_manual` | Canal Empresa | register entry or empty result with search terms and date | free |
| `aeat_census` | AEAT census check of a third party's identifier | the AEAT response PDF; nothing else on the screen | free |
| `registro_mercantil_nota` | registradores.org | the nota informativa as delivered, plus the purchase receipt | ≈ €15 |
| `insolvency` | Registro Público Concursal | search result for the identifier and the name, with the date | free |

Filing the evidence:

```
vx vendors evidence --check <external_check_id> --file <path>
```

The file is stored at `exports/<community_id>/checks/<check_id>.<ext>` and a **completion row** is
appended with `status = 'ok'` and `evidence_storage_path` set, pointing at the pending row through
`request.answers_check_id`. The pending row is not modified — `external_checks` is append-only — so
both the date the check was raised and the date it was satisfied stay on the record.

A leg obtained this way is **not** issuer-direct: a reviewer's screenshot scores `independence`
0.7, an archived machine response 1.0.

## 3. Officers

`company_profile` names are normalised (accents, `l·l`, particles), split into given name and the
two surnames by the core splitter, and upserted into `public.entity_officers` with the gazette
reference (`borme_ref`) and the id of the check they came from. The match key is party + normalised
name + office, so re-running the check updates a row instead of adding a duplicate.

These are natural persons who are not parties to the review. Their names exist in
`entity_officers` and on the reviewer screen and nowhere else; every other output renders them as
initials (`J.M. E. R.`). The only reason the full name is stored is that a surname equality test
cannot be run on an initial.

## 4. Related-party signals

`vx vendors links` scores each vendor against the office-holder material and against the rest of
the corpus. The office-holder side comes **only** from `public.reference_match_keys(cid)`, which
returns keyed digests and normalised surname tokens; no given name, address or identifier of an
office-holder is ever loaded in clear.

| Signal | Test | Points |
|---|---|---|
| S1 | identifier digest of the vendor or an officer equals an office-holder's | 100 |
| S2 | officer's given name and both surnames equal an office-holder's | 90 |
| S3 | both surnames equal, same order / reversed | 45 × w / 30 × w |
| S4 | one surname equal — **skipped** when that surname is carried by more than 5 ‰ | 8 × w |
| S5 | vendor's registered address is the building's or an office-holder's | 80 |
| S6 | address shared with another vendor or with the managing agent | 40, or **15** at an address hosting ≥ 5 entities |
| S7 | account digest shared with another party | 90 |
| S7 | account digest equals one the presidency's quotas are paid from | 100 |
| S7 | telephone shared / e-mail mailbox or domain shared | 60 / 50 |
| S8 | first invoice under 12 months after incorporation (45 under 3 months); capital ≤ €3,000 **+10**; activity code not covering the work **+25** | additive |
| S9 | quotes from "different" vendors sharing a PDF producer or author, a telephone, an account or a number series | 50 |
| S10 | REA absent 30 · RASIC absent 50 · census check fails 60 · check digit invalid 20 | the strongest |
| S11 | the person who signs for the vendor also appears advising in the minutes | 40 |

**Rarity weight w** from the Idescat frequency f (‰): 1.3 below 0.1 · 1.0 from 0.1 to 1 · 0.6 above
1 to 10 · 0.3 above 10. When the frequency was not obtained the weight is 0.6 (the "fairly common"
band) and the row says so. For a pair of surnames, w = √(w₁ · w₂).

**Expected homonyms** ≈ 1,600,000 × f₁ × f₂ (frequencies as fractions). The population is a
Barcelona order of magnitude and is printed so a reader can redo the arithmetic.

**Tiers** on the points of one signal: **priority** at 80 and above, **review** 40–79, **note**
below 40. Rows are written with `status = 'open'`.

### Signals that are not links to a role

`party_links.to_role` accepts only `president`, `president_family` and `administrator`, and the
table has no column for a second party. Coincidences that are **not** with an office-holder — a
shared address between two vendors, a shared account, the age of a company, an absent registry
entry, look-alike quotes — cannot be stored as a row without asserting a role that was not
observed. They are therefore computed, returned by the scorer, counted in the vendor's ordering
score, and reported through rules B1, B2, B7, B9 and A10 — but not written to `party_links`. See
the schema notes below.

## 5. Rules (`packages/cli/src/rules/m5.ts`)

| Code | Test | Severity |
|---|---|---|
| B1 | company age against the first invoice; capital against works invoiced; activity code against the work | 2–3 |
| B2 | address coincidence: the building, an office-holder, the managing agent, another vendor; downgraded at a domiciliation address | 1–3 |
| B3 | surname coincidence, read from the stored `party_links` S1–S4 rows | 1–4 |
| B7 | REA absent for a construction vendor; RASIC absent for a regulated installation vendor — decided by the category codes of that vendor's invoices | 2–3 |
| B8 | vendor concentration, **ordinary spend only**, severity 1, never worklist | 1 |
| B9 | implied annual invoice volume from the numbering; a first number ≤ 10 as context | 1–2 |
| A10 | quotes for one package sharing a PDF producer or author, a telephone or a number series | 2–3 |
| G2 | 111/190/347 filings requested and not received, or invoices with withholding and no filing on file | 1–2 |
| G5 | lift: no CE declaration or commissioning registration; maintainer not in RASIC; no periodic inspection invoiced | 1–2 |
| G6 | coordination or health-and-safety services billed with no appointment or plan on file | 1–2 |
| G7 | no technical building inspection on file, for a building the `building_year` parameter does not date after 1965 | 1 |

`independence` is 1.0 only when the leg is a register response the system fetched and archived; a
manual capture, or a check with no archived response, is 0.7. Event keys are per vendor and signal
(`party:<id>:rasic_absent`, `party:<id>:company_age`, …), so B7 and G5 firing on the same absent
RASIC entry collapse to one finding before any aggregation.

## 6. Commands

```
vx vendors check [--vendor <party_id> | --all] [--only <types>] [--dry-run]
vx vendors links [--community <uuid>] [--dry-run]
vx vendors evidence --check <id> --file <path> [--note <text>]
vx vendors factsheet [--community <uuid>] [--json]
```

`--all` also runs the checks that concern the Community itself (`nif_validate`, `bdns_grants`,
`raisc_grants`, `catastro_units`) — the grants published for the Community's H-NIF are the
independent leg rule D8 needs. After a `company_profile` result, the surnames of the officers are
queued for `surname_frequency` automatically, so the weights are available before `links` runs.

## 7. To verify

Nothing below was reachable from the machine this module was written on. Every endpoint, dataset
id, parameter name and population figure is a **guess recorded in code** and must be confirmed
against the live source before a pack cites anything derived from it. The same hard gate as
`docs/legal-references.md` applies.

| Item | Where | What must be confirmed |
|---|---|---|
| OpenMercantil base URL, auth, search and detail paths, every field name, licence to store responses | `SOURCES.openmercantil` | the provider's own documentation |
| BDNS path `concesiones/busqueda` and its parameters; the response envelope | `SOURCES.bdns` | the BDNS API |
| RAISC dataset `s9xt-n979`, host and column names | `SOURCES.raisc`, `RAISC_DATASET_ID` | the Catalan transparency portal |
| **RASIC dataset id** — a placeholder; the automated check refuses to run while it starts with `TO-VERIFY` | `RASIC_DATASET_ID` | whether the register is published as open data at all |
| Cadastre method names (`Consulta_DNPLOC`, `Consulta_DNPRC`), parameter spelling, envelope, real rate limit | `SOURCES.catastro` | the OVC service description |
| Idescat onomàstica endpoint, table id, and **whether the published figure is a rate or a count** | `SOURCES.idescat`, `CATALONIA_POPULATION` | Idescat |
| REA public-lookup URL and whether it searches by identifier, by name or both | `MANUAL_SOURCES.rea` | the register |
| AEAT census procedure code and URL | `MANUAL_SOURCES.aeat_census` | AEAT |
| Registro Mercantil product name and current price (≈ €15 assumed) | `MANUAL_SOURCES.registro_mercantil_nota` | registradores.org |
| Registro Público Concursal search URL | `MANUAL_SOURCES.insolvency` | the register |
| Homonym population (1.6 M) | `HOMONYM_POPULATION` | the current padró |
| CNAE divisions per line category | `CNAE_DIVISIONS_BY_CATEGORY` | the official CNAE-2009 table |
| REA/RASIC scope by trade | `REA_CATEGORIES`, `RASIC_CATEGORIES` | Ley 32/2006 / RD 1109/2007 and the Generalitat regime, both "likely" in `docs/legal-references.md` |

A check whose source is unverified carries `normalised.source_verified = false`; the fact sheet
lists those check types under the table, so a reader always sees which figures rest on an
unconfirmed endpoint.

## 8. Schema notes

Recorded here rather than fixed, because M5 adds no migration:

1. **`party_links.to_role`** has no member for a vendor-to-vendor link and the table has no
   `to_party_id`, so S6/S7 cross-vendor coincidences, S8, S9 and S10 are computed but not stored as
   rows (see §4).
2. **`party_links` has no `detail` jsonb.** The sub-case of a signal — which surname matched, in
   which order, at which address — survives only in the `explanation` text, so rule B3 derives its
   severity from `points` and the signal code rather than from the sub-case.
3. **`external_checks` has no `party_id`.** Party checks use the party's uuid as `subject_key`,
   which keeps the join stable when an identifier is corrected; `subject_type` also carries the
   values `surname` and `address`, which the column allows (it is free text).
4. **`parties` has no `nif_hmac`.** The keyed digest of a vendor identifier is computed at scoring
   time by `hmacNif()` (HMAC-SHA256 over the canonical 9-character form, key `IBAN_HMAC_KEY`), the
   convention `restricted.reference_persons.nif_hmac` must be written with for S1 to work.
5. **`communities` has no construction year.** G7 reads the `building_year` parameter and, when it
   is absent, says so in the finding instead of assuming.
6. **`external_checks.fetched_at` defaults to `now()`**, which is the transaction timestamp; the
   module inserts `clock_timestamp()` explicitly so two checks appended in one transaction can be
   ordered.
