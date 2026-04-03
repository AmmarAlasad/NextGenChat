/**
 * OpenRouter Provider — Multi-Model Gateway, OpenAI-Compatible API
 *
 * Extends OpenAIProvider — adds:
 * - Base URL: https://openrouter.ai/api/v1
 * - Required headers: HTTP-Referer + X-Title (OpenRouter requires these)
 * - Model format: "provider/model-name" (e.g., "google/gemini-2.5-pro")
 * - Model discovery: GET /api/v1/models → cached in Redis for 1 hour
 * - Context limits: vary per model, fetched from model list response
 * - Cost tracking: OpenRouter returns usage.cost → stored in Message.metadata
 *
 * Admin can select any model from the discovered list when configuring an agent.
 * Token counting: tiktoken (approximate, as OpenRouter doesn't expose a counting endpoint)
 */

// TODO: Implement OpenRouter provider (extend OpenAI)
export {};
