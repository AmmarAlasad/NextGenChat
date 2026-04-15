/**
 * Provider Settings Screen
 *
 * Workspace-level provider settings page for managing global credentials,
 * OAuth connections, and the default fallback provider used by agents.
 *
 * Phase 5 implementation status:
 * - Supports OpenAI, Anthropic, Kimi, OpenRouter, and OpenAI Codex OAuth.
 * - Lets the operator add global credentials and choose a fallback model.
 * - Future phases can add usage stats, provider health checks, and per-workspace scopes.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import type {
  FallbackProvider,
  ProviderModelsResponse,
  ProviderStatus,
  SetApiKeyCredentialInput,
} from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';

export function ProviderSettingsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accessToken, ready, setupRequired, user } = useAuth();

  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  const [fallback, setFallback] = useState<FallbackProvider>({ providerName: null, model: null });
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [savingFallback, setSavingFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) {
      router.replace('/setup');
      return;
    }
    if (!user) {
      router.replace('/login');
    }
  }, [ready, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken) return;

    let active = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const [nextProviders, nextFallback] = await Promise.all([
          apiJson<ProviderStatus[]>('/providers', { headers }),
          apiJson<FallbackProvider>('/providers/fallback', { headers }),
        ]);

        if (!active) return;

        setProviders(nextProviders);
        setFallback(nextFallback);

        const modelEntries = await Promise.all(
          nextProviders.map(async (provider) => {
            try {
              const response = await apiJson<ProviderModelsResponse>(`/providers/${provider.providerName}/models`, { headers });
              return [provider.providerName, response.models.map((model) => ({ id: model.id, name: model.name }))] as const;
            } catch {
              return [provider.providerName, []] as const;
            }
          }),
        );

        if (!active) return;

        setProviderModels(Object.fromEntries(modelEntries));
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load providers.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();

    return () => { active = false; };
  }, [accessToken]);

  const fallbackModels = useMemo(
    () => (fallback.providerName ? providerModels[fallback.providerName] ?? [] : []),
    [fallback.providerName, providerModels],
  );

  async function refreshProviders() {
    if (!accessToken) return;
    const headers = { Authorization: `Bearer ${accessToken}` };
    const nextProviders = await apiJson<ProviderStatus[]>('/providers', { headers });
    setProviders(nextProviders);
  }

  async function saveApiKey(providerName: string) {
    if (!accessToken) return;

    setSavingProvider(providerName);
    setError(null);

    try {
      const payload: SetApiKeyCredentialInput = {
        providerName: providerName as SetApiKeyCredentialInput['providerName'],
        apiKey: apiKeys[providerName] ?? '',
      };

      await apiJson(`/providers/${providerName}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });

      setApiKeys((current) => ({ ...current, [providerName]: '' }));
      await refreshProviders();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save provider API key.');
    } finally {
      setSavingProvider(null);
    }
  }

  async function connectCodex() {
    if (!accessToken) return;

    setSavingProvider('openai-codex-oauth');
    setError(null);

    try {
      const response = await apiJson<{ authUrl: string }>('/providers/oauth/codex/init', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      window.location.href = response.authUrl;
    } catch (connectError) {
      setSavingProvider(null);
      setError(connectError instanceof Error ? connectError.message : 'Failed to start Codex OAuth.');
    }
  }

  async function deleteProvider(providerName: string) {
    if (!accessToken) return;

    setDeletingProvider(providerName);
    setError(null);

    try {
      await apiJson(`/providers/${providerName}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      await refreshProviders();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to remove provider credentials.');
    } finally {
      setDeletingProvider(null);
    }
  }

  async function saveFallback() {
    if (!accessToken) return;

    setSavingFallback(true);
    setError(null);

    try {
      await apiJson('/providers/fallback', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(fallback),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save fallback provider.');
    } finally {
      setSavingFallback(false);
    }
  }

  if (!ready || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center" style={{ background: 'var(--ib-950)' }}>
        <span className="text-sm text-on-surface-variant/50">Loading provider settings…</span>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-6 py-8" style={{ background: 'var(--ib-950)', color: 'var(--on-surface)' }}>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-on-surface-variant/50">
              <Link href="/chat" className="hover:text-on-surface">Chat</Link>
              <span>·</span>
              <span>Settings</span>
            </div>
            <h1 className="mt-2 font-headline text-2xl font-semibold text-on-surface">AI Provider Settings</h1>
            <p className="mt-1 text-sm text-on-surface-variant/50">
              Manage shared provider credentials, OAuth connections, and the default fallback used by agents.
            </p>
          </div>

          {searchParams.get('connected') === 'true' && searchParams.get('provider') === 'openai-codex-oauth' ? (
            <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(34, 197, 94, 0.12)', color: '#86efac', border: '1px solid rgba(34, 197, 94, 0.24)' }}>
              OpenAI Codex connected.
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255, 0, 51, 0.08)', border: '1px solid rgba(255, 0, 51, 0.2)', color: '#ff6685' }}>
            {error}
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-2">
          {providers.map((provider) => {
            const isApiKey = provider.authKind === 'api_key';
            const isBusy = savingProvider === provider.providerName || deletingProvider === provider.providerName;

            return (
              <article
                key={provider.providerName}
                className="rounded-2xl p-5"
                style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-headline text-lg font-semibold text-on-surface">{provider.label}</h2>
                    <p className="mt-1 text-sm text-on-surface-variant/50">
                      {provider.authKind === 'oauth' ? 'OAuth connection' : 'API key provider'}
                    </p>
                  </div>

                  <span
                    className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    style={{
                      background: provider.isConfigured ? 'rgba(34, 197, 94, 0.12)' : 'rgba(255,255,255,0.05)',
                      color: provider.isConfigured ? '#86efac' : 'var(--on-surface-variant)',
                    }}
                  >
                    {provider.isConfigured ? 'Configured' : 'Not configured'}
                  </span>
                </div>

                <div className="mt-4 space-y-4">
                  {isApiKey ? (
                    <>
                      <input
                        className="w-full rounded-lg px-3 py-2.5 text-sm outline-none"
                        onChange={(event) => setApiKeys((current) => ({ ...current, [provider.providerName]: event.target.value }))}
                        placeholder={provider.isConfigured ? 'Replace API key…' : 'Enter API key…'}
                        style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}
                        type="password"
                        value={apiKeys[provider.providerName] ?? ''}
                      />

                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-lg px-3 py-2 text-sm font-semibold text-on-primary disabled:opacity-40"
                          disabled={isBusy || !(apiKeys[provider.providerName] ?? '').trim()}
                          onClick={() => void saveApiKey(provider.providerName)}
                          style={{ background: 'var(--primary)' }}
                          type="button"
                        >
                          {savingProvider === provider.providerName ? 'Saving…' : provider.isConfigured ? 'Update key' : 'Save key'}
                        </button>

                        {provider.isConfigured ? (
                          <button
                            className="rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40"
                            disabled={isBusy}
                            onClick={() => void deleteProvider(provider.providerName)}
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface-variant)' }}
                            type="button"
                          >
                            {deletingProvider === provider.providerName ? 'Removing…' : 'Remove'}
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface-variant)' }}>
                        {provider.oauthExpiresAt ? `Connected until ${new Date(provider.oauthExpiresAt).toLocaleString()}` : 'Connect your OpenAI account to enable Codex models.'}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-lg px-3 py-2 text-sm font-semibold text-on-primary disabled:opacity-40"
                          disabled={isBusy}
                          onClick={() => void connectCodex()}
                          style={{ background: 'var(--primary)' }}
                          type="button"
                        >
                          {savingProvider === provider.providerName ? 'Redirecting…' : provider.isConfigured ? 'Reconnect' : 'Connect'}
                        </button>

                        {provider.isConfigured ? (
                          <button
                            className="rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40"
                            disabled={isBusy}
                            onClick={() => void deleteProvider(provider.providerName)}
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface-variant)' }}
                            type="button"
                          >
                            {deletingProvider === provider.providerName ? 'Disconnecting…' : 'Disconnect'}
                          </button>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <section className="rounded-2xl p-5" style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-headline text-lg font-semibold text-on-surface">Fallback Provider</h2>
              <p className="mt-1 text-sm text-on-surface-variant/50">
                Optional default provider to use when an agent does not have a working provider config.
              </p>
            </div>

            <button
              className="rounded-lg px-3 py-2 text-sm font-semibold text-on-primary disabled:opacity-40"
              disabled={savingFallback}
              onClick={() => void saveFallback()}
              style={{ background: 'var(--primary)' }}
              type="button"
            >
              {savingFallback ? 'Saving…' : 'Save fallback'}
            </button>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <select
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none"
              onChange={(event) => {
                const providerName = event.target.value || null;
                setFallback({
                  providerName: providerName as FallbackProvider['providerName'],
                  model: providerName ? providerModels[providerName]?.[0]?.id ?? null : null,
                });
              }}
              style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}
              value={fallback.providerName ?? ''}
            >
              <option value="">No fallback</option>
              {providers.filter((provider) => provider.isConfigured).map((provider) => (
                <option key={provider.providerName} value={provider.providerName}>{provider.label}</option>
              ))}
            </select>

            <select
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none disabled:opacity-40"
              disabled={!fallback.providerName}
              onChange={(event) => setFallback((current) => ({ ...current, model: event.target.value || null }))}
              style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}
              value={fallback.model ?? ''}
            >
              <option value="">Select model</option>
              {fallbackModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>
        </section>
      </div>
    </main>
  );
}
