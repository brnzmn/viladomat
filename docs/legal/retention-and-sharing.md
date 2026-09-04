# Retention, sharing and right of reply

## 1. Retention

### 1.1 Rule

The verification dataset is deleted **12 months after the final report is delivered** or, where
proceedings (assembly-commissioned review, mediation, court or administrative proceedings) are opened
on the basis of the report, **12 months after those proceedings end** — whichever is later. A legal
hold recorded in writing by counsel suspends deletion for the items it names.

### 1.2 What is deleted

| Asset | Where | Action |
|---|---|---|
| Originals bucket, derived renders, crops, exports | Supabase Storage | delete all objects; confirm with an empty listing |
| Database (schemas `vx` and `restricted`) | Supabase Postgres | drop schemas; then delete the project so that the provider's point-in-time backups expire |
| Weekly encrypted export and hash list; nightly `pg_dump` | second EU bucket; laptop | delete; confirm |
| Laptop working directories (`vx` cache, renders, batch downloads) | operator laptop | delete; empty trash; the disk stays encrypted |
| Copies placed in Google Drive for intake | Drive | delete and empty the bin (copies owners already held are outside this policy) |
| Anthropic API data | provider | deleted by the provider within 30 days of each request; no action; the Files API is not used |
| Report PDFs held by recipients | recipients | recipients are asked in writing to delete; counsel keeps its file under its own professional rules |

### 1.3 What is kept

Only material without personal data: the custody manifests (file names, hashes, sizes, dates), the
timestamp tokens, the rule catalogue and parameter versions, and the signed deletion record. Hashes
allow a later challenge of integrity without holding the documents again.

### 1.4 Procedure

1. Counsel confirms in writing that no proceedings are pending and no legal hold applies.
2. The operator runs the steps in §1.2 in order, keeping a checklist with timestamps.
3. A second requesting owner verifies the empty bucket listings and the absence of the database.
4. The deletion record is signed by both, filed with the manifests, and recipients are notified.

Early deletion: if the assembly commissions an independent review, the data room is handed over under
a controller–processor contract and the owner-side copies are deleted within 30 days of the handover,
keeping only the manifests.

## 2. Sharing policy

### 2.1 Audiences

| Audience | Receives | Channel |
|---|---|---|
| Requesting owners | everything (review UI with MFA; packs) | UI accounts; encrypted transfer |
| Assembly of owners | pre-junta pack; junta version of the report (facts, tier labels, document requests; no scores, no related-party detail, no third-party rows) | with the convocation documentation, at the meeting, or through the president/administrator as the community's formal channel |
| Legal counsel | everything, including the lawyer annex and related-party material | encrypted transfer; professional secrecy |
| Independent reviewer (once commissioned) | auditor pack, data room, evidence bundles | controller–processor contract; time-boxed read-only access if online |
| Counterparties (administrator; president where concerned) | the "Solicitud de aclaraciones" letter with their specific items and evidence references | letter with proof of delivery (burofax, e-mail with acknowledgment) |

### 2.2 Never

- Notice boards, lift cabins, entrance halls.
- WhatsApp, Telegram or Signal groups; mailing lists to all owners; social media; Notion pages;
  shared drives open to all owners.
- Vendors, contractors or their staff (requests for duplicate documents go through the administrator
  or counsel).
- Anyone outside the audiences above, including family members of owners.

### 2.3 Rules for every export

- Confidentiality banner on every page: "Documento de trabajo confidencial — discrepancias a
  verificar — no publicar ni reenviar".
- Every distributed pack has a `report_exports` row with hash, recipients and date;
  `vx report --reproduce` must diff empty first; counsel's sign-off is recorded before the auditor
  pack leaves the requesting owners.
- No pack prints internal scores, specificity or independence values; tier labels only.
- Third-party owner rows are redacted in crops and in the data room; units are labelled by unit,
  never by owner name; office-holders are referred to by role.

## 3. Right of reply

### 3.1 Rule

Every Tier-1 and Tier-2 finding passes through the workflow state `sent_for_explanation` **before** it
can be included in any distributed pack. The counterparty — the administrator, and the president where
the finding concerns an act of the presidency — receives the specific items, the evidence references
and the list of documents that would resolve each item, and has **at least 10 calendar days** to
answer.

### 3.2 Procedure

1. The reviewer moves the finding from `in_review` to `sent_for_explanation` and generates the letter
   from the template in §4 with the finding references, amounts, dates, page and hash references and
   document requests. The letter carries no scores, no tier labels and no rule names.
2. The letter is sent by a channel with proof of delivery; the letter file (PDF, `.eml`, burofax
   receipt) is ingested, hashed and attached to `finding_reviews` with `explanation_requested_on`.
3. Window: at least 10 calendar days from delivery. Extensions granted on request are logged.
4. Reply received: ingested and hashed; the finding moves to `explained` (with reason),
   `confirmed_discrepancy` or `needs_document`; the reply is printed **verbatim** next to the finding
   in every pack ("Respuesta recibida el <fecha> de <rol>: …").
5. No reply: the finding may proceed after the window with the line "aclaraciones solicitadas el
   <fecha>; sin respuesta a <fecha>".
6. Refusal to answer: recorded with date; treated as no reply.
7. A finding resolved by the reply is closed as `explained` and listed in the annex as resolved, with
   the resolving document reference.

### 3.3 Gate

