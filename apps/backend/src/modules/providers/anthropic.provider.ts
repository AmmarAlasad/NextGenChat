/**
 * Anthropic Provider — API Key Auth + Prompt Caching
 *
 * Extends BaseProvider (NOT OpenAIProvider — different API format).
 *
 * Key differences from OpenAI:
 * - Auth: x-api-key header (not Authorization: Bearer)
 * - Required header: anthropic-version: 2023-06-01
 * - Streaming: SSE with event: + data: pairs, parse content_block_delta events
 * - Tool calling: Anthropic-specific format (adapter normalizes to LLMTool)
 * - Token counting: EXACT via POST /v1/messages/count_tokens (not tiktoken)
 *   Result cached in Redis 60s using SHA-256(messages) as key
 *
 * Prompt Caching (unique to Anthropic):
 * - addCacheBreakpoints() inserts cache_control: { type: "ephemeral" }
 *   after last static message (system prompt + memory + summary boundary)
 * - Cache TTL: 5 minutes (Anthropic-managed)
 * - Tracks cache_creation_input_tokens vs cache_read_input_tokens
 * - Both stored in Message.metadata for cost analytics
 *
 * Models: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
 * Context limits: all 200K tokens
 */

// TODO: Implement Anthropic provider
export {};
