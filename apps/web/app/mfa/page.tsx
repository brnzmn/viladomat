import { MfaClient, SignOutForm } from './MfaClient';

export const dynamic = 'force-dynamic';

export default function MfaPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Second factor</h1>
        <p className="mt-1 text-sm text-neutral-600">
          A time-based one-time code is required for every session. The authenticator secret stays on your device.
        </p>
      </div>
      <div className="card">
        <MfaClient />
        <SignOutForm />
      </div>
    </main>
  );
}
