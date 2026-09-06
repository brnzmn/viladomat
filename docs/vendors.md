# Vendor due diligence (M5)

What the public registers say about the companies the Community contracted with, and which
coincidences between those companies and the Community's office-holders are **questions to put to
a register**. Nothing in this module concludes anything about a person.

Two audiences, two outputs:

| Output | Contains | Goes to |
|---|---|---|
| **Fact sheet** (`vx vendors factsheet`, `vendorFactSheet()`) | registry facts only: identifier validity and entity kind, incorporation date, officers as **initials**, the state of the REA, RASIC, AEAT-census and insolvency-register checks in one closed vocabulary, published grants, first document date | the pre-junta pack, i.e. the assembly of owners |
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
- A register answer other than a match is a **discrepancy to verify**, never a conclusion: every
  rule hit carries its innocent explanations and the document that would resolve it.
- A family-run contractor is lawful. What a meeting can ask about is disclosure and competition.

## 2. Checks

One module per check under `packages/cli/src/vendors/checks/`, registered in `checks/index.ts`.
Each returns `{ type, status, normalised, raw, source_url, cost_cents, request }`, calls the
source through `fetchJson` or `fetchText` in `vendors/http.ts` — which wait on the source's rate
limiter, give up after **10 seconds** and never retry — over the injectable `ctx.fetch` (tests
replay recorded fixtures under `tests/fixtures/m5/` and never touch the network). Every run appends
one `public.external_checks` row with the request, the raw response, the party (`party_id`) and
`fetched_at`; the table is append-only, so a re-run adds a row and the earlier answer stays on the
record. Payloads over 256 KB are archived in the `exports` bucket and the row keeps the storage
path. A check never throws: a failing source is recorded as `status = 'error'` with the reason.

Two things are decided outside the module. Whether a source counts as **verified** is read at run
time from `public.registry_sources` (§ "Source register" below) and written to
`normalised.source_verified` on every row; and the AEAT identity check only calls out when a
**client certificate** is configured (§6, "Credential"), raising its manual route otherwise.

| Check | Source (`registry_sources.id`) | What it returns | Rate | Cost |
|---|---|---|---|---|
| `nif_validate` | local (`@viladomat/core`) | check digit, kind (DNI/NIE/CIF), entity letter and the legal form it implies | – | free |
| `iban_validate` | local (`@viladomat/core`) | mod-97, Spanish CCC control digits, bank code, bank name, absorbed-into code and the current entity, last four characters. The account number itself is never written to the row. Given a transcribed number it computes; given only what `party_ibans` stores (bank code, last four, the verdicts recorded when the number was read) it replays the entity resolution and marks the result `basis: 'stored_pseudonym'` | – | free |
| `company_profile` | `openmercantil` — OpenMercantil `/api/v1` (BORME aggregator, CC BY 4.0 with attribution) | officers, registered address, incorporation date, share capital, CNAE, gazette event timeline; searched by identifier, then by name at ≥ 0.85 token-set similarity | 30/min | free |
| `bdns_grants` | `bdns` — BDNS `concesiones/busqueda` | grants published for a beneficiary, with amounts granted and paid | 30/min | free |
| `raisc_grants` | `raisc` — Catalan open data (Socrata `s9xt-n979`) | the same, for the Catalan register | 60/min | free |
| `rasic` | `rasic` — Catalan open data (Socrata `exxq-fubu`) | registration of lift, electrical, gas, intercom and fire installers and maintainers. **Gated**: refuses to call out (`error`, manual route attached) until the dataset's identifier column is verified, either by the probe (register) or by `RASIC_COLUMNS_VERIFIED`. For a natural person the entries keep the registration facts only (number, activities, dates, status): the published name, identifier and address fields are dropped, the body is not archived and the name on file is not copied into the request; in a name search each matched record is judged by the identifier it carries, in whichever column it sits | 60/min | free |
| `rea` | `rea` — REA public lookup form (mites.gob.es) | GET of the form, POST of the identifier, result table parsed: `ok` with registration number, autonomous community and validity dates on "inscrita"/"acreditada", `not_found` on "no existe ningún registro", `error` listing the markers it could not find otherwise. **Gated**: validates the identifier locally, then refuses to post to the form (`error`, manual route attached) until the register has verified the source (`vx vendors sources probe --source rea`). For a natural person the published name is dropped, the status text is reduced to the marker matched and the page is not archived | 30/min | free |
| `aeat_census` | `aeat_vnif` — AEAT VNifV2 SOAP service (mutual TLS) | whether the identifier **and the name printed on the documents** are identified as a pair in the tax census: `census_match`, `result` (IDENTIFICADO, NO IDENTIFICADO, IDENTIFICADO-BAJA, IDENTIFICADO-REVOCADO, NO PROCESADO), the registered name for a legal person; for a natural person the outcome only — the name sent is written neither to `request` nor to `normalised`, no name is returned, no body is archived. Rows naming another identifier are never read as the party's result (`error`, `rows_for_other_identifiers`). Runs only with `VX_CLIENT_CERT_P12` set; otherwise raises the web-form route below | 30/min | free |
| `catastro_units` | `catastro` — Cadastre OVC callejero (JSON) | units of the building by cadastral reference (or address): 20-character reference, staircase, floor, door, use, built surface, participation coefficient, year built. Run for the Community (its reference) and for every vendor, administrator or architect party with an address on record (`Consulta_DNPLOC` by address; no holder data is returned), so a vendor's building can be compared with the Community's by cadastral reference | 20/min | free |
| `surname_frequency` | `idescat` — Idescat onomàstica | frequency of a surname in ‰, cached in `external_checks` for a year | 30/min | free |

