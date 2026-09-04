# Legitimate Interest Assessment (LIA)

Processing assessed: verification of the accounting records of the owners' community at Carrer de
Viladomat 25, Barcelona, by a group of requesting owners, using the tooling in this repository.

Legal basis relied on: art. 6.1.f GDPR (legitimate interests), read with the AEPD position on owners'
access to community documents — Informe jurídico 0261/2013 and FAQ-0906 [to verify against the
primary text].

Status: draft v1 · Prepared: 2026-09 · Review: before the first ingestion batch, and again when the
assembly decides on an independent review.

## 1. Who processes, and in what capacity

| Party | Capacity | Notes |
|---|---|---|
| Community of owners (through president and administrator) | Controller of the community's own records (accounts, invoices, minutes, bank statements) | Not a party to this processing until it commissions a review |
| Requesting owners (owners holding ≥ 1/4 of quotas who requested the extraordinary meeting) | **Controller** of the verification dataset built with this tooling | They act in their own capacity as owners. They do **not** act "on behalf of the community". |
| Independent reviewer (economist-perito / auditor), if commissioned by the assembly | Processor of the community under a written contract | Data room transferred only after the assembly resolves to commission the review |
| Legal counsel of the requesting owners | Recipient under professional secrecy | – |

Position stated honestly: until the assembly commissions an audit, this is processing by requesting
owners in their own legitimate interest as owners. If the assembly approves the audit, the community
becomes controller of the review, the data room is handed to the independent reviewer under a
controller–processor contract, and the owner-side copies are deleted under
`retention-and-sharing.md`. Packs must carry the same statement.

## 2. Purpose test

Interests pursued:

1. Verifying the management of jointly owned funds (ordinary quotas, extraordinary contributions,
   reserve fund, subsidies, loans) for the fiscal years 2021–2026.
2. Preparing the extraordinary meeting requested by owners holding at least one quarter of the
   quotas (CCCat art. 553-19/553-20 — numbering to verify), whose agenda includes the annual
   accounts, the works and their financing, and the disclosure of relationships between
   office-holders and contractors.
3. Establishing, exercising or defending legal claims of the owners or of the community, should the
   assembly so decide (GDPR recital 47).

Benefit to third parties: all owners share the interest in accurate accounts. The AEPD recognises that
an owner may access invoices, contracts, fees and bank information of the community in order to verify
its management, limited to data that are adequate, pertinent and not excessive [to verify].

The interest is lawful, specific and present: a formal request for the meeting has already been made.

## 3. Necessity test

| Question | Answer |
|---|---|
| Can the purpose be achieved without personal data? | No. Invoices, bank statements and minutes necessarily carry names of vendors, of the administrator, of office-holders and, incidentally, of other owners. |
| Can it be achieved with less data? | Minimised as far as reconciliation allows: no owner directory; units and roles instead of names; owner IBANs kept as HMAC + last four digits; no schema fields for owners' DNI, phone or e-mail; family members of the president as surnames only. |
| Can it be achieved without an LLM extraction service? | Manual transcription of 100–600 pages is possible but slow and error-prone. A machine reader plus an independent OCR engine and a person gives auditable accuracy with a revision trail. |
| Can page images be redacted before they reach the LLM? | Technically possible (OCR-anchored masking), at the cost of 1–2 days and of IBAN-based matching of contributions to units. Decision: **not applied in v1**; masking is applied at storage and presentation instead (§7). Revisit if any data subject objects. |
| Why are the president's identifiers processed? | Several verification tests are equality tests: is a payee the same person as an office-holder; is a vendor's registered address the office-holder's address; does a vendor's IBAN also pay a unit's quotas; is a vendor officer the same person. These tests need the president's surnames, addresses, quota-IBAN HMACs and NIF HMAC as reference values. They are held in the `restricted` schema, readable only through security-definer RPCs, used solely for equality tests, and never exported. Each identifier records its source document and a lawful-basis note. |
| Why are payer→unit keys processed? | Verifying that contributions were collected per unit and applied to their purpose (CCCat 553-45 / 553-30, to verify) requires attributing bank credits to units. The mapping is stored as HMACs in `restricted.unit_payer_keys` and `bank_transactions.unit_id` is set only through an RPC; the ledger shows unit labels only. |

## 4. Data categories

| Data subjects | Data | Source | Purpose | Storage |
|---|---|---|---|---|
| Vendors, contractors, professionals (natural persons and officers of companies) | name, NIF, address, IBAN, invoice content, public-registry facts (BORME, REA, RASIC, BDNS) | community records; public registries | reconciliation; vendor checks | `parties`, `party_ibans` (IBAN encrypted), `entity_officers` |
| Administrator (firm and principal) | name, NIF, fees, office address | community records | reconciliation of fees and process | `parties` |
| President (office-holder) | surnames, given name, addresses, NIF HMAC, quota-IBAN HMACs, units held, term of office | minutes, contribution receipts, property-registry note if obtained | equality tests only (§3) | `restricted.reference_persons`, `office_terms` |
| President's family members | surnames only, from public sources already in the corpus | BORME entries / declarations recorded in minutes | officer-surname equality test | `restricted.reference_persons` (role `president_family`): no addresses, no given names |
| Other owners | unit label, quota, amounts due and paid, arrears as stated by the administrator, payer HMACs | liquidations, receipts, bank statements | contribution ledger per unit | `units`, `derrama_ledger`, `restricted.unit_payer_keys`; names never stored as fields |
| Anyone appearing on a page | whatever the page shows | full page images | extraction | `originals` bucket (immutable, private) and page renders |

