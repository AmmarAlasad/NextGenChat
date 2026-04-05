/**
 * Agent Routing Service
 *
 * Selects which agents should engage for a new message.
 *
 * Phase 5 implementation status:
 * - Group delivery is now membership-based: every eligible non-disabled agent in
 *   the channel receives the message.
 * - `MENTIONS_ONLY` remains the one server-side gating rule.
 * - Reply choice is intentionally delegated to the agent prompt/runtime context
 *   and the agent's authored docs.
 */

import type { AgentRoutingReason, SenderType } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { isExplicitlyMentioned } from '@/modules/agents/agent-visibility.js';

interface RoutingDecision {
  selectedAgentIds: string[];
  diagnostics: AgentRoutingReason[];
}

export class AgentRoutingService {
  async selectAgentsForMessage(input: {
    channelId: string;
    senderId: string;
    senderType: SenderType;
    content: string;
    messageId: string;
    isRelay?: boolean;
  }): Promise<RoutingDecision> {
    const channel = await prisma.channel.findUnique({
      where: { id: input.channelId },
      include: {
        agentMemberships: {
          include: {
            agent: {
              include: {
                identity: true,
              },
            },
          },
        },
      },
    });

    if (!channel) {
      throw new Error('Channel not found.');
    }

    if (channel.type === 'DIRECT') {
      if (input.senderType === 'AGENT' && !input.isRelay) {
        return { selectedAgentIds: [], diagnostics: [] };
      }

      const directAgent = channel.agentMemberships.find((membership) => membership.agent.status === 'ACTIVE');

      return {
        selectedAgentIds: directAgent ? [directAgent.agentId] : [],
        diagnostics: directAgent
          ? [{ agentId: directAgent.agentId, score: 1, decision: 'RESPOND', reason: 'Direct channel routes to its assigned agent.' }]
          : [],
      };
    }

    const diagnostics: AgentRoutingReason[] = [];
    const selectedAgentIds: string[] = [];

    for (const membership of channel.agentMemberships) {
      const agent = membership.agent;

      if (agent.status !== 'ACTIVE' || agent.triggerMode === 'DISABLED') {
        diagnostics.push({
          agentId: agent.id,
          score: 0,
          decision: 'IGNORE',
          reason: 'Agent is not active for routing.',
        });
        continue;
      }

      if (agent.id === input.senderId) {
        diagnostics.push({
          agentId: agent.id,
          score: 0,
          decision: 'IGNORE',
          reason: 'Do not route a message back to the same agent that sent it.',
        });
        continue;
      }

      const mentioned = isExplicitlyMentioned(input.content, { slug: agent.slug, name: agent.name }, input.senderType);

      if (agent.triggerMode === 'MENTIONS_ONLY') {
        diagnostics.push({
          agentId: agent.id,
          score: mentioned ? 1 : 0,
          decision: mentioned ? 'RESPOND' : 'IGNORE',
          reason: mentioned ? 'Explicitly mentioned (MENTIONS_ONLY mode).' : 'Not mentioned; agent is in MENTIONS_ONLY mode.',
        });

        if (mentioned) {
          selectedAgentIds.push(agent.id);
        }

        continue;
      }

      if (input.senderType === 'AGENT') {
        diagnostics.push({
          agentId: agent.id,
          score: mentioned ? 1 : 0,
          decision: mentioned ? 'RESPOND' : 'IGNORE',
          reason: mentioned
            ? 'Explicit agent mention handoff.'
            : 'Agent replies are private to the user unless they explicitly hand off with @mention.',
        });

        if (mentioned) {
          selectedAgentIds.push(agent.id);
        }

        continue;
      }

      diagnostics.push({
        agentId: agent.id,
        score: 1,
        decision: 'RESPOND',
        reason: 'Channel member received the message; the agent decides whether to reply.',
      });
      selectedAgentIds.push(agent.id);
    }

    return {
      selectedAgentIds,
      diagnostics,
    };
  }
}

export const agentRoutingService = new AgentRoutingService();