### Manual checks

Sources with no machine route — a browser-rendered form, a register consulted by hand, a document
that is bought — and the fallbacks of the automated checks. They append a `manual_pending` row that
carries the exact page, the search terms and the evidence to capture, and the CLI prints them:

| Check | Source id | Page | Evidence to upload | Cost |
|---|---|---|---|---|
| `rea_manual` | `rea_manual` | REA public lookup form (`consulta.htm`) | result page with the identifier type, the identifier and the date; registration number and validity dates, or the empty result | free |
| `rasic_manual` | `rasic_manual` | RASIC cercador (Canal Empresa) | register entry or empty result with search terms and date | free |
| `aeat_census` (fallback, no certificate) | `aeat_census` | AEAT procedure G321, check of a third party's identifier (operator's certificate or Cl@ve in the browser) | the AEAT response PDF showing the identifier, the registered name and the date; nothing else on the screen | free |
| `registro_mercantil_nota` | `registro_mercantil_nota` | sede.registradores.org | the nota informativa as delivered, plus the purchase receipt | ≈ €15 assumed (arancel plus VAT; § 7) |
| `insolvency` | `insolvency` | Registro Público Concursal, section 1 search | search result for the identifier and, separately, for the name, with the date; resolution type, date, court and procedure reference when an entry exists | free |
| `dgsfp_manual` | `dgsfp` | DGSFP registers: insurers at `rrpp.dgsfp.mineco.es/`, distributors at `/Mediador` | the entry with the clave administrativa, the situación and the date, or the empty result | free |

The Banco de España register of entities is **not** consulted and has no register row:
`iban_validate` resolves a bank code from the offline table of Spanish bank codes in
`@viladomat/core` (`ES_BANKS`, `packages/core/src/ids/iban.ts`), which is the only basis of the bank
names it prints. A live source (`REGBANESP_CONESTAB_A.xls`, a BIFF8 workbook, see §7) is a
follow-up; it gets its register row together with its check module.

**Default sets.** `vx vendors check --all` runs `VENDOR_DEFAULT_CHECKS` on every vendor,
administrator and architect party — `nif_validate`, `iban_validate`, `company_profile`,
`bdns_grants`, `rasic`, `rea`, `aeat_census`, `insolvency`, and `catastro_units` for the parties
with an address on record (`plannedVendorChecks` in `checks/index.ts` drops it for the others) —
and `COMMUNITY_DEFAULT_CHECKS` on the Community itself (`nif_validate`, `bdns_grants`,
`raisc_grants`, `catastro_units`). `rea_manual`, `rasic_manual` and `dgsfp_manual` are left out so
`--all` does not raise a manual item for every vendor; ask for them with `--only`. `dgsfp_manual`
concerns vendors invoicing insurance and parties of kind `insurer` — which `check` does not select
today (it reads vendor, administrator and architect parties), so an insurer party cannot be
targeted until that list widens. Parties of kind `owner_role` and `president_role` are never
selected, and the same planner carries a second, explicit guard against them: no owner's or
president's identifier goes to the tax census.

