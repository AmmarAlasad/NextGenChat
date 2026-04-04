/**
 * Login Route
 *
 * Renders the local sign-in form. Matches the same card style as the setup
 * page: header outside the card, gradient accent top bar, design-system tokens
 * throughout (no hardcoded brand colors).
 *
 * Phase 1 implementation status:
 * - Signs the user in, restores the in-memory access token, and routes into chat.
 * - Future phases can add invite acceptance, password reset, and session management.
 */

'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/auth-provider';

export default function LoginPage() {
  const router = useRouter();
  const { ready, setupRequired, login, user } = useAuth();
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) { router.replace('/setup'); return; }
    if (user) router.replace('/chat');
  }, [ready, router, setupRequired, user]);

  if (!ready) {
    return <main className="flex min-h-screen items-center justify-center text-on-surface-variant">Loading…</main>;
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6 sm:p-12">
      {/* Decorative background blobs */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
        <div className="absolute -left-24 -top-24 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -right-48 top-1/2 h-[32rem] w-[32rem] rounded-full bg-surface-container/10 blur-[100px]" />
      </div>

      <div className="w-full max-w-md">
        {/* Page header — outside the card */}
        <header className="mb-10 text-center">
          <div className="mb-6 inline-flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border border-outline-variant/20 bg-surface-container-high shadow-sm">
            <Image
              alt="NextGenChat logo"
              className="h-full w-full object-cover"
              height={96}
              priority
              src="/nextgenchat-brand-mark.png"
              width={96}
            />
          </div>
          <h1 className="font-headline mb-3 text-3xl font-extrabold tracking-tight text-on-surface">
            Welcome back
          </h1>
          <p className="text-base font-medium text-on-surface-variant">
            Sign in with the owner account created during setup.
          </p>
        </header>

        {/* Card */}
        <div className="relative overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-8 shadow-[0_8px_30px_rgba(42,52,57,0.04)] sm:p-10">
          {/* Gradient accent bar */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary to-primary-dim" />

          <form
            className="space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              setError(null);
              try {
                await login({ login: loginValue, password });
                router.replace('/chat');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Login failed.');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <div className="grid gap-1.5">
              <label className="px-1 text-xs font-semibold text-on-surface-variant" htmlFor="login">
                Username or email
              </label>
              <input
                className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-2.5 text-sm font-medium text-on-surface placeholder:text-outline transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                id="login"
                onChange={(e) => setLoginValue(e.target.value)}
                required
                value={loginValue}
              />
            </div>

            <div className="grid gap-1.5">
              <label className="px-1 text-xs font-semibold text-on-surface-variant" htmlFor="password">
                Password
              </label>
              <input
                className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-2.5 text-sm font-medium text-on-surface placeholder:text-outline transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                id="password"
                onChange={(e) => setPassword(e.target.value)}
                required
                type="password"
                value={password}
              />
            </div>

            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
                {error}
              </p>
            ) : null}

            <div className="pt-1">
              <button
                className="font-headline w-full rounded-lg bg-primary px-8 py-3.5 text-base font-bold text-on-primary shadow-lg shadow-primary/20 transition-all hover:bg-primary-dim active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                type="submit"
              >
                {submitting ? 'Signing in…' : 'Sign In'}
              </button>
            </div>
          </form>
        </div>

        <footer className="mt-12 text-center text-xs font-medium text-on-surface-variant opacity-60">
          NextGenChat · Local Development Node · v1.0.0
        </footer>
      </div>
    </main>
  );
}
