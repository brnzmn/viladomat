# Legal references register

Every statutory or regulatory reference a rule or a pack relies on, with the content as researched and
its verification status. During research the primary sources (BOE, portaljuridic.gencat.cat,
parlament.cat, ajuntament.barcelona.cat, consorcihabitatge.barcelona, aepd.es, icac.gob.es,
sede.agenciatributaria.gob.es) could not be fetched; every entry was reconstructed from secondary
sources and search summaries. The registry provisions added for the vendor checks (§2, §5) were read
from text mirrors of the BOE, never from the official site.

**Hard gate.** No pack may cite a reference — article number, rate, percentage or threshold — until an
archived copy of the primary text sits at the path in the "Archive" column and
`rules.legal_source_file_id` (or the threshold parameter's source) points at it. Until then the rule
still runs, but its output prints "legal source not yet archived" and E-family findings print elapsed
days only, never "deadline missed". The gate also applies to threshold parameters.

Confidence: `verified` = consistent across at least two research sources and the design review;
`likely` = single source or secondary summary; `estimate` = inferred or design choice. None of the
rows has an archived primary copy yet.

## 1. Civil Code of Catalonia, Book Five (Llei 5/2006 as amended by Llei 5/2015)

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| CCCat art. 553-1 | C11 | community regime; common vs private elements | likely | not yet archived | `legal_sources/cccat-553-01.pdf` |
| CCCat art. 553-3 | D5b; Cadastre comparison | participation quota fixed in the constitutive title; basis for expense sharing and votes | likely | not yet archived | `legal_sources/cccat-553-03.pdf` |
| CCCat art. 553-6 | D6 | reserve fund of at least 5% of the common-expenses budget; separate accounting; deposited in a special bank account in the community's name; urgent expenses payable from it by the administrator with the president's authorisation | verified | not yet archived | `legal_sources/cccat-553-06.pdf` |
| CCCat arts. 553-15 / 553-16 | E6 (annual election); D3 (reimbursement of the president's expenses) | organs of the community; president designated from among owners; one-year term, re-electable, extended until the next ordinary meeting; office is mandatory and unpaid (expenses reimbursable); represents the community | likely | not yet archived | `legal_sources/cccat-553-15-16.pdf` |
| CCCat art. 553-17 / 553-28 | E5 (custody) | secretary keeps convocations, communications, powers, accounting documentation and other relevant documents for at least 5 years; llibre d'actes for 30 years. **Numbering doubt:** the 2015 text places the 5-year custody duty in 553-17 (Secretaria) according to some sources and in 553-28 according to others | likely | not yet archived; numbering to confirm | `legal_sources/cccat-553-17-28.pdf` |
| CCCat art. 553-18 | D1, D7, D9 | administrator: conservation measures, prepare annual accounts and budget, execute resolutions, make payments and collections, issue debt certificates; accountable to the assembly | verified | not yet archived | `legal_sources/cccat-553-18.pdf` |
| CCCat art. 553-19 / 553-20 | E1, E3, E6, request clock | ordinary meeting at least once a year to approve accounts and budget and elect office-holders; meeting also when the president deems it convenient or on request of at least one quarter of the owners or of owners representing one quarter of the quotas; exclusive competence to appoint and remove office-holders at any time. **Numbering doubt:** the 1/4 request right is cited as 553-19 by the law research and as 553-20.2 by the owners' own request; no statutory convening period was found (`convene_days` is a design parameter and E6 prints elapsed days only) | likely | not yet archived; numbering to confirm | `legal_sources/cccat-553-19-20.pdf` |
| CCCat art. 553-21 | E5, E6 | convocation at least 8 calendar days in advance to each owner's designated address and posted on the notice board; documentation sent with the convocation or its location indicated; a professional administrator must have it available to owners from the moment the convocation is sent | verified | not yet archived | `legal_sources/cccat-553-21.pdf` |
| CCCat arts. 553-25 / 553-26 | E8, E1, D0, D11 | assembly approves extraordinary works, their amounts and contributions; works to remove architectural barriers or install lifts adopted by simple majority of owners voting that also represents a simple majority of total quotas, even if they modify the title or affect structure; excluded from the 4/5 requirement of 553-26 | verified | not yet archived | `legal_sources/cccat-553-25-26.pdf` |
| CCCat art. 553-27 | E3, E6 | acta content (date, place, character, who convened, attendance in person/represented, resolutions and votes); signed by secretary and president within 5 days; sent to all owners within 10 days | verified | not yet archived | `legal_sources/cccat-553-27.pdf` |
| CCCat art. 553-30 | D8, D5 (dissenter contribution, informational) | subsidies deducted from the cost borne by owners; dissenting owners must contribute when the expense does not exceed three quarters of the ordinary annual budget after subsidies | likely | not yet archived | `legal_sources/cccat-553-30.pdf` |
| CCCat art. 553-31 | E7 | resolutions contrary to law, title or statutes, or abusive, may be challenged: 1 year if contrary to law, 3 months otherwise, counted from notification of the acta; standing of dissenters, absent owners and any owner if contrary to law; challenge does not suspend execution | verified | not yet archived | `legal_sources/cccat-553-31.pdf` |
| CCCat art. 553-45 | D5, D5b, C11 | common expenses distributed by participation quota unless the title, statutes or a resolution provide otherwise; a flat per-unit contribution needs an express agreement | likely | not yet archived; article number to confirm | `legal_sources/cccat-553-45.pdf` |
| CCCat arts. 121-20 / 121-21 | lawyer annex (`v_limitation_clocks`) | limitation period for civil actions: 10 years general; 3 years for periodic payments | likely | not yet archived | `legal_sources/cccat-121-20-21.pdf` |
| LPH (Ley 49/1960) art. 20.e | E5 (supplementary) | administrator keeps the documentation at the owners' disposal; the LPH applies only where the CCCat is silent | likely | not yet archived | `legal_sources/lph-art-20.pdf` |

## 2. Invoicing, VAT, income-tax and cash rules

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| RD 1619/2012 art. 6 | C1, C10, B6 | mandatory invoice content: number and series; issue date; names of issuer and recipient; issuer NIF (recipient NIF for a Spanish business recipient — in practice always for a community with its H-NIF); addresses; description with taxable base, unit price, discounts; rate; tax amount shown separately; date of operation if different; special legends (exemption, reverse charge) | verified | not yet archived | `legal_sources/rd-1619-2012.pdf` |
| RD 1619/2012 arts. 4 and 7 | C1 | simplified invoice allowed up to €400 VAT included (€3,000 for listed retail-type activities; construction not listed); simplified content | verified | not yet archived | `legal_sources/rd-1619-2012.pdf` |
| RD 1619/2012 art. 11 (advance payments) | D4 | an invoice must be issued on receipt of an advance payment | likely | not yet archived | `legal_sources/rd-1619-2012.pdf` |
| RD 1619/2012 art. 15 | C3 | rectifying invoices reference the original and use a separate series | likely | not yet archived | `legal_sources/rd-1619-2012.pdf` |
| LIVA (Ley 37/1992) art. 91.Uno.2.10º | C2 | 10% on renovation and repair works when the recipient is a natural person or a community of owners, the building is more than two years old and materials supplied by the contractor do not exceed 40% of the taxable base; the 10% invoice must state the materials condition | verified | not yet archived | `legal_sources/liva-art-91.pdf` |
| LIVA art. 20.Uno.22.B | C2 | definition of rehabilitation works (more than 50% of cost on structure, façade, roof; total cost above 25% of building value excluding land) | likely | not yet archived | `legal_sources/liva-art-20.pdf` |
| LIVA art. 84.Uno.2.f | C2 | reverse charge applies only between businesses; not applicable to a community that is not a business — a works invoice to the community without VAT marked "inversión del sujeto pasivo" is a discrepancy | verified | not yet archived | `legal_sources/liva-art-84.pdf` |
| DGT rulings V5079-16, V0659-18, V2599-22, V0281-23 | C2 (notes) | lift installation in an existing building: 10% only within a qualifying rehabilitation or if materials ≤ 40%; usually 21% | likely | not yet archived | `legal_sources/dgt-lift-vat.pdf` |
| LIRPF art. 99 / RIRPF art. 76 | G1, C2 | a community is obliged to withhold; 15% (7% in the first years of activity) on invoices of natural-person professionals; Modelo 111 quarterly and 190 annually; firms taxed as companies carry no retention | verified | not yet archived | `legal_sources/irpf-retencion.pdf` |
| Modelo 347 (RD 1065/2007) | G2, C4 | communities declare each supplier with annual operations above €3,005.06 VAT included, except electricity, water, fuel and insurance; filed in February | likely | not yet archived | `legal_sources/modelo-347.pdf` |
| RD 1065/2007 (RGAT) arts. 31–33 | B10; `aeat_census` (identity check of the NIF and name printed on invoices) | communities of owners have been modelo 347 declarants since 2014 (art. 31 as amended by RD 828/2013) for suppliers above €3,005.06 a year VAT included, with exclusions for electricity, fuel and water supplies and common-element insurance (art. 33.2, recalled, not fetched); the AEAT describes its identity-check service as a tool for declarants to clean the identification data of the taxpayers included in a return before filing it — the duty that motivates checking a vendor's NIF and name against the census. Article numbering from secondary sources | likely | not yet archived | `legal_sources/rd-1065-2007-arts-31-33.pdf` |
| Ley 7/2012 art. 7, as amended by Ley 11/2021 art. 18 | D2, C4, `parameters.cash_limit` | no cash payment of operations of €1,000 or more when a party is a business or professional, in force since 11 July 2021 (€2,500 before); the limit applies to the operation, not to each payment | verified | not yet archived | `legal_sources/ley-7-2012-art-7.pdf` |
| RD 1007/2023; RD 254/2025; RDL 15/2025 (Verifactu) | C1, C8 notes | invoicing-software requirements postponed to 1 Jan 2027 (companies) and 1 Jul 2027 (others); absence of a QR on 2021–2026 invoices is not anomalous | likely | not yet archived | `legal_sources/verifactu-timing.pdf` |

## 3. Subsidies

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| Ley 38/2003 art. 31.3 | G3 | a subsidised beneficiary must request at least three quotes from different suppliers before contracting when the subsidised works exceed the threshold, keep them for justification and justify in writing a choice other than the cheapest. **Contradiction:** threshold reported as €30,000 (older text €40,000) by one pack and as the LCSP minor-contract limits (€40,000 works / €15,000 services) by another; a call's bases may set its own figure | likely | not yet archived; threshold to read from the consolidated text and the archived bases | `legal_sources/ley-38-2003-art-31.pdf` |
| Ley 38/2003 art. 20; RD 130/2019 | D8 | grants to legal entities published in the BDNS for four years | likely | not yet archived | `legal_sources/bdns-publicity.pdf` |
| Llei 18/2007 art. 136 | D8 | rehabilitation grants recorded against the property at the Registre de la Propietat | likely | not yet archived | `legal_sources/llei-18-2007-art-136.pdf` |
| Consorci de l'Habitatge de Barcelona, accessibility call 2024–2026 (DOGC 12 Aug 2024; bases DOGC 7 May 2021) | D8, A8, G3 | interior lift 35% of eligible budget capped at €30,000 (exterior €50,000); barrier removal 25% / €30,000; 50% / €45,000–65,000 only in listed neighbourhoods (Eixample excluded). **Contradiction:** 35% in two packs vs 25% in three; composition of the eligible budget (fees, ICIO, VAT) unconfirmed | likely | not yet archived | `legal_sources/consorci-accessibilitat-2024.pdf` |
| Consorci de l'Habitatge de Barcelona, common-elements call 2025 | D8, A8, D2 | 35%; cap the lower of €30,000 per building or €3,000 per dwelling; eligible expenses above €1,000 must be paid by bank transfer; ITE with certificate of aptitude required | likely | not yet archived | `legal_sources/consorci-elements-comuns-2025.pdf` |
| RD 853/2021 Programa 3; Barcelona call DOGC 27 Jun 2022 | D8 | 40 / 65 / 80% by primary-energy saving with per-dwelling caps; closed 31 Dec 2023 | likely | not yet archived | `legal_sources/rd-853-2021.pdf` |

## 4. Barcelona permits and taxes

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| Ordenança fiscal 2.1 (ICIO), editions 2021–2026 | G4, A9, reconciliation step 7 | base = PEM; **rate reported as 4% by two packs and ≈ 3.35% by one** — stored as `icio_rate_by_year`; 90% bonus for accessibility works (subject to council approval; must be requested); other bonuses for heritage and sustainability | likely | not yet archived; rate and bonus per year to confirm | `legal_sources/bcn-of-2.1-<year>.pdf` |
| Ordenança fiscal 3.3 (taxa de serveis urbanístics) | G4 | 4.96 €/m² with a €385 minimum for major works (figure may be from 2021); fixed amounts for extensions and comunicats | estimate | not yet archived | `legal_sources/bcn-of-3.3-<year>.pdf` |
| ORPIMO (2011, amended 2022) | E2, G4, permit document types | regimes: assabentat, comunicat immediat, comunicat diferit, llicència; consulta prèvia; Informe d'Idoneïtat Tècnica issued by COAC/CATEB; heritage report in protected ensembles; expedient number on the site sign | likely | not yet archived | `legal_sources/orpimo.pdf` |
| Llei 19/2014 (transparency) | permit checks | access-to-information request resolved within one month | likely | not yet archived | `legal_sources/llei-19-2014.pdf` |

## 5. Contractors, lifts, safety, inspections and public registers consulted

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| Ley 32/2006; RD 1109/2007 (REA) | B7, G5 | contractors and subcontractors executing construction works must be registered before starting; registration valid three years; public lookup; sole traders without employees exempt | verified | not yet archived | `legal_sources/rea.pdf` |
| Ley 32/2006 arts. 4.2.b and 6; RD 1109/2007 arts. 6, 10.1.c and 10.3 (REA public access) | B7; `rea` check (automated lookup replacing the manual placeholder) | registration in the REA is mandatory for contractors and subcontractors (art. 4.2.b) and the registers' data are public, except data concerning the intimacy of persons (art. 6.2); registration valid three years (RD 1109/2007 art. 6); public access to the data held in any of the regional registers (art. 10.1.c) through a central database managed by the Ministry (art. 10.3). Sole traders appear under a personal NIF: only the registration flag, number and check date are stored | likely | not yet archived | `legal_sources/rea-public-access.pdf` |
| RASIC (Generalitat industrial-safety agents register) | B7, G5 | lift maintainers and installers of electrical, gas and thermal installations must be registered; open dataset on the Generalitat transparency portal (dataset id and columns to verify) | likely | not yet archived | `legal_sources/rasic.pdf` |
| Llei 9/2014 art. 8 (RASIC) | B7, G5; `rasic` check (dataset `exxq-fubu`, id and NIF column to verify) | the Registre d'Agents de la Seguretat Industrial de Catalunya lists in one register the organismes de control and the companies that install, maintain, repair and operate industrial installations (art. 8.3); entries are made by the Generalitat from the companies' responsible declarations (art. 8.4); the register's data are public except personal data, and the department publishes the updated list of organismes de control with the regulatory fields each one covers (art. 8.8). Absence from the register is non-exculpatory outside its scope | likely | not yet archived | `legal_sources/llei-9-2014-art-8.pdf` |
| Ley 22/2003 art. 198 (publicity of insolvency; now TRLC arts. 560–565 after Ley 16/2022); RD 892/2013 arts. 3–6 and 8 (Registro Público Concursal) | `insolvency` check; fact-sheet `insolvency_status` | access to the Registro Público Concursal is public, free and permanent and requires no legitimate interest to be shown for the section of insolvency resolutions (RD 892/2013 art. 3.1); searchable by the debtor's name, denomination or NIF (art. 4.2); entries carry the type of resolution, the debtor's identity, the court, the case number and date and the edict text (art. 8.2); the data may be used only for the purposes of the insolvency law (art. 5.a); the register takes measures against automated indexing (art. 3.2); personal data are cancelled one month after the effects of the resolution end (art. 6). **Numbering doubt:** the plan cites Ley 22/2003 art. 198; the consolidated TRLC numbering (560.1; 561 sections; 564.2 legitimate-interest gate for the other sections; 565 "merely informative value") could not be read | likely | not yet archived; numbering to confirm | `legal_sources/rpc-publicity.pdf` |
| TRLCI (RDL 1/2004) arts. 51–53 (Catastro protected vs public data) | `catastro_units` check; E3, D5b (unit and coefficient cross-check); B2 (address equality) | protected cadastral data are the name, surnames, business name, identification code and domicile of the holders and the cadastral value (art. 51); all other cadastral information is open to everyone (art. 52), its transformation and onward distribution being subject to the conditions of the Dirección General del Catastro (art. 52.2, statute confirmed; the licence conditions — attribution with access date, no republication of raw data, derived output not presented as cadastral information — are paraphrased from unread licence documents); protected data are released only with the holder's express written consent, by law, or to the legitimate and direct interests listed in art. 53.1 (research, notaries and registrars, adjoining owners, holders of real rights or leases, heirs) — a community is not among them, so only the free services returning building facts are used and no holder is ever looked up. Article text confirmed only against a mirror that one reading found truncated | likely | not yet archived | `legal_sources/trlci-arts-51-53.pdf` |
| RD 203/2016 | G5 | lift CE declaration of conformity; commissioning registration with the Generalitat | likely | not yet archived | `legal_sources/rd-203-2016.pdf` |
| RD 355/2024 (ITC AEM 1), in force 1 Jul 2024 | G5, D10, expected invoice count | maintenance visits monthly unless the lift has ≤ 3 stops and serves ≤ 20 dwellings (then every four months); periodic inspection every 4 years for buildings with more than 4 floors served or more than 20 dwellings, otherwise every 6 years | likely | not yet archived | `legal_sources/rd-355-2024.pdf` |
| RD 1627/1997 art. 3 | G6 | when more than one company or sole trader works on site the promoter must appoint a health-and-safety coordinator; safety plan; work-centre opening | verified | not yet archived | `legal_sources/rd-1627-1997.pdf` |
| Decret 67/2015 (ITE) | G7 | buildings with housing use older than 45 years must pass the technical inspection and obtain a certificate of aptitude; subsidy calls require it | verified | not yet archived | `legal_sources/decret-67-2015.pdf` |
| RERA (asbestos-removal companies register) | G5 (asbestos) | removal of asbestos-cement requires a registered company and an approved work plan | likely | not yet archived | `legal_sources/rera.pdf` |
| LOE (Ley 38/1999) | A4 | community as promoter; written contract, certifications signed by the site director, 5–10% retention released at reception; liability periods 1/3/10 years | likely | not yet archived | `legal_sources/loe.pdf` |
| LCSP excess-measurement rule (10%) | A3 | public-works convention that measurement excess up to 10% of the contract price is absorbed without prior approval — used only as a professional-standard analogy | likely | not yet archived | `legal_sources/lcsp-extras.pdf` |
| Ley 2/2007 (professional societies) | G1 | professional partnerships (SCCLP); retention depends on tax regime | likely | not yet archived | `legal_sources/ley-2-2007.pdf` |
| Ley 18/2022 (Crea y Crece) | B1 | limited companies with €1 share capital | likely | not yet archived | `legal_sources/ley-18-2022.pdf` |
| TS doctrine on lift-maintenance permanence clauses (TS Pleno 2019; STS 27 Nov 2025; STS 541/2026 of 9 Apr 2026) | A7 | 10-year permanence held abusive; a 3-year term tied to a real discount accepted; dates and numbers from secondary sources | estimate | not yet archived | `legal_sources/ts-lift-maintenance.pdf` |

## 6. Evidence, limitation periods and standing

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| Código Penal art. 131; art. 250.1.5º | lawyer annex (`v_limitation_clocks`) | limitation periods for criminal actions: 5 years in general, 10 years where the aggravated form applies (threshold €50,000); the period runs from the last act in continued conduct. Described neutrally; the annex prints dates and articles only | likely | not yet archived | `legal_sources/cp-art-131-250.pdf` |
| STS Sala 1ª, 6 Mar 2024 | lawyer annex (standing note) | assembly authorisation required for the president to litigate on behalf of the community | likely | not yet archived | `legal_sources/sts-2024-03-06.pdf` |
| LEC art. 256 | document requests (routes) | preliminary proceedings for exhibition of documents (mention only) | likely | not yet archived | `legal_sources/lec-art-256.pdf` |
| Ley 6/2020 art. 3; LEC arts. 299, 326, 384; eIDAS Reg. 910/2014 art. 41 | custody manifests, timestamps | electronic documents as evidence; qualified electronic timestamps presumed accurate | likely | not yet archived | `legal_sources/evidence-electronic.pdf` |
| STS 685/2010; STS 356/2016 | custody | doubts about chain of custody must be proven, not merely alleged | likely | not yet archived | `legal_sources/sts-custody.pdf` |

## 7. Data protection

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| GDPR arts. 6.1.f, 13, 14, 21, 30, 35, 36; LOPDGDD | `docs/legal/*` | legitimate interest; information duties; right to object; record of processing; DPIA and prior consultation | verified (text of the Regulation) | consolidated text to archive | `legal_sources/gdpr.pdf` |
| AEPD Informe jurídico 0261/2013; FAQ-0906 | LIA, DPIA, sharing policy | an owner may access and copy community documents (fees, invoices, contracts, debts, consumption, bank accounts) to verify management, limited to adequate, pertinent and non-excessive data; directories of other owners' contact data or account numbers and employee payrolls are disproportionate; exposure of debtors or minutes on notice boards has been sanctioned (figures of €10,000–15,000 from secondary sources) | likely | not yet archived | `legal_sources/aepd-0261-2013.pdf`, `legal_sources/aepd-faq-0906.pdf` |
| AEPD list of processing requiring a DPIA (art. 35.4) | DPIA | criteria list | likely | not yet archived | `legal_sources/aepd-dpia-list.pdf` |
| Anthropic DPA, retention statement, DPF status; Supabase and Vercel DPAs | LIA §6, processing record | SCCs; 30-day deletion of API inputs and outputs; no training | likely | not yet archived | `legal_sources/dpa-anthropic.pdf`, `legal_sources/dpa-supabase.pdf`, `legal_sources/dpa-vercel.pdf` |

## 8. Bank data formats

| Reference | Used for | Content as researched | Confidence | Verification status | Archive |
|---|---|---|---|---|---|
| AEB Norma 43 (Cuaderno 43) record layout and "concepto común" codes | D2, D3, D5 (`tx_kind`), parsers | fixed-width records 11 / 22 / 23 / 33 / 88 with positions as documented by open-source parsers. **Contradiction:** two incompatible code tables for codes 12–17 (one lists 12 returned items, 14 taxes, 16 interest, 17 cards; the other 12 card/ATM, 14 returned items, 16 taxes, 17 interest). `tx_kind` is therefore derived primarily from record-23 text (BIZUM, REINTEGRO, EFECTIVO, TRANSF, RECIBO, TARJETA) and the code is secondary until the issuing bank's own legend is archived | estimate | not yet archived; bank legend to obtain | `legal_sources/norma43-<bank>.pdf` |
| ISO 20022 camt.053 | parsers | bank statement XML: entries with amount, credit/debit indicator, booking and value dates, related parties | verified (standard) | schema to archive | `legal_sources/camt053.xsd` |

## 9. Numbering doubts and contradictions (summary)

| Item | Sources disagree on | Resolution before any pack cites it |
|---|---|---|
| Custody duty | CCCat 553-17 vs 553-28 | read the consolidated 2015 text; store the paragraph |
| ≥ 1/4 request right | CCCat 553-19 vs 553-20.2 | same; adjust the citation in the request-clock template |
| Expense distribution criterion | CCCat 553-45 (number unconfirmed) | same |
| ICIO rate | 4% vs ≈ 3.35% | archive OF 2.1 for each year 2021–2026; parameter `icio_rate_by_year` |
| Consorci accessibility percentage | 35% vs 25%; eligible-budget composition | archive DOGC 12 Aug 2024 and the 2021 bases |
| Three-quote threshold | €30,000 vs €40,000 vs LCSP limits | archive Ley 38/2003 art. 31.3 consolidated text and the call's bases |
| OF 3.3 amounts | possibly outdated | archive the current PDF |
| Norma 43 concept codes | two tables | obtain the bank's own legend; keep text-based classification primary |
| Administrator fee benchmark | 3–7 vs 15–30 €/unit/month | trade sources only; severity capped (see `benchmark-sources.md`) |
| Insolvency-register publicity | Ley 22/2003 art. 198 vs TRLC arts. 560–565 (Ley 16/2022); whether RD 892/2013 was updated to the five-section scheme | read the consolidated TRLC and RD 892/2013; store the paragraphs before any pack cites the register |
