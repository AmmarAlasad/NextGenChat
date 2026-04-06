/**
 * Auto-Compaction Service — OpenClaw-style synchronous pre-turn compaction
 *
 * Mirrors OpenClaw's compaction architecture:
 *   - 1.2x safety margin on all token estimates (same as OpenClaw's SAFETY_MARGIN)
 *   - Token-share splitting with configurable parts (DEFAULT_PARTS = 2)
 *   - Oversized message detection: messages > 50% of context window cannot be summarized safely
 *   - Progressive fallback: full → partial (excluding oversized) → descriptive note
 *   - Retry loop with exponential backoff on summarization API failures
 *   - 15-minute compaction timeout (COMPACTION_TIMEOUT_MS = 900_000)
 *   - History turn limit: cap candidates to MAX_HISTORY_TURNS user turns before compaction
 *   - firstKeptMessageId: marks start of unsummarized tail so context builder skips
 *     already-summarized messages on reload — prevents unbounded DB message growth
 *   - Tool result detail stripping: large content truncated before summarization LLM call
 *
 * Exported entry points:
 *   compactBeforeTurn(params) — synchronous pre-turn compaction called by ContextBuilder
 *   compactNow(input)         — manual/admin-triggered compaction (used by chat.service.ts)
 *
 * Phase 5 implementation status:
 * - schedule() removed: compaction now runs synchronously before the LLM call, not async-after.
 * - compactBeforeTurn() is the new canonical entry; ContextBuilder calls it before returning.
 * - compactNow() kept for manual admin triggers via chat.service.ts.
 * - Future phases: per-agent customInstructions, per-provider summarization model selection.
 */

import type { ContentType, SenderType } from '@prisma/client';
import type { Message } from '@prisma/client';

import { prisma } from '@/db/client.js';
import { env } from '@/config/env.js';
import { isMessageVisibleToAgent } from '@/modules/agents/agent-visibility.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';

// ── OpenClaw constants ────────────────────────────────────────────────────────

/** 20% buffer for token estimation inaccuracy (identical to OpenClaw's SAFETY_MARGIN). */
export const SAFETY_MARGIN = 1.2;

/** A single message > 50% of context window cannot be safely summarized. */
const OVERSIZED_FRACTION = 0.5;

/** Compaction must complete within 15 minutes or it is abandoned. */
const COMPACTION_TIMEOUT_MS = 900_000;

/** Retry summarization up to 3 times before attempting progressive fallback. */
const MAX_RETRY_ATTEMPTS = 3;

/** Initial retry delay in ms; doubles on each attempt (jitter ±20%). */
const RETRY_BASE_DELAY_MS = 500;

/** Default split: divide messages into 2 token-share chunks before dropping oldest. */
const DEFAULT_PARTS = 2;

/** History turn limit: keep at most this many user turns in pre-turn candidates. */
export const MAX_HISTORY_TURNS = 50;

/** Keep at least this many messages in manual compaction to avoid over-compacting. */
const MANUAL_COMPACTION_KEEP_RECENT = 12;

/** Truncate message content at this length before feeding to the summarization LLM. */
const MAX_SUMMARIZATION_CONTENT_LENGTH = 3000;

// ── Types ─────────────────────────────────────────────────────────────────────

type CompactableMesasge = Pick<Message, 'id' | 'senderId' | 'senderType' | 'content' | 'contentType' | 'createdAt'>;

interface CompactNowInput {
  agentId: string;
  channelId: string;
  messageIds?: string[];
  origin: 'auto' | 'manual';
}

interface CompactionResult {
  compacted: boolean;
  agentId: string;
  agentName: string;
}

export interface CompactBeforeTurnParams {
  agentId: string;
  channelId: string;
  agentName: string;
  agentSlug: string;
  /** All visible candidates in chronological order (oldest → newest). */
  visibleMessages: CompactableMesasge[];
  /** Token budget available for history (not including trigger message). */
  historyBudgetTokens: number;
  /** Full model context window size (used for oversized detection). */
  contextWindow: number;
  /** Latest existing summary for this agent+channel, if any. */
  previousSummary: { id: string; summary: string } | null;
}

export interface CompactBeforeTurnResult {
  keptMessages: CompactableMesasge[];
  compacted: boolean;
}

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Estimate tokens for a DB message. Applies SAFETY_MARGIN so estimates are
 * conservative — identical philosophy to OpenClaw's estimateMessagesTokens.
 */
