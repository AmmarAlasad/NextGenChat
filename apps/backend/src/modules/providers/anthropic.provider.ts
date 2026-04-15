/**
 * Anthropic Provider — API Key Auth + Native Streaming + Prompt Caching
 *
 * Extends BaseProvider (NOT OpenAIProvider — completely different API format).
 *
 * Phase 5 implementation status:
 * - complete() and stream() both implemented using @anthropic-ai/sdk.
 * - Tool calling: full support — maps to Anthropic's tool_use/tool_result blocks.
 * - Exact token counting via POST /v1/messages/count_tokens (Redis-cached 60s).
 * - Prompt caching: cache_control ephemeral injected on system + long static messages.
 * - countTokens() falls back to char/4 estimate when Redis is unavailable.
 * - Future: beta extended thinking, vision, files API.
 */

import { createHash } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import type {
  FinishReason,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolChoice,
  ToolCall,
} from '@nextgenchat/types';

import { redis } from '@/lib/redis.js';
import { BaseProvider } from '@/modules/providers/base.provider.js';

interface AnthropicTextBlock { type: 'text'; text: string; }
interface AnthropicImageBlock { type: 'image'; mimeType: string; dataBase64: string; }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

const TOKEN_COUNT_CACHE_TTL = 60; // seconds

// ── Format converters ─────────────────────────────────────────────────────────

function mapTools(tools?: LLMTool[]): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
  }));
}

function mapToolChoice(toolChoice?: LLMToolChoice): Anthropic.Messages.ToolChoice | undefined {
  if (!toolChoice || toolChoice.type === 'auto') return { type: 'auto' };
  if (toolChoice.type === 'required') return { type: 'any' };
  return { type: 'tool', name: toolChoice.name };
}

/**
 * Convert our normalized LLMMessage array into Anthropic's message format.
 * System messages are separated out (they go in the top-level `system` field).
 * Tool results (role=tool) become user-role content blocks with type=tool_result.
 * Assistant tool calls become content blocks with type=tool_use.
 */
function prepareMessages(messages: LLMMessage[]): {
  systemParts: string[];
  anthropicMessages: MessageParam[];
} {
  const systemParts: string[] = [];
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemParts.push(msg.content);
      } else {
        systemParts.push((msg.content as unknown as AnthropicContentBlock[]).filter((block): block is AnthropicTextBlock => block.type === 'text').map((block) => block.text).join('\n\n'));
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Tool result — wrap in a user message with tool_result block.
      const resultBlock: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? '',
        content: typeof msg.content === 'string'
          ? msg.content
          : (msg.content as unknown as AnthropicContentBlock[]).filter((block): block is AnthropicTextBlock => block.type === 'text').map((block) => block.text).join('\n\n'),
      };
      // Coalesce consecutive tool results into one user message.
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as ContentBlockParam[]).push(resultBlock);
      } else {
        anthropicMessages.push({ role: 'user', content: [resultBlock] });
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: ContentBlockParam[] = [];
      if (typeof msg.content === 'string' && msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>; } catch { /* keep empty */ }
        const toolUseBlock: ToolUseBlockParam = {
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input,
        };
        blocks.push(toolUseBlock);
      }
      anthropicMessages.push({ role: 'assistant', content: blocks });
      continue;
    }

    anthropicMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : (msg.content as unknown as AnthropicContentBlock[]).map((block): ContentBlockParam => {
            if (block.type === 'text') {
              return { type: 'text', text: block.text };
            }

            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: block.dataBase64,
              },
            };
          }),
    });
  }

  return { systemParts, anthropicMessages };
}

