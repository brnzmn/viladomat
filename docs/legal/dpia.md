# Data Protection Impact Assessment (short form)

Processing assessed: the verification dataset described in `lia.md`. This DPIA is prepared although
the processing is small in scale, because several criteria of the WP29/AEPD lists for art. 35 GDPR are
at least arguably met: use of a new technology (LLM vision extraction of financial documents sent to a
processor outside the EU), evaluation of identifiable natural persons (office-holder and vendor-officer
equality tests), financial data of all owners, and systematic cross-matching with public registries.
[AEPD list of processing operations requiring a DPIA: to verify against the primary text.]

Status: draft v1 · Owner: requesting owners · Date: 2026-09

## 1. Description of the processing

| Aspect | Description |
|---|---|
| Nature | Ingestion of photographs, scans and PDFs of community records; page rendering and OCR; extraction of structured records by an LLM; deterministic reconciliation between invoices, bank movements, liquidations, contracts, certifications and resolutions; vendor checks against public registries; production of verification reports. |
| Scope | One community (about 15 units), fiscal years 2021–2026, 100–600 pages; 10–20 vendors, the administrator, office-holders, other owners as incidental data. |
| Context | Owners holding ≥ 1/4 of quotas have requested an extraordinary meeting with the accounts and the works documentation on the agenda; the requesting owners prepare that meeting and, if the assembly so decides, an independent review. |
| Purposes | See `lia.md` §2. |
| Assets | Supabase EU project (Postgres, private Storage buckets), Vercel UI in an EU region, operator laptop running the `vx` worker, Anthropic API, optional Google Drive intake. |
| Data flows | Source device → laptop (hash, EXIF) → Storage (immutable originals) → renders and OCR on the laptop → page images to the Anthropic API (base64 inline; batch) → JSON back → Postgres → reports → recipients per the sharing policy. |

## 2. Necessity and proportionality

- Lawful basis: art. 6.1.f (LIA §2–5). Purpose limitation: verification and preparation of the
  assembly; no other use. Storage limitation: `retention-and-sharing.md`.
- Data minimisation: units and roles, not names; HMAC + last4 for owner IBANs; no owner DNI/phone/
  e-mail fields; family members of the president as surnames only; restricted schema for reference
  identifiers and payer→unit keys.
- Accuracy: two independent readers or a person for every money/date/NIF/IBAN field; validators;
  revision log; right of reply so that the counterparty can correct facts before circulation.
- Transparency: art. 13/14 notice to every unit within the first week of ingestion.
- Processors: DPAs with Supabase, Vercel and Anthropic (SCCs; 30-day deletion; no training); archived
  copies required before the first batch.
- Data-subject rights: LIA §9.

## 3. Risks

Likelihood: L low, M medium, H high. Severity: 1 minimal, 2 limited, 3 significant, 4 maximum.

| # | Risk | Source | Likelihood | Severity | Measures | Residual |
|---|---|---|---|---|---|---|
| R1 | Mis-identification via homonyms: a vendor officer or payee is wrongly treated as the same person as an office-holder | surname-based matching; frequent Catalan/Spanish surnames; nominee officers | M | 3 | equality tests on NIF/IBAN HMACs where available; surname matches weighted by Idescat rarity and printed with the expected number of homonyms; a Registro Mercantil note required before any Tier-1 link; wording "possible link to verify"; related-party material never sent to the assembly; right of reply | L / 2 |
| R2 | Exposure of neighbours' arrears or payment behaviour to other owners | liquidation unit rows, receipts and statements appear in crops, data room or packs | M | 3 | `anchored_redacted` crops (all OCR boxes outside the target field blacked out); data-room exports carry unit labels and masked counterparties only; full-page renders visible only to the reviewer role and logged; packs shared only through formal channels; never notice boards or messaging groups | L / 2 |
| R3 | Transfer to a third-country processor of full page images including incidental third-party data | design decision not to redact scans before extraction (LIA §3) | H (it will happen) | 2 | DPA with SCCs; EU–US DPF participation [to verify]; 30-day deletion; no training; base64 inline only (no Files API); only the pages needed for extraction; option to enable OCR-anchored redaction if an objection is upheld | L / 2 |
| R4 | Purpose creep: the dataset is used for other disputes, for profiling, or shared beyond the stated audience | availability of a searchable corpus | M | 3 | purpose stated in LIA and notice; sharing policy with audience split; audit log of every access; retention with deletion procedure; data room transferred to the independent reviewer only under contract; no copies in Notion, messaging apps or shared drives | L / 2 |
| R5 | Inaccurate extraction leads to an incorrect statement about a person | OCR/LLM errors on photographed pages | M | 3 | two-source rule; human review ordered by money at stake; four-eyes confirmation for Tier-1 fields when a second reviewer exists; `--reproduce` gate; template wording "to verify"; right of reply | L / 2 |
| R6 | Unauthorised access or breach | credentials, laptop loss | L | 3 | MFA, RLS, private buckets, signed URLs ≤ 1 h, encrypted laptop disk, encrypted weekly export to a second EU bucket, no public endpoints | L / 2 |
| R7 | Reputational harm to a counterparty from premature circulation | owners sharing drafts | M | 4 | `sent_for_explanation` state and ≥ 10-day window before any pack inclusion; confidentiality banner; junta version without scores, severities or related-party material; legal review before circulation | L / 3 |
| R8 | Pressure on a data subject through direct contact by individual owners | owner contacting vendors directly | L | 2 | vendor requests routed through the administrator or legal counsel only | L / 1 |

## 4. Measures adopted (summary)

Technical: EU hosting; immutable hashed originals; restricted schema behind RPCs; HMAC and encryption
of IBANs; redaction stage; audit log; MFA; append-only evidence tables; weekly encrypted export.

Organisational: LIA; owner notice; retention and deletion procedure; sharing policy and audience split;
right-of-reply procedure; neutrality policy with CI check; legal review gate before circulation;
processor DPAs archived.

## 5. Residual risk and conclusion

Residual risks are low for all items except R7 (severity remains limited-to-significant if the
right-of-reply and sharing rules were broken). No residual high risk remains; prior consultation of
the supervisory authority under art. 36 is not required. The assessment is revisited if the assembly
commissions a review, if a data subject objects, if a processor is added, or if pre-LLM redaction is
enabled.

## 6. Consultation

Data subjects are informed by the owner notice; no DPO is appointed (not required). Legal counsel is
consulted before the first circulation of findings.

## 7. Sign-off

| Role | Identification (role only in the repository) | Date | Signature |
|---|---|---|---|
| Controller (requesting owners) | [unit __] | ____ | ____ |
| Legal counsel | [firm] | ____ | ____ |
| Reviewer of this DPIA | [unit __ / counsel] | ____ | ____ |