function estimateMessageTokens(content: string): number {
  return Math.ceil((Math.ceil(content.length / 4) + 4) * SAFETY_MARGIN);
}

function estimateTotalTokens(messages: CompactableMesasge[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0);
}

// ── History turn limit (OpenClaw: limitHistoryTurns) ─────────────────────────

/**
 * Cap candidates to the last N user turns plus their associated agent replies.
 * Prevents unbounded history accumulation in long-running sessions.
 * Messages must be in chronological order (oldest first).
 */
export function limitHistoryTurns(messages: CompactableMesasge[], limit: number): CompactableMesasge[] {
  if (limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderType === 'USER') {
      userTurns++;
      if (userTurns > limit) {
        return messages.slice(i + 1);
      }
    }
  }

  return messages;
}

// ── Oversized detection (OpenClaw: isOversizedForSummary) ────────────────────

/**
 * A message is oversized if its token estimate (with safety margin) exceeds
 * 50% of the context window. Such messages cannot be passed to a summarization
 * LLM without exceeding its own context budget.
 */
function isOversizedForSummary(content: string, contextWindow: number): boolean {
  return estimateMessageTokens(content) > contextWindow * OVERSIZED_FRACTION;
}

// ── Token-share splitting (OpenClaw: splitMessagesByTokenShare) ───────────────

/**
 * Split messages into roughly equal token-share chunks. Unlike OpenClaw we don't
 * track tool_call/tool_result boundaries because tool calls are not stored as DB
 * messages — only the final text response is persisted.
 *
 * Returns chunks in chronological order (oldest chunk first).
 */