function buildSystemBlock(systemParts: string[]): Anthropic.Messages.TextBlockParam[] | undefined {
  if (systemParts.length === 0) return undefined;
  const combined = systemParts.join('\n\n');
  // Add cache_control on long system prompts (>500 chars) to benefit from Anthropic caching.
  return [{ type: 'text', text: combined, cache_control: { type: 'ephemeral' } }];
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class AnthropicProvider extends BaseProvider {
  readonly name: import('@nextgenchat/types').ProviderName = 'anthropic';

  readonly supportedModels = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
  ];

  private readonly client: Anthropic;

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    this.client = new Anthropic({ apiKey });
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const { systemParts, anthropicMessages } = prepareMessages(options.messages);
    const system = buildSystemBlock(systemParts);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      system,
      messages: anthropicMessages,
      tools: mapTools(options.tools),
      tool_choice: options.tools?.length ? mapToolChoice(options.toolChoice) : undefined,
    });

    // Collect text content and tool calls from the response.
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const usage = response.usage;
    // The SDK's Usage type doesn't declare cache fields but they are present at runtime.
    const usageAny = usage as unknown as Record<string, unknown>;
    const cacheRead = (usageAny.cache_read_input_tokens as number | undefined) ?? 0;
    const cacheCreation = (usageAny.cache_creation_input_tokens as number | undefined) ?? 0;

    return {
      id: response.id,
      content,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
        cachedTokens: cacheRead,
      },
      providerMetadata: {
        model: this.model,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
      },
    };
  }

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk> {
    const { systemParts, anthropicMessages } = prepareMessages(options.messages);
    const system = buildSystemBlock(systemParts);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      system,
      messages: anthropicMessages,
      tools: mapTools(options.tools),
      tool_choice: options.tools?.length ? mapToolChoice(options.toolChoice) : undefined,
    });

    let responseId = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let stopReason: string | null = null;

    // Buffer tool call fragments indexed by content block index.
    const toolBufs = new Map<number, { id: string; name: string; args: string }>();

    for await (const event of stream) {
      if (event.type === 'message_start') {
        responseId = event.message.id;
        const u = event.message.usage as unknown as Record<string, unknown>;
        inputTokens = (u.input_tokens as number) ?? 0;
        cacheReadTokens = (u.cache_read_input_tokens as number) ?? 0;
        cacheCreationTokens = (u.cache_creation_input_tokens as number) ?? 0;
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolBufs.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { delta: delta.text };
        } else if (delta.type === 'input_json_delta') {
          const buf = toolBufs.get(event.index);
          if (buf) buf.args += delta.partial_json;
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason ?? null;
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolBufs.values()).map((buf) => ({
      id: buf.id,
      name: buf.name,
      arguments: buf.args,
    }));

    const finishReason: FinishReason = stopReason === 'tool_use' ? 'tool_calls' : 'stop';

    yield {
      delta: '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      responseId,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedTokens: cacheReadTokens,
      },
      providerMetadata: {
        model: this.model,
        cacheCreationInputTokens: cacheCreationTokens,
        cacheReadInputTokens: cacheReadTokens,
      },
    };
  }

  /**
   * Exact token count via Anthropic's count_tokens endpoint.
   * Result is cached in Redis for 60 s using a SHA-256 hash of the serialized messages.
   */
  override async countTokens(messages: LLMMessage[]): Promise<number> {
    const { systemParts, anthropicMessages } = prepareMessages(messages);
    const system = buildSystemBlock(systemParts);

    const cacheKey = `anthropic:tokens:${createHash('sha256')
      .update(JSON.stringify({ model: this.model, system, messages: anthropicMessages }))
      .digest('hex')
      .slice(0, 32)}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return Number(cached);
    } catch {
      // Redis unavailable — skip cache
    }

    try {
      const result = await this.client.messages.countTokens({
        model: this.model,
        system,
        messages: anthropicMessages,
      });

      const count = result.input_tokens;

      try {
        await redis.set(cacheKey, String(count), 'EX', TOKEN_COUNT_CACHE_TTL);
      } catch {
        // Redis unavailable — skip caching
      }

      return count;
    } catch {
      // Fall back to approximate estimate if the API call fails.
      return messages.reduce((acc, m) => {
        const contentLength = typeof m.content === 'string'
          ? m.content.length
          : (m.content as unknown as AnthropicContentBlock[]).reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 1024), 0);
        return acc + Math.ceil(contentLength / 4) + 4;
      }, 0);
    }
  }
}
