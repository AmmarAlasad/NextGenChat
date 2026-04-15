/**
 * Provider Registry — Singleton
 *
 * Resolves and caches LLM provider instances per agent.
 *
 * Credential resolution order (first non-empty wins):
 *   1. Per-agent ProviderConfig.credentials (encrypted JSON with apiKey or oauth tokens)
 *   2. GlobalProviderConfig for the same providerName (shared workspace credential)
 *   3. Environment variable fallback (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
 *
 * Phase 5 implementation status:
 * - Supports all five providers: openai, anthropic, kimi, openrouter, openai-codex-oauth.
 * - Instances cached by providerName:model:agentId; invalidated on credential update via
 *   invalidate(agentId) — called from providers.routes.ts after PUT /providers/:name.
 * - Future: per-tenant credential scoping, provider health checks.
 */

import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { decryptJson } from '@/lib/crypto.js';
import { AnthropicProvider } from '@/modules/providers/anthropic.provider.js';
import { KimiProvider } from '@/modules/providers/kimi.provider.js';
import { OpenAICodexOAuthProvider, decryptOAuthCredentials } from '@/modules/providers/openai-codex-oauth.provider.js';
import type { OAuthCredentials } from '@/modules/providers/openai-codex-oauth.provider.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';
import { OpenRouterProvider } from '@/modules/providers/openrouter.provider.js';
import type { BaseProvider } from '@/modules/providers/base.provider.js';

// ── ENV fallbacks (used when no DB credential is configured) ─────────────────

const ENV_FALLBACKS: Record<string, string | undefined> = {
  openai: env.OPENAI_API_KEY || undefined,
  anthropic: (process.env.ANTHROPIC_API_KEY as string | undefined),
  kimi: (process.env.KIMI_API_KEY as string | undefined),
  openrouter: (process.env.OPENROUTER_API_KEY as string | undefined),
};

// ── Registry ──────────────────────────────────────────────────────────────────

class ProviderRegistry {
  private static _instance: ProviderRegistry | null = null;

  private readonly cache = new Map<string, BaseProvider>();

  static getInstance() {
    if (!ProviderRegistry._instance) {
      ProviderRegistry._instance = new ProviderRegistry();
    }
    return ProviderRegistry._instance;
  }

  /** Remove all cached instances for this agent so next get() rebuilds fresh. */
  invalidate(agentId: string) {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${agentId}`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Remove all cached instances for a given provider name (e.g. after global cred update). */
  invalidateProvider(providerName: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${providerName}:`)) {
        this.cache.delete(key);
      }
    }
  }

  async get(agentId: string): Promise<BaseProvider> {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { providerConfig: true },
    });

    if (!agent?.providerConfig) {
      throw new Error('Agent provider configuration is missing.');
    }

    const { providerName, model } = agent.providerConfig;
    const cacheKey = `${providerName}:${model}:${agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const provider = await this.buildProvider(providerName, model, agent.providerConfig.credentials);
    this.cache.set(cacheKey, provider);
    return provider;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the API key (or OAuth credentials) for a provider.
   * Resolution order: per-agent encrypted credentials → global config → env var.
   */
  private async resolveApiKey(
    providerName: string,
    agentCredentials: string,
  ): Promise<string | undefined> {
    // 1. Per-agent credentials
    try {
      const dec = decryptJson<{ apiKey?: string }>(agentCredentials);
      if (dec?.apiKey) return dec.apiKey;
    } catch {
      // invalid or empty — fall through
    }

    // 2. Global provider config
    try {
      const global = await prisma.globalProviderConfig.findUnique({
        where: { providerName },
      });
      if (global?.isActive) {
        const dec = decryptJson<{ apiKey?: string }>(global.credentials);
        if (dec?.apiKey) return dec.apiKey;
      }
    } catch {
      // no global config or decrypt error — fall through
    }

    // 3. Env var
    return ENV_FALLBACKS[providerName];
  }

  private async resolveOAuthCredentials(
    agentCredentials: string,
  ): Promise<OAuthCredentials | undefined> {
    // 1. Per-agent credentials (edge case — OAuth is normally global)
    try {
      const dec = decryptJson<OAuthCredentials>(agentCredentials);
      if (dec?.accessToken) return dec;
    } catch {
      // fall through
    }

    // 2. Global provider config
    try {
      const global = await prisma.globalProviderConfig.findUnique({
        where: { providerName: 'openai-codex-oauth' },
      });
      if (global?.isActive) {
        return decryptOAuthCredentials(global.credentials);
      }
    } catch {
      // no global config — fall through
    }

    return undefined;
  }

  private async buildProvider(
    providerName: string,
    model: string,
    agentCredentials: string,
  ): Promise<BaseProvider> {
    switch (providerName) {
      case 'openai': {
        const apiKey = await this.resolveApiKey('openai', agentCredentials);
        if (!apiKey) throw new Error('OpenAI API key is not configured. Add it in Settings → Providers.');
        return new OpenAIProvider(apiKey, model);
      }

      case 'anthropic': {
        const apiKey = await this.resolveApiKey('anthropic', agentCredentials);
        if (!apiKey) throw new Error('Anthropic API key is not configured. Add it in Settings → Providers.');
        return new AnthropicProvider(apiKey, model);
      }

      case 'kimi': {
        const apiKey = await this.resolveApiKey('kimi', agentCredentials);
        if (!apiKey) throw new Error('Kimi API key is not configured. Add it in Settings → Providers.');
        return new KimiProvider(apiKey, model);
      }

      case 'openrouter': {
        const apiKey = await this.resolveApiKey('openrouter', agentCredentials);
        if (!apiKey) throw new Error('OpenRouter API key is not configured. Add it in Settings → Providers.');
        return new OpenRouterProvider(apiKey, model);
      }

      case 'openai-codex-oauth': {
        const oauthCreds = await this.resolveOAuthCredentials(agentCredentials);
        if (!oauthCreds) throw new Error('OpenAI Codex OAuth is not connected. Connect it in Settings → Providers.');
        return new OpenAICodexOAuthProvider(oauthCreds, model);
      }

      default:
        throw new Error(`Unknown provider: "${providerName}". Supported: openai, anthropic, kimi, openrouter, openai-codex-oauth.`);
    }
  }
}

export const providerRegistry = ProviderRegistry.getInstance();

// ── Convenience helper used by providers.routes.ts ────────────────────────────

export function buildProviderInstance(providerName: string, model: string, apiKey: string): BaseProvider {
  switch (providerName) {
    case 'openai': return new OpenAIProvider(apiKey, model);
    case 'anthropic': return new AnthropicProvider(apiKey, model);
    case 'kimi': return new KimiProvider(apiKey, model);
    case 'openrouter': return new OpenRouterProvider(apiKey, model);
    default: throw new Error(`Cannot build provider instance for "${providerName}".`);
  }
}
