# Shared interfaces (contract between packages and agents)

Keep these stable; change them here first.

## Storage keys (Supabase Storage, private buckets)

| Bucket | Key | Written by |
|---|---|---|
| `originals` | `<community_id>/<sha256[0:2]>/<sha256>.<ext>` | web upload, `vx ingest` (immutable; never updated or deleted) |
| `derived` | `<community_id>/<sha256>/p<page_no>_<w>x<h>.jpg` (render), `<community_id>/<sha256>/t<page_no>.jpg` (768 px thumbnail), `<community_id>/crops/<finding_id>/<n>.jpg` | worker |
| `exports` | `<community_id>/manifests/…`, `<community_id>/packs/…`, `<community_id>/legal_sources/<id>.pdf`, `<community_id>/letters/…` | CLI |

## Jobs (`public.jobs`)

`idempotency_key = <sha256 | document_id | page_id>:<step>:<pipeline_version>`; `payload` per step:

| step | payload | produces |
|---|---|---|
| `ingest` | `{ file_id }` | server re-hash → `files.server_sha256/hash_verified/status`; `page_count`; enqueues `render` |
| `render` | `{ file_id }` | `pages` rows (render + thumbnail in `derived`, `render_params`, `phash`, `has_text_layer`, `text_layer`); enqueues `ocr` for each page and `group` for the batch |
| `ocr` | `{ page_id }` | `ocr_words` rows (Tesseract `spa+cat`, TSV word boxes) |
| `group` | `{ batch_label }` | `documents` + `document_pages` (Stage A ordering + Stage B classifier + union-find); enqueues nothing (human confirms; then `extract`) |
| `extract` | `{ document_id }` | `extraction_runs` (stage `extract`) + `field_revisions` (source `model`) + `validator_results`; domain rows (invoices, meetings, …) |
| `verify` | `{ document_id }` | `extraction_runs` (stage `verify`, Sonnet third opinion) + `field_values.sonnet_*` |
| `crosscheck` | `{ document_id }` | `field_values.ocr_value_norm/ocr_agrees/status` (two-source rule) + `crop_status` |
| `match` | `{ community_id }` | `recon_links`, `works_events`, `derrama_ledger.paid/basis/status` |

Step handlers are registered from `packages/cli/src/steps/index.ts` via `registerAll(registerStep)`; a handler is
`(payload, job) => Promise<result>` and must be idempotent (re-running with the same key is a no-op).

## Extraction module (`packages/core/src/extraction`)

```ts
type PageImage = { index: number; jpeg: Buffer; width: number; height: number; sha256: string };
type DocType = 'acta' | 'liquidacion_anual' | 'extracto_bancario' | 'contrato_obra' | 'contrato_ascensor' | 'aviso_derrama' | 'factura' | ...;

classifyPages(input: { thumbs: PageImage[]; window: { prev: PageImage[]; next: PageImage[] } }, opts) => Promise<PageClassification[]>
extractDocument(input: { docType: DocType; pages: PageImage[]; language?: 'es'|'ca'|'mixed' }, opts) =>
  Promise<{ parsed: unknown | null; raw: unknown; usage: {...}; model: string; promptVersion: string; schemaVersion: string; stopReason: string; requestJson: unknown }>
buildBatchRequest(...)  // same params for the Batches API; custom_id = `d_<12-char sha>_<schema_v>`
```

Every extraction schema returns `evidence[{ field_path, page_index, bbox|null, quote, confidence }]` for
monetary/identity fields, `self_checks`, and `doc_type_confirmed`. Prompts are transcription-only.

## Field paths

Dot paths over the parsed object, e.g. `total`, `lineas[3].base`, `acuerdos[2].importes_mencionados[0].importe`.
`field_values.value_norm` uses `normaliseValue(kind, raw)` from `@viladomat/core` (amount → 2 decimals, date → ISO, nif/iban → normalised, text → NFD-stripped lowercase).

## Two-source rule

`auto_accepted` ⇔ validators pass AND `value_norm == ocr_value_norm` (OCR words fuzzy-located from the evidence quote).
Sonnet can only demote (`sonnet_agrees=false` → `needs_review`). Human confirmation → `human_confirmed` (Tier-2 at most for a single reviewer).

## Reconciliation links

`recon_links(from_type, from_id, to_type, to_id, link_type, method, score, amount_matched, status)`;
auto-accept only `exact`/`iban` with score ≥ 0.95, else `proposed`. Types: invoice→bank_transaction `paid_by`;
invoice→liquidation_line `reported_as`; invoice→resolution `authorised_by`; invoice→contract `under_contract`;
work_certification→contract `certifies`; bank_transaction→derrama `funds`; permit→works_package `declares_pem_for`;
subsidy→works_package `subsidises`; bank_transaction→invoice `refunds`; bank_transaction→bank_transaction `returns`.

## Findings

Rule hits use `RuleHit` from `packages/cli/src/rules/engine.ts`; `event_key` collapses correlated rules; wording
template-locked (roles, "verify whether"); tiers per `tierFor`. Every rule module exports `Record<code, Rule>`.
