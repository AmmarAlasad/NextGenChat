/**
 * Context Window Management Types
 *
 * Defines types for the 3-layer context management system:
 *
 * Layer 1 — Token Budgeting:
 *   Count tokens per provider (tiktoken for OpenAI/Kimi/OpenRouter,
 *   Anthropic API endpoint for Claude). Always reserve RESPONSE_BUFFER.
 *
 * Layer 2 — Auto-Compaction:
 *   When conversation exceeds context limit, summarize old messages
 *   via a cheap model (gpt-4o-mini / claude-haiku). Summary stored
 *   in ConversationSummary table. Runs async via BullMQ — never blocks.
 *
 * Layer 3 — Prompt Caching:
 *   Anthropic cache_control hints on static context (system + memory).
 *   OpenAI implicit prefix caching (keep static parts first and stable).
 *   Track cache hit/miss rates in Message.metadata for cost analytics.
 */

export interface ContextBuildResult {
  messages: import('./providers.js').LLMMessage[];
  totalTokens: number;
  budgetUsed: number;
  budgetLimit: number;
  compactionTriggered: boolean;
  summaryUsed: boolean;
}

export interface ConversationSummaryData {
  id: string;
  channelId: string;
  agentId: string;
  summary: string;
  tokenCount: number;
  coversFromMessageId: string;
  covesToMessageId: string;
  createdAt: Date;
}

export interface ContextStats {
  avgPromptTokens: number;
  avgCompletionTokens: number;
  cacheHitRate: number;      // 0-1, Anthropic only
  compactionCount: number;
  estimatedCostSavings: number;
}

/** Default token buffer reserved for the LLM response */
export const RESPONSE_BUFFER = 4096;

/** Known context limits per model (tokens) */
export const CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'o1': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'kimi-k2-5': 131_072,
  'moonshot-v1-8k': 8_192,
  'moonshot-v1-32k': 32_768,
  'moonshot-v1-128k': 131_072,
};
