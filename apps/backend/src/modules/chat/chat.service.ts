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

import path from 'node:path';

import type {
  AgentRoutingReason,
  CompactChannelSessionInput,
  CompactChannelSessionResult,
  ChannelSessionSummary,
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
import { compactionService } from '@/modules/context/compaction.service.js';
import { sessionLaneRegistry } from '@/modules/gateway/session-lane.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
const TEXT_ATTACHMENT_MIME_PREFIXES = ['text/'];
const TEXT_ATTACHMENT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.log', '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.py', '.sh', '.sql', '.env', '.ini', '.toml', '.cfg', '.conf',
]);

interface MessageAttachmentInput {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

interface PersistedMessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  relativePath: string;
  fileKey: string;
  textPreview?: string | null;
}

interface AgentMessageAttachmentInput {
  fileName: string;
  mimeType: string;
  relativePath: string;
  contentBuffer: Buffer;
  textPreview?: string | null;
}

interface ChannelLiveStateSnapshot {
  channelId: string;
  agentState: 'idle' | 'queued' | 'streaming' | 'error';
  turns: Array<{
    tempId: string;
    agentId: string;
    text: string;
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      status: 'running' | 'success' | 'failed';
      arguments?: unknown;
      output?: string;
      durationMs?: number;
      success?: boolean;
    }>;
  }>;
  todos: Array<{
    agentId: string;
    agentName: string;
    todos: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority: 'high' | 'medium' | 'low';
    }>;
  }>;
}

type SendMessageWithAttachmentsInput = SendMessageInput & {
  attachments?: MessageAttachmentInput[];
};

function sanitizeAttachmentFileName(fileName: string) {
  const cleaned = fileName.replace(/[\r\n\t]/g, ' ').replace(/[\\/]+/g, '-').trim();
  return cleaned || `attachment-${Date.now()}`;
}

function buildAttachmentRelativePath(channelId: string, messageId: string, fileName: string) {
  return `uploads/${channelId}/${messageId}/${sanitizeAttachmentFileName(fileName)}`;
}

function buildAttachmentDownloadPath(attachmentId: string) {
  return `/attachments/${attachmentId}/download`;
}

function createAttachmentRoutingHint(content: string, attachments: Array<{ fileName: string }>) {
  if (attachments.length === 0) return content;

  const fileHint = `Uploaded files: ${attachments.map((attachment) => attachment.fileName).join(', ')}`;
  return content.trim() ? `${content.trim()}\n\n${fileHint}` : fileHint;
}

