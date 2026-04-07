/**
 * Application Entry Point
 *
 * Phase 1 implementation status:
 * - This file now boots the first functional backend milestone for NextGenChat.
 * - Current scope starts Fastify, validates env, connects Prisma and optional Redis,
 *   registers the local auth/chat/agent routes, creates Socket.io namespaces, and
 *   starts the agent processor in either worker or in-process mode.
 * - Future phases will add more modules, richer workers, and production hardening.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

import { APP_VERSION } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { redis, redisPublisher, redisSubscriber } from '@/lib/redis.js';
import { authRoutes } from '@/modules/auth/auth.routes.js';
import { authService } from '@/modules/auth/auth.service.js';
import { agentsRoutes } from '@/modules/agents/agents.routes.js';
import { skillRoutes } from '@/modules/agents/skill.routes.js';
import { chatRoutes } from '@/modules/chat/chat.routes.js';
import { workspaceRoutes } from '@/modules/workspace/workspace.routes.js';
import { projectRoutes } from '@/modules/project/project.routes.js';
import { createAgentProcessorWorker } from '@/queues/agent.processor.js';
import { createSocketServer } from '@/sockets/socket-server.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: env.isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }
      : true,
  });

  await fastify.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
    // Explicitly declare allowed methods and headers so that the preflight
    // response is unambiguous for PUT and PATCH requests (which require
    // non-simple CORS handling and send Authorization + Content-Type headers).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Type'],
    maxAge: 86_400, // cache preflight for 24 h to reduce OPTIONS round-trips
  });

  await fastify.register(cookie);
  await fastify.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    reply.status(400).send({
      code: 'REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'Request failed.',
    });
  });

  fastify.get('/health', async () => {
    let db: 'ok' | 'error' = 'ok';
    let redisStatus: 'ok' | 'error' | 'disabled' = env.redisEnabled ? 'ok' : 'disabled';

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    if (env.redisEnabled) {
      try {
        await redis.ping();
      } catch {
        redisStatus = 'error';
      }
    }

    return {
      status: 'ok',
      version: APP_VERSION,
      db,
      redis: redisStatus,
      setupRequired: await authService.getSetupRequired(),
    };
  });

  await fastify.register(authRoutes, { prefix: '/auth' });
  await fastify.register(chatRoutes);
  await fastify.register(agentsRoutes);
  await fastify.register(skillRoutes);
  await fastify.register(workspaceRoutes);
  await fastify.register(projectRoutes);

  return fastify;
}

async function start() {
  await prisma.$connect();

  if (env.redisEnabled) {
    await redis.ping();
  }

  const fastify = await buildServer();
  createSocketServer(fastify.server);
  const agentWorker = createAgentProcessorWorker();

  const shutdown = async () => {
    await agentWorker.close();
    await fastify.close();
    await prisma.$disconnect();

    if (env.redisEnabled) {
      await Promise.all([redis.quit(), redisPublisher.quit(), redisSubscriber.quit()]);
    }

    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await fastify.listen({
    port: env.PORT,
    host: '0.0.0.0',
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
