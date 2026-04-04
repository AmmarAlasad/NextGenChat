/**
 * Setup Route — First-Run Wizard
 *
 * Renders the one-time owner setup screen that seeds the owner account,
 * default workspace, channel, and primary agent.
 * Layout follows the Stitch "first-run-setup" design: centered header outside
 * the card, gradient accent top bar, two labelled sections (User Account +
 * Primary Agent), 2-column password grid, and a decorative background.
 *
 * Phase 1 implementation status:
 * - Creates the owner account plus the seeded workspace, channel, and agent.
 * - Future phases can add provider configuration and richer admin options here.
 */

'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/auth-provider';

export default function SetupPage() {
  const router = useRouter();
  const { ready, setupRequired, setup, user } = useAuth();
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    agentName: 'Atelier',
    agentSystemPrompt:
      'You are Atelier, a calm and technically precise AI collaborator inside NextGenChat. Help the user reason clearly, answer directly, and keep responses useful and grounded.',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!setupRequired && user) { router.replace('/chat'); return; }
    if (!setupRequired) router.replace('/login');
  }, [ready, router, setupRequired, user]);

  if (!ready) {
    return <main className="flex min-h-screen items-center justify-center text-on-surface-variant">Loading setup...</main>;
  }

  function field(key: keyof typeof form, label: string, type = 'text') {
    return (
      <div className="grid gap-1.5">
        <label className="px-1 text-xs font-semibold text-on-surface-variant" htmlFor={key}>
          {label}
        </label>
        <input
          className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-2.5 text-sm font-medium text-on-surface placeholder:text-outline transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          id={key}
          onChange={(e) => setForm((c) => ({ ...c, [key]: e.target.value }))}
          required
          type={type}
          value={form[key] as string}
        />
      </div>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6 sm:p-12">
      {/* Decorative background blobs */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
        <div className="absolute -left-24 -top-24 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -right-48 top-1/2 h-[32rem] w-[32rem] rounded-full bg-surface-container/10 blur-[100px]" />
      </div>

      <div className="w-full max-w-xl">
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
            NextGenChat
          </h1>
          <p className="mx-auto max-w-sm text-base font-medium leading-relaxed text-on-surface-variant">
            A local-first AI workspace. Your data and conversations stay on your machine.
          </p>
        </header>

        {/* Card */}
        <div className="relative overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-8 shadow-[0_8px_30px_rgba(42,52,57,0.04)] sm:p-10">
          {/* Gradient accent bar */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary to-primary-dim" />

          <form
            className="space-y-8"
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              setError(null);
              try {
                await setup(form);
                router.replace('/chat');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Setup failed.');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {/* Section: User Account */}
            <section className="space-y-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg leading-none text-on-surface-variant">○</span>
                <h2 className="font-headline text-sm font-bold uppercase tracking-wider text-on-surface">
                  User Account
                </h2>
              </div>

              {field('username', 'Username')}

              <div className="grid gap-4 sm:grid-cols-2">
                {field('password', 'Password', 'password')}
                {field('confirmPassword', 'Confirm Password', 'password')}
              </div>
            </section>

            <hr className="border-outline-variant/20" />

            {/* Section: Primary Agent */}
            <section className="space-y-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg leading-none text-on-surface-variant">◈</span>
                <h2 className="font-headline text-sm font-bold uppercase tracking-wider text-on-surface">
                  Primary Agent
                </h2>
              </div>

              {field('agentName', 'Primary Agent Name')}

              <div className="grid gap-1.5">
                <label className="px-1 text-xs font-semibold text-on-surface-variant" htmlFor="agentSystemPrompt">
                  System Prompt
                </label>
                <textarea
                  className="min-h-[120px] w-full resize-none rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-3 text-sm font-medium text-on-surface placeholder:text-outline transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  id="agentSystemPrompt"
                  onChange={(e) => setForm((c) => ({ ...c, agentSystemPrompt: e.target.value }))}
                  required
                  value={form.agentSystemPrompt}
                />
              </div>
            </section>

            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
                {error}
              </p>
            ) : null}

            <div className="pt-2">
              <button
                className="font-headline flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-8 py-3.5 text-base font-bold text-on-primary shadow-lg shadow-primary/20 transition-all hover:bg-primary-dim active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                type="submit"
              >
                {submitting ? 'Creating workspace…' : 'Create Workspace'}
                {!submitting && <span className="text-lg leading-none">→</span>}
              </button>
              <p className="mt-4 text-center text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/70">
                Ready to launch local environment
              </p>
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
