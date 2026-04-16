/**
 * LLM Provider Types & Schemas
 *
 * Phase 1 implementation status:
 * - This file now supports the first working OpenAI-backed provider slice.
 * - Current scope covers request/response normalization for one local-first agent.
 * - Future phases will deepen token counting, native streaming metadata, and tools.
 *
 * Defines the unified interface all 5 LLM providers implement:
 * - OpenAI (API key)
 * - OpenAI Codex OAuth (OAuth 2.0 flow)
 * - Anthropic (API key, prompt caching)
 * - Kimi K2.5 / Moonshot (API key, OpenAI-compatible)
 * - OpenRouter (API key, OpenAI-compatible, multi-model)
 *
 * Also defines:
 * - LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk
 * - Provider configuration schema (for admin UI)
 * - Token usage tracking types (stored in Message.metadata)
 *
 * Credentials are NEVER part of these types on the client side.
 * They exist only in ProviderConfig DB rows, encrypted at rest.
 */

import { z } from 'zod';

// ── Provider Names ─────────────────────────────────────

export const ProviderName = z.enum([
  'openai',
  'openai-codex-oauth',
  'anthropic',
  'kimi',
  'openrouter',
]);
export type ProviderName = z.infer<typeof ProviderName>;

// ── LLM Message ────────────────────────────────────────

export const LLMMessageRole = z.enum(['system', 'user', 'assistant', 'tool']);
export type LLMMessageRole = z.infer<typeof LLMMessageRole>;

export interface LLMTextContentBlock {
  type: 'text';
  text: string;
}

export interface LLMImageContentBlock {
  type: 'image';
  mimeType: string;
  dataBase64: string;
}

export type LLMContentBlock = LLMTextContentBlock | LLMImageContentBlock;

export interface LLMMessage {
  role: LLMMessageRole;
  content: string | LLMContentBlock[];
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

// ── LLM Request ────────────────────────────────────────

export interface LLMRequestOptions {
  messages: LLMMessage[];
  tools?: LLMTool[];
  toolChoice?: LLMToolChoice;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  systemPrompt?: string;
  abortSignal?: unknown;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type LLMToolChoice =
  | { type: 'auto' }
  | { type: 'required' }
  | { type: 'function'; name: string };

// ── LLM Response ───────────────────────────────────────

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number; // Anthropic cache hits / OpenAI prefix cache
}

export interface LLMResponse {
  id: string;
  content: string;
  finishReason: FinishReason;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  providerMetadata?: Record<string, unknown>;
}

// ── LLM Stream Chunk ───────────────────────────────────

export interface LLMStreamChunk {
  delta: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  responseId?: string;
  usage?: TokenUsage;
  providerMetadata?: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly supportedModels: string[];
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk>;
  countTokens(messages: LLMMessage[]): Promise<number>;
}

// ── Provider Config (admin-facing, no raw credentials) ─

export const ProviderConfigSchema = z.object({
  providerName: ProviderName,
  model: z.string().min(1),
  config: z.object({
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().positive().default(4096),
  }).optional(),
});
export type ProviderConfigInput = z.infer<typeof ProviderConfigSchema>;

// ── Provider Credential Setup (admin only, backend only) ─

export const SetProviderCredentialsSchema = z.object({
  providerName: ProviderName,
  model: z.string().min(1),
  credentials: z.object({
    apiKey: z.string().min(1).optional(),
  }),
  config: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
});
export type SetProviderCredentials = z.infer<typeof SetProviderCredentialsSchema>;
