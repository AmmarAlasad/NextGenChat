/**
 * Chat Types & Schemas
 *
 * Phase 1 implementation status:
 * - This file now covers the first working chat slice: one workspace, one channel,
 *   persisted messages, and agent replies flowing through the normal message pipeline.
 * - Future phases will add richer reactions, attachments, read receipts, and search.
 *
 * Defines contracts for the real-time chat system:
 * - Workspaces (CRUD, membership)
 * - Channels (public, private, direct)
 * - Messages (create, edit, delete, pagination)
 * - Reactions
 * - Attachments
 * - Read receipts / unread counts
 *
 * Message.metadata is JSONB — stores provider-specific data
 * (model, token usage, cache hits) without schema migrations.
 */

import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────

export const ChannelType = z.enum(['PUBLIC', 'PRIVATE', 'DIRECT']);
export type ChannelType = z.infer<typeof ChannelType>;

export const SenderType = z.enum(['USER', 'AGENT']);
export type SenderType = z.infer<typeof SenderType>;

export const ContentType = z.enum(['TEXT', 'MARKDOWN', 'FILE', 'SYSTEM']);
export type ContentType = z.infer<typeof ContentType>;

export const WorkspaceSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const ChannelSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  name: z.string(),
  type: ChannelType,
  participantAgentIds: z.array(z.string().uuid()).default([]),
  participantAgentNames: z.array(z.string()).default([]),
  lastMessageAt: z.string().nullable().optional(),
});
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;

export const MessageRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  senderId: z.string().uuid(),
  senderType: SenderType,
  senderName: z.string().nullable().optional(),
  content: z.string(),
  contentType: ContentType,
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
});
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const ChannelSessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  channelId: z.string().uuid(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  assistantTurns: z.number().int().nonnegative(),
  totalPromptTokens: z.number().int().nonnegative(),
  totalCompletionTokens: z.number().int().nonnegative(),
  totalCachedTokens: z.number().int().nonnegative(),
  latestContextUsed: z.number().int().nonnegative().nullable(),
  latestContextLimit: z.number().int().positive().nullable(),
  latestContextUsagePercent: z.number().min(0).max(100).nullable(),
  summaryCount: z.number().int().nonnegative(),
  lastActiveAt: z.string().nullable(),
});
export type ChannelSessionSummary = z.infer<typeof ChannelSessionSummarySchema>;

// ── Workspace ──────────────────────────────────────────

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

// ── Channel ────────────────────────────────────────────

export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(100),
  type: ChannelType.default('PUBLIC'),
  agentIds: z.array(z.string().uuid()).default([]),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const CreateDirectChannelSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateDirectChannelInput = z.infer<typeof CreateDirectChannelSchema>;

export const UpdateChannelAgentsSchema = z.object({
  agentIds: z.array(z.string().uuid()).default([]),
});
export type UpdateChannelAgentsInput = z.infer<typeof UpdateChannelAgentsSchema>;

// ── Message ────────────────────────────────────────────

export const SendMessageSchema = z.object({
  channelId: z.string().uuid(),
  content: z.string().max(32_000).default(''),
  contentType: ContentType.default('TEXT'),
  attachments: z.array(z.object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    contentBase64: z.string().min(1),
  })).max(8).optional(),
}).refine((value) => value.content.trim().length > 0 || (value.attachments?.length ?? 0) > 0, {
  message: 'Message content or at least one attachment is required.',
  path: ['content'],
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const CompactChannelSessionSchema = z.object({
  agentSlug: z.string().min(1).max(100).optional(),
  all: z.boolean().optional(),
});
export type CompactChannelSessionInput = z.infer<typeof CompactChannelSessionSchema>;

export const CompactChannelSessionResultSchema = z.object({
  compactedAgentIds: z.array(z.string().uuid()),
  compactedAgentNames: z.array(z.string()),
  skippedAgentNames: z.array(z.string()),
  message: z.string(),
});
export type CompactChannelSessionResult = z.infer<typeof CompactChannelSessionResultSchema>;

export const StopAgentExecutionResultSchema = z.object({
  stopped: z.boolean(),
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
  message: z.string(),
});
export type StopAgentExecutionResult = z.infer<typeof StopAgentExecutionResultSchema>;

export const LiveToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['running', 'success', 'failed']),
  arguments: z.unknown().optional(),
  output: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  success: z.boolean().optional(),
});
export type LiveToolCall = z.infer<typeof LiveToolCallSchema>;

export const AgentTodoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']),
});
export type AgentTodoItem = z.infer<typeof AgentTodoItemSchema>;

export const AgentTodoListSchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  todos: z.array(AgentTodoItemSchema),
});
export type AgentTodoList = z.infer<typeof AgentTodoListSchema>;

export const LiveAgentTurnSchema = z.object({
  tempId: z.string(),
  agentId: z.string().uuid(),
  text: z.string(),
  toolCalls: z.array(LiveToolCallSchema),
});
export type LiveAgentTurn = z.infer<typeof LiveAgentTurnSchema>;

export const ChannelLiveStateSchema = z.object({
  channelId: z.string().uuid(),
  agentState: z.enum(['idle', 'queued', 'streaming', 'error']),
  turns: z.array(LiveAgentTurnSchema),
  todos: z.array(AgentTodoListSchema),
});
export type ChannelLiveState = z.infer<typeof ChannelLiveStateSchema>;

export const EditMessageSchema = z.object({
  content: z.string().min(1).max(32_000),
});
export type EditMessageInput = z.infer<typeof EditMessageSchema>;

export const MessagePaginationSchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().max(200).optional(), // full-text search
});
export type MessagePaginationInput = z.infer<typeof MessagePaginationSchema>;

// ── Reaction ───────────────────────────────────────────

export const AddReactionSchema = z.object({
  emoji: z.string().min(1).max(10),
});
export type AddReactionInput = z.infer<typeof AddReactionSchema>;