Filing the evidence:

```
vx vendors evidence --check <external_check_id> --file <path>
```

The file is stored at `exports/<community_id>/checks/<check_id>.<ext>` and a **completion row** is
appended with `status = 'ok'` and `evidence_storage_path` set, pointing at the pending row through
`request.answers_check_id`. The pending row is not modified — `external_checks` is append-only — so
both the date the check was raised and the date it was satisfied stay on the record. A completion
row carries the reviewer's evidence and no structured outcome: the fact sheet shows it as
`not checked` in the status column (the completed check and its date appear in the check list), and
rules B7 and B10 do not fire on it.

A leg obtained this way is **not** issuer-direct: a reviewer's screenshot scores `independence`
0.7, an archived machine response 1.0.

### Source register

`public.registry_sources` (migration 0015) holds one row per source id above, seeded with the
name, base URL, access kind (`api`, `dataset`, `form`, `manual`, `local`), licence note and the
research notes, and with `verified_at` **null**. Nothing in the register is verified until
`vx vendors sources probe` has run one known-good lookup from the operator's machine — the
Community's own cadastral reference against the Cadastre, its identifier against BDNS, RAISC and
(with the certificate) the AEAT service, the administrator's identifier against OpenMercantil, the
RASIC view metadata for an identifier column, a vendor's or the administrator's identifier through
the REA form (a registered entry verifies the result table; the "no existe ningún registro" marker
verifies the route and says the table columns are still unexercised) — and parsed the live answer
into the shape the check expects. Each probe is an `external_checks` row (`check_type = 'source_probe'`, `subject_type =
'source'`); a success sets `verified_at`, `verified_by` and `probe_check_id`; a failure writes the
dated reason to `notes` and leaves `verified_at` as it was.

At run time the check runner reads the register once and sets `normalised.source_verified` on every
automated non-local result from it (`applySourceGate` in `vendors/sources.ts`), whatever the
module's own constant says; `rasic` and `rea` also ask `ctx.sourceVerified(<source>)` before
calling out and return `error` with the manual route while the answer is no (`sourceVerifiedIn` in
`vendors/types.ts`). The fact sheet lists the check types that rest on an unverified source under
its table, and rules B7 and B10 add "the source is not yet verified" to the innocent explanations of
a hit. Sources without a probe — `idescat` and the manual routes — are marked verified by hand in
the register.

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
| S10 | REA absent 30 · RASIC absent 50 · census check does not identify the pair 60 · check digit invalid 20 | the strongest |
| S11 | the person who signs for the vendor also appears advising in the minutes | 40 |

**Rarity weight w** from the Idescat frequency f (‰): 1.3 below 0.1 · 1.0 from 0.1 to 1 · 0.6 above
1 to 10 · 0.3 above 10. When the frequency was not obtained the weight is 0.6 (the "fairly common"
band) and the row says so. For a pair of surnames, w = √(w₁ · w₂).

**Expected homonyms** ≈ 1,600,000 × f₁ × f₂ (frequencies as fractions). The population is a
Barcelona order of magnitude and is printed so a reader can redo the arithmetic.

**Tiers** on the points of one signal: **priority** at 80 and above, **review** 40–79, **note**
below 40. Rows are written with `status = 'open'`.

### Signals that are not links to a role

`party_links.to_role` accepts only `president`, `president_family` and `administrator`. Since
migration 0013 a row may instead point at **another party** (`to_party_id`, with `to_role` null;
the constraint `party_links_target_check` requires one of the two) and carry the sub-case in
`detail` (jsonb). Coincidences with another vendor — a shared address (S6), a shared account,
telephone or mailbox (S7), look-alike quotes (S9) — are therefore stored, one row per target party,
when the scorer names the other party in `detail`. S8 (company age, capital, activity code) and S10
(registry and census state) have no counterparty: they are computed, counted in the vendor's
ordering score, and reported through rules B1, B7 and B10 and the fact sheet, not written to
`party_links`.

## 5. Rules (`packages/cli/src/rules/m5.ts`)

