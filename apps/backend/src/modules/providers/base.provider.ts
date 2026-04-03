/**
 * Base LLM Provider — Abstract Class
 *
 * Phase 1 implementation status:
 * - This file now provides the shared provider surface used by the first OpenAI-backed flow.
 * - Current scope handles normalized completion responses and a fallback chunked stream helper.
 * - Future phases should add native SSE parsing, retries, and richer tool-call support here.
 */

import type { FinishReason, LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from '@nextgenchat/types';

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: 'openai' | 'openai-codex-oauth' | 'anthropic' | 'kimi' | 'openrouter';
  abstract readonly supportedModels: string[];

  constructor(readonly apiKey: string, readonly model: string) {}

  abstract complete(options: LLMRequestOptions): Promise<LLMResponse>;

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk> {
    const response = await this.complete(options);
    const chunks = response.content.match(/.{1,40}(\s|$)/g) ?? [response.content];

    for (const chunk of chunks) {
      yield { delta: chunk };
    }

    yield {
      delta: '',
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
