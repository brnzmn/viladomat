# Record of processing activities (art. 30 GDPR)

One activity. Kept with the LIA and the DPIA; updated on any change of processor, purpose or recipient.

| Field | Entry |
|---|---|
| Controller | The requesting owners of the community at Carrer de Viladomat 25, Barcelona (owners holding ≥ 1/4 of quotas who requested the extraordinary meeting), acting as owners. Contact: [address / e-mail]. No representative; no DPO (not required). |
| Name of the activity | Verification of community accounting records 2021–2026: document intake, extraction, reconciliation, reporting |
| Purposes | (1) verify the management of jointly owned funds; (2) prepare the extraordinary meeting; (3) establish, exercise or defend legal claims |
| Legal basis | Art. 6.1.f GDPR, legitimate interest (see `lia.md`); AEPD Informe 0261/2013 and FAQ-0906 [to verify] |
| Categories of data subjects | vendors and their officers; administrator; office-holders (president); family members of the president (surnames only); other owners (incidental); professionals (architect, counsel) |
| Categories of personal data | identification (name, NIF, address); financial (invoices, IBANs, payments, quotas, arrears); public-registry data (BORME, REA, RASIC, BDNS, Cadastre); role and term data of office-holders; page images of community records. No special categories. |
| Sources | community records supplied by the administrator or by owners; public registries; owners' own copies |
| Recipients | requesting owners; assembly of owners via formal channels; legal counsel; independent reviewer once commissioned; counterparties (their own items only, through the right-of-reply letter) |
| Processors | Supabase (database, storage, auth; EU region); Vercel (web hosting; EU region); Anthropic (document-extraction API; USA; SCCs; 30-day deletion; no training); Google (Drive) only if used for intake; qualified timestamp provider (hashes only) |
| International transfers | Anthropic (USA): SCCs in the DPA; EU–US DPF participation [to verify]; safeguards: no persistent file storage on the API side, 30-day deletion, no training |
| Retention | 12 months after the final report or the end of proceedings, whichever is later; deletion procedure in `retention-and-sharing.md` |
| Technical and organisational measures | EU hosting; private buckets; MFA; row-level security; restricted schema behind RPCs; HMAC + last4 for owner IBANs; encrypted vendor IBANs; append-only evidence tables; audit log; redaction of third-party rows in exports; encrypted backups; right of reply; sharing policy; neutrality policy |
| Risk assessment | DPIA (`dpia.md`); residual risk low |
| Created / last updated | 2026-09 / ____ |
