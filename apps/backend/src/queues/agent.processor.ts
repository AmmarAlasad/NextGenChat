/**
 * Agent Processor Worker
 *
 * Phase 1 implementation status:
 * - This file now runs the first real agent-processing path in either Redis-backed
 *   worker mode or local in-process mode.
 * - Current scope builds prompt context, calls the OpenAI provider, emits streamed
 *   chunks to Socket.io, and persists the final agent message.
 * - Cross-channel relay: after the LLM call, any <<send:channel-name>>…<</send>>
 *   blocks are extracted, posted to the named channels, and stripped from the
 *   response that is saved in the originating channel.
 * - Future phases will add retries, compaction, tools, and memory updates here.
 */

import { randomUUID } from 'node:crypto';

import { Worker as BullWorker } from 'bullmq';

import { AGENT_RESPONSE_CHUNK_DELAY_MS, QUEUE_NAMES } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { redis } from '@/lib/redis.js';
import { contextBuilder } from '@/modules/context/context-builder.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { chatService, serializeMessage } from '@/modules/chat/chat.service.js';
import { getChannelRoom, getChatNamespace } from '@/sockets/socket-server.js';

export interface AgentProcessJobData {
  agentId: string;
  channelId: string;
  messageId: string;
}

export interface AgentProcessorHandle {
  close(): Promise<void>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Match <<send:channel-name>>content<</send>> blocks (case-insensitive, multiline).
const RELAY_TAG_RE = /<<send:([^>]+)>>([\s\S]*?)<\/send>>/gi;

interface RelayCommand {
  channelName: string;
  content: string;
}

function extractRelayCommands(text: string): { commands: RelayCommand[]; cleanedContent: string } {
  const commands: RelayCommand[] = [];
  const cleanedContent = text.replace(RELAY_TAG_RE, (_match, channelName: string, content: string) => {
    const trimmedContent = content.trim();
    if (trimmedContent) {
      commands.push({ channelName: channelName.trim().toLowerCase(), content: trimmedContent });
    }
    return '';
  }).trim();

  return { commands, cleanedContent };
}

async function executeRelayCommands(commands: RelayCommand[], agentId: string): Promise<void> {
  if (commands.length === 0) return;

  for (const cmd of commands) {
    try {
      const targetChannel = await prisma.channel.findFirst({
        where: {
          name: { equals: cmd.channelName, mode: 'insensitive' },
          agentMemberships: { some: { agentId } },
          type: { not: 'DIRECT' },
        },
        select: { id: true, name: true },
      });

      if (!targetChannel) {
        console.warn(`[relay] Agent ${agentId} tried to relay to unknown channel "${cmd.channelName}"`);
        continue;
      }

      const relayMsg = await chatService.createAgentRelayMessage({
        channelId: targetChannel.id,
        senderId: agentId,
        content: cmd.content,
        contentType: 'TEXT',
      });

      getChatNamespace().to(getChannelRoom(targetChannel.id)).emit('message:new', relayMsg);
    } catch (relayError) {
      console.error(`[relay] Failed to relay to channel "${cmd.channelName}":`, relayError);
    }
  }
}

export async function processAgentJob({ agentId, channelId, messageId }: AgentProcessJobData) {
  const tempId = randomUUID();
  const chatNamespace = getChatNamespace();

  try {
    const provider = await providerRegistry.get(agentId);
    const context = await contextBuilder.build(agentId, channelId, messageId);

    let content = '';
    let finalChunk:
      | {
          responseId?: string;
          usage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
            cachedTokens?: number;
          };
          providerMetadata?: Record<string, unknown>;
        }
      | undefined;

    for await (const chunk of provider.stream({
      messages: context.messages,
      maxTokens: 1024,
      temperature: 0.4,
    })) {
      if (chunk.delta) {
        content += chunk.delta;
        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:chunk', {
          tempId,
          agentId,
          channelId,
          delta: chunk.delta,
        });
        await sleep(AGENT_RESPONSE_CHUNK_DELAY_MS);
      }

      if (chunk.responseId || chunk.usage || chunk.providerMetadata) {
        finalChunk = chunk;
      }
    }

    // Extract cross-channel relay commands before persisting the message.
    // The <<send:channel-name>>…<</send>> blocks are stripped from the content
    // that gets saved in the current channel, then posted to the target channels.
    const { commands: relayCommands, cleanedContent } = extractRelayCommands(content);
    const persistedContent = cleanedContent || content; // fallback if stripping empties the response

    const metadata = JSON.parse(
      JSON.stringify({
        provider: provider.name,
        model: provider.model,
        responseId: finalChunk?.responseId ?? null,
        usage: finalChunk?.usage ?? null,
        providerMetadata: finalChunk?.providerMetadata ?? null,
        context: {
          promptTokens: context.totalTokens,
          budgetUsed: context.budgetUsed,
          budgetLimit: context.budgetLimit,
          compactionTriggered: context.compactionTriggered,
          summaryUsed: context.summaryUsed,
          staticPrefixKey: context.staticPrefixKey,
        },
        relayedChannels: relayCommands.length > 0 ? relayCommands.map((cmd) => cmd.channelName) : undefined,
      }),
    );

    const message = await prisma.message.create({
      data: {
        channelId,
        senderId: agentId,
        senderType: 'AGENT',
        content: persistedContent,
        contentType: 'MARKDOWN',
        metadata,
      },
    });

    const agentRecord = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { name: true },
    });

    chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
      tempId,
      finalMessageId: message.id,
      channelId,
      createdAt: message.createdAt.toISOString(),
    });

    chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage({
      ...message,
      senderName: agentRecord?.name ?? null,
    }));

    // Execute any cross-channel relay commands the LLM embedded in its response.
    await executeRelayCommands(relayCommands, agentId);

    await chatService.triggerAgentsForMessage({
      channelId,
      senderId: agentId,
      senderType: 'AGENT',
      content: persistedContent,
      messageId: message.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Agent processing failed.';

    const fallbackMessage = await prisma.message.create({
      data: {
        channelId,
        senderId: agentId,
        senderType: 'AGENT',
        content:
          errorMessage.includes('Incorrect API key')
            ? 'I could not respond because the configured OpenAI API key is invalid. Update `.env` with a valid key and try again.'
            : `I could not respond right now: ${errorMessage}`,
        contentType: 'SYSTEM',
        metadata: {
          provider: 'openai',
          error: errorMessage,
        },
      },
    });

    const agentRecord = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { name: true },
    });

    chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
      tempId,
      finalMessageId: fallbackMessage.id,
      channelId,
      createdAt: fallbackMessage.createdAt.toISOString(),
    });

    chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage({
      ...fallbackMessage,
      senderName: agentRecord?.name ?? null,
    }));

    throw error;
  }
}

export function createAgentProcessorWorker(): AgentProcessorHandle {
  if (!env.redisEnabled) {
    return {
      close: async () => undefined,
    };
  }

  return new BullWorker<AgentProcessJobData>(
    QUEUE_NAMES.agentProcess,
    async (job) => processAgentJob(job.data),
    { connection: redis as never },
  );
}
