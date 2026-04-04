/**
 * Agent Service — Business Logic
 *
 * Phase 1 implementation status:
 * - This file now implements the minimal agent logic needed for Milestone 1.
 * - Current scope covers listing, creating, updating, and inspecting agents for the
 *   local-first multi-agent chat experience.
 * - Future phases will expand tools, cron, analytics, and deeper routing controls.
 */

import type { AgentDetail, AgentSummary, CreateAgentInput, UpdateAgentInput } from '@nextgenchat/types';

import { DEFAULT_AGENT_MODEL } from '@/config/constants.js';
import { prisma } from '@/db/client.js';
import { encryptJson } from '@/lib/crypto.js';
import { env } from '@/config/env.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

function serializeAgent(agent: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  triggerMode: 'AUTO' | 'MENTIONS_ONLY' | 'ALL_MESSAGES' | 'DISABLED';
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

function serializeAgentDetail(agent: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  triggerMode: 'AUTO' | 'MENTIONS_ONLY' | 'ALL_MESSAGES' | 'DISABLED';
  primaryChannelId: string | null;
  identity: { systemPrompt: string | null; persona: string | null; voiceTone: string | null } | null;
  channelMemberships: Array<{ channelId: string }>;
}): AgentDetail {
  return {
    ...serializeAgent(agent),
    primaryChannelId: agent.primaryChannelId,
    voiceTone: agent.identity?.voiceTone ?? null,
    activeChannelIds: agent.channelMemberships.map((membership) => membership.channelId),
  };
}

function sanitizeAgentSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

function buildDefaultAgentTools() {
  return [
    {
      toolName: 'workspace.read_file',
      config: {
        description: 'Read a file from the agent workspace.',
        access: 'workspace-only',
      },
      requiresApproval: false,
    },
    {
      toolName: 'workspace.apply_patch',
      config: {
        description: 'Apply a structured patch to files inside the agent workspace.',
        access: 'workspace-only',
      },
      requiresApproval: true,
    },
  ];
}

async function requireWorkspaceAccess(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
  });

  if (!membership) {
    throw new Error('You do not have access to this workspace.');
  }

  return membership;
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

  async getAgentDetail(userId: string, agentId: string) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        identity: {
          select: {
            systemPrompt: true,
            persona: true,
            voiceTone: true,
          },
        },
        workspace: {
          select: {
            memberships: {
              where: { userId },
              select: { id: true },
              take: 1,
            },
          },
        },
        channelMemberships: {
          select: {
            channelId: true,
          },
        },
      },
    });

    if (!agent || agent.workspace.memberships.length === 0) {
      throw new Error('You do not have access to this agent.');
    }

    return serializeAgentDetail(agent);
  }

  async createAgent(userId: string, workspaceId: string, input: CreateAgentInput) {
    await requireWorkspaceAccess(userId, workspaceId);

    const slugBase = sanitizeAgentSlug(input.name);
    let slug = slugBase;
    let counter = 1;

    while (
      await prisma.agent.findFirst({
        where: { workspaceId, slug },
        select: { id: true },
      })
    ) {
      counter += 1;
      slug = `${slugBase}-${counter}`;
    }

    const agent = await prisma.agent.create({
      data: {
        workspaceId,
        createdBy: userId,
        name: input.name,
        slug,
        triggerMode: input.triggerMode,
        identity: {
          create: {
            systemPrompt: input.systemPrompt ?? `You are ${input.name}, a collaborative AI agent inside NextGenChat.`,
            persona: input.persona ?? null,
            voiceTone: input.voiceTone ?? null,
          },
        },
        providerConfig: {
          create: {
            providerName: 'openai',
            model: env.OPENAI_MODEL || DEFAULT_AGENT_MODEL,
            credentials: encryptJson({}),
            config: { temperature: 0.4, maxTokens: 1024 },
          },
        },
        tools: {
          create: buildDefaultAgentTools(),
        },
      },
      include: {
        identity: true,
      },
    });

    await workspaceService.ensureAgentDocs(agent.id);

    return serializeAgent(agent);
  }

  async updateAgent(userId: string, agentId: string, input: UpdateAgentInput) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        workspace: {
          select: {
            id: true,
            memberships: {
              where: { userId },
              select: { id: true },
              take: 1,
            },
          },
        },
        identity: true,
      },
    });

    if (!agent || agent.workspace.memberships.length === 0) {
      throw new Error('You do not have access to this agent.');
    }

    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: {
        name: input.name,
        triggerMode: input.triggerMode,
        status: input.status,
        identity: {
          upsert: {
            update: {
              systemPrompt: input.systemPrompt,
              persona: input.persona,
              voiceTone: input.voiceTone,
            },
            create: {
              systemPrompt: input.systemPrompt ?? null,
              persona: input.persona ?? null,
              voiceTone: input.voiceTone ?? null,
            },
          },
        },
      },
      include: {
        identity: true,
      },
    });

    await workspaceService.ensureAgentDocs(agentId);

    return serializeAgent(updated);
  }
}

export const agentsService = new AgentsService();
