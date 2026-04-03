/**
 * Agent Processor Worker
 *
 * Phase 1 implementation status:
 * - This file now runs the first real agent-processing worker path.
 * - Current scope builds prompt context, calls the OpenAI provider, emits streamed
 *   chunks to Socket.io, and persists the final agent message.
 * - Future phases will add retries, compaction, tools, and memory updates here.
 */

import { randomUUID } from 'node:crypto';

import type { Worker } from 'bullmq';
import { Worker as BullWorker } from 'bullmq';

import { AGENT_RESPONSE_CHUNK_DELAY_MS, QUEUE_NAMES } from '@/config/constants.js';
import { prisma } from '@/db/client.js';
import { redis } from '@/lib/redis.js';
import { contextBuilder } from '@/modules/context/context-builder.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { serializeMessage } from '@/modules/chat/chat.service.js';
import { getChannelRoom, getChatNamespace } from '@/sockets/socket-server.js';

interface AgentProcessJobData {
  agentId: string;
  channelId: string;
  messageId: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAgentProcessorWorker(): Worker<AgentProcessJobData> {
  return new BullWorker<AgentProcessJobData>(
    QUEUE_NAMES.agentProcess,
    async (job) => {
      const { agentId, channelId, messageId } = job.data;
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

        const metadata = JSON.parse(
          JSON.stringify({
            provider: provider.name,
            model: provider.model,
            responseId: finalChunk?.responseId ?? null,
            usage: finalChunk?.usage ?? null,
            providerMetadata: finalChunk?.providerMetadata ?? null,
          }),
        );

        const message = await prisma.message.create({
          data: {
            channelId,
            senderId: agentId,
            senderType: 'AGENT',
            content,
            contentType: 'MARKDOWN',
            metadata,
          },
        });

        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
          tempId,
          finalMessageId: message.id,
          channelId,
          createdAt: message.createdAt.toISOString(),
        });

        chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage(message));
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

        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
          tempId,
          finalMessageId: fallbackMessage.id,
          channelId,
          createdAt: fallbackMessage.createdAt.toISOString(),
        });

        chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage(fallbackMessage));

        throw error;
      }
    },
    { connection: redis },
  );
}
