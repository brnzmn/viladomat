import { getCommunity } from '@/lib/community';
import { PIPELINE_VERSION } from '@/lib/env';
import { UploadClient } from './UploadClient';

export const dynamic = 'force-dynamic';

const TRANSPORT_DOC_URL = 'https://github.com/brnzmn/viladomat/blob/main/docs/transport-and-capture.md';

export default async function UploadPage() {
  const ctx = await getCommunity();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Upload</h1>
        <p className="text-sm text-neutral-600">
          Every file is hashed in this browser (SHA-256) before it leaves the device, uploaded unchanged to the
          immutable originals bucket, and queued for the worker. Files whose hash is already stored are skipped,
          never re-stored.
        </p>
      </div>
      <div className="rounded border border-neutral-200 bg-white p-3 text-xs text-neutral-700">
        <p>
          <strong>Send originals.</strong> Phone photos must arrive as the original HEIC/JPEG (AirDrop, Files app,
          Drive upload, USB). WhatsApp and similar apps re-encode images and strip capture time, device and
          orientation; such copies can be uploaded but must be marked with the matching transport note. Details:{' '}
          <a href={TRANSPORT_DOC_URL} className="underline" target="_blank" rel="noreferrer">
            docs/transport-and-capture.md
          </a>
          .
        </p>
      </div>
      {ctx.canWrite ? (
        <UploadClient communityId={ctx.id} userId={ctx.userId} pipelineVersion={PIPELINE_VERSION} />
      ) : (
        <p className="text-sm text-amber-800">Your role is read-only; uploads are reserved for reviewers.</p>
      )}
    </div>
  );
}