| Code | Test | Severity |
|---|---|---|
| B1 | company age against the first invoice; capital against works invoiced; activity code against the work | 2–3 |
| B2 | address coincidence: the building, an office-holder, the managing agent, another vendor; downgraded at a domiciliation address | 1–3 |
| B3 | surname coincidence, read from the stored `party_links` S1–S4 rows | 1–4 |
| B7 | REA absent for a construction vendor; RASIC absent for a regulated installation vendor — decided by the category codes of that vendor's invoices | 2–3 |
| B8 | vendor concentration, **ordinary spend only**, severity 1, never worklist | 1 |
| B9 | implied annual invoice volume from the numbering; a first number ≤ 10 as context | 1–2 |
| B10 | the latest `aeat_census` row of a vendor, administrator, architect or insurer party is `ok` with `census_match = false`: the identifier and the name printed on the invoices were not identified as a pair by the AEAT census (3), or the identifier is identified but de-registered, `IDENTIFICADO-BAJA` (2). The summary names neither the party nor the identifier; the registered name is carried in `computed` for legal persons only. Only automated results fire: a manual completion sets no `census_match` | 2–3 |
| A10 | quotes for one package sharing a PDF producer or author, a telephone or a number series | 2–3 |
| G2 | 111/190/347 filings requested and not received, or invoices with withholding and no filing on file | 1–2 |
| G5 | lift: no CE declaration or commissioning registration; maintainer not in RASIC; no periodic inspection invoiced | 1–2 |
| G6 | coordination or health-and-safety services billed with no appointment or plan on file | 1–2 |
| G7 | no technical building inspection on file, for a building the `building_year` parameter does not date after 1965 | 1 |

`independence` is 1.0 only when the leg is a register response the system fetched and archived; a
manual capture, or a check with no archived response, is 0.7 (`checkIndependence`). Event keys are
per vendor and signal (`party:<id>:rasic_absent`, `party:<id>:company_age`,
`party:<id>:aeat_identity`, …), so B7 and G5 firing on the same absent RASIC entry collapse to one
finding before any aggregation. B10's innocent explanations name the transcription of the name or
the identifier, a trade name printed instead of the registered name, a recent change of name, an
incomplete name for a natural person and, while the source is unverified, the endpoint itself; its
next check is the vendor's certificado de situación censal or modelo 036, asked for through the
administrator. Catalogue row: `B10`, family `vendor`, statutory basis RD 1065/2007 arts. 31–33 (to
verify), attribution `vendor_compliance` (`docs/rule-catalog.md` §5; migration 0015).

## 6. Commands

```
vx vendors check [--vendor <party_id> | --all] [--only <types>] [--community <uuid>] [--dry-run]
vx vendors links [--community <uuid>] [--dry-run]
vx vendors evidence --check <id> --file <path> [--note <text>]
vx vendors factsheet [--community <uuid>] [--json]
vx vendors catastro [--apply] [--dry-run] [--force] [--community <uuid>]
vx vendors sources probe [--source <id>] [--community <uuid>]
vx vendors sources status
```

`check --all` also runs the checks that concern the Community itself (`nif_validate`, `bdns_grants`,
`raisc_grants`, `catastro_units`) — the grants published for the Community's H-NIF are the
independent leg rule D8 needs, and the Cadastre check takes `communities.catastro_rc` or, failing
that, the seeded address (province and municipality read from it, `BARCELONA` by default). After a
`company_profile` result, the surnames of the officers are queued for `surname_frequency`
automatically, so the weights are available before `links` runs. `--dry-run` prints the plan and
writes nothing.

`catastro` compares the latest Cadastre unit list with the unit table: floor and door are
normalised on both sides into the same tokens, a unit label is split only when the row carries no
floor and door of its own, and the Cadastre coefficient is printed next to the quota so a difference
can be verified (rule E3 corroboration), both columns summed. With `--apply` it writes
`units.catastro_rc20` and `units.surface_m2` where exactly one unit matches exactly one Cadastre
unit, one `public.log_access` row per unit naming the check the figures came from; anything not
one-to-one is listed and left alone; `--force` overwrites values already present. **`quota_pct` is
never written**: the constitutive title is the authority on participation quotas (CCCat art. 553-3)
and the Cadastre coefficient is a cross-check, not the legal quota.

`sources probe` runs one probe per automatable source (`catastro`, `bdns`, `raisc`, `rasic`, `rea`,
`openmercantil`, `aeat_vnif`) with data already on file, stores each attempt as a `source_probe` row
and updates the register; `--source <id>` probes one. The AEAT probe is skipped without the
certificate; the REA probe is the one caller allowed past the form's gate (`reaLookup`), so a
verified row is what opens the automated `rea` check. `sources status` prints the register: id, access, `verified_at`, probe check id, notes,
and flags ids that are in code but not in the register or the reverse.

