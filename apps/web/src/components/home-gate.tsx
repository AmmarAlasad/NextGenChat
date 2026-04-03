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
  const { ready, setupRequired, user } = useAuth();

  useEffect(() => {
    if (!ready) {
      return;
    }

    if (setupRequired) {
      router.replace('/setup');
      return;
    }

    if (user) {
      router.replace('/chat');
      return;
    }

    router.replace('/login');
  }, [ready, router, setupRequired, user]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16 text-slate-700">
      Routing into the first local NextGenChat flow...
    </main>
  );
}
