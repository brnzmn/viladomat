'use client';

import exifr from 'exifr';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import * as tus from 'tus-js-client';
import type { Json } from '@/lib/database.types';
import { bytes as fmtBytes } from '@/lib/format';
import { getBrowserClient } from '@/lib/supabase/client';

const SUPPLIED_BY_ROLES = ['administrator', 'president', 'requesting_owner', 'other_owner', 'bank', 'public_body'] as const;
const TRANSPORT_NOTES = [
  { value: 'airdrop', label: 'AirDrop (original)' },
  { value: 'files_app', label: 'Files app (original)' },
  { value: 'drive_original', label: 'Drive upload (original)' },
  { value: 'usb', label: 'USB cable' },
  { value: 'onsite', label: 'On-site capture (this device)' },
  { value: 'whatsapp_stripped', label: 'WhatsApp / messenger copy (metadata stripped)' },
  { value: 'email', label: 'E-mail attachment' },
] as const;

const ACCEPT = 'image/*,.heic,.heif,application/pdf,.pdf,message/rfc822,.eml,text/plain,.txt,text/csv,.csv';
const CHUNK_SIZE = 6 * 1024 * 1024;

type Status = 'pending' | 'hashing' | 'checking' | 'uploading' | 'registering' | 'done' | 'skipped' | 'error';

type Item = {
  key: string;
  file: File;
  status: Status;
  progress: number;
  sha256?: string;
  message?: string;
  exif?: ExifSummary;
  fileId?: string;
};

type ExifSummary = {
  DateTimeOriginal: string | null;
  Make: string | null;
  Model: string | null;
  Software: string | null;
  Orientation: number | null;
};

type Batch = {
  batchLabel: string;
  suppliedByRole: string;
  suppliedOn: string;
  transportNote: string;
};

/** Bucket-allowed content type derived from the extension, falling back to octet-stream. */
function contentTypeFor(file: File): string {
  const ext = extensionOf(file.name);
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    heic: 'image/heic',
    heif: 'image/heif',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    pdf: 'application/pdf',
    eml: 'message/rfc822',
    txt: 'text/plain',
    csv: 'text/csv',
  };
  return byExt[ext] ?? (file.type || 'application/octet-stream');
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i === -1 || i === name.length - 1) return 'bin';
  return name.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}

async function readExif(file: File): Promise<ExifSummary | undefined> {
  if (!/^image\//.test(contentTypeFor(file))) return undefined;
  try {
    const raw: Record<string, unknown> | null | undefined = await exifr.parse(file, { tiff: true, exif: true, gps: false });
    if (!raw) return undefined;
    return {
      DateTimeOriginal: toIso(raw.DateTimeOriginal),
      Make: typeof raw.Make === 'string' ? raw.Make : null,
      Model: typeof raw.Model === 'string' ? raw.Model : null,
      Software: typeof raw.Software === 'string' ? raw.Software : null,
      Orientation: typeof raw.Orientation === 'number' ? raw.Orientation : null,
    };
  } catch {
    return undefined;
  }
}

function tusUpload(file: File, opts: { endpoint: string; token: string; objectName: string; onProgress: (p: number) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: opts.endpoint,
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: CHUNK_SIZE,
      headers: { authorization: 'Bearer ' + opts.token, 'x-upsert': 'false' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: 'originals',
        objectName: opts.objectName,
        contentType: contentTypeFor(file),
        cacheControl: '3600',
      },
      onError: (error) => reject(error),
      onProgress: (sent, total) => opts.onProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
      onSuccess: () => resolve(),
    });
    upload
      .findPreviousUploads()
      .then((previous) => {
        const first = previous[0];
        if (first) upload.resumeFromPreviousUpload(first);
        upload.start();
      })
      .catch(() => upload.start());
  });
}

