/**
 * Context Builder — Assembles the LLM Prompt
 *
 * Builds a stable, budgeted prompt from agent docs, durable memory, compacted
 * summaries, and the most relevant recent turns. This is the main context
 * engineering boundary for the agent pipeline.
 *
 * Cross-channel awareness (DIRECT channels):
 *   When the agent is responding in a DM, the builder also injects a
 *   cross-channel-context.md section listing every group channel the agent
 *   belongs to, along with the last few messages from each.  This lets the
 *   agent reference those conversations and, when instructed, relay a message
 *   by including:
 *     <<send:channel-name>>message content<</send>>
 *   anywhere in its response.  The agent processor strips and executes these
 *   relay tags after the LLM call.
 */

import type { LLMMessage, SenderType } from '@nextgenchat/types';

import { CONTEXT_LIMITS, RESPONSE_BUFFER } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { compactionService } from '@/modules/context/compaction.service.js';
import { promptCacheService } from '@/modules/context/cache.service.js';
import { tokenCounter } from '@/modules/context/token-counter.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

export interface ContextBuildResult {
  messages: LLMMessage[];
  totalTokens: number;
  budgetUsed: number;
  budgetLimit: number;
  compactionTriggered: boolean;
  summaryUsed: boolean;
  staticPrefixKey: string;
}

function buildRuntimeIdentityMessage(input: {
  agentName: string;
  agentSlug: string;
  channelName: string;
  channelType: 'PUBLIC' | 'PRIVATE' | 'DIRECT';
  participantNames: string[];
}) {
  return [
    '# runtime-context.md',
    '',
    `You are ${input.agentName} (@${input.agentSlug}).`,
    'Always speak in first person when referring to yourself.',
    'Never describe yourself as unavailable, absent, or as a third-party colleague if you are the one responding.',
    'If a group message asks who people are or asks for names, answer for yourself only unless the user explicitly asks you to summarize the whole team.',
    'Do not assign lines or speaking tasks to other agents unless the message explicitly asks for coordination.',
    `Current channel: ${input.channelName} (${input.channelType}).`,
    `Visible participants in this channel: ${input.participantNames.join(', ') || 'none recorded'}.`,
    input.channelType === 'DIRECT'
      ? 'This is a direct conversation. Stay focused on the operator and do not role-play other agents.'
      : 'This is a group conversation. Other agents are colleagues, not your own prior assistant turns. You may respond to them only when it is genuinely useful.',
  ].join('\n');
}

function toConversationMessage(message: {
  senderId: string;
  senderType: SenderType;
  senderName: string | null;
  content: string;
}, currentAgentId: string): LLMMessage {
  if (message.senderType === 'AGENT' && message.senderId === currentAgentId) {
    return {
      role: 'assistant',
      content: message.content,
    };
  }

  const speakerType = message.senderType === 'AGENT' ? 'AGENT_COLLEAGUE' : 'USER';
  const speakerName = message.senderName ?? (message.senderType === 'AGENT' ? 'Unknown agent' : 'Unknown user');

  return {
    role: 'user',
    content: `<message speaker="${speakerName}" speakerType="${speakerType}">\n${message.content}\n</message>`,
  };
}