function splitMessagesByTokenShare(messages: CompactableMesasge[], parts: number): CompactableMesasge[][] {
  if (messages.length === 0) return [];

  const effectiveParts = Math.min(Math.max(1, Math.floor(parts)), messages.length);
  if (effectiveParts <= 1) return [messages];

  const totalTokens = estimateTotalTokens(messages);
  const targetPerPart = totalTokens / effectiveParts;

  const chunks: CompactableMesasge[][] = [];
  let current: CompactableMesasge[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateMessageTokens(msg.content);

    if (
      current.length > 0 &&
      chunks.length < effectiveParts - 1 &&
      currentTokens + msgTokens > targetPerPart
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ── Tool result stripping (OpenClaw: stripToolResultDetails) ──────────────────

/**
 * Truncate very long message content before passing to the summarization LLM.
 * Prevents verbose tool output from inflating the summarization prompt.
 * Security: keeps summarization LLM from processing raw tool payloads.
 */
function stripLargeContent(content: string): string {
  if (content.length <= MAX_SUMMARIZATION_CONTENT_LENGTH) {
    return content;
  }

  return (
    content.slice(0, MAX_SUMMARIZATION_CONTENT_LENGTH) +
    `\n[... ${content.length - MAX_SUMMARIZATION_CONTENT_LENGTH} chars truncated for summarization]`
  );
}

// ── Timeout wrapper (OpenClaw: compactWithSafetyTimeout) ─────────────────────

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  label: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts - 1) {
        const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) * jitter;
        console.warn(`[compaction] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms:`, err instanceof Error ? err.message : err);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ── LLM summarization ────────────────────────────────────────────────────────

function buildFallbackSummary(messages: CompactableMesasge[], previousSummary?: string | null): string {
  const lines = ['Compacted conversation summary:', ''];

  if (previousSummary?.trim()) {
    lines.push('Previous summary:');
    lines.push(previousSummary.trim());
    lines.push('');
  }

  for (const message of messages.slice(0, 20)) {
    const role = message.senderType === 'AGENT' ? 'Agent' : 'User';
    lines.push(`- ${role}: ${message.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  if (messages.length > 20) {
    lines.push(`- [...${messages.length - 20} more messages omitted]`);
  }

  return lines.join('\n');
}

async function callSummarizeLLM(
  messages: CompactableMesasge[],
  previousSummary: string | null,
): Promise<string> {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
    return buildFallbackSummary(messages, previousSummary);
  }

  // Strip large content before sending to summarization LLM
  const transcript = messages
    .map((m) => {
      const role = m.senderType === 'AGENT' ? 'Assistant' : 'User';
      return `${role}: ${stripLargeContent(m.content)}`;
    })
    .join('\n\n');

  const provider = new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-5.4');

  const response = await provider.complete({
    messages: [
      {
        role: 'system',
        content: [
          'Summarize the conversation history into a cumulative continuation summary.',
          'Preserve all opaque identifiers exactly as written (UUIDs, hashes, IDs, file names, hostnames, URLs).',
          'MUST PRESERVE: active tasks and their current status, batch operation progress (e.g. "5/17 completed"),',
          'the last user request and what was being done about it, decisions and their rationale,',
          'TODOs and open questions, commitments and follow-ups.',
          'PRIORITIZE recent context over older history.',
          'If a previous summary is provided, merge it forward rather than replacing it.',
          'Keep the result concise but sufficient for an agent to continue the session from scratch.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          previousSummary?.trim() ? `Previous summary:\n${previousSummary.trim()}` : 'Previous summary: none',
          '',
          'New transcript to fold in:',
          transcript,
        ].join('\n'),
      },
    ],
    maxTokens: 1200,
    temperature: 0.2,
  });

  return response.content.trim() || buildFallbackSummary(messages, previousSummary);
}

/**
 * Progressive fallback summarization (OpenClaw: summarizeWithFallback).
 * Strategy:
 *   1. Try full summarization of all messages
 *   2. If that fails: exclude oversized messages, note what was omitted
 *   3. If that also fails: return a plain descriptive note
 */
async function summarizeWithFallback(
  messages: CompactableMesasge[],
  previousSummary: string | null,
  contextWindow: number,
): Promise<string> {
  // Try full summarization with retry
  try {
    return await withRetry(
      () => callSummarizeLLM(messages, previousSummary),
      MAX_RETRY_ATTEMPTS,
      'full-summarization',
    );
  } catch (fullError) {
    console.warn('[compaction] Full summarization failed, attempting partial:', fullError instanceof Error ? fullError.message : fullError);
  }

  // Fallback 1: exclude oversized messages, note them
  const smallMessages: CompactableMesasge[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg.content, contextWindow)) {
      const role = msg.senderType === 'AGENT' ? 'assistant' : 'user';
      const tokens = estimateMessageTokens(msg.content);
      oversizedNotes.push(`[Large ${role} message (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`);
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await withRetry(
        () => callSummarizeLLM(smallMessages, previousSummary),
        MAX_RETRY_ATTEMPTS,
        'partial-summarization',
      );
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join('\n')}` : '';
      return partialSummary + notes;
    } catch (partialError) {
      console.warn('[compaction] Partial summarization also failed:', partialError instanceof Error ? partialError.message : partialError);
    }
  }

  // Final fallback: plain description
  return (
    `Context contained ${messages.length} messages` +
    (oversizedNotes.length > 0 ? ` (${oversizedNotes.length} oversized, summary unavailable due to size limits)` : '') +
    '.\n\n' +
    buildFallbackSummary(messages.slice(0, 10), previousSummary)
  );
}

// ── Serialization helper (for Socket.io emit) ─────────────────────────────────

function serializeSystemMessage(message: {
  id: string;
  channelId: string;
  senderId: string;
  senderType: SenderType;
  senderName?: string | null;
  content: string;
  contentType: ContentType;
  metadata: unknown;
  createdAt: Date;
  editedAt?: Date | null;
  deletedAt?: Date | null;
}) {
  return {
    id: message.id,
    channelId: message.channelId,
    senderId: message.senderId,
    senderType: message.senderType,
    senderName: message.senderName ?? null,
    content: message.content,
    contentType: message.contentType,
    metadata: (message.metadata as Record<string, unknown> | null) ?? null,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

async function emitCompactionEvent(input: {
  channelId: string;
  agentId: string;
  agentName: string;
  origin: 'auto' | 'manual';
}) {
  const message = await prisma.message.create({
    data: {
      channelId: input.channelId,
      senderId: input.agentId,
      senderType: 'AGENT',
      content: `Session compacted for ${input.agentName}.`,
      contentType: 'SYSTEM',
      metadata: {
        compaction: {
          agentId: input.agentId,
          agentName: input.agentName,
          origin: input.origin,
        },
      },
    },
  });

  getChatNamespace().to(getChannelRoom(input.channelId)).emit('message:new', serializeSystemMessage({
    ...message,
    senderName: input.agentName,
  }));
}

// ── CompactionService ─────────────────────────────────────────────────────────

class CompactionService {
  /**
   * Guards against concurrent compaction for the same agent+channel.
   * Two parallel jobs processing the same trigger message would otherwise both
   * compact and create duplicate summaries. The first one wins; the second finds
   * the budget already met and returns early.
   */
  private readonly compacting = new Set<string>();

  /**
   * Synchronous pre-turn compaction — called by ContextBuilder before building
   * the LLM prompt. If history exceeds the budget, drops the oldest token-share
   * chunk, summarizes it, saves the summary with firstKeptMessageId, and returns
   * the kept messages that fit within budget.
   *
   * Mirrors OpenClaw's pruneHistoryForContextShare + summarizeInStages flow.
   * Returns all messages unchanged when under budget (no compaction needed).
   */
  async compactBeforeTurn(params: CompactBeforeTurnParams): Promise<CompactBeforeTurnResult> {
    const { agentId, channelId, agentName, contextWindow, previousSummary } = params;

    // Apply history turn limit first (OpenClaw: limitHistoryTurns)
    const limitedMessages = limitHistoryTurns(params.visibleMessages, MAX_HISTORY_TURNS);

    const totalTokens = estimateTotalTokens(limitedMessages);

    if (totalTokens <= params.historyBudgetTokens) {
      return { keptMessages: limitedMessages, compacted: false };
    }

    // Deduplication: if another parallel job for this agent+channel is already
    // compacting, skip and return the best guess (limitedMessages). The other job
    // will save the summary and the next turn will use it.
    const dedupeKey = `${agentId}:${channelId}`;
    if (this.compacting.has(dedupeKey)) {
      console.info(`[compaction] compactBeforeTurn(${agentName}): skipping — already in progress for this lane`);
      return { keptMessages: limitedMessages, compacted: false };
    }
    this.compacting.add(dedupeKey);

    // Split into chunks by token share; drop oldest chunk(s) until under budget
    let keptMessages = limitedMessages;
    const droppedMessages: CompactableMesasge[] = [];
    let iterations = 0;
    const maxIterations = 5; // safety: never loop indefinitely

    while (
      keptMessages.length > 0 &&
      estimateTotalTokens(keptMessages) > params.historyBudgetTokens &&
      iterations < maxIterations
    ) {
      const chunks = splitMessagesByTokenShare(keptMessages, DEFAULT_PARTS);
      if (chunks.length <= 1) {
        // Can't split further; keep the newest messages by dropping from the front
        const half = Math.ceil(keptMessages.length / 2);
        droppedMessages.push(...keptMessages.slice(0, half));
        keptMessages = keptMessages.slice(half);
      } else {
        const [oldest, ...rest] = chunks;
        droppedMessages.push(...oldest);
        keptMessages = rest.flat();
      }

      iterations++;
    }

    if (droppedMessages.length === 0) {
      this.compacting.delete(dedupeKey);
      return { keptMessages, compacted: false };
    }

    // Summarize the dropped messages (with timeout + progressive fallback)
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true, slug: true },
    });

    if (!agent) {
      this.compacting.delete(dedupeKey);
      console.warn(`[compaction] Agent ${agentId} not found; skipping summary save`);
      return { keptMessages, compacted: true };
    }

    const previousSummaryText = previousSummary?.summary ?? null;

    let summary: string;
    try {
      summary = await withTimeout(
        () => summarizeWithFallback(droppedMessages, previousSummaryText, contextWindow),
        COMPACTION_TIMEOUT_MS,
        `compaction(${agentName})`,
      );
    } catch (err) {
      console.warn('[compaction] compactBeforeTurn summarization timed out or failed:', err instanceof Error ? err.message : err);
      summary = buildFallbackSummary(droppedMessages, previousSummaryText);
    }

    // firstKeptMessageId = oldest message in the kept tail
    const firstKeptMessage = keptMessages[0] ?? null;

    await prisma.conversationSummary.create({
      data: {
        channelId,
        agentId,
        summary,
        tokenCount: Math.ceil(summary.length / 4),
        coversFromMessageId: previousSummary
          ? (await prisma.conversationSummary.findFirst({
              where: { agentId, channelId },
              orderBy: { createdAt: 'asc' },
              select: { coversFromMessageId: true },
            }))?.coversFromMessageId ?? droppedMessages[0].id
          : droppedMessages[0].id,
        covesToMessageId: droppedMessages[droppedMessages.length - 1].id,
        firstKeptMessageId: firstKeptMessage?.id ?? null,
      },
    });

    this.compacting.delete(dedupeKey);

    // Auto pre-turn compaction is silent — no visible system message.
    // Only manual compactNow() emits the "Session compacted" chat message.
    console.info(`[compaction] compactBeforeTurn(${agentName}): summarized ${droppedMessages.length} messages, kept ${keptMessages.length}`);

    return { keptMessages, compacted: true };
  }

  /**
   * Manual / admin-triggered compaction. Called from chat.service.ts when a
   * workspace owner explicitly requests a session compact.
   */
  async compactNow(input: CompactNowInput): Promise<CompactionResult> {
    const agent = await prisma.agent.findUnique({
      where: { id: input.agentId },
      select: { id: true, name: true, slug: true },
    });

    if (!agent) {
      throw new Error('Agent not found for compaction.');
    }

    const latestSummary = await prisma.conversationSummary.findFirst({
      where: { agentId: input.agentId, channelId: input.channelId },
      orderBy: { createdAt: 'desc' },
    });

    const messages = await this.loadMessagesForManualCompaction({
      agent,
      channelId: input.channelId,
      messageIds: input.messageIds,
      latestSummary,
    });

    if (messages.length === 0) {
      return { compacted: false, agentId: agent.id, agentName: agent.name };
    }

    let summary: string;
    try {
      const contextWindow = 128_000; // conservative estimate for manual compaction
      summary = await withTimeout(
        () => summarizeWithFallback(messages, latestSummary?.summary ?? null, contextWindow),
        COMPACTION_TIMEOUT_MS,
        `manual-compaction(${agent.name})`,
      );
    } catch {
      summary = buildFallbackSummary(messages, latestSummary?.summary ?? null);
    }

    const earliestSummary = await prisma.conversationSummary.findFirst({
      where: { agentId: input.agentId, channelId: input.channelId },
      orderBy: { createdAt: 'asc' },
      select: { coversFromMessageId: true },
    });

    await prisma.conversationSummary.create({
      data: {
        channelId: input.channelId,
        agentId: input.agentId,
        summary,
        tokenCount: Math.ceil(summary.length / 4),
        coversFromMessageId: earliestSummary?.coversFromMessageId ?? messages[0].id,
        covesToMessageId: messages[messages.length - 1].id,
        firstKeptMessageId: null, // manual compaction: let context builder decide dynamically
      },
    });

    await emitCompactionEvent({
      channelId: input.channelId,
      agentId: input.agentId,
      agentName: agent.name,
      origin: input.origin,
    });

    return { compacted: true, agentId: agent.id, agentName: agent.name };
  }

  private async loadMessagesForManualCompaction(input: {
    agent: { id: string; name: string; slug: string };
    channelId: string;
    messageIds?: string[];
    latestSummary: { covesToMessageId: string } | null;
  }): Promise<CompactableMesasge[]> {
    if (input.messageIds && input.messageIds.length > 0) {
      const messages = await prisma.message.findMany({
        where: { id: { in: input.messageIds } },
        orderBy: { createdAt: 'asc' },
      });

      return messages.filter((m) => isMessageVisibleToAgent({
        messageSenderId: m.senderId,
        messageSenderType: m.senderType,
        messageContent: m.content,
        currentAgentId: input.agent.id,
        currentAgentSlug: input.agent.slug,
        currentAgentName: input.agent.name,
      }));
    }

    let lowerBoundCreatedAt: Date | undefined;

    if (input.latestSummary?.covesToMessageId) {
      const covered = await prisma.message.findUnique({
        where: { id: input.latestSummary.covesToMessageId },
        select: { createdAt: true },
      });
      lowerBoundCreatedAt = covered?.createdAt;
    }

    const candidates = await prisma.message.findMany({
      where: {
        channelId: input.channelId,
        contentType: { not: 'SYSTEM' },
        ...(lowerBoundCreatedAt ? { createdAt: { gt: lowerBoundCreatedAt } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    const visible = candidates.filter((m) => isMessageVisibleToAgent({
      messageSenderId: m.senderId,
      messageSenderType: m.senderType,
      messageContent: m.content,
      currentAgentId: input.agent.id,
      currentAgentSlug: input.agent.slug,
      currentAgentName: input.agent.name,
    }));

    if (visible.length <= MANUAL_COMPACTION_KEEP_RECENT) {
      return [];
    }

    return visible.slice(0, Math.max(0, visible.length - MANUAL_COMPACTION_KEEP_RECENT));
  }
}

export const compactionService = new CompactionService();
