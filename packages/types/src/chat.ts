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
  name: z.string(),
  type: ChannelType,
});
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;

export const MessageRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  senderId: z.string().uuid(),
  senderType: SenderType,
  content: z.string(),
  contentType: ContentType,
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
});
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

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
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

// ── Message ────────────────────────────────────────────

export const SendMessageSchema = z.object({
  channelId: z.string().uuid(),
  content: z.string().min(1).max(32_000),
  contentType: ContentType.default('TEXT'),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

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
