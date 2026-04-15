/**
 * Setup Route — First-Run Wizard
 *
 * Three-step owner setup: (1) account credentials, (2) agency/workspace
 * identity that AgentCreatorAgent uses to generate agency.md, (3) first agent.
 *
 * Phase 5 implementation status:
 * - Collects agencyName + agencyDescription so the backend can LLM-generate agency.md.
 * - Animated step transitions with progress rail.
 * - Future phases can add provider key entry or invite configuration here.
 */

'use client';

import Image from 'next/image';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { ProviderModelsResponse, ProviderStatus, SetupInput } from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';

const SETUP_DRAFT_STORAGE_KEY = 'nextgenchat:setup-draft';
type SetupPayload = SetupInput & {
  providerName?: SetupInput['providerName'];
  providerModel?: string;
  providerApiKey?: string;
};

// ── Shared style helpers ──────────────────────────────────────────────────────

const inputBase = [
  'w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none',
  'transition-colors duration-150 placeholder:text-on-surface-variant/25',
].join(' ');

const inputStyle = {
  background: 'var(--surface-container)',
  border: '1px solid var(--outline-variant)',
};

function focusStyle(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.style.borderColor = 'var(--primary)';
  e.currentTarget.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent)';
}

function blurStyle(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.style.borderColor = 'var(--outline-variant)';
  e.currentTarget.style.boxShadow = 'none';
}

// ── Step icons ────────────────────────────────────────────────────────────────

type IconProps = { className?: string; style?: React.CSSProperties };

function IconKey({ className, style }: IconProps) {
  return (
    <svg className={className} style={style} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  );
}

function IconBuilding({ className, style }: IconProps) {
  return (
    <svg className={className} style={style} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
    </svg>
  );
}