function formatMemoryBlock(
  entries: Array<{ scope: 'GLOBAL' | 'CHANNEL' | 'USER'; key: string; value: unknown; channelId: string | null; userId: string | null }>,
) {
  if (entries.length === 0) {
    return 'No durable memory entries recorded yet.';
  }

  return entries
    .map((entry) => {
      const qualifiers = [
        `scope=${entry.scope}`,
        entry.channelId ? `channel=${entry.channelId}` : null,
        entry.userId ? `user=${entry.userId}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      return `- ${entry.key} (${qualifiers}): ${JSON.stringify(entry.value)}`;
    })
    .join('\n');
}

function getContextLimit(model: string) {
  return CONTEXT_LIMITS[model] ?? 64_000;
}

function buildCrossChannelContextMessage(channels: Array<{
  name: string;
  recentMessages: Array<{ senderName: string; senderType: SenderType; content: string }>;
}>): string {
  const lines = [
    '# cross-channel-context.md',
    '',
    'You are also an active member in the group channels listed below.',
    'You can reference recent conversations from those channels in your replies.',
    '',
    'If the user asks you to send a message to one of these channels, include',
    'the following block anywhere in your response (you may also write your',
    'normal reply alongside it):',
    '',
    '  <<send:channel-name>>',
    '  The message you want to post in that channel.',
    '  <</send>>',
    '',
    'Use the exact channel name (case-insensitive). Only send to a channel when',
    'the user explicitly asks for it.',
    '',
  ];

  for (const ch of channels) {
    lines.push(`## #${ch.name}`);
    if (ch.recentMessages.length === 0) {
      lines.push('No recent messages in this channel.');
    } else {
      lines.push('Recent messages (newest last):');
      for (const msg of ch.recentMessages) {
        const prefix = msg.senderType === 'AGENT' ? `[Agent: ${msg.senderName}]` : `[${msg.senderName}]`;
        lines.push(`  ${prefix}: ${msg.content.slice(0, 250)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export class ContextBuilder {
  async build(agentId: string, channelId: string, triggerMessageId: string): Promise<ContextBuildResult> {
    await workspaceService.ensureAgentDocs(agentId);

    const [agent, docs, memoryEntries, summary, triggerMessage, candidateMessages, channel] = await Promise.all([
      prisma.agent.findUnique({
        where: { id: agentId },
        include: {
          providerConfig: true,
          identity: true,
        },
      }),
      prisma.workspaceFile.findMany({
        where: {
          agentId,
          docType: {
            in: ['AGENT_MD', 'IDENTITY_MD', 'AGENCY_MD', 'HEARTBEAT_MD'],
          },
        },
        select: {
          fileName: true,
          content: true,
        },
        orderBy: { fileName: 'asc' },
      }),
      prisma.agentMemory.findMany({
        where: {
          agentId,
          OR: [{ scope: 'GLOBAL' }, { scope: 'CHANNEL', channelId }],
        },
        orderBy: [{ scope: 'asc' }, { key: 'asc' }],
      }),
      prisma.conversationSummary.findFirst({
        where: { agentId, channelId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.message.findUnique({ where: { id: triggerMessageId } }),
      prisma.message.findMany({
        where: {
          channelId,
          NOT: { id: triggerMessageId },
        },
        orderBy: { createdAt: 'desc' },
        take: 80,
        select: {
          id: true,
          senderId: true,
          senderType: true,
          content: true,
        },
      }),
      prisma.channel.findUnique({
        where: { id: channelId },
        include: {
          memberships: {
            include: {
              user: {
                select: {
                  username: true,
                },
              },
            },
          },
          agentMemberships: {
            include: {
              agent: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!agent?.providerConfig || !triggerMessage || !channel) {
      throw new Error('Agent context could not be built.');
    }

    // For direct channels, load the agent's group channel memberships so the
    // agent is aware of conversations happening elsewhere and can relay messages.
    let crossChannelInfo: Array<{
      name: string;
      recentMessages: Array<{ senderName: string; senderType: SenderType; content: string }>;
    }> = [];

    if (channel.type === 'DIRECT') {
      const groupMemberships = await prisma.agentChannelMembership.findMany({
        where: {
          agentId,
          channel: { type: { not: 'DIRECT' } },
        },
        include: {
          channel: {
            include: {
              messages: {
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: {
                  senderId: true,
                  senderType: true,
                  content: true,
                  contentType: true,
                },
              },
            },
          },
        },
      });

      // Resolve sender names for cross-channel messages.
      const allCrossUserIds = new Set<string>();
      const allCrossAgentIds = new Set<string>();
      for (const membership of groupMemberships) {
        for (const msg of membership.channel.messages) {
          if (msg.senderType === 'USER') allCrossUserIds.add(msg.senderId);
          else allCrossAgentIds.add(msg.senderId);
        }
      }

      const [crossUsers, crossAgents] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: Array.from(allCrossUserIds) } }, select: { id: true, username: true } }),
        prisma.agent.findMany({ where: { id: { in: Array.from(allCrossAgentIds) } }, select: { id: true, name: true } }),
      ]);

      const crossUserMap = new Map(crossUsers.map((u) => [u.id, u.username]));
      const crossAgentMap = new Map(crossAgents.map((a) => [a.id, a.name]));

      crossChannelInfo = groupMemberships.map((membership) => ({
        name: membership.channel.name,
        recentMessages: [...membership.channel.messages]
          .reverse()
          .filter((msg) => msg.contentType !== 'SYSTEM')
          .map((msg) => ({
            senderType: msg.senderType as SenderType,
            senderName: msg.senderType === 'AGENT'
              ? (crossAgentMap.get(msg.senderId) ?? 'Agent')
              : (crossUserMap.get(msg.senderId) ?? 'User'),
            content: msg.content,
          })),
      }));
    }

    const provider = await providerRegistry.get(agentId).catch(() => undefined);
    const budgetLimit = getContextLimit(agent.providerConfig.model) - RESPONSE_BUFFER;

    const staticMessages: LLMMessage[] = docs
      .filter((doc) => doc.content?.trim())
      .map((doc) => ({
        role: 'system',
        content: `# ${doc.fileName}\n\n${doc.content ?? ''}`,
      }));

    staticMessages.unshift({
      role: 'system',
      content: buildRuntimeIdentityMessage({
        agentName: agent.name,
        agentSlug: agent.slug,
        channelName: channel.name,
        channelType: channel.type,
        participantNames: [
          ...channel.memberships.map((membership) => membership.user.username),
          ...channel.agentMemberships.map((membership) => membership.agent.name),
        ],
      }),
    });

    staticMessages.push({
      role: 'system',
      content: `# memory.md\n\n${formatMemoryBlock(memoryEntries)}`,
    });

    if (summary?.summary) {
      staticMessages.push({
        role: 'system',
        content: `# conversation-summary.md\n\n${summary.summary}`,
      });
    }

    if (crossChannelInfo.length > 0) {
      staticMessages.push({
        role: 'system',
        content: buildCrossChannelContextMessage(crossChannelInfo),
      });
    }

    const userSenderIds = Array.from(new Set([triggerMessage.senderType === 'USER' ? triggerMessage.senderId : null, ...candidateMessages.filter((message) => message.senderType === 'USER').map((message) => message.senderId)].filter((value): value is string => Boolean(value))));
    const agentSenderIds = Array.from(new Set([triggerMessage.senderType === 'AGENT' ? triggerMessage.senderId : null, ...candidateMessages.filter((message) => message.senderType === 'AGENT').map((message) => message.senderId)].filter((value): value is string => Boolean(value))));

    const [users, agents] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userSenderIds } },
        select: { id: true, username: true },
      }),
      prisma.agent.findMany({
        where: { id: { in: agentSenderIds } },
        select: { id: true, name: true },
      }),
    ]);

    const userNameMap = new Map(users.map((entry) => [entry.id, entry.username]));
    const agentNameMap = new Map(agents.map((entry) => [entry.id, entry.name]));

    const triggerPrompt = toConversationMessage(
      {
        senderId: triggerMessage.senderId,
        senderType: triggerMessage.senderType,
        senderName: triggerMessage.senderType === 'AGENT' ? (agentNameMap.get(triggerMessage.senderId) ?? null) : (userNameMap.get(triggerMessage.senderId) ?? null),
        content: triggerMessage.content,
      },
      agentId,
    );

    const recentMessagesChronological = [...candidateMessages].reverse().map((message) =>
      toConversationMessage(
        {
          senderId: message.senderId,
          senderType: message.senderType,
          senderName: message.senderType === 'AGENT' ? (agentNameMap.get(message.senderId) ?? null) : (userNameMap.get(message.senderId) ?? null),
          content: message.content,
        },
        agentId,
      ),
    );
    const includedRecent: LLMMessage[] = [];
    const overflowMessageIds: string[] = [];

    for (let index = recentMessagesChronological.length - 1; index >= 0; index -= 1) {
      const candidate = recentMessagesChronological[index];
      const nextMessages = [...staticMessages, candidate, ...includedRecent, triggerPrompt];
      const tokenCount = await tokenCounter.count(nextMessages, provider);

      if (tokenCount <= budgetLimit) {
        includedRecent.unshift(candidate);
      } else {
        overflowMessageIds.push(candidateMessages[candidateMessages.length - 1 - index].id);
      }
    }

    if (overflowMessageIds.length > 0) {
      compactionService.schedule({
        agentId,
        channelId,
        overflowMessageIds,
      });
    }

    const messages = [...staticMessages, ...includedRecent, triggerPrompt];
    const totalTokens = await tokenCounter.count(messages, provider);

    return {
      messages,
      totalTokens,
      budgetUsed: totalTokens,
      budgetLimit,
      compactionTriggered: overflowMessageIds.length > 0,
      summaryUsed: Boolean(summary),
      staticPrefixKey: promptCacheService.buildStaticPrefixKey(messages, staticMessages.length),
    };
  }
}

export const contextBuilder = new ContextBuilder();
