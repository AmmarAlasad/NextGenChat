/**
 * Chat Service — Business Logic
 *
 * Phase 1 implementation status:
 * - This file now implements the first real chat path: list workspaces/channels/messages,
 *   persist user messages, and enqueue agent responses.
 * - Current scope is intentionally narrow and local-first: one owner, one workspace,
 *   one default channel, and one active agent.
 * - Future phases will extend edits, deletes, reactions, search, and read receipts.
 */

import type {
  AgentRoutingReason,
  ChannelSummary,
  ContentType,
  CreateChannelInput,
  CreateDirectChannelInput,
  MessagePaginationInput,
  MessageRecord,
  SendMessageInput,
  UpdateChannelAgentsInput,
  WorkspaceSummary,
} from '@nextgenchat/types';

import { agentProcessQueue } from '@/lib/queues.js';
import type { Prisma } from '@prisma/client';

import { prisma } from '@/db/client.js';
import { agentRoutingService } from '@/modules/agents/agent-routing.service.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';

function serializeWorkspace(workspace: { id: string; name: string; slug: string }): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  };
}

function serializeChannel(channel: {
  id: string;
  workspaceId: string;
  name: string;
  type: 'PUBLIC' | 'PRIVATE' | 'DIRECT';
  agentMemberships?: Array<{ agentId: string; agent: { name: string } }>;
  messages?: Array<{ createdAt: Date }>;
}): ChannelSummary {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    name: channel.name,
    type: channel.type,
    participantAgentIds: channel.agentMemberships?.map((membership) => membership.agentId) ?? [],
    participantAgentNames: channel.agentMemberships?.map((membership) => membership.agent.name) ?? [],
    lastMessageAt: channel.messages?.[0]?.createdAt?.toISOString() ?? null,
  };
}

export function serializeMessage(message: {
  id: string;
  channelId: string;
  senderId: string;
  senderType: 'USER' | 'AGENT';
  senderName?: string | null;
  content: string;
  contentType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'SYSTEM';
  metadata: unknown;
  createdAt: Date;
  editedAt?: Date | null;
  deletedAt?: Date | null;
}): MessageRecord {
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

async function ensureWorkspaceMembership(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
  });

  if (!membership) {
    throw new Error('You do not have access to this workspace.');
  }
}

async function ensureAgentWorkspaceMembership(userId: string, workspaceId: string, agentIds: string[]) {
  if (agentIds.length === 0) {
    return;
  }

  const agents = await prisma.agent.findMany({
    where: {
      id: { in: agentIds },
      workspaceId,
      status: { not: 'ARCHIVED' },
    },
    select: { id: true },
  });

  if (agents.length !== agentIds.length) {
    throw new Error('One or more selected agents do not belong to this workspace.');
  }

  await ensureWorkspaceMembership(userId, workspaceId);
}

async function scheduleTriggeredAgents(input: {
  channelId: string;
  senderId: string;
  senderType: 'USER' | 'AGENT';
  content: string;
  messageId: string;
}) {
  const routing = await agentRoutingService.selectAgentsForMessage(input);

  await Promise.all(
    routing.selectedAgentIds.map((agentId) =>
      agentProcessQueue.add('agent:process', {
        agentId,
        channelId: input.channelId,
        messageId: input.messageId,
      }),
    ),
  );

  return routing;
}