### Credential

The AEAT identity check identifies its caller through the TLS handshake. Two variables, read with
`envOptional` and documented in `.env.example`:

- `VX_CLIENT_CERT_P12` — path to the PKCS#12 (`.p12` / `.pfx`) file of a qualified certificate;
- `VX_CLIENT_CERT_PASSPHRASE` — its passphrase, held in memory for the run and never written to a
  log, an error message or a check row.

Both live on the **operator's machine only**: hosted functions never see the variables, the file or
the passphrase, and the file stays outside the repository. The transport (`vendors/transport/mtls.ts`,
`node:https` with `pfx`) accepts `https:` URLs only, never lowers server-certificate verification
and never retries; the limiter and the 10-second timeout apply to it as to the plain `fetch`. Today
the certificate is the operator's **personal** FNMT certificate, which the service accepts; the
better legal fit is the Community's own FNMT "certificado de representante de entidad sin
personalidad jurídica" (the Community is the modelo 347 declarant), which will replace it with no
code change once obtained — its acceptance by the service is the highest-value live test (§7). A
seal certificate uses the `www10` host instead of `www1`. Cl@ve opens browser forms only and cannot
drive the SOAP service. When the variables are unset the check raises the G321 web-form route and
nothing leaves the machine; a configured path that cannot be read is an error, not a silent fallback.
A PKCS#12 exported with legacy ciphers is refused by OpenSSL 3 and must be re-exported, never
accepted by lowering the security level.

## 7. To verify

Nothing below was reachable from the machine this module was written on: the sandbox proxy blocks
every `.gob.es`, `gencat.cat` and registry host. Every endpoint, parameter name, field name and
result string comes from the research report — specifications, client code and mirrors, not live
answers — and is recorded in code as **unverified** (`SOURCES.*.verified = false`,
`registry_sources.verified_at` null) until the probe or a lookup by hand from the operator's machine
confirms it. A pack cites nothing derived from an unverified source: the same hard gate as
`docs/legal-references.md` applies.

