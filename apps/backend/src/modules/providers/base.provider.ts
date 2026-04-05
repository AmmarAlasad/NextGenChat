/**
 * Base LLM Provider — Abstract Class
 *
 * Phase 4 implementation status:
 * - Provides the shared provider surface for all LLM integrations.
 * - stream() default falls back to complete() as a single chunk; subclasses override with real SSE.
 * - OpenAIProvider overrides stream() with native SSE (stream: true).
 * - Future providers (Anthropic, Kimi) should also override stream().
 */

import type { FinishReason, LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from '@nextgenchat/types';

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: 'openai' | 'openai-codex-oauth' | 'anthropic' | 'kimi' | 'openrouter';
  abstract readonly supportedModels: string[];

  constructor(readonly apiKey: string, readonly model: string) {}

  abstract complete(options: LLMRequestOptions): Promise<LLMResponse>;

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk> {
    // Default fallback: providers that support native SSE override this method.
    // Yields the full response as a single chunk so callers always get a terminal
    // chunk with finishReason + usage regardless of whether real streaming is used.
    const response = await this.complete(options);
    yield {
      delta: response.content,
      finishReason: response.finishReason as FinishReason,
      responseId: response.id,
      usage: response.usage,
      providerMetadata: response.providerMetadata,
    };
  }

  async countTokens(options: LLMRequestOptions['messages']) {
    return options.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 4, 0);
  }
}
