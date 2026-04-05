/**
 * OpenAI Provider — API Key Auth
 *
 * Phase 4 implementation status:
 * - Implements OpenAI Chat Completions API with tool-call support.
 * - complete() handles tool rounds (non-streaming, returns full JSON).
 * - stream() implements real SSE via stream:true; only used for final text rounds.
 * - o1/o3 reasoning models don't support streaming — falls back to complete()-as-chunk.
 * - Future: retries, prompt caching headers.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolChoiceOption } from 'openai/resources/chat/completions';

import type { FinishReason, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk } from '@nextgenchat/types';

import { BaseProvider } from '@/modules/providers/base.provider.js';

function mapRole(role: LLMMessage['role']) {
  if (role === 'system') {
    return 'developer';
  }

  return role;
}

function mapMessage(message: LLMMessage): ChatCompletionMessageParam {
  if (message.role === 'assistant' && message.toolCalls) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? '',
    };
  }

  return {
    role: mapRole(message.role) as 'developer' | 'user' | 'assistant',
    content: message.content,
  };
}

function mapTools(tools: LLMRequestOptions['tools']): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function mapToolChoice(toolChoice: LLMRequestOptions['toolChoice']): ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice.type === 'auto') {
    return 'auto';
  }

  if (toolChoice.type === 'required') {
    return 'required';
  }

  return {
    type: 'function',
    function: {
      name: toolChoice.name,
    },
  };
}

function usesMaxCompletionTokens(model: string) {
  return model.startsWith('gpt-5') || model.startsWith('o');
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai' as const;

  readonly supportedModels = ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3', 'o3-mini'];

  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    this.client = new OpenAI({ apiKey });
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages.map(mapMessage),
      tools: mapTools(options.tools),
      tool_choice: mapToolChoice(options.toolChoice),
      temperature: options.temperature,
      ...(usesMaxCompletionTokens(this.model)
        ? { max_completion_tokens: options.maxTokens }
        : { max_tokens: options.maxTokens }),
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';
    const usage = response.usage;

    return {
      id: response.id,
      content,
      finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      toolCalls: choice?.message?.tool_calls
        ?.filter((toolCall) => toolCall.type === 'function')
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        cachedTokens:
          (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      providerMetadata: {
        model: this.model,
      },
    };
  }

  // o1 and o3 reasoning models do not support stream:true.
  private get supportsStreaming() {
    return !this.model.startsWith('o1') && !this.model.startsWith('o3');
  }

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk> {
    // Fall back to single-chunk for models that don't support SSE.
    if (!this.supportsStreaming) {
      yield* super.stream(options);
      return;
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages.map(mapMessage),
      tools: mapTools(options.tools),
      tool_choice: mapToolChoice(options.toolChoice),
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(usesMaxCompletionTokens(this.model)
        ? { max_completion_tokens: options.maxTokens }
        : { max_tokens: options.maxTokens }),
    });

    // Accumulate tool call deltas in case any slip through (defensive — gateway
    // only calls stream() on final text rounds with no tools offered).
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = 'stop';
    let responseId = '';
    let usage: LLMStreamChunk['usage'];

    for await (const chunk of response) {
      if (!responseId && chunk.id) responseId = chunk.id;

      const choice = chunk.choices[0];

      if (choice?.finish_reason === 'tool_calls') finishReason = 'tool_calls';
      else if (choice?.finish_reason === 'length') finishReason = 'length';

      const delta = choice?.delta;

      // Yield text deltas immediately so the gateway can stream them to the socket.
      if (delta?.content) {
        yield { delta: delta.content };
      }

      // Buffer any tool call fragments (should be empty in pure text rounds).
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const buf = toolCallBuffers.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name += tc.function.name;
          if (tc.function?.arguments) buf.args += tc.function.arguments;
          toolCallBuffers.set(tc.index, buf);
        }
      }

      // OpenAI sends usage in the last chunk when stream_options.include_usage is set.
      const chunkUsage = (chunk as unknown as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage;
      if (chunkUsage) {
        usage = {
          promptTokens: chunkUsage.prompt_tokens,
          completionTokens: chunkUsage.completion_tokens,
          totalTokens: chunkUsage.total_tokens,
          cachedTokens: chunkUsage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
    }

    // Terminal chunk — signals end of stream with metadata for persistence.
    yield {
      delta: '',
      finishReason,
      responseId,
      usage,
      providerMetadata: {
        model: this.model,
        toolCalls: toolCallBuffers.size > 0
          ? Array.from(toolCallBuffers.values()).map((buf) => ({
              id: buf.id,
              name: buf.name,
              arguments: buf.args,
            }))
          : undefined,
      },
    };
  }
}
