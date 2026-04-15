/**
 * Home Gate
 *
 * Phase 1 implementation status:
 * - This file now routes users into the first working flow based on backend state.
 * - Current scope chooses between setup, login, and chat once the auth provider is ready.
 * - Future phases can add onboarding, workspace pickers, and richer empty states.
 */

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/auth-provider';

export function HomeGate() {
  const router = useRouter();
  const { ready, setupRequired, backendError, user, retryInit } = useAuth();

  useEffect(() => {
    if (!ready || backendError) return;

    if (setupRequired) {
      router.replace('/setup');
      return;
    }

    if (user) {
      router.replace('/chat');
      return;
    }

    router.replace('/login');
  }, [ready, backendError, router, setupRequired, user]);

  if (ready && backendError) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full"
            style={{ background: 'rgba(255, 0, 51, 0.1)' }}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" style={{ color: '#ff6685' }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface">Backend not responding</p>
            <p className="mt-1 text-xs text-on-surface-variant/60">
              Make sure the backend is running on port 3001.
            </p>
          </div>
          <button
            onClick={retryInit}
            className="rounded-lg px-4 py-2 text-sm font-medium text-on-primary transition-all active:scale-[0.98]"
            style={{ background: 'var(--primary)' }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex flex-col items-center gap-3 text-on-surface-variant">
        <svg
          className="animate-spin h-6 w-6 text-primary"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <span className="text-sm">Starting up…</span>
      </div>
    </main>
  );
}
