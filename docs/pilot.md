# M0.5 API pilot gate

Purpose: before `prompt_version` and `schema_version` are frozen, measure on 20 real-shaped pages
whether the extraction path meets the thresholds that the two-source rule and the review budget depend
on. Results are recorded here and stay blank until the pilot runs. A failed gate triggers the fallback
path in §4, then a re-run; the chosen path is printed in the methodology section of every pack.

## 1. Pilot corpus (20 pages)

| # | Page set | Count | Notes |
|---|---|---|---|
| 1 | 2023 acta PDF (native text) from Drive | 4 | Catalan/Spanish; attendance table with quotas |
| 2 | Synthetic invoices rendered from templates, printed and photographed | 6 | ES and CA; 10% and 21% VAT; one simplified; one with IRPF retention |
| 3 | Photographed bank-statement pages (synthetic, or real with third-party rows masked) | 4 | continuity check; 38-character concept lines |
| 4 | Handwritten receipt / note | 2 | exercises the `--hires` 2576 px path |
| 5 | Quote with partidas (m2, ml, ud, pa) | 2 | quantity-pattern extraction |
| 6 | Skewed phone photo of a printed liquidation | 2 | worst-case geometry |

Labelling: every money/date/NIF/IBAN field is hand-labelled by one person before the run (ground
truth) and stored in `golden_set` as its first 20 documents.

## 2. Gates

| G | Metric | Method | Threshold | Result | Pass/Fail |
|---|---|---|---|---|---|
| G1 | Image tokens per page at 1568 px long edge | `client.messages.countTokens` per render; `usage.input_tokens` on the run | measured and recorded (expected ≈ 2,240 per A4 page; ≤ 2,600) | ____ | ____ |
| G2 | Prompt caching works | `usage.cache_read_input_tokens` on the second and later requests sharing the system prompt | > 0 on ≥ 90% of requests after the first | ____ | ____ |
| G3 | Batch with structured outputs + images | 2-item `messages.batches.create` with `output_config.format` and base64 image blocks | both results `succeeded` with `parsed_output !== null` | ____ | ____ |
| G4 | bbox-contains-quote rate | for every field with a bbox, the OCR words inside the bbox contain the verbatim `quote` (`anchored`) | ≥ 70% of money/date/NIF fields | ____ | ____ |
| G5 | Opus ↔ Tesseract exact agreement on printed amounts | normalised-value equality on labelled printed amount fields | ≥ 80% | ____ | ____ |
| G6 | Page legibility (Sonnet page pass) | mean `legibility` over printed pages | ≥ 0.6 | ____ | ____ |
| G7 | Field accuracy vs ground truth (informational) | exact match on labelled fields with a Wilson 95% interval | recorded; no threshold in M0.5 | ____ | ____ |
| G8 | Refusals / parse failures | count of `stop_reason: refusal`, `parsed_output === null`, `stop_reason: max_tokens` | recorded; every refusal noted with its page | ____ | ____ |
| G9 | Cost per page (batch) | `cost_usd` from usage × price table | recorded (expected 2–6 cents) | ____ | ____ |
| G10 | Handwriting path | G4 and G5 recomputed on the two handwritten pages at 2576 px | recorded; no threshold (handwritten fields are human-confirmed by design) | ____ | ____ |

Pass = G2, G3, G4, G5 and G6 all pass. G1 and G7–G10 are recorded for the methodology section.

## 3. Run record

| Item | Value |
|---|---|
| Date | ____ |
| Models | extraction `claude-opus-5`; page pass and third opinion `claude-sonnet-5` |
| `prompt_version` under test | ____ |
| `schema_version` under test | ____ |
| Effort | `medium` |
| Render parameters | 1568 px / 2576 px long edge, JPEG q88, orientation baked |
| OCR engine | Tesseract 5, tessdata_best `spa+cat`, TSV word boxes |
| Pilot batch id | ____ |
| Total cost (USD) | ____ |
| Operator | [role] |

## 4. Fallback path if a gate fails

| Failed gate | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| G4 or G5 (geometry / OCR agreement) | Enable perspective warp before OCR (`jscanify` 4-point warp + `sharp.normalise()`), applied only when the detected quad covers ≥ 40% of the frame with near-right angles; re-run the pilot | Add a **second non-LLM OCR engine hosted in an EU region** as an alternative independent reader (candidate: Azure Document Intelligence Read / prebuilt-invoice, EU region, F0 tier ≈ $6 per 600 pages). A field is accepted when Opus agrees exactly with either engine. Add the engine to the LIA processor list and the processing record before use | If still below threshold: **Tier-2 only** on human-confirmed single-source fields (Tier-1 requires machine two-source agreement or a second person); raise the review budget and record the decision |
| G6 (legibility) | Re-shoot the pages under the capture protocol; use `--hires` renders | Warp as above | Mark pages `ilegible`; request originals |
| G2 (cache) | Confirm the system prompt is byte-stable and carries `cache_control` on its last block; nothing per-request precedes it | Confirm `output_config.format` is identical across requests (a changed schema invalidates the cache) | – |
| G3 (batch) | Inspect `result.error.type`; `invalid_request` → fix payload | Fall back to synchronous `messages.parse` for the corpus (cost ×2) | – |
| G1 (tokens) | Reduce long edge to 1400 px if > 2,600 tokens and G4/G5 still pass | – | – |

After any fallback: re-run the pilot, fill a new run record, and only then freeze versions.

## 5. Freeze

| Item | Value |
|---|---|
| `prompt_version` frozen | ____ |
| `schema_version` frozen | ____ |
| Chosen path (baseline / warp / second OCR / T2-only) | ____ |
| Golden set started (20 documents labelled) | ____ |
| Signed off by | [role], ____ |
