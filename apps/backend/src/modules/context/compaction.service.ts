/**
 * Auto-Compaction Service
 *
 * Schedules async summarization of older channel messages so future context
 * builds can stay within budget without losing the thread completely.
 */

import type { Message } from '@prisma/client';

import { prisma } from '@/db/client.js';
import { env } from '@/config/env.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

interface CompactionJobInput {
  agentId: string;
  channelId: string;
  overflowMessageIds: string[];
}

function buildFallbackSummary(messages: Message[]) {
  const lines = ['Compacted conversation summary:', ''];

  for (const message of messages.slice(0, 12)) {
    lines.push(`- ${message.senderType === 'AGENT' ? 'Agent' : 'User'}: ${message.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  return lines.join('\n');
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
      void this.process(input)
        .catch((error) => {
          console.error('Compaction job failed', error);
        })
        .finally(() => {
          this.inFlight.delete(dedupeKey);
        });
    });
  }

  private async process(input: CompactionJobInput) {
    const messages = await prisma.message.findMany({
      where: {
        id: { in: input.overflowMessageIds },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (messages.length === 0) {
      return;
    }

    const summary = await this.summarize(messages);

    await prisma.conversationSummary.create({
      data: {
        channelId: input.channelId,
        agentId: input.agentId,
        summary,
        tokenCount: Math.ceil(summary.length / 4),
        coversFromMessageId: messages[0].id,
        covesToMessageId: messages[messages.length - 1].id,
      },
    });
  }

  private async summarize(messages: Message[]) {
    const transcript = messages
      .map((message) => `${message.senderType === 'AGENT' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n');

    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
      return buildFallbackSummary(messages);
    }

    try {
      const provider = new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o-mini');
      const response = await provider.complete({
        messages: [
          {
            role: 'system',
            content:
              'Summarize older conversation history concisely. Preserve decisions, facts, commitments, unresolved questions, and useful state for the next run.',
          },
          {
            role: 'user',
            content: transcript,
          },
        ],
        maxTokens: 600,
        temperature: 0.2,
      });

      return response.content.trim() || buildFallbackSummary(messages);
    } catch {
      return buildFallbackSummary(messages);
    }
  }
}

export const compactionService = new CompactionService();
