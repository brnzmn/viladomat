# Benchmark sources register

Every `benchmark_records` row cites one source in this register and an archived copy (PDF, JSON or
screenshot) in Storage. Records are append-only: a re-sync inserts a new row and sets `superseded_by`
on the old one, so every finding can cite the exact record version it used. Tier decides the weight in
the expected-price engine (official 0.30, others 0.20) and the ceiling on severity: **a trade-tier
benchmark alone can never yield MATERIAL**.

Tiers: `official` (law, ordinance, official call, official statistics, official price bank),
`semi_official` (professional bodies, quasi-official databases), `trade` (marketplaces, trade
guides, firms' price pages), `own_history` (the community's own prior-period prices).

**Verification status of every row below: to verify from an unrestricted network; archive the
PDF/JSON in Storage before use.** All figures come from search-engine summaries of the source pages;
none of the underlying documents was read in full during research. Where research packs disagreed,
the disagreement is recorded in the caveats column.

## 1. Register

| ID | Name | Tier | Provides | Unit | Access | URL | Licence note | Comparability caveats |
|---|---|---|---|---|---|---|---|---|
| BS-01 | Ajuntament de Barcelona, Ordenança fiscal 2.1 (ICIO), editions 2021–2026 | official | ICIO rate on the PEM and bonuses (accessibility, heritage, sustainability) by year | % of PEM | manual (PDF per year) | ajuntament.barcelona.cat/hisenda → normativa → 2.1 | official publication; reuse with attribution | rate reported as 4% in two research packs and ≈ 3.35% in a third — store as `icio_rate_by_year`, never as a constant; bonuses (90% accessibility reported) must be requested and approved; definitive liquidation may follow |
| BS-02 | Ajuntament de Barcelona, Ordenança fiscal 3.3 (taxa de serveis urbanístics) | official | fee for major-works licences and comunicats | €/m² of works, minimum € | manual (PDF) | ajuntament.barcelona.cat/hisenda → normativa → 3.3 | official publication | 4.96 €/m² with 385 € minimum may be a 2021 figure; comunicats carry lower fixed fees |
| BS-03 | Consorci de l'Habitatge de Barcelona, accessibility call 2024–2026 (DOGC 12 Aug 2024; bases DOGC 7 May 2021) | official | subsidy percentage and caps for lift installation and barrier removal | % of eligible budget; € cap | manual (DOGC PDF; Consorci e-tauler resolutions) | consorcihabitatge.barcelona | official publication | 35% capped at €30,000 interior / €50,000 exterior in two packs vs 25% / €30,000 in others; Eixample not in the priority-neighbourhood list; composition of the eligible budget (fees, taxes, VAT) unconfirmed; caps are absolute, not unit prices |
| BS-04 | Consorci de l'Habitatge de Barcelona, common-elements call 2025 | official | 35%; cap = lower of €30,000 per building or €3,000 per dwelling; eligible expenses > €1,000 must be paid by bank transfer; ITE required | % of eligible budget; € cap | manual | consorcihabitatge.barcelona; icaen.gencat.cat | official publication | applications until 30 Jun 2026 or funds exhausted; documentary requirements are the useful part |
| BS-05 | RD 853/2021, Programa 3 (Next Generation), Barcelona call DOGC 27 Jun 2022 | official | 40/65/80% by energy saving with per-dwelling caps | % ; €/dwelling | manual (BOE/DOGC) | boe.es; portaldogc.gencat.cat | official publication | closed 31 Dec 2023; relevant only if an application exists |
| BS-06 | RD 355/2024 (ITC AEM 1) | official | maintenance visit and OCA inspection periodicity | visits per period | manual (BOE PDF) | boe.es | official publication | not a price; drives G5 and the expected count of maintenance invoices per year |
| BS-07 | CYPE Generador de Precios (rehabilitación) | semi_official | partida prices: ITA020 lift for small stairwell (17,338.13 €/ud, 4 stops, 320 kg, equipment + installation only); EHY090 slab-edge repair 69.52 €/m; EHY091 with recast 82.99 €/m; ITA010 configurable | € per ud / m | manual (free registration; HTML page per partida; no API) | generadordeprecios.info | free after registration; terms of reuse to verify | national prices; apply +5–10% Barcelona factor (estimate) or prefer BEDEC; ITA020 is **not comparable** to a 6–7-stop lift in a protected pre-1965 stairwell with civil and structural works |
| BS-08 | ITeC BEDEC (Banc Estructurat de Dades d'Elements Constructius) | official (Catalonia) | partida prices with Barcelona labour basis; annual editions; edition-to-edition variation table (2026 = +4.25% over 2025) | € per unit | purchase (BEDEC Consulta ≈ €50/month; free tier 15 lookups per 30 days) | itec.cat; tienda.itec.es; metabase.itec.es/vide/es/bedec/trendings | commercial licence; terms for citing captured partidas in a report to verify | capture ~40 partidas manually with edition date; carries weight with Catalan architects and reviewers |
| BS-09 | INE Tempus3 JSON API — IPC (Spain and Catalonia, table 50913) | official | consumer price index series for indexation | index | api (`servicios.ine.es/wstempus/js/ES/DATOS_SERIE/{code}`) | ine.es | INE open data | base changed to 2025 = 100 with the January 2026 release (ECOICOP v2) — store base and rebase when chaining |
| BS-10 | Idescat IPC and API | official | IPC Catalonia | index | api (endpoint unverified) / manual | idescat.cat/pub/?id=ipc; api.idescat.cat | open data | verify endpoint and licence before wiring |
| BS-11 | INE materials and labour indices; IPCO; BOE price-revision Orders | official | construction cost indices | index | manual / api | ine.es; boe.es | open data | IPCO replaces the previous series from Jan 2026 |
| BS-12 | MITMA construction cost index (CNAE 2009, base 2010) | semi_official | labour and materials monthly series | index | manual | transportes.gob.es | open data | enter manually with a stale-after date |
| BS-13 | COAC Mòdul Bàsic | semi_official | annual reference module for cost-of-reference calculations | €/m² | manual | arquitectes.cat | professional body publication | value for 2025/2026 not obtained |
| BS-14 | Architect fee ratios | trade | 7–10% of PEM full service, regressive with size, × 1.2 for rehabilitation; project ≈ 60–70% of fee, site direction ≈ 25–30%; H&S coordination 1–1.5% of PEM | % of PEM | manual | fusterarquitectos.es; wolfblanc.es; arch.cat | firm blogs | reference scales abolished since 1997/2009; only supports A11 at severity 1 |
| BS-15 | Administrator fees, Barcelona | trade | 3–7 €/unit/month (up to 8–10 with lift); extraordinary meetings 150–400 € each; works-management 2–5% of works when agreed | €/unit/month | manual | housfy.com; finorbcn.com; presidentedelacomunidad.es | firm blogs | one research pack estimated 15–30 €/unit/month — contradiction; use the lower range and cap D9 at severity 2 |
| BS-16 | Lift maintenance contracts | trade | Barcelona 80–250 €/month by cover; national basic 30–50, all-risk 80–120 €/month | €/month | manual | habitissimo.es; cronoshare.com; ascensoresymas.com | marketplaces | new lifts often include 1–2 years or a mandatory 3–5-year contract |
| BS-17 | OCA periodic inspection | trade | 80–140 € per inspection | €/ud | manual | simecal.com; confiascensores.com | firm pages | paid to the inspection body, not to the maintainer |
| BS-18 | Lift installation in an old Barcelona building | trade | 36,000–62,000 € typical; 50,000–90,000 € for 5–7 floors with project, licence and civil works; 100,000–120,000 € with structural reinforcement; component breakdown for a 4-stop job | € per project | manual | miascensor.com; fachadasbarcelonarehabilitacion.es; ascensoreseuropquality.com | marketplaces | **non-benchmarkable in v1**; order-of-magnitude sanity input for D0 only |
| BS-19 | Façade rehabilitation | trade | 25–50 €/m² cosmetic; 75–110 €/m² structural; +15–30% for balconies and cornices | €/m² | manual | ecofachadas.com; humedades.com | guides | Barcelona in the upper-middle band; heritage conditions add cost |
| BS-20 | Balcony slab-edge repair | trade + semi_official | ≈ 70 €/ml; 300–700 € per balcony edge; 800–2,000 € per balcony with underside, railing and waterproofing (estimate) | €/ml; €/ud | manual | preguntas.habitissimo.es; itearquitectes.com; CYPE EHY090/091 | Q&A and firm pages | estimate ranges flagged as such |
| BS-21 | Scaffolding, Barcelona | trade | 3.5–6 €/m²/month rental; 8–15 €/m² of façade for ≤ 3 storeys incl. assembly; typically 20–30% of a façade budget | €/m²·month | manual | alquilerandamios.es; milandamios.com | firm pages | rear façade (patio d'illa) needs no public-way tax but may need access agreements |
| BS-22 | Interior painting of common areas | trade | 5–15 €/m²; 1,600–2,500 € per 4–5-storey stairwell; 3,000–9,000 € plausible for a 6-level Eixample stairwell (estimate) | €/m² | manual | habitissimo.es; cronoshare.com; pintors-barcelona.com | marketplaces | ceiling height 3.5–4 m in Eixample stairwells |
| BS-23 | Staircase rehabilitation, Barcelona | trade | 7,500 € (clean, paint, lighting) to 30,000 €+ (steps re-laid, railing restored, damp treatment) | € per project | manual | exhibespacios.es; rehabilitacionfachadasbarcelona.es | firm pages | **non-benchmarkable in v1** for a protected pre-1965 stairwell |
| BS-24 | Entrance door | trade | 1,100–3,500 € replacement; stainless steel ≈ 2,400–2,500 €; heritage restoration 3,000–8,000 € (estimate); automation 300–900 € | €/ud | manual | cronoshare.com; elymar.es; cerrajeriajp.com | firm pages | protected ensemble may require restoration instead of replacement |
| BS-25 | Video-entry system, 10–15 units | trade | 1,500–4,000 € with existing wiring; roughly double if rewired; ≈ 120 € per resident | € per system | manual | fincavolt.es; grupolasser.com | firm pages | 2-wire systems are the norm |
| BS-26 | Aluminium RPT windows | trade | 230–370 €/m² supplied; 200–450 €/unit + ≈ 200 € installation; 450–900 €/unit installed (estimate) | €/ud; €/m² | manual | habitissimo.es; hazul.es; cronoshare.com | marketplaces | large stairwell or patio openings and heritage-compatible profiles cost more; check `element_scope` |
| BS-27 | ITE / IITE report | trade | 600–1,200 € for 5–20 dwellings plus the Generalitat certificate fee | €/ud | manual | certicalia.com; kaitekarquitectura.com | marketplaces | no administratively fixed price |
| BS-28 | Community insurance | trade | 60–140 €/dwelling/year; Barcelona +15–25%; 900–2,200 €/year for ≈ 15 units in a pre-1965 building (estimate) | €/dwelling/year | manual | arrenta.es; ahorroyseguros.com | comparison sites | premium depends on cover and claims history |
| BS-29 | Cleaning, Barcelona | trade | 13–20 €/h; 150–300 €/month for a 4–5-storey stairwell | €/h; €/month | manual | limpieza.ai; limpiezaporhora.com | firm pages | frequency drives the total |
| BS-30 | CAE / PRL coordination | trade | 35 € + VAT platform-only to 500–1,500 €/year managed | €/year | manual | fincatech.es | firm pages | > 1,500 €/year for 15 units would be unusual |
| BS-31 | Electricity and water for common use | trade | 10–30 €/month lighting only; +20–80 kWh/month once the lift runs; water 150–500 €/year (estimate) | €/month; kWh | manual | roams.es; selectra.es | comparison sites | benchmark on kWh and tariff, not on € indexed |
| BS-32 | Sewer, collector and downpipe works | trade | 400–9,000 € range, ≈ 2,100 € average; ≈ 400 €/ml for asbestos-cement replacement; basement collector with excavation 6,000–15,000 € (estimate) | €/ml; € per job | manual | habitissimo.es; fixhogar.com; wollyhome.com | marketplaces | camera inspection (150–400 €) usually precedes |
| BS-33 | Own history | own_history | the community's prior-period unit price for the same vendor and category, IPC-indexed | as invoiced | internal | – | – | needs ≥ 2 periods; band ± (IPC + 3 points); weight 0.35 for recurring services without a contract |

## 2. Record schema (summary)

`benchmark_records`: `category_code`, `source_id` (this register), `source_ref` (e.g. "BEDEC 2025
partida K…", "CYPE ITA020", "OF 2.1 art. 7 (2025)"), `unit`, `region` (BCN / CAT / ES),
`valid_from`, `valid_to`, `price_low`, `price_median`, `price_high`, `vat_included`, `index_basis`
(IPC_CAT / IPC_ES / BEDEC / INE_MAT / NONE), `index_ref_date`, `scope_json` (stops, load, building
age class, protected ensemble, pit/structural scope, includes/excludes), `comparable` (computed per
works package), `evidence_file_id` (archived copy), `captured_at`, `superseded_by`, `hash`.

`index_series`: `series_code`, `source` (INE / IDESCAT / ITEC / MITMA), `base_year`, `period`,
`value`, `fetched_at`; INE refreshed by a monthly job in M8, the rest entered manually with a
stale-after date.

## 3. Comparability caveats

- **Lift and staircase are non-benchmarkable in v1.** No listed source describes a 6–7-stop lift
  inserted into the stairwell of a protected pre-1965 Eixample building with pit, slab cutting,
  structural reinforcement and heritage conditions. `ELEV_INSTALL`, `ELEV_CIVIL` and `STAIR_REHAB`
  print "no comparable benchmark"; only the CONTRACT and BUDGET layers apply. Trade ranges for whole
  projects (BS-18, BS-23) feed the D0 sanity envelope only.
- **Region factor.** National prices (CYPE) need a +5–10% Barcelona factor, itself an estimate; BEDEC
  already uses the Barcelona labour agreement.
- **Period.** 2021–2022 materials inflation of 10–20% and construction-index rises justify accepting
  2022 quotes up to +20% over 2021 references; every record carries `valid_from/to` and an index
  basis.
- **Heritage and access.** Protected ensembles, scaffolding restrictions and rear-façade access can
  add 20–40% over generic databases; the expected-price band is widened accordingly and severity is
  capped at REVIEW when the only source is trade-tier.
- **VAT and units.** Records store whether VAT is included and the unit; a line without a recognised
  unit cannot use the BENCHMARK layer.
- **Contradictions to resolve before use:** ICIO rate (BS-01), Consorci percentage and eligible-budget
  composition (BS-03), administrator fee range (BS-15), OF 3.3 amounts (BS-02).
