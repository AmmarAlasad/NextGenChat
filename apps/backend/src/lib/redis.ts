/**
 * Redis Connections
 *
 * Phase 1 implementation status:
 * - This file now provides the shared Redis clients when Redis is enabled and a
 *   tiny in-memory fallback when local packaged mode runs without Redis.
 * - Future phases can extend these clients for presence, caching, and analytics.
 */

import IORedis from 'ioredis';

import { env } from '@/config/env.js';

class InMemoryRedis {
  private store = new Map<string, string>();

  private createMulti() {
    const operations: Array<() => void> = [];
    const chain = {
      incr: (key: string) => {
        operations.push(() => {
          const currentValue = Number(this.store.get(key) ?? '0');
          this.store.set(key, String(currentValue + 1));
        });
        return chain;
      },
      expire: (...args: [string, number]) => {
        void args;
        return chain;
      },
      exec: async () => {
        for (const operation of operations) {
          operation();
        }

        return [];
      },
    };

    return chain;
  }

  async ping() {
    return 'PONG';
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async del(key: string) {
    this.store.delete(key);
    return 1;
  }

  multi() {
    return this.createMulti();
  }

  async quit() {
    return 'OK';
  }
}

class InMemoryRedisPubSub {
  async ping() {
    return 'PONG';
  }

  async quit() {
    return 'OK';
  }
}

const redisFallback = new InMemoryRedis();
const pubSubFallback = new InMemoryRedisPubSub();

export const redis = env.redisEnabled
  ? new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    })
  : redisFallback;

export const redisPublisher = env.redisEnabled
  ? new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    })
  : pubSubFallback;

export const redisSubscriber = env.redisEnabled
  ? new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    })
  : pubSubFallback;
