/**
 * Auto-Compaction Service
 *
 * Schedules async summarization of older channel messages so future context
 * builds can stay within budget without losing the thread completely.
 *
 * Phase 5 implementation status:
 * - Compaction summaries are cumulative per agent+channel session so the latest
 *   summary remains sufficient on its own.
 * - Manual compaction is supported for a channel session and can target one
 *   agent or multiple agents.
 * - Compaction emits a visible system message in the channel when a summary is
 *   successfully updated.
 */

import type { ContentType, SenderType } from '@prisma/client';
import type { Message } from '@prisma/client';

import { prisma } from '@/db/client.js';
import { env } from '@/config/env.js';
import { isMessageVisibleToAgent } from '@/modules/agents/agent-visibility.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';

interface CompactionJobInput {
  agentId: string;
  channelId: string;
  overflowMessageIds: string[];
}

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

const MANUAL_COMPACTION_KEEP_RECENT_MESSAGES = 12;

function buildFallbackSummary(messages: Message[], previousSummary?: string | null) {
  const lines = ['Compacted conversation summary:', ''];

  if (previousSummary?.trim()) {
    lines.push('Previous summary:');
    lines.push(previousSummary.trim());
    lines.push('');
  }

  for (const message of messages.slice(0, 16)) {
    lines.push(`- ${message.senderType === 'AGENT' ? 'Agent' : 'User'}: ${message.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  return lines.join('\n');
}

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

class CompactionService {
  private readonly inFlight = new Set<string>();

  schedule(input: CompactionJobInput) {
    const dedupeKey = `${input.agentId}:${input.channelId}`;

    if (this.inFlight.has(dedupeKey) || input.overflowMessageIds.length === 0) {
      return;
    }

    this.inFlight.add(dedupeKey);

    queueMicrotask(() => {
      void this.compactNow({
        agentId: input.agentId,
        channelId: input.channelId,
        messageIds: input.overflowMessageIds,
        origin: 'auto',
      })
        .catch((error) => {
          console.error('Compaction job failed', error);
        })
        .finally(() => {
          this.inFlight.delete(dedupeKey);
        });
    });
  }

  async compactNow(input: CompactNowInput): Promise<CompactionResult> {
    const agent = await prisma.agent.findUnique({
      where: { id: input.agentId },
      select: { id: true, name: true, slug: true },
    });

    if (!agent) {
      throw new Error('Agent not found for compaction.');
    }

    const latestSummary = await prisma.conversationSummary.findFirst({
      where: {
        agentId: input.agentId,
        channelId: input.channelId,
      },
      orderBy: { createdAt: 'desc' },
    });

    const messages = await this.loadMessagesForCompaction({
      agent,
      channelId: input.channelId,
      messageIds: input.messageIds,
      latestSummary,
    });

    if (messages.length === 0) {
      return {
        compacted: false,
        agentId: agent.id,
        agentName: agent.name,
      };
    }

    const summary = await this.summarize(messages, latestSummary?.summary ?? null);

    await prisma.conversationSummary.create({
      data: {
        channelId: input.channelId,
        agentId: input.agentId,
        summary,
        tokenCount: Math.ceil(summary.length / 4),
        coversFromMessageId: latestSummary?.coversFromMessageId ?? messages[0].id,
        covesToMessageId: messages[messages.length - 1].id,
      },
    });

    await this.emitCompactionEvent({
      channelId: input.channelId,
      agentId: input.agentId,
      agentName: agent.name,
      origin: input.origin,
    });

    return {
      compacted: true,
      agentId: agent.id,
      agentName: agent.name,
    };
  }

  private async loadMessagesForCompaction(input: {
    agent: {
      id: string;
      name: string;
      slug: string;
    };
    channelId: string;
    messageIds?: string[];
    latestSummary: {
      covesToMessageId: string;
    } | null;
  }) {
    if (input.messageIds && input.messageIds.length > 0) {
      const messages = await prisma.message.findMany({
        where: {
          id: { in: input.messageIds },
        },
        orderBy: { createdAt: 'asc' },
      });

      return messages.filter((message) => isMessageVisibleToAgent({
        messageSenderId: message.senderId,
        messageSenderType: message.senderType,
        messageContent: message.content,
        currentAgentId: input.agent.id,
        currentAgentSlug: input.agent.slug,
        currentAgentName: input.agent.name,
      }));
    }

    let lowerBoundCreatedAt: Date | undefined;

    if (input.latestSummary?.covesToMessageId) {
      const coveredToMessage = await prisma.message.findUnique({
        where: { id: input.latestSummary.covesToMessageId },
        select: { createdAt: true },
      });
      lowerBoundCreatedAt = coveredToMessage?.createdAt;
    }

    const candidates = await prisma.message.findMany({
      where: {
        channelId: input.channelId,
        contentType: { not: 'SYSTEM' },
        ...(lowerBoundCreatedAt
          ? {
              createdAt: {
                gt: lowerBoundCreatedAt,
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    const visibleCandidates = candidates.filter((message) => isMessageVisibleToAgent({
      messageSenderId: message.senderId,
      messageSenderType: message.senderType,
      messageContent: message.content,
      currentAgentId: input.agent.id,
      currentAgentSlug: input.agent.slug,
      currentAgentName: input.agent.name,
    }));

    if (visibleCandidates.length <= MANUAL_COMPACTION_KEEP_RECENT_MESSAGES) {
      return [];
    }

    return visibleCandidates.slice(0, Math.max(0, visibleCandidates.length - MANUAL_COMPACTION_KEEP_RECENT_MESSAGES));
  }

  private async emitCompactionEvent(input: {
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

  private async summarize(messages: Message[], previousSummary?: string | null) {
    const transcript = messages
      .map((message) => `${message.senderType === 'AGENT' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n');

    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
      return buildFallbackSummary(messages, previousSummary);
    }

    try {
      const provider = new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-5.4');
      const response = await provider.complete({
        messages: [
          {
            role: 'system',
            content: [
              'Summarize the conversation history into a cumulative continuation summary.',
              'Preserve decisions, facts, commitments, unresolved questions, user preferences, and useful operating context.',
              'If a previous summary is provided, merge it forward instead of replacing it with a narrower summary.',
              'Keep the result concise but strong enough for another agent run to continue from it.',
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
        maxTokens: 900,
        temperature: 0.2,
      });

      return response.content.trim() || buildFallbackSummary(messages, previousSummary);
    } catch {
      return buildFallbackSummary(messages, previousSummary);
    }
  }
}

export const compactionService = new CompactionService();
