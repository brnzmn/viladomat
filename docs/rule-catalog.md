# Rule catalogue v1

Every rule is a deterministic, versioned test over the normalised tables. A hit is a **discrepancy
to verify**; it carries its innocent explanations, the document that would resolve it, and a next
check. Rule names describe the test, not a motive. Thresholds reference the versioned `parameters`
table (`pm_works`, `pm_ordinary`, `trivial_floor`, `outflow_min`, `authority_threshold`,
`funding_gap_min`, `upfront_max_pct`, cash limit by date).

Column key:

- **S** default severity 1–4 (1 informational, 2 low, 3 medium, 4 high); a range means the rule sets
  S conditionally as described in the test.
- **Sp** specificity prior (1 − expected false-positive rate); an initial estimate, changed only through
  a `rules.version` bump fed by `rule_precision_log`.
- **Basis**: `statutory` / `subsidy_bases` / `professional_standard` / `internal_control`. Only
  `statutory` and `subsidy_bases` rules may print an article number, and only once the cited text is
  archived (`legal-references.md`).
- **Attribution**: `vendor_compliance` / `administrator_process` / `governance` / `funds`. Entity
  scores aggregate per attribution; vendor-compliance items are reported in a separate "formal
  defects" subsection.
- **M**: milestone at which the rule is enabled (M3 rules marked "seed" already run on seeded acta
  figures from M0).