No special-category data are sought. If a page incidentally contains such data (for example health
grounds for an excuse from office), the field is not extracted and the crop is not printed.

## 5. Balancing test

| Factor | Assessment |
|---|---|
| Nature of the data | Financial and identification data of professionals acting in a business capacity; office-holder data tied to a role that accounts to the assembly by law; incidental data of other owners. Not special-category. |
| Reasonable expectations | Vendors invoicing a community expect their invoices to be checked. Office-holders account to the assembly (CCCat 553-16/553-18, to verify). Owners expect the community's accounts to be verifiable by owners. |
| Impact on data subjects | Low for vendors (verification of documents they issued). Moderate for office-holders if findings were circulated prematurely or inaccurately: mitigated by the right-of-reply step, template-locked wording, roles instead of names, and the split between assembly outputs and reviewer/counsel outputs. Moderate for other owners if arrears became visible to neighbours: mitigated by redaction of third-party rows in crops and data room, unit labels only, and no sharing outside formal channels. |
| Vulnerability | None specific. |
| Third-country processor | Page images reach the extraction API (§6). Mitigated by DPA with SCCs, 30-day deletion, no training on API data, no persistent file storage on the API side. |
| Would the data subjects object? | A counterparty under review might. Objections are handled under art. 21 (§9); verification of jointly owned funds and the preparation of legal claims are compelling grounds within art. 21.1. |
| Safeguards | §7 |

Conclusion: the interests of the requesting owners (and of all owners) are not overridden by the
interests or rights of the data subjects, provided the safeguards in §7 are applied and the outputs
remain discrepancies to verify rather than conclusions.

## 6. Processors and recipients

| Recipient | Role | Location | Terms | Data reaching it |
|---|---|---|---|---|
| Supabase (Postgres, Storage, Auth) | processor | EU region (eu-central-1 or eu-west-1), dedicated project | Supabase DPA | everything |
| Vercel (web UI hosting) | processor | functions pinned to an EU region (`fra1`, to verify) | Vercel DPA | data in transit through the UI; no persistent storage |
| Anthropic (Claude API) | processor | United States; transfer under DPA with SCCs; EU–US DPF participation [to verify against archived copy] | commercial-terms DPA; inputs and outputs deleted within 30 days by default; not used for training; Files API not used (base64 inline only); Message Batches results retrievable by the API for up to 29 days | **full page images**, including incidental names, IBAN fragments and arrears of other owners appearing on statements and receipts; extracted JSON |
| Google Drive (only if used for intake) | processor | per Google terms | Google DPA | copies of documents already held there by owners |
| Qualified timestamp authority / notary | recipient | EU | – | hash lists only (no personal data) |
| Legal counsel; independent reviewer once commissioned | recipients | Spain | professional secrecy; controller–processor contract for the reviewer | evidence bundles, data room |
| Assembly of owners, through formal channels | recipient | – | sharing policy | pre-junta pack; junta version of reports |

Archived copies of the Anthropic DPA, retention statement and DPF status page, and of the Supabase and
Vercel DPAs, are stored under `legal_sources/dpa-*.pdf` before the first batch is submitted.

## 7. Safeguards

- Minimisation as in §3–4; no owner directory; HMAC + last4 for owner IBANs; vendor and community
  IBANs encrypted at the application layer.
- `restricted` schema for reference persons and payer→unit keys, readable only via security-definer
  RPCs, never exported.
- EU hosting; private buckets; signed URLs ≤ 1 h; MFA; row-level security; append-only evidence
  tables; every view, download and edit written to `audit_log`.
- Redaction stage for crops and data-room exports: third-party owner rows blacked out
  (`anchored_redacted`); unit labels instead of names; the president's units identified by role only.
- Right of reply before circulation for every Tier-1/2 finding (`retention-and-sharing.md` §3).
- Template-locked vocabulary and the neutrality check in CI (`docs/neutrality.md`).
- Audience split: related-party material only to legal counsel or the independent reviewer, never to
  the assembly.
- Information notice to every unit within the first week of ingestion (`owner-notice.md`), logged in
  `notices_sent`.
- Retention limit and deletion procedure (`retention-and-sharing.md` §1).
- Vendor requests for duplicates routed through the administrator or counsel, never from an owner
  directly.
- Pre-LLM redaction of scans: **not applied in v1** (see §3); to be revisited on any objection or when
  the assembly commissions the review.

## 8. Retention

Delete the dataset 12 months after the final report is delivered or, if proceedings are opened, 12
months after they end — whichever is later. Procedure in `retention-and-sharing.md`.

## 9. Rights of the data subjects

Arts. 15–22 GDPR apply. In particular:

- **Right to object (art. 21).** Any data subject may object on grounds relating to their particular
  situation. Processing of that person's data stops unless the controller demonstrates compelling
  legitimate grounds (verification of jointly owned funds; establishment, exercise or defence of legal
  claims). Objections and the reasoned response are logged.
- Access, rectification and erasure are answered within one month; rectification of an extracted
  value is recorded in `field_revisions` with the request as attachment.
- Complaints: Agencia Española de Protección de Datos (aepd.es) or Autoritat Catalana de Protecció de
  Dades where competent.

Contact: [requesting owners' contact address / e-mail].

## 10. Review and sign-off

| Item | Value |
|---|---|
| Prepared by | [requesting owner, unit __] |
| Reviewed by | [legal counsel] |
| Date | ____ |
| Next review | before first ingestion; on the assembly's decision; on any objection; on any change of processor |
| Open items | archive AEPD Informe 0261/2013 and FAQ-0906; archive Anthropic DPA, retention and DPF pages; confirm CCCat article numbering (553-19/553-20; 553-45; 553-30) |