function IconSparkles({ className, style }: IconProps) {
  return (
    <svg className={className} style={style} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

// ── Step config ───────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: 'Account',  short: '01', Icon: IconKey       },
  { id: 2, label: 'Agency',   short: '02', Icon: IconBuilding  },
  { id: 3, label: 'Agent',    short: '03', Icon: IconSparkles  },
] as const;

// ── Field component ───────────────────────────────────────────────────────────

function Field({
  id, label, hint, type = 'text', placeholder, value, onChange, autoComplete,
}: {
  id: string; label: string; hint?: string; type?: string;
  placeholder?: string; value: string;
  onChange: (v: string) => void; autoComplete?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-baseline justify-between" htmlFor={id}>
        <span className="text-xs font-medium text-on-surface-variant/70">{label}</span>
        {hint ? <span className="text-[10px] text-on-surface-variant/35">{hint}</span> : null}
      </label>
      <input
        autoComplete={autoComplete ?? (type === 'password' ? 'new-password' : 'off')}
        className={inputBase}
        id={id}
        onBlur={blurStyle}
        onChange={(e) => onChange(e.target.value)}
        onFocus={focusStyle}
        placeholder={placeholder}
        required
        style={{ ...inputStyle, transition: 'border-color 0.15s, box-shadow 0.15s' }}
        type={type}
        value={value}
      />
    </div>
  );
}

function TextareaField({
  id, label, hint, placeholder, value, onChange, rows = 4,
}: {
  id: string; label: string; hint?: string; placeholder?: string;
  value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-baseline justify-between" htmlFor={id}>
        <span className="text-xs font-medium text-on-surface-variant/70">{label}</span>
        {hint ? <span className="text-[10px] text-on-surface-variant/35">{hint}</span> : null}
      </label>
      <textarea
        className={`${inputBase} resize-none`}
        id={id}
        onBlur={blurStyle}
        onChange={(e) => onChange(e.target.value)}
        onFocus={focusStyle}
        placeholder={placeholder}
        required
        rows={rows}
        style={{ ...inputStyle, transition: 'border-color 0.15s, box-shadow 0.15s', minHeight: `${rows * 24 + 20}px` }}
        value={value}
      />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function SetupScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready, setupRequired, setup, user } = useAuth();

  const [step, setStep] = useState(1);
  const [animDir, setAnimDir] = useState<'forward' | 'back'>('forward');
  const [visible, setVisible] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providerModels, setProviderModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingProviderModels, setLoadingProviderModels] = useState(false);

  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    agencyName: '',
    agencyDescription: '',
    agentName: 'Atelier',
    agentDescription:
      'A calm and technically precise AI collaborator. Helps reason clearly, answers directly, and keeps responses useful and grounded.',
    providerName: 'openai',
    providerModel: 'gpt-5.4',
    providerApiKey: '',
  });

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    if (!setupRequired && user) { router.replace('/chat'); return; }
    if (!setupRequired) router.replace('/login');
  }, [ready, router, setupRequired, user]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const saved = window.sessionStorage.getItem(SETUP_DRAFT_STORAGE_KEY);
    if (!saved) return;

    try {
      const parsed = JSON.parse(saved) as Partial<typeof form>;
      setForm((current) => ({ ...current, ...parsed }));
    } catch {
      window.sessionStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(SETUP_DRAFT_STORAGE_KEY, JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    let active = true;

    async function loadProviders() {
      setLoadingProviders(true);
      try {
        const nextProviders = await apiJson<ProviderStatus[]>('/auth/setup/providers');
        if (!active) return;
        setProviders(nextProviders);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Failed to load providers.');
      } finally {
        if (active) setLoadingProviders(false);
      }
    }

    void loadProviders();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingProviderModels(true);

    void apiJson<ProviderModelsResponse>(`/auth/setup/providers/${form.providerName}/models`).then((response) => {
      if (!active) return;
      const models = response.models.map((model) => ({ id: model.id, name: model.name }));
      setProviderModels(models);
      setForm((current) => ({
        ...current,
        providerModel: models.some((model) => model.id === current.providerModel)
          ? current.providerModel
          : (models[0]?.id ?? current.providerModel),
      }));
    }).catch((loadError) => {
      if (!active) return;
      setProviderModels([]);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load provider models.');
    }).finally(() => {
      if (active) setLoadingProviderModels(false);
    });

    return () => { active = false; };
  }, [form.providerName]);

  useEffect(() => {
    if (searchParams.get('provider') !== 'openai-codex-oauth' || searchParams.get('connected') !== 'true') return;

    setForm((current) => ({ ...current, providerName: 'openai-codex-oauth' }));
  }, [searchParams]);

  function set(key: keyof typeof form) {
    return (v: string) => setForm((c) => ({ ...c, [key]: v }));
  }

  function animateTo(next: number, dir: 'forward' | 'back') {
    setAnimDir(dir);
    setVisible(false);
    setTimeout(() => {
      setStep(next);
      setError(null);
      setVisible(true);
      containerRef.current?.scrollTo({ top: 0 });
    }, 200);
  }

  function validateStep1() {
    if (form.username.length < 3) return 'Username must be at least 3 characters.';
    if (!/^[a-zA-Z0-9_-]+$/.test(form.username)) return 'Username may only contain letters, numbers, _ and -.';
    if (form.password.length < 8) return 'Password must be at least 8 characters.';
    if (form.password !== form.confirmPassword) return 'Passwords do not match.';
    return null;
  }

  function validateStep2() {
    if (form.agencyName.trim().length < 2) return 'Agency name must be at least 2 characters.';
    if (form.agencyDescription.trim().length < 20) return 'Please describe your agency in at least 20 characters.';
    return null;
  }

  function validateProviderSelection() {
    const selectedProvider = providers.find((provider) => provider.providerName === form.providerName);

    if (!form.providerModel.trim()) return 'Please choose a model for the first agent.';
    if (!selectedProvider) return 'Please wait for provider setup to finish loading.';

    if (selectedProvider.authKind === 'api_key' && !selectedProvider.isConfigured && !form.providerApiKey.trim()) {
      return `Enter an API key for ${selectedProvider.label} or configure it later from environment variables.`;
    }

    if (selectedProvider.authKind === 'oauth' && !selectedProvider.isConfigured && searchParams.get('connected') !== 'true') {
      return `Connect ${selectedProvider.label} before creating the first agent.`;
    }

    return null;
  }

  function handleNext() {
    let err: string | null = null;
    if (step === 1) err = validateStep1();
    if (step === 2) err = validateStep2();
    if (err) { setError(err); return; }
    animateTo(step + 1, 'forward');
  }

  function handleBack() {
    animateTo(step - 1, 'back');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.agentName.trim().length < 1) { setError('Agent name is required.'); return; }
    if (form.agentDescription.trim().length < 10) { setError('Please describe your agent in at least 10 characters.'); return; }
    const providerError = validateProviderSelection();
    if (providerError) { setError(providerError); return; }

    setSubmitting(true);
    setError(null);
    try {
      const payload: SetupPayload = {
        username: form.username,
        password: form.password,
        confirmPassword: form.confirmPassword,
        agencyName: form.agencyName.trim(),
        agencyDescription: form.agencyDescription.trim(),
        agentName: form.agentName.trim(),
        agentDescription: form.agentDescription.trim(),
        providerName: form.providerName as SetupPayload['providerName'],
        providerModel: form.providerModel,
        providerApiKey: form.providerApiKey.trim() || undefined,
      };

      await setup(payload as SetupInput);
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
      }
      router.replace('/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-on-surface-variant/40">Loading…</span>
      </main>
    );
  }

  const slideStyle: React.CSSProperties = {
    transition: 'opacity 0.2s ease, transform 0.2s ease',
    opacity: visible ? 1 : 0,
    transform: visible
      ? 'translateX(0)'
      : animDir === 'forward'
        ? 'translateX(-16px)'
        : 'translateX(16px)',
  };
  const selectedProvider = providers.find((provider) => provider.providerName === form.providerName) ?? null;

  async function connectSetupCodex() {
    if (typeof window === 'undefined') return;

    window.sessionStorage.setItem(SETUP_DRAFT_STORAGE_KEY, JSON.stringify(form));
    const response = await apiJson<{ authUrl: string }>('/auth/setup/oauth/codex/init');
    window.location.href = response.authUrl;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[460px]">

        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl shadow-lg"
            style={{ background: 'var(--primary)', boxShadow: '0 8px 24px color-mix(in srgb, var(--primary) 30%, transparent)' }}
          >
            <Image alt="NextGenChat" className="h-full w-full object-cover" height={40} priority src="/nextgenchat-brand-mark.png" width={40} />
          </div>
          <div className="text-center">
            <h1 className="font-headline text-xl font-bold tracking-tight text-on-surface">
              Set up your workspace
            </h1>
            <p className="mt-0.5 text-xs text-on-surface-variant/50">
              Local-first · Your data stays on your machine
            </p>
          </div>
        </div>

        {/* Step rail */}
        <div className="mb-6 flex items-center gap-0">
          {STEPS.map((s, idx) => {
            const done = step > s.id;
            const active = step === s.id;
            return (
              <div key={s.id} className="flex flex-1 items-center">
                {/* Node */}
                <div className="flex flex-col items-center gap-1.5" style={{ minWidth: 64 }}>
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-full transition-all duration-300"
                    style={{
                      background: done
                        ? 'var(--primary)'
                        : active
                          ? 'color-mix(in srgb, var(--primary) 15%, transparent)'
                          : 'var(--surface-container)',
                      border: active
                        ? '1.5px solid var(--primary)'
                        : done
                          ? '1.5px solid var(--primary)'
                          : '1.5px solid var(--outline-variant)',
                      boxShadow: active
                        ? '0 0 0 4px color-mix(in srgb, var(--primary) 12%, transparent)'
                        : 'none',
                    }}
                  >
                    {done ? (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" style={{ color: 'var(--on-primary)' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    ) : (
                      <s.Icon
                        className="h-4 w-4"
                        style={{ color: active ? 'var(--primary)' : 'var(--on-surface-variant)', opacity: active ? 1 : 0.4 }}
                      />
                    )}
                  </div>
                  <span
                    className="text-[10px] font-semibold tracking-wider"
                    style={{ color: active ? 'var(--primary)' : done ? 'var(--on-surface-variant)' : 'var(--on-surface-variant)', opacity: active ? 1 : done ? 0.7 : 0.35 }}
                  >
                    {s.label.toUpperCase()}
                  </span>
                </div>

                {/* Connector */}
                {idx < STEPS.length - 1 && (
                  <div
                    className="mx-1 h-px flex-1 transition-all duration-500"
                    style={{ background: done ? 'var(--primary)' : 'var(--outline-variant)', opacity: done ? 0.7 : 0.4 }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Card */}
        <div
          className="overflow-hidden rounded-2xl"
          style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}
          ref={containerRef}
        >
          <form onSubmit={step === 3 ? handleSubmit : (e) => { e.preventDefault(); handleNext(); }}>
            <div style={slideStyle}>

              {/* ── Step header ──────────────────────────────────────────────── */}
              <div
                className="flex items-center gap-3 px-6 py-4"
                style={{ borderBottom: '1px solid var(--outline-variant)', background: 'var(--surface-container)' }}
              >
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: 'color-mix(in srgb, var(--primary) 12%, transparent)' }}
                >
                  {step === 1 && <IconKey className="h-4 w-4" style={{ color: 'var(--primary)' } as React.CSSProperties} />}
                  {step === 2 && <IconBuilding className="h-4 w-4" style={{ color: 'var(--primary)' } as React.CSSProperties} />}
                  {step === 3 && <IconSparkles className="h-4 w-4" style={{ color: 'var(--primary)' } as React.CSSProperties} />}
                </div>
                <div>
                  <p className="font-headline text-sm font-semibold text-on-surface">
                    {step === 1 && 'Owner Account'}
                    {step === 2 && 'Your Agency'}
                    {step === 3 && 'Primary Agent'}
                  </p>
                  <p className="text-[11px] text-on-surface-variant/50">
                    {step === 1 && 'Create your local admin credentials'}
                    {step === 2 && 'AI will generate your workspace constitution from this'}
                    {step === 3 && 'Your first AI collaborator'}
                  </p>
                </div>
                <div
                  className="ml-auto text-xs font-bold tabular-nums"
                  style={{ color: 'var(--primary)', opacity: 0.5 }}
                >
                  {step} / {STEPS.length}
                </div>
              </div>

              {/* ── Step body ────────────────────────────────────────────────── */}
              <div className="space-y-4 p-6">

                {step === 1 && (
                  <>
                    <Field
                      id="username" label="Username" placeholder="e.g. admin"
                      value={form.username} onChange={set('username')}
                      autoComplete="username"
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Field
                        id="password" label="Password" type="password"
                        value={form.password} onChange={set('password')}
                      />
                      <Field
                        id="confirmPassword" label="Confirm" type="password"
                        value={form.confirmPassword} onChange={set('confirmPassword')}
                      />
                    </div>
                  </>
                )}

                {step === 2 && (
                  <>
                    <Field
                      id="agencyName" label="Agency name" placeholder="e.g. Acme Labs, My Studio…"
                      hint="Used as your workspace name"
                      value={form.agencyName} onChange={set('agencyName')}
                    />
                    <TextareaField
                      id="agencyDescription"
                      label="What does your agency do?"
                      hint="The AI will write your agency.md from this"
                      placeholder={`Describe the purpose, tone, and domain of your workspace.\n\nFor example: "A product design studio focused on mobile apps. We value clarity, craft, and shipping fast without cutting corners. Our agents help with research, writing, and code review."`}
                      value={form.agencyDescription}
                      onChange={set('agencyDescription')}
                      rows={5}
                    />
                    <div
                      className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[11px]"
                      style={{
                        background: 'color-mix(in srgb, var(--primary) 8%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--primary) 20%, transparent)',
                        color: 'var(--on-surface-variant)',
                      }}
                    >
                      <IconSparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' } as React.CSSProperties} />
                      <span>
                        AgentCreatorAgent will generate a full <code className="font-mono text-[10px]">agency.md</code> constitution
                        tailored to your description after setup completes.
                      </span>
                    </div>
                  </>
                )}

                {step === 3 && (
                  <>
                    <Field
                      id="agentName" label="Agent name" placeholder="e.g. Atelier, Nova, Rex…"
                      value={form.agentName} onChange={set('agentName')}
                    />
                    <TextareaField
                      id="agentDescription"
                      label="Describe this agent"
                      hint="AgentCreatorAgent generates full config from this"
                      placeholder="Describe the agent's role, personality, and how it should communicate…"
                      value={form.agentDescription}
                      onChange={set('agentDescription')}
                      rows={4}
                    />
                    <div
                      className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[11px]"
                      style={{
                        background: 'color-mix(in srgb, var(--primary) 8%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--primary) 20%, transparent)',
                        color: 'var(--on-surface-variant)',
                      }}
                    >
                      <IconSparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' } as React.CSSProperties} />
                      <span>
                        AgentCreatorAgent will generate all eight agent files —
                        soul, identity, operating manual, wakeup instructions, and more.
                      </span>
                    </div>

                    <div
                      className="space-y-4 rounded-xl p-4"
                      style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)' }}
                    >
                      <div>
                        <p className="font-headline text-sm font-semibold text-on-surface">First Agent Provider</p>
                        <p className="mt-1 text-[11px] text-on-surface-variant/50">
                          Choose which AI provider powers your first agent. You can change any agent later from its workspace settings.
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="block text-xs font-medium text-on-surface-variant/70">Provider</label>
                          <select
                            className="w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none"
                            onChange={(e) => setForm((current) => ({ ...current, providerName: e.target.value, providerApiKey: '' }))}
                            style={inputStyle}
                            value={form.providerName}
                          >
                            {providers.map((provider) => (
                              <option key={provider.providerName} value={provider.providerName}>
                                {provider.label}
                                {provider.isConfigured ? '' : ' (needs setup)'}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-1.5">
                          <label className="block text-xs font-medium text-on-surface-variant/70">Model</label>
                          <select
                            className="w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none disabled:opacity-40"
                            disabled={loadingProviderModels || providerModels.length === 0}
                            onChange={(e) => set('providerModel')(e.target.value)}
                            style={inputStyle}
                            value={form.providerModel}
                          >
                            {providerModels.map((model) => (
                              <option key={model.id} value={model.id}>{model.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {loadingProviders ? (
                        <p className="text-[11px] text-on-surface-variant/40">Loading provider options…</p>
                      ) : selectedProvider?.authKind === 'api_key' ? (
                        <div className="space-y-1.5">
                          <label className="block text-xs font-medium text-on-surface-variant/70">
                            {selectedProvider.isConfigured ? 'Replace shared API key (optional)' : 'API key'}
                          </label>
                          <input
                            className="w-full rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/25"
                            onBlur={blurStyle}
                            onChange={(e) => set('providerApiKey')(e.target.value)}
                            onFocus={focusStyle}
                            placeholder={selectedProvider.isConfigured ? 'Leave empty to keep the current provider setup or environment key' : 'Paste API key'}
                            style={{ ...inputStyle, transition: 'border-color 0.15s, box-shadow 0.15s' }}
                            type="password"
                            value={form.providerApiKey}
                          />
                        </div>
                      ) : (
                        <div className="space-y-3 rounded-lg px-3 py-3 text-[11px]" style={{ ...inputStyle }}>
                          <p className="text-on-surface-variant/70">
                            {selectedProvider?.isConfigured || searchParams.get('connected') === 'true'
                              ? 'OpenAI Codex is connected for setup.'
                              : 'Connect OpenAI Codex with OAuth before finishing setup.'}
                          </p>
                          <button
                            className="rounded-lg px-3 py-2 text-sm font-semibold text-on-primary transition-all active:scale-[0.98] disabled:opacity-40"
                            disabled={submitting}
                            onClick={() => void connectSetupCodex()}
                            style={{ background: 'var(--primary)' }}
                            type="button"
                          >
                            {selectedProvider?.isConfigured || searchParams.get('connected') === 'true' ? 'Reconnect Codex' : 'Connect Codex'}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}

              </div>

              {/* ── Error ────────────────────────────────────────────────────── */}
              {error ? (
                <div
                  className="mx-6 mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
                  style={{ background: 'rgba(255,0,51,0.08)', border: '1px solid rgba(255,0,51,0.2)', color: '#ff6685' }}
                >
                  <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" strokeLinecap="round" />
                  </svg>
                  {error}
                </div>
              ) : null}

              {/* ── Actions ──────────────────────────────────────────────────── */}
              <div
                className="flex items-center gap-3 px-6 pb-6"
                style={{ paddingTop: error ? 0 : undefined }}
              >
                {step > 1 && (
                  <button
                    type="button"
                    onClick={handleBack}
                    disabled={submitting}
                    className="flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-medium transition-all active:scale-[0.97] disabled:opacity-40"
                    style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface-variant)' }}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                    Back
                  </button>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="font-headline ml-auto flex h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold text-on-primary transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: submitting ? 'var(--primary-dim, var(--primary))' : 'var(--primary)', boxShadow: '0 4px 12px color-mix(in srgb, var(--primary) 25%, transparent)' }}
                >
                  {submitting ? (
                    <>
                      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                      Launching…
                    </>
                  ) : step < 3 ? (
                    <>
                      Continue
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                    </>
                  ) : (
                    'Launch Workspace →'
                  )}
                </button>
              </div>

            </div>
          </form>
        </div>

        <p className="mt-6 text-center text-[10px] text-on-surface-variant/25">
          NextGenChat · Local Node
        </p>
      </div>
    </main>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupScreen />
    </Suspense>
  );
}