| Source (id) | As implemented | Expected answer | Still unverified |
|---|---|---|---|
| AEAT VNifV2 (`aeat_vnif`, check `aeat_census`) | `POST https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP` (personal and representative certificates; `www10` for seal certificates), mutual TLS, SOAP 1.1 document/literal, empty `SOAPAction`; request `VNifV2Ent/Contribuyente{Nif, Nombre}` — `Nif` 9 characters without `ES`, `Nombre` mandatory for a natural person, up to 20,000 entries per call (the check sends one); WSDL `https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/burt/jdit/ws/VNifV2.wsdl` with `VNifV2Ent.xsd` / `VNifV2Sal.xsd` (the namespace URIs of the envelope) | `VNifV2Sal/Contribuyente{Nif, Nombre, Resultado}`; `Resultado` ∈ IDENTIFICADO, NO IDENTIFICADO, IDENTIFICADO-BAJA, IDENTIFICADO-REVOCADO, NO PROCESADO, plus NO IDENTIFICABLE (reported by one client library) and NO IDENTIFICADO-SIMILAR (the web form); several rows may return for one identifier; the registered name for a legal person, an echo of the name sent for a natural person; HTTP 401 on a rejected certificate | the live handshake with the operator's PKCS#12; whether the web service emits the `-SIMILAR` value and what NO IDENTIFICABLE means; quotas; acceptance of the Community's H-entity certificate (the single highest-value live test); whether a legacy-cipher PKCS#12 needs re-export. Manual v1.7 (`Manual_Tecnico_WS_Masivo_Calidad_Datos_Identificativos.pdf`) on the AEAT sede |
| AEAT web form (`aeat_census`, manual fallback) | `https://sede.agenciatributaria.gob.es/Sede/tramitacion/G321.shtml` (procedure G321, which replaces the G313 URL first recorded); lines `NIF;Apellidos y nombre` or `NIF;Razón Social`, CSV of up to 20,000 lines | the same result vocabulary, on screen | that the procedure code and URL are current; capture only the identifier, the registered name and the date |
| OpenMercantil (`openmercantil`, check `company_profile`) | `GET https://openmercantil.es/api/v1/search?q={name or NIF}&limit=5`; `GET /api/v1/company/{slug}`, `/officers`, `/events`; optional `X-API-Key: omk_*` from `VX_OPENMERCANTIL_API_KEY`; OpenAPI at `https://openmercantil.es/openapi.json` | `{ query, count, offset, items, _attributions }`; response header `x-ratelimit-limit: 200` (per day and IP without a key, reported); CC BY 4.0 with mandatory attribution (`X-Attribution-Required`) — keep `_attributions` with the archived response and print the attribution wherever a figure is cited | the field names inside `items` and the detail objects (the parser accepts several spellings and lists what it could not read), the slug key, the 200-per-day quota, the attribution wording |
| BDNS (`bdns`, check `bdns_grants`) | `GET https://www.infosubvenciones.es/bdnstrans/api/concesiones/busqueda?vpd=GE&nifCif={NIF}&page=0&pageSize=50&order=fechaConcesion&direccion=desc` (same path on infosubvenciones.gob.es, pap.hacienda.gob.es, subvenciones.gob.es) | wrapper `{ content[], totalElements, totalPages, size, number }`; `Concesion{ id, idConvocatoria, numeroConvocatoria, convocatoria, nivel1 (LOCAL/AUTONOMICA/ESTATAL), nivel2, nivel3, fechaConcesion, beneficiario ("NIF Razón social", masked for natural persons), instrumento, importe, ayudaEquivalente, urlBR }`; 10 requests per second per IP | that `nifCif` is accepted as a filter, that `vpd` is mandatory, the `pageSize` maximum, whether the Community's H-NIF is returned unmasked; the swagger at `/bdnstrans/doc/swagger` read live. Ley 38/2003 art. 20 is itself only "likely" in `docs/legal-references.md` |
| RAISC (`raisc`, check `raisc_grants`) | `GET https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json?cif_beneficiari={NIF}&$order=data_concessi DESC&$limit=5000` | columns `codi_raisc, codi_bdns, any_de_la_convocat_ria, objecte_de_la_convocat_ria, tipus_de_beneficiaris, cif_beneficiari, ra_social_del_beneficiari ("Persona física" / "Benef. no publicable" for natural persons), codi_territorial, data_concessi, import_subvenci_pr_stec_ajut, import_ajuda_equivalent, administraci_` | `GET /api/views/s9xt-n979.json` for the exact column list and types; whether the name column can be filtered with `$where`; the portal licence page |
| RASIC (`rasic`, dataset `exxq-fubu`; `rasic_manual`) | `GET https://analisi.transparenciacatalunya.cat/api/views/exxq-fubu.json` (metadata first, the probe), then `…/resource/exxq-fubu.json?$where=…`; cercador `https://empresa.gencat.cat/ca/departament/dades-obertes/seguretat-industrial/rasic/` | by naming analogy with the sibling dataset `ebyt-8dme` (RASIC-TRA workshops): `n_mero_de_rasic, nom_titular_actual, adre_a, poblaci_, codi_postal, prov_ncia` | **whether the dataset carries an identifier column at all** — the decisive item; the check refuses to run until the probe finds one (or `RASIC_COLUMNS_VERIFIED` is set); the dataset licence; whether the cercador searches by identifier |
| Cadastre (`catastro`, check `catastro_units`) | `GET https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/Consulta_DNPRC?RefCat={RC14 or RC20}&Provincia=&Municipio=` — the parameter is **`RefCat`**; `RC` (the legacy `.asmx` parameter) answers `lerr[].cod = 17`, "LA REFERENCIA CATASTRAL ES OBLIGATORIA"; `Consulta_DNPLOC?Provincia=&Municipio=&Sigla=&Calle=&Numero=&Bloque=&Escalera=&Planta=&Puerta=` by address | root `consulta_dnprcResult`; 14 characters → `lrcdnp.rcdnp[]{ rc{pc1, pc2, car, cc1, cc2}, dt{loine{cp, cm}, cmc, np, nm, locs.lous.lourb{dir{tv, nv, pnp}, loint{es, pt, pu}, dp}}, debi{luso, sfc, cpt "7,320000", ant} }`; 20 characters → `bico.bi{idbi{cn, rc}, dt, ldt, debi}` and `bico.lcons[]{lcd, dt.lourb.loint, dfcons.stl}`; a single result is an object, several an array; `control{cudnp, cucons, cuerr}`; about 3,600 requests per hour before a four-hour denial (self-imposed cap 20/min) | `.svc/json` liveness, the `DNPLOC` parameter spelling, the official rate limit and the licence wording (TRLCI art. 52.2 on transformation and redistribution); `Webservices_Libres.pdf` v2.6 to read |
| REA (`rea`; `rea_manual`) | `GET` then `POST https://expinterweb.mites.gob.es/rea/pub/consulta.htm` with `tipoIdentificacion` (1 NIF, 2 NIE, 3 CIF, 6 passport), `numIdentificacion`, `submitButton_mostrar=Mostrar`, the page's own hidden fields and cookie sent back; 2-second pacing (30/min) — replaces the `consultaEmpresas.htm` URL first recorded. Gated until the probe has verified the form | `<table id="tabla-consulta">` whose text contains "inscrita" or "acreditada" for a registered company and "no existe ningún registro" when nothing is found; registration numbers `AA/PP/SSSSSSS` | that the form answers without a session, a token or a captcha; the column headings of the result table (number, autonomous community, validity dates); IED and Nº REA codes; the certificate check at `/rea/pub/vericert.htm`; whether the form searches by name |
| Registro Público Concursal (`insolvency`, manual) | `https://www.publicidadconcursal.es/consulta-publicidad-concursal-new` — a Liferay portlet that renders in the browser only (`waitUntil: networkidle0` in a headless browser); fields `#busquedaNif`, `#busquedaNombre`, button `#btnBuscar` | rows `.tablaResultados tbody tr` (nombre, CIF, juzgado, procedimiento, estado, fecha); "Exportar" CSV columns `nif_sujeto, sujeto, tipo_resolucion, fecha_resolucion, numero_procedimiento_expediente, seccion` | captcha or anti-bot measures, the result headers, CSV without login; automation is deferred (no plain HTTP form). Ley 22/2003 art. 198 / RD 892/2013 art. 5.a "likely" until archived |
| DGSFP (`dgsfp`, check `dgsfp_manual`) | insurers `https://rrpp.dgsfp.mineco.es/?culture=es-ES&ui-culture=es-ES` (claves `C####`, `E####`, `L####`); distributors `https://rrpp.dgsfp.mineco.es/Mediador` (`J####`, `F####`, `AV####`, `OV####`; exclusive agents `<insurer clave>A<NIF>`, a confirmed grammar) | situación strings Inscrita / En liquidación / Revocada / Disuelta (insurers) and Inscrito / Cancelado (distributors) | whether the portals search by identifier, the exact situación strings, the detail URLs, any captcha; reuse under Ley 37/2007 and RD 1495/2011 per the ministry's legal notice |
| Banco de España (not consulted; no check module, no register row) | nothing: `iban_validate` reads the offline table `ES_BANKS` in `@viladomat/core` | the research report's candidate for a later source: `https://www.bde.es/f/webbde/SGE/regis/REGBANESP_CONESTAB_A.xls` (BIFF8 workbook), columns `COD_BE, COD_TIPO, NOMBRE105, NOMCOMERCIAL, …, CODIGOCIF, FCHBAJA`; credit institutions `COD_TIPO` ∈ BP, CA, CC, CO, EFC, OR, SECC, SECE; intermittent HTTP 403 — cache with an as-of date | everything, before a module is written: the legal notice, the `rbe_spa` portal, the column presence; until then the bank names printed rest on the offline table only |
| Idescat (`idescat`, check `surname_frequency`) | `https://api.idescat.cat/onomastica/v1` | a surname frequency | the endpoint path, the table id, the query parameter and **whether the figure is a rate or a count**; no probe — verified by hand |
| Registro Mercantil (`registro_mercantil_nota`, manual) | `https://sede.registradores.org/` | the nota informativa PDF | the product name and the current price (≈ €2.10 per block plus €0.60 per entry plus VAT reported; ≈ €15 assumed in code) |

