'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

type Mode = 'loading' | 'enrol' | 'verify' | 'verified' | 'error';

const FRIENDLY_NAME = 'Authenticator app';

/** Accepts either the data URL Supabase Auth returns or a raw SVG string. */
function qrSrc(qr: string): string {
  if (qr.startsWith('data:')) return qr;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(qr);
}

export function MfaClient() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [factorId, setFactorId] = useState<string>('');
  const [qr, setQr] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getBrowserClient();
        const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalError) throw aalError;
        if (aal.currentLevel === 'aal2') {
          if (!cancelled) setMode('verified');
          return;
        }
        const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
        if (listError) throw listError;
        const verified = factors.totp.find((f) => f.status === 'verified');
        if (verified) {
          if (!cancelled) {
            setFactorId(verified.id);
            setMode('verify');
          }
          return;
        }
        // Remove leftovers of an interrupted enrolment before starting a new one.
        for (const f of factors.all) {
          if (f.factor_type === 'totp' && f.status === 'unverified') {
            await supabase.auth.mfa.unenroll({ factorId: f.id });
          }
        }
        const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: FRIENDLY_NAME,
        });
        if (enrollError) throw enrollError;
        if (!cancelled) {
          setFactorId(enrolled.id);
          setQr(enrolled.totp.qr_code);
          setSecret(enrolled.totp.secret);
          setMode('enrol');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setMode('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = getBrowserClient();
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;
      setMode('verified');
      router.replace('/');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'loading') return <p className="text-sm text-neutral-600">Preparing the second factor…</p>;

  if (mode === 'verified') {
    return (
      <div className="space-y-2">
        <p className="text-sm">The second factor is verified for this session.</p>
        <Link href="/" className="btn">
          Continue
        </Link>
      </div>
    );
  }

  if (mode === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-700">{error}</p>
        <button type="button" className="btn-secondary" onClick={() => router.refresh()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === 'enrol' ? (
        <div className="space-y-2">
          <p className="text-sm">
            Scan the code with an authenticator app (or enter the secret manually), then type the six-digit code it
            shows.
          </p>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- SVG data URL from the auth API
            <img src={qrSrc(qr)} alt="Enrolment QR code" width={192} height={192} className="border border-neutral-200" />
          ) : null}
          {secret ? (
            <p className="text-xs text-neutral-600">
              Secret: <code className="select-all break-all">{secret}</code>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm">Enter the six-digit code from your authenticator app.</p>
      )}
      <label className="block">
        <span className="label">Code</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          className="input"
          autoFocus
        />
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex items-center gap-3">
        <button type="submit" className="btn" disabled={busy || code.trim().length < 6}>
          {busy ? 'Checking…' : mode === 'enrol' ? 'Enrol and verify' : 'Verify'}
        </button>
        <button type="submit" form="mfa-signout" className="text-sm text-neutral-600 underline">
          Sign out
        </button>
      </div>
    </form>
  );
}

/** Sign-out as a POST form (rendered next to the client form by the page). */
export function SignOutForm() {
  return <form id="mfa-signout" action="/logout" method="post" />;
}
