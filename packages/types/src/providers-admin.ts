/**
 * Provider Administration Types & Schemas
 *
 * Shared contracts for the provider management system:
 * - Global credential CRUD (Settings → Providers)
 * - Per-agent provider selection
 * - Model listing (OpenRouter catalogue)
 * - Fallback provider configuration
 *
 * Phase 5 implementation status:
 * - Full CRUD schemas for GlobalProviderConfig.
 * - Fallback provider setting schema.
 * - Model listing types for the admin UI.
 * - Future: OAuth connection status, usage analytics per provider.
 */

import { z } from 'zod';

import { ProviderName } from './providers.js';

// ── Provider status (returned by GET /providers) ───────────────────────────

export const ProviderStatusSchema = z.object({
  providerName: ProviderName,
  label: z.string(),
  authKind: z.enum(['api_key', 'oauth']),
  isConfigured: z.boolean(),
  isActive: z.boolean(),
  /** Only set for OAuth providers when connected. */
  oauthExpiresAt: z.string().nullable().optional(),
  usage: z.object({
    source: z.enum(['live', 'app', 'none']),
    summary: z.string().nullable(),
    error: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
    windows: z.array(z.object({
      label: z.string(),
      usedPercent: z.number().min(0).max(100),
      resetAt: z.string().nullable().optional(),
    })),
    assistantTurns: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    lastActivityAt: z.string().nullable().optional(),
  }).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

// ── Set global credentials ─────────────────────────────────────────────────

export const SetApiKeyCredentialSchema = z.object({
  providerName: ProviderName,
  apiKey: z.string().min(1, 'API key is required'),
});
export type SetApiKeyCredentialInput = z.infer<typeof SetApiKeyCredentialSchema>;

// ── Per-agent provider update ──────────────────────────────────────────────

export const UpdateAgentProviderSchema = z.object({
  providerName: ProviderName,
  model: z.string().min(1),
});
export type UpdateAgentProviderInput = z.infer<typeof UpdateAgentProviderSchema>;

// ── Fallback provider ──────────────────────────────────────────────────────

export const SetFallbackProviderSchema = z.object({
  /** null means "no fallback — let each agent fail on its own". */
  providerName: ProviderName.nullable(),
  model: z.string().min(1).nullable(),
});
export type SetFallbackProviderInput = z.infer<typeof SetFallbackProviderSchema>;

export const FallbackProviderSchema = z.object({
  providerName: ProviderName.nullable(),
  model: z.string().nullable(),
});
export type FallbackProvider = z.infer<typeof FallbackProviderSchema>;

// ── Model list (OpenRouter catalogue) ─────────────────────────────────────

export const ProviderModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number().int().positive(),
  pricing: z
    .object({ prompt: z.string(), completion: z.string() })
    .optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelsResponseSchema = z.object({
  providerName: z.string(),
  models: z.array(ProviderModelSchema),
});
export type ProviderModelsResponse = z.infer<typeof ProviderModelsResponseSchema>;

// ── Static model lists (for non-OpenRouter providers) ─────────────────────

export const STATIC_PROVIDER_MODELS: Record<string, ProviderModel[]> = {
  openai: [
    { id: 'gpt-5.4', name: 'GPT-5.4', contextLength: 128_000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', contextLength: 128_000 },
    { id: 'gpt-4o', name: 'GPT-4o', contextLength: 128_000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextLength: 128_000 },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextLength: 128_000 },
    { id: 'o1', name: 'o1', contextLength: 200_000 },
    { id: 'o3', name: 'o3', contextLength: 200_000 },
    { id: 'o3-mini', name: 'o3-mini', contextLength: 200_000 },
  ],
  anthropic: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextLength: 200_000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 200_000 },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', contextLength: 200_000 },
    { id: 'claude-sonnet-4-1', name: 'Claude Sonnet 4.1', contextLength: 200_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextLength: 200_000 },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextLength: 200_000 },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextLength: 200_000 },
  ],
  kimi: [
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextLength: 262_144 },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextLength: 262_144 },
    { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextLength: 262_144 },
    { id: 'kimi-k2-turbo', name: 'Kimi K2 Turbo', contextLength: 256_000 },
  ],
  'openai-codex-oauth': [
    { id: 'gpt-5.4', name: 'GPT-5.4', contextLength: 1_050_000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', contextLength: 272_000 },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextLength: 272_000 },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextLength: 128_000 },
  ],
};

// ── Provider metadata (for the UI cards) ──────────────────────────────────

export const PROVIDER_METADATA: Record<string, {
  label: string;
  description: string;
  authKind: 'api_key' | 'oauth';
  docsUrl?: string;
}> = {
  openai: {
    label: 'OpenAI',
    description: 'GPT-5.4, GPT-4o, o-series reasoning models via OpenAI API.',
    authKind: 'api_key',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    description: 'Claude Opus, Sonnet, and Haiku models via Anthropic API.',
    authKind: 'api_key',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    description: 'Kimi K2.5 and K2 reasoning variants via Moonshot API.',
    authKind: 'api_key',
    docsUrl: 'https://platform.moonshot.cn/',
  },
  openrouter: {
    label: 'OpenRouter',
    description: 'One key, 200+ models — Gemini, Llama, DeepSeek, and more.',
    authKind: 'api_key',
    docsUrl: 'https://openrouter.ai/keys',
  },
  'openai-codex-oauth': {
    label: 'OpenAI Codex (OAuth)',
    description: 'Access Codex GPT-5.x models through your ChatGPT account with OAuth.',
    authKind: 'oauth',
  },
};
