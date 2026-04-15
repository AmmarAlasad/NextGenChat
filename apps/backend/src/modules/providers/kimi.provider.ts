/**
 * Kimi K2.5 Provider — Moonshot AI, OpenAI-Compatible API
 *
 * Extends OpenAIProvider — the Moonshot API is 100% OpenAI-compatible.
 * Only differences: base URL, supported model list.
 *
 * Phase 5 implementation status:
 * - Fully functional: inherits complete(), stream(), countTokens() from OpenAIProvider.
 * - Supports kimi-k2-5 (131K context) and all moonshot-v1-* context variants.
 * - Token counting: tiktoken (approximate — Moonshot has no counting endpoint).
 * - Future: dedicated token counter if Moonshot adds a /count_tokens endpoint.
 */

import OpenAI from 'openai';

import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

const KIMI_BASE_URL = 'https://api.moonshot.cn/v1';

export class KimiProvider extends OpenAIProvider {
  override readonly name: import('@nextgenchat/types').ProviderName = 'kimi';

  override readonly supportedModels = [
    'kimi-k2-5',
    'moonshot-v1-8k',
    'moonshot-v1-32k',
    'moonshot-v1-128k',
  ];

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    // Override the parent's client with one pointed at Moonshot's endpoint.
    (this as unknown as { client: OpenAI }).client = new OpenAI({
      apiKey,
      baseURL: KIMI_BASE_URL,
    });
  }
}
