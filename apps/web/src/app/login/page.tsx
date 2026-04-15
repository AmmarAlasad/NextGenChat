/**
 * Login Route
 *
 * Owner account sign-in. Dark, minimal layout — brand mark, headline, and a
 * clean form card on the ink-black background. No decorative blobs.
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
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-on-surface-variant/40">Loading…</span>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[380px]">

        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-primary shadow-lg shadow-primary/20">
            <Image
              alt="NextGenChat"
              className="h-full w-full object-cover"
              height={44}
              priority
              src="/nextgenchat-brand-mark.svg"
              width={44}
            />
          </div>
          <div className="text-center">
            <h1 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
              Welcome back
            </h1>
            <p className="mt-1 text-sm text-on-surface-variant/60">
              Sign in to your workspace
            </p>
          </div>
        </div>

        {/* Card */}
        <div
          className="overflow-hidden rounded-2xl p-6"
          style={{
            background: 'var(--surface-container-lowest)',
            border: '1px solid var(--outline-variant)',
          }}
        >
          <form
            className="space-y-4"
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
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-on-surface-variant/60" htmlFor="login">
                Username or email
              </label>
              <input
                autoComplete="username"
                className="w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/25"
                id="login"
                onChange={(e) => setLoginValue(e.target.value)}
                required
                style={{
                  background: 'var(--surface-container)',
                  border: '1px solid var(--outline-variant)',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
                value={loginValue}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-on-surface-variant/60" htmlFor="password">
                Password
              </label>
              <input
                autoComplete="current-password"
                className="w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/25"
                id="password"
                onChange={(e) => setPassword(e.target.value)}
                required
                style={{
                  background: 'var(--surface-container)',
                  border: '1px solid var(--outline-variant)',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
                type="password"
                value={password}
              />
            </div>

            {error ? (
              <div
                className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
                style={{
                  background: 'rgba(255, 0, 51, 0.08)',
                  border: '1px solid rgba(255, 0, 51, 0.2)',
                  color: '#ff6685',
                }}
              >
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" strokeLinecap="round" />
                </svg>
                {error}
              </div>
            ) : null}

            <button
              className="font-headline mt-2 w-full rounded-lg py-2.5 text-sm font-semibold text-on-primary transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={submitting}
              style={{ background: submitting ? 'var(--primary-dim)' : 'var(--primary)' }}
              type="submit"
            >
              {submitting ? 'Signing in…' : 'Sign In →'}
            </button>
          </form>
        </div>

        <p className="mt-8 text-center text-[11px] text-on-surface-variant/25">
          NextGenChat · Local Node
        </p>
      </div>
    </main>
  );
}
