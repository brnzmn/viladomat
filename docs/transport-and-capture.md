# Transport and capture protocol

How documents reach the evidence store, and how they are photographed when only inspection at the
administrator's office is offered. Every rule below serves one goal: the first hash must be computed
on bytes as close as possible to what the source produced, and the record must state honestly what
happened before that hash.

## 1. Sending documents (co-owners and other suppliers)

### 1.1 Originals only

| Do | Do not |
|---|---|
| Send the **original file**: the HEIC/JPEG straight from the camera roll, the PDF as downloaded from the bank or received from the administrator, the `.eml` of an e-mail | Forward through WhatsApp, iMessage, Telegram, Signal "as photo" or an inline mail preview: these re-encode the image and strip EXIF (capture time, device, orientation) |
| iPhone: Files app → share → **AirDrop** (keeps the original); or Photos → select → share → AirDrop with "All Photos Data" enabled; or Google Drive → "Upload file" | Screenshot a document |
| Android: Google Drive app → "Upload" from Files, or a USB cable | "Save as" from a viewer app that re-exports |
| Scanner apps: export the **PDF plus the underlying JPEGs** when the app offers them | Apply filters, crops or "enhance" before sending |
| E-mails: forward **as attachment** (`.eml`) so the headers survive | Paste e-mail bodies |

If a file can only be obtained through a lossy channel (a co-owner holds only a WhatsApp copy), send
it anyway and say so. It is recorded with `transport_note = "WhatsApp – EXIF stripped"`, the sender's
role as `origin_class`, and a legibility caveat; its capture time is never cited.

### 1.2 What accompanies each batch

Every delivery is one **batch** with:

- a **batch label** (e.g. `entrega-2026-09-12-unitX`);
- the **supplied-by role**: administrator, president, requesting owner, other owner, vendor via
  administrator, bank;
- the **supplied-on date**: the date the sender handed the documents over, not the date printed on the
  paper;
- the **transport method**: `airdrop`, `drive`, `usb`, `email-attachment`, `whatsapp`, `onsite`;
- optionally a short note ("binder 2021 invoices, pages 1–40; two pages illegible").

The operator ingests with:

```
vx ingest <dir> --source admin_delivery --supplied-by administrator --supplied-on 2026-09-12 \
  --batch entrega-2026-09-12 --transport airdrop
vx manifest --batch entrega-2026-09-12
```

`--supplied-on` auto-fills `document_requests.received_on` for the matching request class. The
manifest CSV and its own SHA-256 are stored in `custody_manifests` with a slot for a qualified
timestamp token or a notarial deposit reference.

### 1.3 Index sheet

At the start of every photo session, photograph a hand-written **index sheet**: batch label, date,
place, binder title, page-counter start. Photograph it again whenever the binder changes. Grouping of
pages into documents uses EXIF time first and falls back to index sheet + filename sequence, so the
index sheet is what saves a batch whose EXIF was lost.

### 1.4 Optional: hash on the source device

An iOS Shortcut can compute SHA-256 of selected files and write a `hashes.txt` sidecar; send it with
the batch. When present, ingest compares it with `client_sha256` and records
`hash_matched_source_device = true`. This is the only case in which the custody statement may say
that the hash was computed before transport.

## 2. On-site capture at the administrator's office

The documentation for a meeting must be available at the professional administrator's office from the
convocation (CCCat art. 553-21, to verify against the archived text); copies may be refused. The
protocol assumes one person, one phone, about two hours per visit.

### 2.1 Before the visit

- Bring: phone with ≥ 20 GB free and fully charged, **native camera app** (no scanner app), a small
  stand or a second person to hold pages flat, the printed document-request list, blank index sheets,
  a pen.
- Camera settings: HEIC originals, highest resolution, flash off, grid on, Live Photos off. Disable
  "Optimise storage" for the session so originals stay on the device.
- Prepare one batch label per binder, e.g. `onsite-2026-09-15-b01-bank-2023`.

### 2.2 Shoot order (highest evidentiary value first)

1. **Bank statements** — every page of every account and every month; include the account header and
   the page counter on each frame; note missing months on the index sheet.
2. **Liquidaciones** — annual accounts, per-unit statements, reserve-fund statements.
3. **Actas and convocations** — attendance lists and signatures included.
4. **Contracts and work certifications** — works, lift, maintenance, loan; every signed page and annex;
   payment schedules.