A pack may include a finding only if `status ∈ {explained, confirmed_discrepancy, needs_document}`
and `explanation_requested_on` is set (or a refusal is dated). The auditor pack additionally requires
counsel's sign-off recorded in `report_exports`.

## 4. Template letter — "Solicitud de aclaraciones"

### 4.1 Spanish (the version sent)

> **Asunto:** Solicitud de aclaraciones sobre determinados apuntes de las cuentas de la Comunidad
> (ejercicios 2021–2026)
>
> A la atención de [la administración de la finca / la presidencia]
> Comunidad de Propietarios de la calle Viladomat 25, Barcelona
>
> [Lugar], [fecha]
>
> Los propietarios abajo indicados, que representan al menos una cuarta parte de las cuotas de
> participación y que solicitaron la convocatoria de junta extraordinaria el [fecha de la solicitud],
> están revisando la documentación de la Comunidad para preparar dicha junta.
>
> En el curso de esa revisión se han identificado los puntos que se relacionan a continuación,
> respecto de los cuales no hemos localizado en la documentación disponible el soporte o la
> conciliación correspondiente. Se trata de discrepancias a verificar: no prejuzgamos su explicación
> y agradeceremos cualquier aclaración o documento que permita cerrarlas.
>
> | Ref. | Descripción del punto | Importe | Fecha | Documentos de referencia (huella / página) | Documento que se solicita |
> |---|---|---|---|---|---|
> | [F-001] | [p. ej. Transferencia de ___ € el __/__/____ a favor de ___ no conciliada con ninguna factura localizada] | ___ | ___ | [D-________ p. _] | [factura y justificante de pago] |
> | [F-002] | [p. ej. Certificación de obra n.º _ por ___ € sin firma de la dirección facultativa] | ___ | ___ | [D-________ p. _] | [certificación firmada] |
>
> Les rogamos que, en el plazo de diez días naturales desde la recepción de esta carta (hasta el
> [fecha]), nos remitan las aclaraciones y los documentos indicados a [dirección de contacto].
> Cualquier respuesta escrita se reproducirá íntegramente junto a cada punto en la documentación que
> se ponga a disposición de la junta o del revisor independiente.
>
> Transcurrido el plazo sin respuesta, los puntos se harán constar como "aclaraciones solicitadas el
> [fecha]; sin respuesta a [fecha]".
>
> Documentos solicitados con carácter general (art. 553-21 CCCat, documentación disponible desde la
> convocatoria):
>
> 1. Cuentas anuales y presupuestos de los ejercicios 2021 a 2026.
> 2. Estado de aplicación de las derramas por entidad y período.
> 3. Facturas, justificantes de pago y extractos bancarios (preferiblemente en formato Norma 43 o
>    CSV) de todas las cuentas de la Comunidad, 2021–2026, y certificado bancario de titularidad y
>    personas autorizadas.
> 4. Contratos de obra y de ascensor, certificaciones de obra y certificado final de obra.
> 5. Expedientes de licencia o comunicado de obras y autoliquidaciones del ICIO; expedientes de
>    subvención, si los hubiera.
> 6. Declaración sobre cualquier relación entre cargos de la Comunidad y las empresas contratadas.
>
> Atentamente,
>
> [Propietarios solicitantes — entidades]

### 4.2 English translation (for reference only)

> **Subject:** Request for clarifications on certain entries in the Community's accounts (fiscal years
> 2021–2026)
>
> For the attention of [the property administrator / the presidency]
> Owners' Community of Carrer de Viladomat 25, Barcelona
>
> [Place], [date]
>
> The owners listed below, who hold at least one quarter of the participation quotas and who requested
> the convening of an extraordinary meeting on [date of the request], are reviewing the Community's
> records in order to prepare that meeting.
>
> In the course of that review the items listed below were identified, for which we have not located
> in the available records the corresponding supporting document or reconciliation. These are
> discrepancies to verify: we do not prejudge their explanation and would be grateful for any
> clarification or document that allows them to be closed.
>
> | Ref. | Description of the item | Amount | Date | Reference documents (hash / page) | Document requested |
> |---|---|---|---|---|---|
> | [F-001] | [e.g. Transfer of ___ € on __/__/____ to ___ not reconciled with any invoice located] | ___ | ___ | [D-________ p. _] | [invoice and proof of payment] |
> | [F-002] | [e.g. Work certification no. _ for ___ € without the site director's signature] | ___ | ___ | [D-________ p. _] | [signed certification] |
>
> We ask that, within ten calendar days of receipt of this letter (by [date]), you send the
> clarifications and documents indicated to [contact address]. Any written reply will be reproduced
> in full next to each item in the material made available to the assembly or to the independent
> reviewer.
>
> If the period elapses without a reply, the items will be recorded as "clarifications requested on
> [date]; no reply as of [date]".
>
> Documents requested generally (CCCat art. 553-21, documentation available from the convocation):
>
> 1. Annual accounts and budgets for fiscal years 2021 to 2026.
> 2. Statement of application of the extraordinary contributions by unit and period.
> 3. Invoices, proofs of payment and bank statements (preferably in Norma 43 or CSV format) of all
>    the Community's accounts, 2021–2026, and the bank's certificate of account holder and authorised
>    persons.
> 4. Works and lift contracts, work certifications and the final works certificate.
> 5. Building-permit files and ICIO self-assessments; subsidy files, if any.
> 6. Declaration of any relationship between the Community's office-holders and the contracted
>    companies.
>
> Yours faithfully,
>
> [Requesting owners — units]
