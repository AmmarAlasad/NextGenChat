/**
 * Agent Processor Worker
 *
 * Thin BullMQ worker shell — all processing logic lives in AgentSessionGateway.
 *
 * Phase 4 implementation status:
 * - processAgentJob delegates entirely to agentSessionGateway.runAgentTurn().
 * - BullMQ wiring (createAgentProcessorWorker) and local no-op fallback retained.
 * - Future phases: retries, dead-letter handling, worker concurrency config.
 */

import { Worker as BullWorker } from 'bullmq';

import { QUEUE_NAMES } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { redis } from '@/lib/redis.js';
import { agentSessionGateway } from '@/modules/gateway/agent-session.gateway.js';

export interface AgentProcessJobData {
  agentId: string;
  channelId: string;
  messageId: string;
}

export interface AgentProcessorHandle {
  close(): Promise<void>;
}

export async function processAgentJob({ agentId, channelId, messageId }: AgentProcessJobData) {
  await agentSessionGateway.runAgentTurn(agentId, channelId, messageId);
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
