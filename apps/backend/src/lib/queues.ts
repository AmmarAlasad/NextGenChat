/**
 * Queue Registry
 *
 * Phase 1 implementation status:
 * - This file now defines the Redis-backed queue objects for shared mode and a
 *   small in-process fallback queue for local packaged mode.
 * - Future phases can add compaction, file scanning, and cron queues here.
 */

import { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { redis } from '@/lib/redis.js';
import { processAgentJob } from '@/queues/agent.processor.js';

interface LocalAgentQueue {
  add(name: string, data: { agentId: string; channelId: string; messageId: string }, options?: { jobId?: string }): Promise<void>;
}

const localAgentJobIds = new Set<string>();

const localAgentQueue: LocalAgentQueue = {
  async add(_name, data, options) {
    const jobId = options?.jobId;

    if (jobId && localAgentJobIds.has(jobId)) {
      return;
    }

    if (jobId) {
      localAgentJobIds.add(jobId);
    }

    queueMicrotask(() => {
      void processAgentJob(data).catch((error) => {
        console.error('Local agent job failed', error);
      }).finally(() => {
        if (jobId) {
          localAgentJobIds.delete(jobId);
        }
      });
    });
  },
};

export const agentProcessQueue = env.redisEnabled
  ? new Queue(QUEUE_NAMES.agentProcess, {
      connection: redis as never,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    })
  : localAgentQueue;
