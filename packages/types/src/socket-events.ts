/**
 * Socket.io Event Contracts — Discriminated Unions
 *
 * Phase 1 implementation status:
 * - These contracts now back the first working local chat loop.
 * - Current scope focuses on message send, room join, persisted message broadcast,
 *   and incremental agent-response streaming to the active chat view.
 * - Future phases will deepen reactions, presence, typing, moderation, and tools.
 *
 * This file defines every socket event that flows between client and server.
 * Both sides import these types to ensure type safety across the WebSocket layer.
 *
 * Namespaces:
 * - /chat  — messages, edits, deletes, reactions, streaming
 * - /presence — online/offline/away status
 *
 * Room naming convention: channel:{channelId}
 *
 * ALL socket payloads are validated with Zod on the server before processing.
 * Invalid payloads result in an error emitted back to the client.
 */

// ── Client → Server Events ────────────────────────────

export interface ClientToServerEvents {
  'message:send': (data: {
    channelId: string;
    content: string;
    contentType: 'TEXT' | 'MARKDOWN' | 'FILE';
  }) => void;

  'message:edit': (data: {
    messageId: string;
    content: string;
  }) => void;

  'message:delete': (data: {
    messageId: string;
  }) => void;

  'typing:start': (data: {
    channelId: string;
  }) => void;

  'typing:stop': (data: {
    channelId: string;
  }) => void;

  'channel:join': (data: {
    channelId: string;
  }) => void;

  'channel:leave': (data: {
    channelId: string;
  }) => void;

  'reaction:add': (data: {
    messageId: string;
    emoji: string;
  }) => void;

  'reaction:remove': (data: {
    messageId: string;
    emoji: string;
  }) => void;
}

// ── Server → Client Events ────────────────────────────

export interface ServerToClientEvents {
  'message:new': (data: {
    id: string;
    channelId: string;
    senderId: string;
    senderType: 'USER' | 'AGENT';
    senderName?: string | null;
    content: string;
    contentType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'SYSTEM';
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }) => void;

  'message:updated': (data: {
    messageId: string;
    content: string;
    editedAt: string;
  }) => void;

  'message:deleted': (data: {
    messageId: string;
    deletedAt: string;
  }) => void;

  'message:stream:chunk': (data: {
    tempId: string;
    agentId: string;
    channelId: string;
    delta: string;
  }) => void;

  'message:stream:end': (data: {
    tempId: string;
    finalMessageId: string;
    channelId: string;
    createdAt: string;
  }) => void;

  'message:reaction': (data: {
    messageId: string;
    userId: string;
    emoji: string;
    action: 'add' | 'remove';
  }) => void;

  'typing:update': (data: {
    channelId: string;
    users: string[];
  }) => void;

  'presence:update': (data: {
    userId: string;
    status: 'ONLINE' | 'OFFLINE' | 'AWAY';
  }) => void;

  'read:update': (data: {
    channelId: string;
    userId: string;
    lastReadAt: string;
  }) => void;

  // Emitted after the routing pass completes so the client can reset the
  // "Routing…" indicator immediately when no agents were selected.
  'message:routing:complete': (data: {
    channelId: string;
    selectedCount: number;
  }) => void;

  // Emitted when an agent starts executing a tool mid-turn.
  // turnId matches the tempId of the in-progress streaming bubble.
  'agent:tool:start': (data: {
    agentId: string;
    channelId: string;
    toolName: string;
    toolCallId: string;
    turnId: string;
    arguments?: unknown;
  }) => void;

  // Emitted when an agent finishes executing a tool mid-turn.
  'agent:tool:end': (data: {
    agentId: string;
    channelId: string;
    toolName: string;
    toolCallId: string;
    turnId: string;
    success: boolean;
    durationMs: number;
    arguments?: unknown;
    output?: string;
    structuredOutput?: Record<string, unknown>;
  }) => void;

  // Emitted when an agent calls todowrite — carries the full updated list so
  // the frontend can render a live task panel without polling.
  'agent:todos:update': (data: {
    agentId: string;
    channelId: string;
    agentName: string;
    todos: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority: 'high' | 'medium' | 'low';
    }>;
  }) => void;

  'error': (data: {
    code: string;
    message: string;
  }) => void;
}
