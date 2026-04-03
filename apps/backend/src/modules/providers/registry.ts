/**
 * Provider Registry — Singleton
 *
 * Phase 1 implementation status:
 * - This file now resolves the first functional provider path for agent execution.
 * - Current scope supports the local OpenAI provider and reads credentials from
 *   encrypted DB config with a local `.env` fallback.
 * - Future phases will extend this registry to the other providers and richer caching.
 */

import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { decryptJson } from '@/lib/crypto.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

type ProviderInstance = OpenAIProvider;

class ProviderRegistry {
  private static instance: ProviderRegistry | null = null;

  private readonly cache = new Map<string, ProviderInstance>();

  static getInstance() {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }

    return ProviderRegistry.instance;
  }

  async get(agentId: string) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { providerConfig: true },
    });

    if (!agent?.providerConfig) {
      throw new Error('Agent provider configuration is missing.');
    }

    const cacheKey = `${agent.providerConfig.providerName}:${agent.providerConfig.model}:${agentId}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    let decryptedCredentials: { apiKey?: string };
    try {
      decryptedCredentials = decryptJson<{ apiKey?: string }>(agent.providerConfig.credentials);
    } catch {
      decryptedCredentials = {};
    }

    const apiKey = decryptedCredentials.apiKey ?? env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }

    const provider = new OpenAIProvider(apiKey, agent.providerConfig.model);
    this.cache.set(cacheKey, provider);

    return provider;
  }
}

export const providerRegistry = ProviderRegistry.getInstance();
