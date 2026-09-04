import { ActionForm } from '@/components/ActionForm';
import { signIn } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Internal verification material — do not forward. Access is limited to the accounts created by the operator.
        </p>
      </div>
      <div className="card">
        <ActionForm action={signIn} submitLabel="Sign in">
          <input type="hidden" name="next" value={next ?? ''} />
          <label className="block">
            <span className="label">E-mail</span>
            <input type="email" name="email" autoComplete="username" required className="input" />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input type="password" name="password" autoComplete="current-password" required className="input" />
          </label>
        </ActionForm>
      </div>
      <p className="text-xs text-neutral-500">
        Self-service sign-up is disabled. A second factor (authenticator app) is requested after sign-in.
      </p>
    </main>
  );
}
