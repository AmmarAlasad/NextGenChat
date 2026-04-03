/**
 * Prompt Cache Service
 *
 * Manages prompt caching strategies per LLM provider:
 *
 * Anthropic (explicit):
 * - Inserts cache_control: { type: "ephemeral" } after the last static message
 *   (boundary = system prompt + memory + conversation summary)
 * - Cache TTL: 5 minutes (Anthropic-managed, resets on each cache-creating request)
 * - Tracks cache_creation_input_tokens vs cache_read_input_tokens
 * - Optional cache warmth heartbeat: re-request every 4min if agent is active
 *
 * OpenAI (implicit):
 * - No explicit API needed — OpenAI automatically caches matching prefixes
 * - Design rule: keep system prompt + memory FIRST and UNCHANGED between requests
 * - Track cached_tokens from usage response
 *
 * All cache stats stored in Message.metadata JSONB for cost analytics.
 * Admin dashboard: GET /agents/:id/context-stats (cache hit rate, savings)
 */

// TODO: Implement cache service
export {};
