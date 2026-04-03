/**
 * Queue Registry
 *
 * Phase 1 implementation status:
 * - This file now defines the BullMQ queue objects used by the first functional
 *   agent-processing slice.
 * - Future phases can add compaction, file scanning, and cron queues here.
 */

import { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@/config/constants.js';
import { redis } from '@/lib/redis.js';

export const agentProcessQueue = new Queue(QUEUE_NAMES.agentProcess, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});
