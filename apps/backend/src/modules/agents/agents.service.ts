/**
 * Agent Service — Business Logic
 *
 * Phase 1 implementation status:
 * - This file now implements the minimal agent logic needed for Milestone 1.
 * - Current scope covers listing workspace agents and resolving which channel agent
 *   should respond to a user message.
 * - Future phases will expand CRUD, memory, tools, cron, and analytics here.
 */

import type { AgentSummary, SenderType } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';

function serializeAgent(agent: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  triggerMode: 'MENTIONS_ONLY' | 'ALL_MESSAGES' | 'DISABLED';
  identity: { systemPrompt: string | null; persona: string | null } | null;
}): AgentSummary {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    slug: agent.slug,
    status: agent.status,
    triggerMode: agent.triggerMode,
    systemPrompt: agent.identity?.systemPrompt ?? null,
    persona: agent.identity?.persona ?? null,
  };
}

export class AgentsService {
  async listWorkspaceAgents(userId: string, workspaceId: string) {
    const membership = await prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId },
    });

    if (!membership) {
      throw new Error('You do not have access to this workspace.');
    }

    const agents = await prisma.agent.findMany({
      where: {
        workspaceId,
        status: { not: 'ARCHIVED' },
      },
      include: {
        identity: {
          select: {
            systemPrompt: true,
            persona: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const serializedAgents: AgentSummary[] = [];

    for (const agent of agents) {
      serializedAgents.push(serializeAgent(agent));
    }

    return serializedAgents;
  }

  async getTriggeredAgents(channelId: string, senderType: SenderType, content: string) {
    if (senderType === 'AGENT') {
      return [];
    }

    const memberships = await prisma.agentChannelMembership.findMany({
      where: { channelId },
      include: {
        agent: {
          include: {
            identity: true,
            providerConfig: true,
          },
        },
      },
    });

    const triggeredAgents = [];

    for (const membership of memberships) {
      const agent = membership.agent;

      if (agent.status !== 'ACTIVE' || agent.triggerMode === 'DISABLED') {
        continue;
      }

      if (agent.triggerMode === 'ALL_MESSAGES') {
        triggeredAgents.push(agent);
        continue;
      }

      if (content.toLowerCase().includes(`@${agent.slug.toLowerCase()}`)) {
        triggeredAgents.push(agent);
      }
    }

    return triggeredAgents;
  }
}

export const agentsService = new AgentsService();
