/**
 * Agent Types & Schemas
 *
 * Phase 1 implementation status:
 * - This file now covers the minimal local-first agent slice used in Milestone 1.
 * - Current scope includes listing a single active channel agent and its identity.
 * - Future phases will expand memory, tool approval, cron, and analytics contracts.
 *
 * Defines contracts for the AI agent system:
 * - Agent CRUD (create, update, archive)
 * - Agent identity (persona, voice tone, avatar)
 * - Agent memory (global, channel, user scopes)
 * - Agent tools (approval, execution schema)
 * - Agent cron / heartbeat schedules
 * - Agent channel membership
 * - Agent trigger modes
 *
 * Agents use the LLM Provider Layer (see providers.ts)
 * and Context Management (see context.ts) for their message pipeline.
 */

import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────

export const AgentStatus = z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentTriggerMode = z.enum(['AUTO', 'MENTIONS_ONLY', 'ALL_MESSAGES', 'DISABLED']);
export type AgentTriggerMode = z.infer<typeof AgentTriggerMode>;

export const MemoryScope = z.enum(['GLOBAL', 'CHANNEL', 'USER']);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const AgentSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: AgentStatus,
  triggerMode: AgentTriggerMode,
  systemPrompt: z.string().nullable(),
  persona: z.string().nullable(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentDetailSchema = AgentSummarySchema.extend({
  primaryChannelId: z.string().uuid().nullable(),
  voiceTone: z.string().nullable(),
  activeChannelIds: z.array(z.string().uuid()).default([]),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

// ── Agent CRUD ─────────────────────────────────────────

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  systemPrompt: z.string().max(10_000).optional(),
  persona: z.string().max(2_000).optional(),
  voiceTone: z.string().max(200).optional(),
  triggerMode: AgentTriggerMode.default('AUTO'),
});
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

export const UpdateAgentSchema = CreateAgentSchema.partial().extend({
  status: AgentStatus.optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

export const AgentRoutingReasonSchema = z.object({
  agentId: z.string().uuid(),
  score: z.number(),
  decision: z.enum(['IGNORE', 'OPTIONAL', 'RESPOND']),
  reason: z.string(),
});
export type AgentRoutingReason = z.infer<typeof AgentRoutingReasonSchema>;

// ── Agent Memory ───────────────────────────────────────

export const AgentMemoryEntrySchema = z.object({
  scope: MemoryScope,
  key: z.string().min(1).max(256),
  value: z.unknown(), // JSONB — agent decides structure
});
export type AgentMemoryEntry = z.infer<typeof AgentMemoryEntrySchema>;

// ── Agent Tool ─────────────────────────────────────────

export const AgentToolSchema = z.object({
  toolName: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});
export type AgentToolInput = z.infer<typeof AgentToolSchema>;

// ── Agent Cron ─────────────────────────────────────────

export const AgentCronSchema = z.object({
  schedule: z.string().min(1), // cron expression, e.g. "0 9 * * 1-5"
  task: z.string().min(1).max(2_000),
});
export type AgentCronInput = z.infer<typeof AgentCronSchema>;
