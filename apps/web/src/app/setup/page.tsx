/**
 * Setup Route — First-Run Wizard
 *
 * One-time owner setup: account credentials + primary agent description.
 * Dark, minimal two-section card — matches the login aesthetic.
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

const inputClass = [
  'w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none',
  'transition-colors placeholder:text-on-surface-variant/25',
].join(' ');

const inputStyle = {
  background: 'var(--surface-container)',
  border: '1px solid var(--outline-variant)',
};

export default function SetupPage() {
  const router = useRouter();
  const { ready, setupRequired, setup, user } = useAuth();
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    agentName: 'Atelier',
    agentDescription:
      'A calm and technically precise AI collaborator. Helps reason clearly, answers directly, and keeps responses useful and grounded.',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!setupRequired && user) { router.replace('/chat'); return; }
    if (!setupRequired) router.replace('/login');
  }, [ready, router, setupRequired, user]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-on-surface-variant/40">Loading…</span>
      </main>
    );
  }

  function field(key: keyof typeof form, label: string, type = 'text', placeholder?: string) {
    return (
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-on-surface-variant/60" htmlFor={key}>
          {label}
        </label>
        <input
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          className={inputClass}
          id={key}
          onChange={(e) => setForm((c) => ({ ...c, [key]: e.target.value }))}
          onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
          placeholder={placeholder}
          required
          style={inputStyle}
          type={type}
          value={form[key] as string}
        />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-[440px]">

        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-primary shadow-lg shadow-primary/20">
            <Image
              alt="NextGenChat"
              className="h-full w-full object-cover"
              height={44}
              priority
              src="/nextgenchat-brand-mark.png"
              width={44}
            />
          </div>
          <div className="text-center">
            <h1 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
              Set up your workspace
            </h1>
            <p className="mt-1 text-sm text-on-surface-variant/60">
              Local-first · Your data stays on your machine
            </p>
          </div>
        </div>

        {/* Card */}
        <div
          className="overflow-hidden rounded-2xl"
          style={{
            background: 'var(--surface-container-lowest)',
            border: '1px solid var(--outline-variant)',
          }}
        >
          <form
            className="p-6"
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
            {/* Section: Account */}
            <div className="mb-6">
              <div className="mb-4 flex items-center gap-2">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold"
                  style={{ background: 'var(--primary-container)', color: 'var(--on-surface-variant)' }}
                >
                  1
                </span>
                <span className="font-headline text-xs font-semibold uppercase tracking-widest text-on-surface-variant/50">
                  Owner Account
                </span>
              </div>
              <div className="space-y-3">
                {field('username', 'Username', 'text', 'e.g. admin')}
                <div className="grid grid-cols-2 gap-3">
                  {field('password', 'Password', 'password')}
                  {field('confirmPassword', 'Confirm', 'password')}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="my-5" style={{ borderTop: '1px solid var(--outline-variant)' }} />

            {/* Section: Agent */}
            <div className="mb-6">
              <div className="mb-4 flex items-center gap-2">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold"
                  style={{ background: 'var(--primary-container)', color: 'var(--on-surface-variant)' }}
                >
                  2
                </span>
                <span className="font-headline text-xs font-semibold uppercase tracking-widest text-on-surface-variant/50">
                  Primary Agent
                </span>
              </div>
              <div className="space-y-3">
                {field('agentName', 'Agent name', 'text', 'e.g. Atelier')}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-on-surface-variant/60" htmlFor="agentDescription">
                    Description
                  </label>
                  <p className="text-[11px] text-on-surface-variant/35">
                    AgentCreatorAgent will generate full configuration from this.
                  </p>
                  <textarea
                    className="w-full resize-none rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none placeholder:text-on-surface-variant/25"
                    id="agentDescription"
                    onChange={(e) => setForm((c) => ({ ...c, agentDescription: e.target.value }))}
                    onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
                    onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
                    placeholder="Describe the agent's role and personality…"
                    required
                    rows={3}
                    style={{ ...inputStyle, minHeight: '80px' }}
                    value={form.agentDescription}
                  />
                </div>
              </div>
            </div>

            {error ? (
              <div
                className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
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
              className="font-headline w-full rounded-lg py-2.5 text-sm font-semibold text-on-primary transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={submitting}
              style={{ background: submitting ? 'var(--primary-dim)' : 'var(--primary)' }}
              type="submit"
            >
              {submitting ? 'Creating workspace…' : 'Launch Workspace →'}
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