Constants that are guesses recorded in code: the homonym population (`HOMONYM_POPULATION`,
1.6 M, against the current padró), the CNAE divisions per line category
(`CNAE_DIVISIONS_BY_CATEGORY`, against the official CNAE-2009 table), the REA/RASIC scope by trade
(`REA_CATEGORIES`, `RASIC_CATEGORIES`, against Ley 32/2006 / RD 1109/2007 and the Generalitat
regime, both "likely" in `docs/legal-references.md`), and the statutory basis of B10 (RD 1065/2007
arts. 31–33, the modelo 347 obligation; legal source id `rd-1065-2007`, to archive before a pack
cites the article).

A check whose source is unverified carries `normalised.source_verified = false`; the fact sheet
lists those check types under the table, so a reader always sees which figures rest on an
unconfirmed endpoint, and `vx vendors sources status` shows the state of every source.

## 8. Schema notes

M5 first shipped without a migration and recorded its gaps here; migrations 0013 and 0015 close
them. What the schema now is, and what still holds:

1. **`party_links.to_party_id` and `detail`** (0013). A link may point at an office-holder role or
   at another party; `to_role` is nullable and `party_links_target_check` requires one of the two.
   `writePartyLinks` stores a roleless signal once per target party named in `detail`
   (`shared_with_party_ids`, `other_party_ids`), updating an existing row in place, since the
   unique key `(community_id, from_party_id, to_role, signal)` does not cover a null role. S8 and
   S10 name no target and are not stored (§4). `detail` carries the sub-case of a signal (which
   surname matched, in which order, at which address); rule B3 still derives its severity from
   `points` and the signal code.