export function UploadClient({ communityId, userId, pipelineVersion }: { communityId: string; userId: string; pipelineVersion: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [batch, setBatch] = useState<Batch>({
    batchLabel: '',
    suppliedByRole: 'administrator',
    suppliedOn: new Date().toISOString().slice(0, 10),
    transportNote: 'airdrop',
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  function patch(key: string, changes: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...changes } : it)));
  }

  function addFiles(ev: ChangeEvent<HTMLInputElement>) {
    const list = ev.target.files;
    if (!list) return;
    const added: Item[] = Array.from(list).map((file) => ({
      key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: 'pending',
      progress: 0,
    }));
    setItems((prev) => [...prev, ...added]);
    ev.target.value = '';
  }

  async function processItem(item: Item, current: Batch): Promise<void> {
    const supabase = getBrowserClient();
    const key = item.key;
    try {
      patch(key, { status: 'hashing', progress: 0, message: undefined });
      const sha256 = await sha256Hex(item.file);
      const exif = await readExif(item.file);
      patch(key, { sha256, exif, status: 'checking' });

      const { data: existing, error: lookupError } = await supabase
        .from('files')
        .select('id, storage_path, status')
        .eq('community_id', communityId)
        .eq('sha256', sha256)
        .maybeSingle();
      if (lookupError) throw new Error(`lookup: ${lookupError.message}`);
      if (existing) {
        patch(key, { status: 'skipped', progress: 100, fileId: existing.id, message: 'already stored, skipped' });
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('session expired; sign in again');

      const ext = extensionOf(item.file.name);
      const objectName = `${communityId}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
      const endpoint = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`;

      patch(key, { status: 'uploading' });
      try {
        await tusUpload(item.file, {
          endpoint,
          token: session.access_token,
          objectName,
          onProgress: (p) => patch(key, { progress: p }),
        });
      } catch (e) {
        // An object from an earlier interrupted run may exist without its files row: continue registering.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already exists|409/i.test(msg)) throw e;
      }

      patch(key, { status: 'registering', progress: 100 });
      const { data: fileRow, error: insertError } = await supabase
        .from('files')
        .insert({
          community_id: communityId,
          sha256,
          client_sha256: sha256,
          storage_path: objectName,
          original_name: item.file.name,
          mime: contentTypeFor(item.file),
          bytes: item.file.size,
          source: 'web_upload',
          supplied_by_role: current.suppliedByRole,
          supplied_on: current.suppliedOn || null,
          batch_label: current.batchLabel || null,
          transport_note: current.transportNote,
          exif: exif ? (exif as unknown as Json) : null,
          capture_time: exif?.DateTimeOriginal ?? null,
          uploaded_by: userId,
        })
        .select('id')
        .single();
      if (insertError) {
        if (insertError.code === '23505') {
          patch(key, { status: 'skipped', message: 'already stored (registered concurrently), skipped' });
          return;
        }
        throw new Error(`files row: ${insertError.message}`);
      }

      const { error: jobError } = await supabase.from('jobs').insert({
        community_id: communityId,
        idempotency_key: `${sha256}:ingest:${pipelineVersion}`,
        step: 'ingest',
        payload: { file_id: fileRow.id },
      });
      if (jobError && jobError.code !== '23505') {
        throw new Error(`job: ${jobError.message}`);
      }
      patch(key, { status: 'done', fileId: fileRow.id, message: jobError ? 'stored; job already queued' : 'stored and queued' });
    } catch (e) {
      patch(key, { status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function run(only?: (it: Item) => boolean) {
    if (running) return;
    setRunning(true);
    const current = batch;
    const todo = items.filter((it) => (only ? only(it) : it.status === 'pending'));
    for (const it of todo) {
      // Sequential on purpose: one custody event at a time, predictable order for the manifest.
      await processItem(it, current);
    }
    setRunning(false);
  }

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    void run();
  }

  const summary = items.reduce(
    (acc, it) => {
      acc[it.status] = (acc[it.status] ?? 0) + 1;
      acc.bytes += it.file.size;
      return acc;
    },
    { bytes: 0 } as Record<string, number> & { bytes: number },
  );
  const failed = items.filter((it) => it.status === 'error').length;
  const pending = items.filter((it) => it.status === 'pending').length;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="card grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="label">Batch label</span>
          <input
            className="input"
            value={batch.batchLabel}
            onChange={(e) => setBatch({ ...batch, batchLabel: e.target.value })}
            placeholder="e.g. entrega-2026-09-12-admin"
            disabled={running}
          />
        </label>
        <label className="block">
          <span className="label">Supplied by (role)</span>
          <select className="input" value={batch.suppliedByRole} onChange={(e) => setBatch({ ...batch, suppliedByRole: e.target.value })} disabled={running}>
            {SUPPLIED_BY_ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Supplied on</span>
          <input type="date" className="input" value={batch.suppliedOn} onChange={(e) => setBatch({ ...batch, suppliedOn: e.target.value })} disabled={running} />
        </label>
        <label className="block">
          <span className="label">Transport</span>
          <select className="input" value={batch.transportNote} onChange={(e) => setBatch({ ...batch, transportNote: e.target.value })} disabled={running}>
            {TRANSPORT_NOTES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        <input ref={fileInput} type="file" multiple accept={ACCEPT} onChange={addFiles} className="hidden" disabled={running} />
        <input ref={cameraInput} type="file" multiple accept="image/*" capture="environment" onChange={addFiles} className="hidden" disabled={running} />
        <button type="button" className="btn-secondary" onClick={() => fileInput.current?.click()} disabled={running}>
          Choose files
        </button>
        <button type="button" className="btn-secondary" onClick={() => cameraInput.current?.click()} disabled={running}>
          Take photos (camera)
        </button>
        <button type="submit" className="btn" disabled={running || pending === 0}>
          {running ? 'Uploading…' : `Upload ${pending} pending`}
        </button>
        {failed > 0 ? (
          <button type="button" className="btn-secondary" onClick={() => void run((it) => it.status === 'error')} disabled={running}>
            Retry {failed} failed
          </button>
        ) : null}
        <button
          type="button"
          className="text-sm text-neutral-600 underline"
          onClick={() => setItems((prev) => prev.filter((it) => it.status !== 'done' && it.status !== 'skipped'))}
          disabled={running}
        >
          Clear finished
        </button>
        <span className="ml-auto text-xs text-neutral-600">
          {items.length} file{items.length === 1 ? '' : 's'} · {fmtBytes(summary.bytes)} · done {summary.done ?? 0} · skipped {summary.skipped ?? 0} · failed{' '}
          {failed}
        </span>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">Size</th>
              <th>Type</th>
              <th>Capture time (EXIF)</th>
              <th>SHA-256</th>
              <th>Status</th>
              <th>Progress</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-neutral-500">
                  No files selected.
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.key}>
                  <td className="max-w-xs truncate" title={it.file.name}>
                    {it.file.name}
                  </td>
                  <td className="num whitespace-nowrap">{fmtBytes(it.file.size)}</td>
                  <td className="text-xs">{contentTypeFor(it.file)}</td>
                  <td className="whitespace-nowrap text-xs">
                    {it.exif?.DateTimeOriginal ?? (it.exif ? 'no capture time' : '—')}
                    {it.exif?.Model ? <div className="text-neutral-500">{[it.exif.Make, it.exif.Model].filter(Boolean).join(' ')}</div> : null}
                  </td>
                  <td className="font-mono text-[11px]">{it.sha256 ? `${it.sha256.slice(0, 12)}…${it.sha256.slice(-6)}` : '—'}</td>
                  <td className="whitespace-nowrap text-xs">
                    <span
                      className={
                        it.status === 'error'
                          ? 'text-red-700'
                          : it.status === 'done'
                            ? 'text-green-700'
                            : it.status === 'skipped'
                              ? 'text-neutral-500'
                              : ''
                      }
                    >
                      {it.status}
                    </span>
                    {it.message ? <div className="max-w-xs whitespace-normal text-neutral-500">{it.message}</div> : null}
                  </td>
                  <td className="w-32">
                    <div className="h-2 w-full rounded bg-neutral-200">
                      <div className="h-2 rounded bg-neutral-700" style={{ width: `${it.progress}%` }} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </form>
  );
}
