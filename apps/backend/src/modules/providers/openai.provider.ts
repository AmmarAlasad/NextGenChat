/**
 * OpenAI Provider — API Key Auth
 *
 * Phase 1 implementation status:
 * - This file now implements the first real OpenAI provider integration.
 * - Current scope uses the OpenAI Chat Completions API for text generation with a local-only
 *   single-agent workflow.
 * - Future phases should add native SSE streaming, retries, and function calling.
 */

import OpenAI from 'openai';

import type { LLMMessage, LLMRequestOptions, LLMResponse } from '@nextgenchat/types';

import { BaseProvider } from '@/modules/providers/base.provider.js';

function mapRole(role: LLMMessage['role']) {
  if (role === 'system') {
    return 'developer';
  }

  return role;
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai' as const;

  readonly supportedModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3', 'o3-mini'];

  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    this.client = new OpenAI({ apiKey });
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages.map((message) => ({
        role: mapRole(message.role) as 'system' | 'user' | 'assistant',
        content: message.content,
      })),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage;

    return {
      id: response.id,
      content,
      finishReason: 'stop',
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      providerMetadata: {
        model: this.model,
      },
    };
  }
}