async function createSystemChannelEvent(input: {
  channelId: string;
  actorId: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const message = await prisma.message.create({
    data: {
      channelId: input.channelId,
      senderId: input.actorId,
      senderType: 'USER',
      content: input.content,
      contentType: 'SYSTEM',
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  const actor = await prisma.user.findUnique({
    where: { id: input.actorId },
    select: { username: true },
  });

  const serialized = serializeMessage({
    ...message,
    senderName: actor?.username ?? 'System',
  });

  getChatNamespace().to(getChannelRoom(input.channelId)).emit('message:new', serialized);

  return serialized;
}

async function ensureChannelMembership(userId: string, channelId: string) {
  const membership = await prisma.channelMembership.findFirst({
    where: { userId, channelId },
  });

  if (!membership) {
    throw new Error('You do not have access to this channel.');
  }
}

export class ChatService {
  async listWorkspaces(userId: string) {
    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: {
        joinedAt: 'asc',
      },
    });

    const workspaces: WorkspaceSummary[] = [];

    for (const membership of memberships) {
      workspaces.push(serializeWorkspace(membership.workspace));
    }

    return workspaces;
  }

  async listChannels(userId: string, workspaceId: string) {
    await ensureWorkspaceMembership(userId, workspaceId);

    const channels = await prisma.channel.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        memberships: {
          some: {
            userId,
          },
        },
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        type: true,
        agentMemberships: {
          include: {
            agent: {
              select: {
                name: true,
              },
            },
          },
        },
        messages: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const serializedChannels: ChannelSummary[] = [];

    for (const channel of channels) {
      serializedChannels.push(serializeChannel(channel));
    }

    return serializedChannels;
  }

  async createChannel(userId: string, workspaceId: string, input: CreateChannelInput) {
    await ensureAgentWorkspaceMembership(userId, workspaceId, input.agentIds);

    if (input.type === 'DIRECT' && input.agentIds.length !== 1) {
      throw new Error('Direct chats must be created with exactly one agent.');
    }

    const channel = await prisma.channel.create({
      data: {
        workspaceId,
        name: input.name,
        type: input.type,
        memberships: {
          create: {
            userId,
            role: 'OWNER',
          },
        },
        agentMemberships: {
          create: input.agentIds.map((agentId) => ({
            agentId,
            addedBy: userId,
          })),
        },
      },
      include: {
        agentMemberships: {
          include: {
            agent: {
              select: { name: true },
            },
          },
        },
        messages: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (input.agentIds.length > 0 && input.type !== 'DIRECT') {
      const agentNames = channel.agentMemberships.map((membership) => membership.agent.name);
      await createSystemChannelEvent({
        channelId: channel.id,
        actorId: userId,
        content: `${agentNames.join(', ')} joined the group.`,
        metadata: {
          eventType: 'GROUP_AGENT_JOIN',
          agentIds: input.agentIds,
        },
      });
    }

    return serializeChannel(channel);
  }

  async createDirectChannel(userId: string, input: CreateDirectChannelInput) {
    const agent = await prisma.agent.findUnique({
      where: { id: input.agentId },
      select: { id: true, name: true, workspaceId: true },
    });

    if (!agent) {
      throw new Error('Agent not found.');
    }

    await ensureWorkspaceMembership(userId, agent.workspaceId);

    const existing = await prisma.channel.findFirst({
      where: {
        workspaceId: agent.workspaceId,
        type: 'DIRECT',
        memberships: { some: { userId } },
        agentMemberships: { some: { agentId: agent.id } },
      },
      include: {
        agentMemberships: {
          include: { agent: { select: { name: true } } },
        },
        messages: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (existing) {
      return serializeChannel(existing);
    }

    return this.createChannel(userId, agent.workspaceId, {
      name: agent.name,
      type: 'DIRECT',
      agentIds: [agent.id],
    });
  }

  async updateChannelAgents(userId: string, channelId: string, input: UpdateChannelAgentsInput) {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        workspaceId: true,
        type: true,
      },
    });

    if (!channel) {
      throw new Error('Channel not found.');
    }

    if (channel.type === 'DIRECT') {
      throw new Error('Direct chat memberships are managed through direct chat creation.');
    }

    await ensureAgentWorkspaceMembership(userId, channel.workspaceId, input.agentIds);

    const existingMemberships = await prisma.agentChannelMembership.findMany({
      where: { channelId },
      select: { agentId: true },
    });

    await prisma.$transaction([
      prisma.agentChannelMembership.deleteMany({ where: { channelId } }),
      ...input.agentIds.map((agentId) =>
        prisma.agentChannelMembership.create({
          data: {
            channelId,
            agentId,
            addedBy: userId,
          },
        }),
      ),
    ]);

    const updated = await prisma.channel.findUniqueOrThrow({
      where: { id: channelId },
      include: {
        agentMemberships: {
          include: { agent: { select: { name: true } } },
        },
        messages: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const existingIds = new Set(existingMemberships.map((membership) => membership.agentId));
    const addedAgents = updated.agentMemberships.filter((membership) => !existingIds.has(membership.agentId));

    if (addedAgents.length > 0) {
      await createSystemChannelEvent({
        channelId,
        actorId: userId,
        content: `${addedAgents.map((membership) => membership.agent.name).join(', ')} joined the group.`,
        metadata: {
          eventType: 'GROUP_AGENT_JOIN',
          agentIds: addedAgents.map((membership) => membership.agentId),
        },
      });
    }

    return serializeChannel(updated);
  }

  async listMessages(userId: string, channelId: string, pagination: MessagePaginationInput) {
    await ensureChannelMembership(userId, channelId);

    let beforeCursor: Date | undefined;

    if (pagination.before) {
      const beforeMessage = await prisma.message.findUnique({
        where: { id: pagination.before },
        select: { createdAt: true },
      });

      beforeCursor = beforeMessage?.createdAt;
    }

    const messages = await prisma.message.findMany({
      where: {
        channelId,
        ...(beforeCursor
          ? {
              createdAt: {
                lt: beforeCursor,
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: pagination.limit,
    });

    const userSenderIds = Array.from(new Set(messages.filter((message) => message.senderType === 'USER').map((message) => message.senderId)));
    const agentSenderIds = Array.from(new Set(messages.filter((message) => message.senderType === 'AGENT').map((message) => message.senderId)));

    const [usersById, agentsById] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userSenderIds } },
        select: { id: true, username: true },
      }),
      prisma.agent.findMany({
        where: { id: { in: agentSenderIds } },
        select: { id: true, name: true },
      }),
    ]);

    const userNameMap = new Map(usersById.map((entry) => [entry.id, entry.username]));
    const agentNameMap = new Map(agentsById.map((entry) => [entry.id, entry.name]));

    const serializedMessages: MessageRecord[] = [];

    for (const message of [...messages].reverse()) {
      serializedMessages.push(
        serializeMessage({
          ...message,
          senderName: message.senderType === 'AGENT' ? (agentNameMap.get(message.senderId) ?? null) : (userNameMap.get(message.senderId) ?? null),
        }),
      );
    }

    return serializedMessages;
  }

  async createUserMessage(userId: string, input: SendMessageInput): Promise<MessageRecord> {
    await ensureChannelMembership(userId, input.channelId);

    const message = await prisma.message.create({
      data: {
        channelId: input.channelId,
        senderId: userId,
        senderType: 'USER',
        content: input.content,
        contentType: input.contentType as ContentType,
      },
    });

    const sender = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    const serializedBase = serializeMessage({
      ...message,
      senderName: sender?.username ?? null,
    });

    const routing = await this.triggerAgentsForMessage({
      channelId: input.channelId,
      senderId: userId,
      senderType: serializedBase.senderType,
      content: serializedBase.content,
      messageId: message.id,
    });

    const serialized = {
      ...serializedBase,
      metadata: {
        ...(serializedBase.metadata ?? {}),
        routing,
      },
    };

    getChatNamespace().to(getChannelRoom(input.channelId)).emit('message:new', serialized);

    return serialized;
  }

  async triggerAgentsForMessage(input: {
    channelId: string;
    senderId: string;
    senderType: 'USER' | 'AGENT';
    content: string;
    messageId: string;
  }): Promise<{ selectedAgentIds: string[]; diagnostics: AgentRoutingReason[] }> {
    return scheduleTriggeredAgents(input);
  }

  async createAgentRelayMessage(input: { channelId: string; senderId: string; content: string; contentType: ContentType; metadata?: Record<string, unknown> | null }): Promise<MessageRecord> {
    const message = await prisma.message.create({
      data: {
        channelId: input.channelId,
        senderId: input.senderId,
        senderType: 'AGENT',
        content: input.content,
        contentType: input.contentType,
        metadata: (input.metadata as Prisma.InputJsonValue | null | undefined) ?? undefined,
      },
    });

    const agent = await prisma.agent.findUnique({
      where: { id: input.senderId },
      select: { name: true },
    });

    return serializeMessage({
      ...message,
      senderName: agent?.name ?? null,
    });
  }

  async ensureSocketChannelAccess(userId: string, channelId: string) {
    await ensureChannelMembership(userId, channelId);
  }
}

export const chatService = new ChatService();