5. **Works invoices** (≥ €1,000 first, then the rest), quotes, permits, ICIO receipts, subsidy files.
6. Everything else (recurring invoices, insurance, correspondence).

If time runs out, the batch still covers the classes that unlock the strongest reconciliations.

### 2.3 How to shoot

- Index sheet first; re-shoot it on every binder change.
- One page per frame, page flat, whole page in frame with margins, phone parallel to the page, no
  fingers over amounts, no flash.
- Double-sided pages: front then back, in order. Do not skip blank backs that carry stamps or notes.
- Long tables: one overview frame plus one close-up per half, in order.
- Do not delete "bad" frames on site; duplicates are handled by hashing and pHash.
- Every 30–40 frames, zoom in on one amount to confirm sharpness.

### 2.4 Immediately after

Transfer the originals **the same day** (AirDrop to the laptop with "All Photos Data"), then:

```
vx ingest <dir> --source admin_delivery --supplied-by administrator --supplied-on 2026-09-15 \
  --batch onsite-2026-09-15-b01-bank-2023 --transport onsite
vx manifest --batch onsite-2026-09-15-b01-bank-2023
```

Record the visit itself in the batch note: place, start and end time, and who showed the documents,
by role.

### 2.5 Inspected but not copied

When a document is shown but photographing is refused, or time runs out:

- write class, year, description and page count on the index sheet, mark it "inspected — no copy",
  and photograph the index sheet;
- in the Requests screen set `document_requests.status = inspected_only` with the visit date, the
  class, the fiscal year, and the index-sheet file as evidence;
- the document matrix then shows the cell as `inspected` (distinct from `copy_held`, `refused` and
  `not_provided`), each with its date;
- a refusal to allow copies is recorded with date and channel and becomes an E5 finding citing the
  custody duty (CCCat 553-17/553-28, numbering to verify); the wording is "shown on <date>; copy not
  provided as of <date>".

Never transcribe amounts from memory after an inspection. Only the index sheet and the status are
recorded.

## 3. Custody statement per batch

The manifest carries the following statement, generated from the batch metadata. It states what the
hash proves and nothing more.

**English**

> Batch `<label>`: `<n>` files, first hashed (SHA-256) on `<device>` at `<ISO time>` after transport
> by `<method>`; supplied by `<role>` on `<date>`; `<k>` files carry a source-device hash that
> matched. The hashes establish the content of each file as it existed on that device at that time.
> They do not establish the origin, capture time or authenticity of the underlying document, nor that
> the copy was unaltered before it reached that device. EXIF timestamps are used for ordering only and
> are not cited as evidence.

**Spanish**

> Lote `<etiqueta>`: `<n>` archivos cuya huella (SHA-256) se calculó por primera vez en
> `<dispositivo>` el `<fecha y hora ISO>` tras su transporte por `<método>`; aportados por `<rol>` el
> `<fecha>`; `<k>` archivos incluyen una huella calculada en el dispositivo de origen que coincide.
> Las huellas acreditan el contenido de cada archivo tal como existía en ese dispositivo en ese
> momento. No acreditan el origen, la fecha de captura ni la autenticidad del documento subyacente, ni
> que la copia no fuera alterada antes de llegar a ese dispositivo. Las marcas de tiempo EXIF se
> utilizan solo para ordenar y no se citan como prueba.

When the manifest hash receives a qualified timestamp (RFC 3161) or a notarial deposit reference, the
statement adds: "Manifest hash `<sha256>` timestamped by `<provider>` at `<time>` (token `<path>`);
the timestamp proves existence at that time, not authenticity of the photographed source."

## 4. Quick card for co-owners (Spanish)

> **Cómo enviarnos documentos.** Envíe siempre el archivo original: la foto tal como la hizo el móvil
> (HEIC/JPEG) o el PDF tal como lo descargó. Use AirDrop, Google Drive ("Subir archivo") o un cable.
> **No** use WhatsApp ni capturas de pantalla: borran la fecha y los datos de la foto. Al empezar cada
> carpeta, fotografíe una hoja con la fecha, su piso y el nombre de la carpeta. Indíquenos quién le
> entregó los documentos y cuándo. Si solo le dejan verlos y no copiarlos, anote qué vio y avísenos:
> también cuenta.
