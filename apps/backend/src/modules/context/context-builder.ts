/**
 * Context Builder — Assembles the LLM Prompt
 *
 * Phase 1 implementation status:
 * - This file now builds the minimal prompt context needed for the first agent reply flow.
 * - Current scope includes the agent system prompt plus recent channel messages.
 * - Future phases will add token budgeting, memory scopes, summaries, and compaction.
 */

import type { LLMMessage } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';

export interface ContextBuildResult {
  messages: LLMMessage[];
}

export class ContextBuilder {
  async build(agentId: string, channelId: string, triggerMessageId: string): Promise<ContextBuildResult> {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        identity: true,
      },
    });

    if (!agent) {
      throw new Error('Agent not found for context build.');
    }

    // Fetch the 20 most recent messages then reverse to chronological order.
    // Using desc + take avoids a table scan when the channel has many messages.
    const recentMessages = (
      await prisma.message.findMany({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    ).reverse();

    void triggerMessageId;

    const messages: LLMMessage[] = [];

    if (agent.identity?.systemPrompt) {
      messages.push({
        role: 'system',
        content: agent.identity.systemPrompt,
      });
    }

    for (const message of recentMessages) {
      messages.push({
        role: message.senderType === 'AGENT' ? 'assistant' : 'user',
        content: message.content,
      });
    }

    return { messages };
  }
}

export const contextBuilder = new ContextBuilder();
