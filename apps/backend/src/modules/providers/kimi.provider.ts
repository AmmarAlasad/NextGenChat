/**
 * Kimi K2.5 Provider — Moonshot AI, OpenAI-Compatible API
 *
 * Extends OpenAIProvider — only overrides:
 * - name: 'kimi'
 * - baseURL: https://api.moonshot.cn/v1
 * - supportedModels: kimi-k2-5, moonshot-v1-8k/32k/128k
 * - contextLimits: kimi-k2-5=131072 tokens
 *
 * The Moonshot API is 100% OpenAI-compatible:
 * - Same SSE streaming format
 * - Same function calling format
 * - Same Authorization: Bearer header
 *
 * Token counting: tiktoken (approximate — Moonshot doesn't expose a counting endpoint)
 * Default context: 128K — Kimi K2.5 handles long context natively
 */

// TODO: Implement Kimi provider (extend OpenAI)
export {};
