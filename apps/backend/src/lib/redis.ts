/**
 * Redis Connections
 *
 * Phase 1 implementation status:
 * - This file now provides the shared Redis clients used by BullMQ, auth lockouts,
 *   refresh/session state, and Socket.io adapter wiring.
 * - Future phases can extend these clients for presence, caching, and analytics.
 */

import IORedis from 'ioredis';

import { env } from '@/config/env.js';

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const redisPublisher = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const redisSubscriber = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