2. **`external_checks.party_id`** (0013). Written by `persistCheck` and copied to the completion row
   by `attachEvidence`, so the rows of one vendor can be listed by party id. `subject_key` stays the
   party's uuid, which keeps the join stable when an identifier is corrected; `subject_type` also
   carries `surname`, `address` and `source` (probe rows), which the column allows (free text) and
   the `SubjectType` union does not yet list for `source`.
3. **`parties.nif_hmac`** (0013). Written by `upsertParty` (`extract/persist.ts`) as HMAC-SHA256
   over the canonical 9-character identifier with `IBAN_HMAC_KEY`, the convention
   `restricted.reference_persons.nif_hmac` is written with, so S1 compares digests, never
   identifiers. The scorer still derives the digest from the identifier at scoring time
   (`hmacNif()`), so a row written before 0013 scores the same.
4. **`communities.building_year`, `address`, `catastro_rc`** (0013 and the seed). Loaded by
   `lib/community.ts`; `catastro_rc` and `address` feed `catastro_units` and `vx vendors catastro`.
   G7 still reads the `building_year` parameter rather than the column and, when it is absent, says
   so in the finding instead of assuming; aligning the two is open.
5. **`public.registry_sources`** (0015). `id text primary key, name, base_url, access check in
   (api, dataset, form, manual, local), licence_note, verified_at, verified_by, probe_check_id
   references external_checks(id), notes, updated_at` with the `touch_updated_at` trigger. A global
   catalogue like `benchmark_sources` and `legal_sources`, so `install_policies()` (which needs a
   `community_id`) is not used: row-level security is on, `registry_sources_select` lets signed-in
   members read, there is no write policy for `authenticated`, and grants are explicit (defaults
   revoked; `select` to `authenticated`, all to `service_role`, nothing to `anon`). Seeded with one
   row per source id in code, all with `verified_at` null. `tests/sql/04_registry_sources.sql`
   asserts the shape, the seed, the policies and the probe provenance.
6. **`public.rules` row `B10`** (0015). Family `vendor`, version 1, severity 3, specificity 0.85,
   `statutory`, `vendor_compliance`, `article_refs {RD 1065/2007 arts. 31-33 (to verify)}`,
   `legal_source_ids {rd-1065-2007}`, milestone M5; inserted with `on conflict (code) do nothing`.
7. **`external_checks.fetched_at` defaults to `now()`**, the transaction timestamp; the module
   inserts `clock_timestamp()` explicitly so two checks appended in one transaction can be ordered,
   and "the latest row" is well defined for the rules and the fact sheet.
8. **Data room.** `external_checks` and `registry_sources` are listed in the data-room ledger
   (`report/dataroom.ts`), so the provenance of every registry figure travels with the pack. The
   archived response and the officer names stay behind, and a lookup made for a natural person
   (the party's identifier is a DNI, NIE or K/L/M number, or the check flagged `natural_person`)
   is exported with every name dropped from its `request` and `normalised` payloads
   (`redactExternalCheckRow` in `report/redact.ts`): the outcome travels, the person's name does
   not, whatever the check wrote.
