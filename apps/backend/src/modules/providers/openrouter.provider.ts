/**
 * OpenRouter Provider — Multi-Model Gateway, OpenAI-Compatible API
 *
 * Extends OpenAIProvider — adds:
 * - Base URL: https://openrouter.ai/api/v1
 * - Required headers: HTTP-Referer + X-Title (OpenRouter policy requirement)
 * - Model format: "provider/model-name" (e.g. "google/gemini-2.5-pro")
 * - Model discovery: GET /api/v1/models — cached in Redis for 1 hour
 *
 * Phase 5 implementation status:
 * - complete() and stream() fully functional (inherited + header override).
 * - listModels() fetches and caches the OpenRouter model catalogue.
 * - Token counting: tiktoken (approximate — OpenRouter has no counting endpoint).
 * - Future: cost tracking (OpenRouter returns usage.cost), per-model context limits.
 */

import OpenAI from 'openai';

import { redis } from '@/lib/redis.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS_CACHE_KEY = 'openrouter:models';
const MODELS_CACHE_TTL = 60 * 60; // 1 hour

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing?: { prompt: string; completion: string };
}

export class OpenRouterProvider extends OpenAIProvider {
  override readonly name: import('@nextgenchat/types').ProviderName = 'openrouter';

  // Populated lazily via listModels(); starts with a minimal static set.
  override readonly supportedModels = [
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-6',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-r1',
  ];

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    (this as unknown as { client: OpenAI }).client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://nextgenchat.ai',
        'X-Title': 'NextGenChat',
      },
    });
  }

  /**
   * Fetch the full OpenRouter model catalogue and cache it in Redis for 1 hour.
   * Returns an array sorted alphabetically by model ID.
   */
  async listModels(): Promise<OpenRouterModelInfo[]> {
    try {
      const cached = await redis.get(MODELS_CACHE_KEY);
      if (cached) return JSON.parse(cached) as OpenRouterModelInfo[];
    } catch {
      // Redis unavailable — fetch fresh
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://nextgenchat.ai',
        'X-Title': 'NextGenChat',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter model listing failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{
        id: string;
        name: string;
        context_length: number;
        pricing?: { prompt: string; completion: string };
      }>;
    };

    const models: OpenRouterModelInfo[] = data.data
      .map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        pricing: m.pricing,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    try {
      await redis.set(MODELS_CACHE_KEY, JSON.stringify(models), 'EX', MODELS_CACHE_TTL);
    } catch {
      // Redis unavailable — skip caching
    }

    return models;
  }
}
