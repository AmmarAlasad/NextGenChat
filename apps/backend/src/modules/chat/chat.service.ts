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
  ChannelSummary,
  ContentType,
  MessagePaginationInput,
  MessageRecord,
  SendMessageInput,
  WorkspaceSummary,
} from '@nextgenchat/types';

import { agentProcessQueue } from '@/lib/queues.js';
import { prisma } from '@/db/client.js';
import { agentsService } from '@/modules/agents/agents.service.js';
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
}): ChannelSummary {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    name: channel.name,
    type: channel.type,
  };
}

export function serializeMessage(message: {
  id: string;
  channelId: string;
  senderId: string;
  senderType: 'USER' | 'AGENT';
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
      },
      orderBy: { createdAt: 'asc' },
    });

    const serializedChannels: ChannelSummary[] = [];

    for (const channel of channels) {
      serializedChannels.push(serializeChannel(channel));
    }

    return serializedChannels;
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

    const serializedMessages: MessageRecord[] = [];

    for (const message of [...messages].reverse()) {
      serializedMessages.push(serializeMessage(message));
    }

    return serializedMessages;
  }

  async createUserMessage(userId: string, input: SendMessageInput) {
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

    const serialized = serializeMessage(message);

    getChatNamespace().to(getChannelRoom(input.channelId)).emit('message:new', serialized);

    const triggeredAgents = await agentsService.getTriggeredAgents(
      input.channelId,
      serialized.senderType,
      serialized.content,
    );

    await Promise.all(
      triggeredAgents.map((agent: { id: string }) =>
        agentProcessQueue.add('agent:process', {
          agentId: agent.id,
          channelId: input.channelId,
          messageId: message.id,
        }),
      ),
    );

    return serialized;
  }

  async ensureSocketChannelAccess(userId: string, channelId: string) {
    await ensureChannelMembership(userId, channelId);
  }
}

export const chatService = new ChatService();