function decodeAttachmentBase64(attachment: MessageAttachmentInput) {
  const buffer = Buffer.from(attachment.contentBase64, 'base64');

  if (buffer.byteLength === 0) {
    throw new Error(`Attachment "${attachment.fileName}" is empty or invalid.`);
  }

  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment "${attachment.fileName}" exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit.`);
  }

  return buffer;
}

function isTextAttachment(fileName: string, mimeType: string, fileSize: number) {
  if (fileSize > TEXT_ATTACHMENT_MAX_BYTES) return false;

  const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (TEXT_ATTACHMENT_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) return true;
  if (TEXT_ATTACHMENT_MIMES.has(normalizedMime)) return true;

  return TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function extractTextAttachmentContent(fileName: string, mimeType: string, buffer: Buffer) {
  if (!isTextAttachment(fileName, mimeType, buffer.byteLength)) {
    return null;
  }

  return buffer.toString('utf8');
}

function buildAttachmentMetadataEntries(entries: Array<{
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  relativePath: string;
  fileKey: string;
  textPreview?: string | null;
}>) {
  return entries.map((entry) => ({
    id: entry.id,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    fileSize: entry.fileSize,
    relativePath: entry.relativePath,
    fileKey: entry.fileKey,
    downloadPath: buildAttachmentDownloadPath(entry.id),
    textPreview: entry.textPreview ?? null,
  }));
}

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
  projectId?: string | null;
  name: string;
  type: 'PUBLIC' | 'PRIVATE' | 'DIRECT';
  agentMemberships?: Array<{ agentId: string; agent: { name: string } }>;
  messages?: Array<{ createdAt: Date }>;
}): ChannelSummary {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    projectId: channel.projectId ?? null,
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

function isInternalMessage(metadata: unknown) {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && 'internal' in metadata
    && (metadata as Record<string, unknown>).internal === true,
  );
}

function estimateSessionTextTokens(content: string) {
  return Math.ceil(content.length / 4) + 4;
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
  isRelay?: boolean;
}) {
  const routing = await agentRoutingService.selectAgentsForMessage(input);
  const selectedAgentIds = Array.from(new Set(routing.selectedAgentIds));

  await Promise.all(
    selectedAgentIds.map((agentId) =>
      agentProcessQueue.add('agent:process', {
        agentId,
        channelId: input.channelId,
        messageId: input.messageId,
      }, {
        jobId: `${input.messageId}:${agentId}`,
      }),
    ),
  );

  // Always notify the client that routing is done.  When 0 agents are selected
  // the client would otherwise stay stuck in the "Routing…" state forever.
  getChatNamespace().to(getChannelRoom(input.channelId)).emit('message:routing:complete', {
      channelId: input.channelId,
      selectedCount: selectedAgentIds.length,
    });

  return {
    ...routing,
    selectedAgentIds,
  };
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

async function persistMessageAttachments(input: {
  userId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  agentIds: string[];
  attachments: MessageAttachmentInput[];
}) {
  const results: PersistedMessageAttachment[] = [];
  const usedFileNames = new Map<string, number>();

  for (const attachment of input.attachments) {
    const sanitizedBaseFileName = sanitizeAttachmentFileName(attachment.fileName);
    const seenCount = usedFileNames.get(sanitizedBaseFileName) ?? 0;
    usedFileNames.set(sanitizedBaseFileName, seenCount + 1);
    const ext = path.extname(sanitizedBaseFileName);
    const stem = ext ? sanitizedBaseFileName.slice(0, -ext.length) : sanitizedBaseFileName;
    const sanitizedFileName = seenCount === 0 ? sanitizedBaseFileName : `${stem}-${seenCount + 1}${ext}`;
    const buffer = decodeAttachmentBase64({ ...attachment, fileName: sanitizedFileName });
    const relativePath = buildAttachmentRelativePath(input.channelId, input.messageId, sanitizedFileName);
    const fileKey = `channels/${input.channelId}/messages/${input.messageId}/${sanitizedFileName}`;
    const textContent = extractTextAttachmentContent(sanitizedFileName, attachment.mimeType, buffer);

    const createdAttachment = await prisma.attachment.create({
      data: {
        messageId: input.messageId,
        uploadedBy: input.userId,
        fileKey,
        fileName: sanitizedFileName,
        fileSize: buffer.byteLength,
        mimeType: attachment.mimeType,
        virusScanStatus: 'CLEAN',
      },
    });

    for (const agentId of input.agentIds) {
      await workspaceService.saveUploadedFileToAgentWorkspace({
        agentId,
        workspaceId: input.workspaceId,
        uploadedBy: input.userId,
        relativePath,
        fileName: sanitizedFileName,
        mimeType: attachment.mimeType,
        fileSize: buffer.byteLength,
        contentBuffer: buffer,
        textContent,
      });
    }

    results.push({
      id: createdAttachment.id,
      fileName: sanitizedFileName,
      mimeType: attachment.mimeType,
      fileSize: buffer.byteLength,
      relativePath,
      fileKey,
      textPreview: textContent ? textContent.slice(0, 4000) : null,
    });
  }

  return results;
}

async function persistAgentMessageAttachments(input: {
  messageId: string;
  senderId: string;
  attachments: AgentMessageAttachmentInput[];
}) {
  const results: PersistedMessageAttachment[] = [];

  for (const attachment of input.attachments) {
    const fileKey = `agents/${input.senderId}/${attachment.relativePath}`;
    const createdAttachment = await prisma.attachment.create({
      data: {
        messageId: input.messageId,
        uploadedBy: null,
        fileKey,
        fileName: attachment.fileName,
        fileSize: attachment.contentBuffer.byteLength,
        mimeType: attachment.mimeType,
        virusScanStatus: 'CLEAN',
      },
    });

    results.push({
      id: createdAttachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.contentBuffer.byteLength,
      relativePath: attachment.relativePath,
      fileKey,
      textPreview: attachment.textPreview ?? null,
    });
  }

  return results;
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
        projectId: true,
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

    const rawMessages = await prisma.message.findMany({
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
      take: pagination.limit * 3,
    });

    const messages = rawMessages
      .filter((message) => !isInternalMessage(message.metadata))
      .slice(0, pagination.limit);

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
    const messageInput = input as SendMessageWithAttachmentsInput;

    await ensureChannelMembership(userId, input.channelId);

    const channel = await prisma.channel.findUnique({
      where: { id: input.channelId },
      select: {
        workspaceId: true,
        agentMemberships: {
          select: { agentId: true },
        },
      },
    });

    if (!channel) {
      throw new Error('Channel not found.');
    }

    const message = await prisma.message.create({
      data: {
        channelId: input.channelId,
        senderId: userId,
        senderType: 'USER',
        content: input.content.trim(),
        contentType: input.contentType as ContentType,
      },
    });

    const attachmentEntries = messageInput.attachments?.length
      ? await persistMessageAttachments({
          userId,
          workspaceId: channel.workspaceId,
          channelId: input.channelId,
          messageId: message.id,
          agentIds: channel.agentMemberships.map((membership) => membership.agentId),
          attachments: messageInput.attachments,
        })
      : [];

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
      content: createAttachmentRoutingHint(serializedBase.content, attachmentEntries),
      messageId: message.id,
    });

    const metadata = {
      routing,
      attachments: buildAttachmentMetadataEntries(attachmentEntries),
    };

    await prisma.message.update({
      where: { id: message.id },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
      },
    });

    const serialized = {
      ...serializedBase,
      metadata,
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
    /** Set to true for tool-relay messages — allows AUTO pickup agents to evaluate
     *  the message even though the sender is an agent. */
    isRelay?: boolean;
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

  async createAgentAttachmentMessage(input: {
    channelId: string;
    senderId: string;
    content: string;
    contentType: ContentType;
    metadata?: Record<string, unknown> | null;
    attachments: AgentMessageAttachmentInput[];
  }): Promise<MessageRecord> {
    const message = await prisma.message.create({
      data: {
        channelId: input.channelId,
        senderId: input.senderId,
        senderType: 'AGENT',
        content: input.content,
        contentType: input.contentType,
      },
    });

    const attachmentEntries = await persistAgentMessageAttachments({
      messageId: message.id,
      senderId: input.senderId,
      attachments: input.attachments,
    });

    const metadata = {
      ...(input.metadata ?? {}),
      attachments: buildAttachmentMetadataEntries(attachmentEntries),
    };

    await prisma.message.update({
      where: { id: message.id },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
      },
    });

    const agent = await prisma.agent.findUnique({
      where: { id: input.senderId },
      select: { name: true },
    });

    return serializeMessage({
      ...message,
      senderName: agent?.name ?? null,
      metadata,
    });
  }

  async downloadAttachment(userId: string, attachmentId: string) {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        message: {
          select: {
            channelId: true,
            senderId: true,
            senderType: true,
            metadata: true,
            channel: {
              select: {
                agentMemberships: {
                                  select: { agentId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!attachment) {
      throw new Error('Attachment not found.');
    }

    await ensureChannelMembership(userId, attachment.message.channelId);

    const metadataAttachments = Array.isArray((attachment.message.metadata as { attachments?: unknown } | null | undefined)?.attachments)
      ? (attachment.message.metadata as { attachments: Array<Record<string, unknown>> }).attachments
      : [];
    const metadataEntry = metadataAttachments.find((entry) => entry?.id === attachment.id);
    const relativePath = typeof metadataEntry?.relativePath === 'string' ? metadataEntry.relativePath : null;

    if (!relativePath) {
      throw new Error('Attachment is missing a readable workspace path.');
    }

    const sourceAgentId = attachment.message.senderType === 'AGENT'
      ? attachment.message.senderId
      : (attachment.message.channel.agentMemberships[0]?.agentId ?? null);

    if (!sourceAgentId) {
      throw new Error('Attachment file is not available for download in this channel yet.');
    }

    const file = await workspaceService.readAgentWorkspaceBinaryFile(sourceAgentId, relativePath);

    return {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      content: file.content,
    };
  }

  async ensureSocketChannelAccess(userId: string, channelId: string) {
    await ensureChannelMembership(userId, channelId);
  }

  async stopAgentExecution(userId: string, channelId: string, agentId: string) {
    await ensureChannelMembership(userId, channelId);

    const membership = await prisma.agentChannelMembership.findFirst({
      where: { channelId, agentId },
      select: { agentId: true },
    });

    if (!membership) {
      throw new Error('That agent is not a member of this channel.');
    }

    const { agentSessionGateway } = await import('@/modules/gateway/agent-session.gateway.js');
    const cancelled = agentSessionGateway.cancelAgentTurn(agentId, channelId);

    return {
      stopped: Boolean(cancelled),
      agentId,
      channelId,
      message: cancelled
        ? 'Stop requested for the active agent run.'
        : 'That agent is not currently running in this channel.',
    };
  }

  async getChannelSession(userId: string, channelId: string): Promise<ChannelSessionSummary> {
    await ensureChannelMembership(userId, channelId);

    const [messages, summaryCount, latestSummary] = await Promise.all([
      prisma.message.findMany({
        where: {
          channelId,
          senderType: 'AGENT',
          contentType: { not: 'SYSTEM' },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true,
          metadata: true,
        },
      }),
      prisma.conversationSummary.count({
        where: { channelId },
      }),
      prisma.conversationSummary.findFirst({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        select: {
          tokenCount: true,
          covesToMessageId: true,
          firstKeptMessageId: true,
        },
      }),
    ]);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let provider: string | null = null;
    let model: string | null = null;
    let latestContextUsed: number | null = null;
    let latestContextLimit: number | null = null;
    let lastActiveAt: string | null = null;

    for (const message of messages) {
      const metadata = (message.metadata as Record<string, unknown> | null) ?? null;
      const usage = (metadata?.usage as Record<string, unknown> | undefined) ?? undefined;
      const context = (metadata?.context as Record<string, unknown> | undefined) ?? undefined;

      totalPromptTokens += typeof usage?.promptTokens === 'number' ? usage.promptTokens : 0;
      totalCompletionTokens += typeof usage?.completionTokens === 'number' ? usage.completionTokens : 0;
      totalCachedTokens += typeof usage?.cachedTokens === 'number' ? usage.cachedTokens : 0;

      if (typeof metadata?.provider === 'string') {
        provider = metadata.provider;
      }

      if (typeof metadata?.model === 'string') {
        model = metadata.model;
      }

      if (typeof context?.budgetUsed === 'number') {
        latestContextUsed = context.budgetUsed;
      }

      if (typeof context?.budgetLimit === 'number') {
        latestContextLimit = context.budgetLimit;
      }

      lastActiveAt = message.createdAt.toISOString();
    }

    let estimatedCurrentContextUsed = latestContextUsed;
    if (latestSummary) {
      let candidateCreatedAtGte: Date | undefined;

      if (latestSummary.firstKeptMessageId) {
        const firstKept = await prisma.message.findUnique({
          where: { id: latestSummary.firstKeptMessageId },
          select: { createdAt: true },
        });
        candidateCreatedAtGte = firstKept?.createdAt;
      } else if (latestSummary.covesToMessageId) {
        const coveredTo = await prisma.message.findUnique({
          where: { id: latestSummary.covesToMessageId },
          select: { createdAt: true },
        });
        if (coveredTo) {
          candidateCreatedAtGte = new Date(coveredTo.createdAt.getTime() + 1);
        }
      }

      const remainingMessages = await prisma.message.findMany({
        where: {
          channelId,
          contentType: { not: 'SYSTEM' },
          ...(candidateCreatedAtGte ? { createdAt: { gte: candidateCreatedAtGte } } : {}),
        },
        select: { content: true },
      });

      estimatedCurrentContextUsed = latestSummary.tokenCount + remainingMessages.reduce((sum, message) => sum + estimateSessionTextTokens(message.content), 0);
    }

    return {
      sessionId: channelId,
      channelId,
      provider,
      model,
      assistantTurns: messages.length,
      totalPromptTokens,
      totalCompletionTokens,
      totalCachedTokens,
      latestContextUsed: estimatedCurrentContextUsed,
      latestContextLimit,
      latestContextUsagePercent:
        estimatedCurrentContextUsed !== null && latestContextLimit !== null && latestContextLimit > 0
          ? Math.round((estimatedCurrentContextUsed / latestContextLimit) * 1000) / 10
          : null,
      summaryCount,
      lastActiveAt,
    };
  }

  async getChannelLiveState(userId: string, channelId: string): Promise<ChannelLiveStateSnapshot> {
    await ensureChannelMembership(userId, channelId);
    return sessionLaneRegistry.getLiveState(channelId);
  }

  async compactChannelSession(userId: string, channelId: string, input: CompactChannelSessionInput): Promise<CompactChannelSessionResult> {
    await ensureChannelMembership(userId, channelId);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        agentMemberships: {
          include: {
            agent: {
              select: {
                id: true,
                name: true,
                slug: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!channel) {
      throw new Error('Channel not found.');
    }

    const activeAgents = channel.agentMemberships
      .map((membership) => membership.agent)
      .filter((agent) => agent.status === 'ACTIVE');

    if (activeAgents.length === 0) {
      throw new Error('No active agents are available to compact this session.');
    }

    let targets = activeAgents;

    if (input.all !== true && input.agentSlug) {
      const matched = activeAgents.find((agent) => agent.slug.toLowerCase() === input.agentSlug?.toLowerCase());

      if (!matched) {
        throw new Error(`Agent '${input.agentSlug}' is not in this channel.`);
      }

      targets = [matched];
    }

    const results = await Promise.all(
      targets.map((agent) => compactionService.compactNow({
        agentId: agent.id,
        channelId,
        origin: 'manual',
      })),
    );

    const compactedAgentNames = results.filter((result) => result.compacted).map((result) => result.agentName);
    const compactedAgentIds = results.filter((result) => result.compacted).map((result) => result.agentId);
    const skippedAgentNames = results.filter((result) => !result.compacted).map((result) => result.agentName);

    if (compactedAgentNames.length > 0) {
      const message = await prisma.message.create({
        data: {
          channelId,
          senderId: compactedAgentIds[0],
          senderType: 'AGENT',
          content: compactedAgentNames.length === 1
            ? `Session compacted for ${compactedAgentNames[0]}.`
            : `Session compacted for ${compactedAgentNames.join(', ')}.`,
          contentType: 'SYSTEM',
          metadata: {
            compaction: {
              agentIds: compactedAgentIds,
              agentNames: compactedAgentNames,
              skippedAgentNames,
              origin: 'manual',
            },
          },
        },
      });

      getChatNamespace().to(getChannelRoom(channelId)).emit('message:new', serializeMessage({
        ...message,
        senderName: compactedAgentNames[0] ?? null,
      }));
    }

    return {
      compactedAgentIds,
      compactedAgentNames,
      skippedAgentNames,
      message:
        compactedAgentNames.length > 0
          ? `Compacted session for ${compactedAgentNames.join(', ')}.`
          : `No compaction was needed for ${skippedAgentNames.join(', ')}.`,
    };
  }
}

export const chatService = new ChatService();