## 1. Family D — funds and money flow

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes (legitimate explanations) | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| D0 | Funding gap | committed or paid works spend − (contributions collected + subsidies + loans + reserve drawn) > `funding_gap_min`, per package and overall | 3 | 0.85 | internal_control (553-25 context) | funds | M3 (seed) | later contributions, a loan or a subsidy approved in minutes not yet in the corpus; unpaid contractor balances; works not yet invoiced; seed figures typed from minutes pending second-person check | later minutes; loan contract; subsidy resolution; contractor statement of account; `seed_verified_by` |
| D1 | Three-way residuals | R1 invoice without debit (2); R2 debit > `outflow_min` without invoice (3; 4 if the payee is a natural person); R3 liquidation line with neither (3) | 2–4 | 0.85 | internal_control | administrator_process (R1, R3); funds (R2) | M3 | invoice paid from another account or in a later period; recurring direct debits whose invoices are never filed (pre-classified and excluded from R2); partial payments; retention; statement months missing (R7). R2 totals are printed as "not yet matched as of <date>", never as unsupported spend | invoice or receipt for each R2 line via the administrator; complete statement coverage; next fiscal year for R1 |
| D2 | Cash, cheque, card, Bizum | any such debit > €300 (2); ≥ the statutory cash limit in a single operation or > €3,000/yr (3); invoice ≥ the limit marked as paid in cash (3). Limit is date-dependent: €2,500 before 2021-07-11, €1,000 after | 2–3 | 0.9 | statutory (Ley 7/2012 art. 7) for the limit tests; internal_control for the €300 observation | funds | M3 | small locksmith or plumbing jobs paid in cash; petty cash reimbursed to an office-holder with receipts; the limit applies to the operation, not to each payment, and only when a party is a business | receipts; card holder identity by role; vendor's confirmation of the amount received |
| D3 | Payees | transfer to a natural person for an invoice issued by a company (3); to the president or administrator beyond documented fees or approved reimbursements (4); Bizum, card or PayPal (2); foreign or neobank IBAN (2) | 2–4 | 0.8 | internal_control | funds | M3 | sole trader operating under a trade name; a company's sole administrator receiving under a valid endorsement; reimbursement of expenses advanced by an office-holder (suplidos) with receipts; factoring; a local vendor banking with an EU neobank | endorsement or assignment document; expense receipts; Registro Mercantil note for the payee; transfer receipt with beneficiary name |
| D4 | Payment timing | payment before the invoice date without an advance invoice (2); payment before the approving resolution (3); before contract signature (3); more than 180 days after the invoice (1) | 1–3 | 0.7 | internal_control; RD 1619/2012 for the advance-invoice point | administrator_process | M3 | administrator paid from a pro-forma and the vendor invoiced later; advances customary for made-to-order equipment (lift, joinery); quotes gathered before the vote (15-day tolerance); approval recorded in a later acta | final invoice matching the advance; acta with the approval; contract payment schedule |
| D5 | Contribution (derrama) reconciliation | \|expected − collected\| or \|collected − applied\| > max(€1,000, 5%) (3); purpose switch without resolution (3); contribution continuing after the financed works are fully paid (2); office-holder's units netted or paid in cash (3); flat amount vs quota criterion without express agreement (1, informational) | 1–3 | 0.85 | statutory (553-45 quota criterion, to verify; 553-30 subsidies deducted) for the criterion tests; internal_control for the ledger | funds | M3 (expected side from seed; collected side needs bank credits) | contributions collected into a pooled administrator account (ledger rebuilt as `basis='assertion'`); arrears; instalment plans; netting against genuine out-of-pocket expenses with receipts; purpose changed by a later resolution | bank credits per unit via `restricted.unit_payer_keys`; liquidation unit rows; resolutions on purpose |
| D5b | Quota expectation per unit | expected ordinary = approved budget × quota / 12 (or the community's own criterion); expected extraordinary = contribution rule; deviation > €5 or missing month against receipts, liquidation rows and bank credits, with an explicit row for the office-holder's units | 1–3 | 0.8 | statutory (553-45, to verify) / internal_control | funds | M4 | statutes with a different distribution criterion; agreed exemptions or instalments; rounding; mid-year budget change | statutes (`community_rules`); receipts; administrator's per-unit statement |
| D6 | Reserve fund | balance < 5% of ordinary budget (1); decrease without an urgent invoice and the president's authorisation (3); no separate account in the community's name (2) | 1–3 | 0.8 | statutory (553-6) | governance | M3 | very common non-compliance in small communities (the 5% test is informational); urgent repair documented later; reserve held as a sub-account | statement of the reserve account; invoice and authorisation for each drawdown |
| D7 | Balance continuity and custody of funds | opening ≠ prior closing (3); liquidation cash ≠ bank balance at the same date (3); funds held by the administrator or account not titled to the community's H-NIF (3); post-bridge control totals differ by more than `pm_ordinary` (3) | 3 | 0.9 | professional_standard (accounting continuity; 553-18 duty to render accounts) | funds | M3 | accrual vs cash basis and cut-off items (opening/closing payables, retentions) — only the residual after the printed bridge is tested; administrators lawfully running client accounts with sub-ledgers (the finding is "funds not in an account titled to the community"); statement months missing | bank certificate of holder and authorised persons; closing lists of debtors and creditors; accounting-basis statement |
| D8 | Subsidy pass-through | grant resolved or paid but absent from liquidation income (4); paid to an IBAN other than the community's (4); eligible lift never applied for (1, cost of inaction) | 1–4 | 0.9 | statutory (553-30; Ley 38/2003 justification rules) | funds | M3 | grant not yet paid (paid after the final certificate and justification); grant credited in a later fiscal year; application refused; community never applied | BDNS and RAISC search by the community's NIF; Consorci resolution; bank credit |
| D9 | Administrator fees | fees > benchmark × 1.5 without resolution (2); works-management fee > 5% or unapproved (2); increase > IPC + 5 points without resolution (1) | 1–2 | 0.6 | internal_control (fees approved by the assembly) | administrator_process | M4 | extraordinary meetings, certificates and subsidy processing billed separately by agreement; fee set in the mandate contract; benchmark packs disagree on the Barcelona range | mandate contract; acta approving fees; archived benchmark record |
| D10 | Recurring service drift | year-on-year > IPC + 10 points (1); > 30% (2); supplier switch without resolution (2); two suppliers for one service in overlapping months (3); lift maintenance billed before the lift exists (3) | 1–3 | 0.7 | internal_control | administrator_process | M8 | 2021–22 materials and energy inflation; contract escalation clauses; coverage upgrade (basic → all-risk); overlap during a handover month | contract; renewal letter; policy schedule |
| D11 | Loan flows | disbursement to a third party (4); repayments ≠ amortisation table (2); no resolution approving the loan (2) | 2–4 | 0.9 | statutory (553-25 assembly competence) for the resolution test; internal_control otherwise | funds | M3 on seeded header; full in M4 | bank pays the contractor directly under a financed-works product documented in the loan contract; early repayment; fee capitalisation | loan contract; amortisation table; acta |
| D12 | Budget variance | actual > budgeted × 1.25 and > `pm_ordinary` without resolution (1–2) | 1–2 | 0.6 | internal_control | governance | M4 | reclassification between lines; one-off repairs approved in a later acta; budget line omitted | acta; liquidation notes |

## 2. Family E — governance and timeline

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| E1 | Authority | spend > `authority_threshold` with no resolution or budget line (2); delegated spend > highest quote considered (3) | 2–3 | 0.8 | statutory (553-19/553-25) for works approvals; internal_control for the €1,000 default (the community has no rule; stated explicitly) | governance | M3 (seed) | ordinary-budget items need no specific resolution; approval in a later acta; delegation with an implicit cap; urgent repairs under the 553-6 procedure | acta text; delegation wording; quotes considered |
| E2 | Works sequence | each violated inequality in acta ≤ quote acceptance/contract ≤ permit ≤ start ≤ certifications/invoices ≤ final certification ≤ final payment (2–3); 15-day tolerance for quotes before the acta | 2–3 | 0.8 | internal_control (permit timing is regulated by ORPIMO, cited via G4) | governance | M3 | quotes collected before the vote; permit filed the week works start; dates transcribed from photographs of printouts | permit file; site-sign photo; contractor's dated start notice |
| E3 | Acta integrity | quotas or votes ≠ unit table (2); no accounts item in an ordinary meeting (2); "unanimity" contradicted elsewhere (2); bare quorum carried by the office-holder's units (1, never worklist) | 1–2 | 0.7 | statutory (553-27 acta content; 553-19 annual approval) | governance | M3 | rounding of quotas; proxies; quorum patterns are normal in small communities (base rate) | Cadastre coefficient table; proxies; convocation |
| E4 | Segregation of duties | distinct roles across approve / contract / certify / pay = 1 (S1, never worklist) | 1 | 0.6 | internal_control | governance | M3 | expected in most 15-unit communities; a control weakness that only raises the weight of findings produced by other rules | – |
| E5 | Missing documents and availability | class missing per year (2); not available from the convocation (2); statement months missing, R7 (2); Norma 43 export or holder certificate refused (2, dated, with request evidence) | 2 | 0.9 | statutory (553-21 availability; 553-17/553-28 custody, numbering to verify) | administrator_process | M3 (seed) | documents exist but were only inspected on site (`inspected_only`); delivered later (`received_on`); class not applicable in that year. Output wording: "requested on <date> via <channel>; not received as of <date>" | request evidence file; document-matrix cell state; on-site index sheet |
| E6 | Formal deadlines and request clock | convocation notice < 8 days (2); acta signed > 5 days or sent > 10 days after the meeting (1); no annual election (1); days elapsed since the ≥ 1/4 request — informational only, no statutory period | 1–2 | 0.8 | statutory (553-21, 553-27, 553-16, 553-19) | governance | M3 (seed) | notification date unknown (the clock cannot start); e-mail delivery dates; extension of office until the next ordinary meeting is lawful | convocation with date; notification evidence |
| E7 | Challenge windows | resolutions whose +3-month / +12-month windows from notification are still open at report date (informational) | 1 | 1.0 | statutory (553-31) | governance | M3 (seed) | notification date missing → printed as "not computable" | acta notification evidence |
| E8 | Resolution majority validity | works or lift resolutions must carry a simple majority of owners voting that also represents a simple majority of total quotas; 4/5 exclusions checked (2) | 2 | 0.9 | statutory (553-25/553-26) | governance | M3 | votes recorded as "unanimity of those present" without quotas listed; abstentions; statutes with other rules | acta; unit table; statutes |

## 3. Family A — procurement and works execution

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Award vs quotes | fewer than 2 quotes for spend > €3,000 (2); award > lowest quote × 1.10 without written justification (3) | 2–3 | 0.7 | internal_control (no statutory three-quote rule outside subsidies; see G3) | governance | M4 | cheaper quote had a narrower scope or lacked licence or insurance; the assembly chose quality; a small community with one trusted contractor | line-by-line scope comparison; confirmation from losing bidders through the administrator or counsel |
| A2 | Unit-price outliers | unit price / benchmark > 1.30 (2) or > 1.60 (3) on partidas summing > 10% of the contract; official-tier benchmarks only | 2–3 | 0.5 | professional_standard | governance | M8 | protected pre-1965 building, access constraints, 2021–22 inflation, small-job overhead (+20–40% over generic databases is plausible); ELEVATOR and STAIRCASE are non-benchmarkable in v1 | independent quote for the same partidas; BEDEC record with edition date |
| A3 | Extras | extras / contract > 10% (2) or > 20% (3); extra without dated approval under a choice-only delegation (3); extra duplicating a base partida (3) | 2–3 | 0.7 | internal_control (10% conventional threshold by analogy with public-works practice) | governance | M4 | genuine hidden conditions in a pre-1965 building (structure, sewer, asbestos, party walls, heritage conditions); 10–15% extras are routine — documentation and pricing are what matter | site director's report or dated photos per extra; extra unit prices vs base contract rates |
| A4 | Certification vs contract and suspension | certified > contract without a modificado (3); no site-director signature (2); Σ certifications ≠ Σ invoices ± 1% (2); no retention in the schedule (1); certification before permit or start (3); paid > certified + contractual advances at the suspension date (3); payment or invoice after suspension without certification (3) | 1–3 | 0.8 | professional_standard (LOE certification practice) | administrator_process | M4 | advances for made-to-order equipment (lift cabin and machinery: 40–60% on order); seasonal August stop (`suspension_reason = seasonal` is neutral); certification signed later than issued; retention released at reception | contract payment schedule; site diary; dated photos; final certificate |
| A5 | Cross-vendor duplicate scope | line-item similarity > 0.85 (`pg_trgm`) between different vendors within 120 days (2) | 2 | 0.5 | internal_control | funds | M8 | dismantling or preparation legitimately split between trades at different stages; generic descriptions | line detail of both invoices; site director's confirmation |
| A6 | Invoice without quote; deviation | invoice > €1,000 without quote or contract (2); invoice ≠ accepted quote by more than 5% (2); quote accepted but no resolution (2) | 1–2 | 0.7 | internal_control | administrator_process | M4 | small jobs quoted verbally; quote kept only by the administrator; price update agreed by e-mail | copy of the quote via the administrator; e-mail evidence |
| A7 | Contract clauses | upfront > `upfront_max_pct` (40% works / 60% lift) (2); no deadline or penalty (2); no retention (1); discretionary pricing clause (2); unindexed revision clause (2); maintenance permanence > 3 years or penalty > remaining fees (2); signer without authority for the amount (3); counterparty ≠ invoicing entity (3) | 1–3 | 0.7 | professional_standard (industry practice; TS doctrine on permanence clauses, to verify) | governance | M4 | lift industry customarily bills 30–60% on order; small contractors' standard forms omit penalties; group companies invoicing for the contracting entity (documented) | vendor's standard conditions; acta delegating signature; group structure from a Registro Mercantil note |
| A8 | Subsidy budget vs contract | eligible budget declared > contract × 1.15 (2); contract > declared × 1.3 (2) | 2 | 0.7 | subsidy_bases | funds | M4 | eligible budget includes technical fees, taxes and VAT (composition to verify in the call's bases); contract later modified | Consorci file; call bases |
| A9 | PEM triangulation | contract > architect's PEM × 1.3 (1–2); invoices > PEM × 1.19 × VAT by more than 20% (2); no permit or ICIO while works ran (2) | 1–2 | 0.7 | professional_standard (contract ≈ PEM × 1.19) | governance | M4 | PEM declared at project stage; scope added later; private works use other overhead ratios | permit file with declared PEM; project document |
| A10 | Quote authenticity | losing quotes for the same package sharing PDF producer or author, phone, e-mail, IBAN, typos or sequential numbers (2–3); losing bidder whose NIF fails census or registry checks (3) | 2–3 | 0.7 | internal_control | vendor_compliance | M5 | quotes prepared on the architect's template; bidders using the same estimating software; OCR errors in phone numbers | AEAT census check; Registro Mercantil note; confirmation from the bidder via counsel |
| A11 | Fee ratio | architect fee / PEM outside 4–12% (1) | 1 | 0.6 | professional_standard (7–10% × 1.2 for rehabilitation; reference scales abolished) | governance | M4 | partial service (no certification control); lump-sum fee; PEM revised | fee agreement (full d'encàrrec); project PEM |
| P1a | Price vs contract and budget | expected-price engine with CONTRACT and BUDGET layers only: INFO inside the band; REVIEW outside by < 25% or low confidence; MATERIAL outside by ≥ 25% and D ≥ `pm_works` and confidence ≥ medium | 1–3 | 0.7 | internal_control | funds | M4 | signed change orders; a delegation without explicit cap is a ceiling, not a price; quantities not stated on the invoice | change order; certification line; quote line |
| P1b | Price vs benchmark and history | adds BENCHMARK and HISTORY layers; a trade-tier benchmark alone never yields MATERIAL; ELEVATOR and STAIRCASE print "no comparable benchmark" | 1–3 | 0.5 | professional_standard | funds | M8 | see A2; regional and heritage factors; index basis and edition date | archived benchmark record; independent quote |

## 4. Family C — document integrity

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Mandatory content | ≥ 3 mandatory elements missing, or no NIF or number (2); simplified invoice > €400 for works or services (2); quote or delivery note paid as if an invoice (3) | 2–3 | 0.8 | statutory (RD 1619/2012 arts. 6 and 4/7) | vendor_compliance | M4 | administrator templates often omit the community's NIF on the recipient side; a pro-forma later replaced by a final invoice; the Verifactu QR is not mandatory before 2027, so its absence is not a defect | final invoice from the vendor via the administrator |
| C2 | Arithmetic, VAT, IRPF | line sums, base × rate or total mismatches (2); rate ∉ {21, 10, 4, 0} (3); reverse charge or 0% on works to the community (3); 10% without the 40%-materials statement (1); IRPF retention missing on a natural-person professional (2) | 1–3 | 0.85 | statutory (LIVA arts. 91.Uno.2.10º, 20.Uno.22.B, 84.Uno.2.f; LIRPF art. 99 / RIRPF art. 76) | vendor_compliance | M4 | 10% vs 21% on mixed works is genuinely ambiguous (40% materials test; rehabilitation qualification) and is the vendor's tax exposure; professional firm taxed as a company (no retention); rounding | vendor's materials breakdown; NIF letter and tax regime of the professional firm; Modelo 111 filings |
| C3 | Duplicates (after deterministic dedup) | same vendor and total with a different number within 365 days (3); same number with different totals (3); identical image paid twice in the bank (4); ± 1% within 45 days (2) | 2–4 | 0.8 | internal_control | funds | M4 | the same invoice legitimately present in several bundles (removed by dedup); recurring identical monthly fees; rectificative invoice reissued with a new number | bank shows one or two debits; vendor's statement of account |
| C4 | Splits | sets of invoices from one vendor within 7 days summing to +5%/−0% of {€400, €1,000, €3,000, €3,005.06, delegation cap} (2; 3 if paid in cash) | 2–3 | 0.6 | internal_control (thresholds derived from statutory figures) | funds | M8 (T3 only until a null model exists) | phased works invoiced per stage; chance matches are frequent at n ≈ 300 (permutation baseline required) | contract phases; quote |
| C5 | Round numbers | share of round totals > 30% or round bases > 60% for a vendor with ≥ 5 invoices and no line detail (1–2) | 1–2 | 0.4 | internal_control | vendor_compliance | M8 | Spanish quotes are habitually rounded on the base ("1.500 € + IVA") | line-detail request |
| C6 | Sequence | later number with an earlier date (2); gap-free sequence containing only this community's invoices (S1, never worklist, read with B9) | 1–2 | 0.5 | internal_control | vendor_compliance | M4 | annual restart of numbering; one series per client; rectificative series; micro-firms issuing 20–60 invoices a year | vendor's series scheme |
| C7 | Calendar | issue date on a weekend or holiday (1); value date on a non-business day (1) | 1 | 0.3 | internal_control | vendor_compliance | M8 | many small firms invoice on Saturdays; instant transfers post on weekends | – |
| C8 | Altered-document signals | ModDate > CreationDate by more than 1 day (1); producer or creator is an image editor or word processor where the vendor elsewhere uses an ERP (2); text layer ≠ OCR of the image for amounts (3); template drift between consecutive invoices (2); page identical except amount or number (3) | 1–3 | 0.6 | internal_control | vendor_compliance | M8 | vendors regenerate PDFs when re-sending; scanned copies of printed PDFs; letterhead redesign. Every C8 hit is a "request the original" item | original from the vendor via the administrator |
| C9 | Generic descriptions | "trabajos varios", "según presupuesto", "mano de obra" with no quantity or unit on invoices > €1,000 (1) | 1 | 0.4 | internal_control | vendor_compliance | M8 | common among small contractors; the referenced quote carries the detail | quote; certification |
| C10 | Recipient mismatch | invoice addressed to a person, to the administrator's firm, to another community, or with a wrong H-NIF (3) | 3 | 0.85 | statutory (RD 1619/2012 art. 6, recipient identification) | administrator_process | M4 | administrator's template addressing invoices to its office for forwarding; typo in the NIF; invoice re-issued later | corrected invoice; Modelo 347 declared by the community |
| C11 | Element scope | invoice line classified `private_unit` or naming a specific floor or door (3) | 3 | 0.7 | statutory (553-1 common vs private elements; 553-45, to verify) | funds | M4 | works on private elements lawfully charged to the community by resolution (windows on a common façade, accessibility adaptations); a floor named as the location of common works (stairwell landing) | acta; project drawings; statutes on element ownership |

## 5. Family B — vendor identity

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Company age and form | first invoice < 365 days after incorporation (2) or < 180 days (3); share capital ≤ €3,000 with a sole administrator and works > €20,000 (2); CNAE inconsistent with the service (2) | 2–3 | 0.6 | internal_control | vendor_compliance | M5 | new companies are common (spin-offs, retirements); €1 companies lawful since Ley 18/2022; CNAE rarely updated | Registro Mercantil note; filed accounts; REA/RASIC |
| B2 | Address linkage | vendor address = another vendor's, = the administrator's office, = the building or an office-holder's address (3; reduced to a weak signal when the address hosts many companies) | 1–3 | 0.5 | internal_control | governance | M5 | shared gestoría or coworking domiciliation addresses (dozens of companies at one Eixample address); a resident's legitimate company | count of companies at the address; Registro Mercantil note |
| B3 | Surname linkage | vendor officer shares both surnames of the office-holder in order (4) or reversed (3); one rare surname (3); one common surname (1, only with other hits); expected homonyms always printed | 1–4 | 0.4–0.9 by rarity | internal_control | governance | M5 | common surnames produce hundreds of homonyms in Barcelona; two-surname order swaps; nominee officers; family-run contractors are lawful — the reportable issue is non-disclosure and lack of competition | Idescat frequency; Registro Mercantil note confirming identity before any Tier-1 link; disclosure requested under the ≥ 1/4 request |
| B4 | IBAN reuse and change | same IBAN under ≥ 2 vendor names (4); IBAN change mid-relationship (2); natural-person IBAN for a company invoice (3) | 2–4 | 0.95 | internal_control | funds | M4 | factoring or confirming; a gestoría collecting on behalf of clients; group treasury; bank migration (absorbed bank codes); sole administrator's account under endorsement | factoring contract; endorsement; bank confirmation of holder |
| B5 | Payee-name mismatch | bank counterparty vs invoice issuer token-set similarity < 0.80 after stripping legal forms and accents (2) | 2 | 0.75 | internal_control | funds | M4 | trade name vs legal name; OCR errors on photographed statements; bank truncation at 38 characters | transfer receipt with full beneficiary name and IBAN |
| B6 | NIF validity | missing (2); invalid after re-read (3); type ≠ legal form (3); same NIF under two names (2); census check fails (3) | 2–3 | 0.8 | statutory (RD 1619/2012 art. 6) for presence; internal_control for validity | vendor_compliance | M4 | OCR error (re-read the original at high resolution first); company renamed; NIE vs DNI | AEAT census check (operator's Cl@ve); Registro Mercantil note |
| B7 | Registry compliance | construction contractor absent from REA (2); lift installer or maintainer, or electrical installer, absent from RASIC (3) | 2–3 | 0.8 | statutory (Ley 32/2006 / RD 1109/2007; Generalitat industrial-safety regime) | vendor_compliance | M5 | sole trader without employees exempt from REA; registered in another region's equivalent register; registration lapsed after the works | REA certificate; RASIC dataset row with date |
| B8 | Vendor concentration | top vendor share of works spend > 60% across unrelated trades (S1, never worklist unless computed on ordinary spend) | 1 | 0.4 | internal_control | governance | M5 | one lift project dominates any small community's spend; one trusted contractor for everything is inefficient, not irregular | – |
| B9 | Implied invoice volume | implied annual invoices < 30 for a company with > €10,000 of works (2); first number ≤ 10 within a year (1) | 1–2 | 0.5 | internal_control | vendor_compliance | M5 | one series per client; annual restart; micro-firms legitimately issue few invoices | vendor's series scheme; filed accounts (turnover) |

## 6. Family G — regulatory compliance

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| G1 | IRPF retention | invoice of a natural-person or attribution-regime professional without 15% (7%) retention (2) | 2 | 0.8 | statutory (LIRPF art. 99; RIRPF art. 76) | administrator_process | M4 | firm taxed as a company (no retention); first-year professional at 7%; retention applied at payment but not printed | Modelo 111/190; NIF letter of the firm |
| G2 | Modelo 111 / 190 / 347 | filings absent or totals ≠ invoice set (1–2; document request) | 1–2 | 0.7 | statutory (tax filing obligations) | administrator_process | M5 | vendors below €3,005.06 not declared; utilities and insurance exempt from 347; timing differences | administrator's filings; AEAT receipts |
| G3 | Three quotes if subsidised | subsidised works above the threshold in the statute or the call's bases without three quotes (3) | 3 | 0.9 | subsidy_bases (Ley 38/2003 art. 31.3; call bases) | governance | M4 (if a grant exists; header seeded in M3) | threshold contradiction across sources (€30,000 vs LCSP €40,000 works / €15,000 services) — read from the archived bases of the relevant call; quotes held in the Consorci file | Consorci file; call bases |
| G4 | ICIO and taxa | ICIO ≠ rate × PEM for the year (1); no debit to the Ajuntament while works ran (2); accessibility bonus not requested (1, missed saving) | 1–2 | 0.8 | statutory (Barcelona OF 2.1 and OF 3.3, by year) | administrator_process | M4 | ICIO paid by the contractor and re-invoiced; definitive liquidation after completion; bonus requires council approval; rate value to verify (research packs disagree) | permit file; ICIO self-assessment receipt |
| G5 | Lift compliance | no CE declaration, no registration or commissioning, maintainer not in RASIC, no OCA inspection at the RD 355/2024 periodicity; asbestos removal without a RERA-registered company (1–2) | 1–2 | 0.7 | statutory (RD 203/2016; RD 355/2024; Generalitat regime) | vendor_compliance | M5 | lift not yet commissioned (works suspended); documents held by the installer | installer's dossier; Generalitat registration number |
| G6 | Health and safety on site | no coordinator appointment, safety plan or work-centre opening although CAE/PRL services were billed (1–2) | 1–2 | 0.7 | statutory (RD 1627/1997 art. 3) | governance | M5 | a single contractor on site (no coordinator required); documents held by the CAE provider | CAE provider's file; contractor's opening notice |
| G7 | ITE | no ITE certificate for a pre-1965 building (1); contracted works absent from the ITE deficiency list (1) | 1 | 0.7 | statutory (Decret 67/2015) | governance | M5 | ITE done under a previous administrator; works decided for reasons other than ITE deficiencies (accessibility) | Generalitat certificate of aptitude; ITE report |

## 7. Family F — statistics (annex only)

| Code | Name | Test summary | S | Sp | Basis | Attribution | M | False-positive notes | Corroborating check |
|---|---|---|---|---|---|---|---|---|---|
| F1 | First-digit distribution | pooled population ≥ 200 amounts excluding fixed recurring items; MAD against Nigrini thresholds and chi-square; capped at S1 with confidence 0.3; never per vendor | 1 | 0.3 | internal_control | funds | M8, never worklist | weak power at this sample size; fixed recurring items distort | – |
| F2 | Number duplication | ten most frequent exact amounts across vendors; any amount repeated ≥ 3 times by different vendors (1) | 1 | 0.3 | internal_control | funds | M8, never worklist | standard tariffs (inspection fees, certificates) | – |
| F3 | Relative size factor | largest / second-largest invoice > 4 for vendors with ≥ 3 invoices (1) | 1 | 0.3 | internal_control | funds | M8, never worklist | one large job plus small call-outs is normal | read the outlier |
| F4 | Threshold clustering | count in [0.9T, T) vs [T, 1.1T] with ratio > 3 and n ≥ 6 (1–2) | 1–2 | 0.3 | internal_control | funds | M8, never worklist | chance at small n; quotes priced to round figures | permutation baseline |
| F5 | Price-drift regression | recurring services vs IPC (feeds D10) | 1 | 0.3 | internal_control | administrator_process | M8, never worklist | contract escalation | contract |

## 8. Scoring and tiers

**Per hit.** `hit_score = S × C`, with `C = extraction_quality × specificity × independence`.
`extraction_quality` is the lower bound of the Wilson interval of the empirical accuracy for that
engine, field type and confidence bucket (never the model's self-report). `specificity` is the prior
above. `independence` is scored by **provenance, not by issuer**: 1.0 only when a leg is issuer-direct
(a Norma 43 or bank-signed export obtained with the account holder's mandate; a registry response
fetched and archived by the system; a vendor duplicate obtained through the administrator or counsel);
0.85 for bank-issued documents that passed through the administrator; 0.7 for photographs of
printouts or a single document; 0.7 for `vendor_direct` legs when the vendor has an open B-family
finding. The liquidation is the assertion of the party under review and never counts as an
independent leg. If the account is an administrator's pooled account, the bank leg drops to
administrator provenance.

**Event-key collapse.** Every hit carries an `event_key` derived from the facts it tests
(`tx:<id>`, `doc:<id>:date_order`, `contract:<id>:missing`, …). Before any aggregation, hits sharing
an `event_key` collapse to the one with the highest severity, so a single payment before a contract
counts once even though D4, E2, A4 and E1 all fire on it.

**Entity aggregation.** Per vendor, works package, fiscal year or document:
`max + 0.5 × second + 0.25 × third + 0.125 × fourth`, computed over distinct events; multiplier
× 1.5 when the distinct events come from ≥ 2 families, × 2.0 for ≥ 3 families, capped at 8, and only
when the corroborating families rest on ≥ 2 different documents. Euro at stake (severity ≥ 3) is shown
separately and breaks ties. Hits below `trivial_floor` are stored but hidden unless ≥ 3 same-rule
hits concern one vendor. The pack prints the number of distinct underlying events, never the number
of rule hits.

**Base-rate rules** (E4, B8, C6 gap-free sequence, E3 bare quorum) are severity 1 with
`worklist_eligible = false` and may only appear as context inside a finding produced by another
rule; the annex prints "expected in most small communities" next to each. **Pattern rules** (C4, C5,
A5, A10 fingerprint overlap, B3) are Tier-3 only until a permutation null model exists
(`rule_null_models`, M8): a pattern hit becomes worklist-eligible only when the observed count
exceeds the null 95th percentile for that entity. **F-family** never enters the worklist.

**Tiers.**

| Tier | Definition |
|---|---|
| T1 — evidence-grade | one S4 hit with C ≥ 0.8, or two S3 hits from different families with distinct event keys on ≥ 2 documents and C ≥ 0.7; every cited money/date/NIF/IBAN field auto-accepted by machine two-source agreement (or blind-confirmed by a second person when one exists); at least one issuer-direct leg; human-reviewed; explanation requested |
| T2 — unexplained discrepancy | reviewed and not explained; may rest on human-confirmed single-source fields; explanation requested |
| T3 — observation | everything else, including base-rate and pattern rules; annex only |

Only T1 and T2 with `explanation_requested_on` set (or a dated refusal) enter a distributed pack; the
auditor pack also requires counsel's sign-off. Packs print facts, the tier label, sources and document
requests; `hit_score`, specificity and independence values stay in the data room with a methodology
note. Absence of a hit is stated as non-exculpatory; presence of a hit is stated as unverified. The
rule set is symmetric: every rule, including those with zero hits, is listed in the annex, and the
percentage of spend fully supported is headlined before any discrepancy.

## 9. Detection scope and limits

The following text is printed, unchanged, at the start of the auditor pack and of the junta version.

**Spanish**

> **Alcance y límites de la detección.** Este informe se basa exclusivamente en la documentación de
> la Comunidad puesta a disposición de los propietarios solicitantes y en registros públicos. A partir
> de esa documentación es posible comprobar: la correspondencia entre facturas, pagos bancarios,
> liquidaciones, contratos, certificaciones y acuerdos de junta; la continuidad de los saldos y la
> custodia de los fondos en cuentas a nombre de la Comunidad; la aplicación de derramas, subvenciones
> y préstamos; la existencia de los documentos obligatorios; y determinados datos registrales de las
> empresas contratadas y sus coincidencias con datos de los cargos de la Comunidad. **No** es posible
> comprobar, a partir de esta documentación: pagos o compensaciones realizados fuera de las cuentas
> de la Comunidad; la identidad real de las personas que controlan una sociedad cuando los cargos
> registrales son personas interpuestas; acuerdos verbales; ni la calidad o el grado de ejecución
> real de las obras, salvo por lo que resulte de las certificaciones y de fotografías fechadas. La
> ausencia de discrepancias en una prueba no acredita la regularidad de la partida correspondiente;
> la presencia de una discrepancia no acredita irregularidad alguna hasta que se verifique. Para las
> cuestiones no comprobables se indica, en cada caso, la prueba externa que sería necesaria: la
> contabilidad del proveedor, la nota informativa del Registro Mercantil, el diario de obra de la
> dirección facultativa, la confirmación de los licitadores no adjudicatarios, el certificado bancario
> de titularidad y personas autorizadas, o el expediente municipal o de subvención.

**English**

> **Scope and limits of detection.** This report relies exclusively on the Community's records made
> available to the requesting owners and on public registries. From those records it is possible to
> check: the correspondence between invoices, bank payments, liquidations, contracts, certifications
> and assembly resolutions; the continuity of balances and the custody of funds in accounts held in
> the Community's name; the application of extraordinary contributions, subsidies and loans; the
> existence of mandatory documents; and certain registry data of the contracted companies and their
> coincidences with data of the Community's office-holders. It is **not** possible to check, from
> these records: payments or set-offs made outside the Community's accounts; the real identity of the
> persons controlling a company when the registered officers are nominees; verbal agreements; or the
> quality or actual degree of execution of the works, beyond what follows from certifications and
> dated photographs. The absence of discrepancies in a test does not establish the regularity of the
> corresponding item; the presence of a discrepancy does not establish any irregularity until it is
> verified. For the matters that cannot be checked, the external evidence that would be required is
> stated in each case: the vendor's own accounts, a Registro Mercantil information note, the site
> director's diary, confirmation from the unsuccessful bidders, the bank's certificate of account
> holder and authorised persons, or the municipal or subsidy file.
