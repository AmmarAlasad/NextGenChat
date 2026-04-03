/**
 * Chat Routes — Fastify Route Registration
 *
 * Phase 1 implementation status:
 * - This file now exposes the minimal REST fallback endpoints for the first chat slice.
 * - Current scope lists the seeded workspace/channel, loads message history, and sends
 *   messages when the UI needs an HTTP path in addition to Socket.io.
 * - Future phases will add richer workspace/channel CRUD and moderation flows here.
 */

import type { FastifyPluginAsync } from 'fastify';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { MessagePaginationSchema, SendMessageSchema } from '@/modules/chat/chat.schema.js';
import { chatService } from '@/modules/chat/chat.service.js';

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/workspaces', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    return chatService.listWorkspaces(authUser.id);
  });

  fastify.get('/workspaces/:id/channels', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return chatService.listChannels(authUser.id, params.id);
  });

  fastify.get('/channels/:id/messages', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const pagination = MessagePaginationSchema.parse(request.query ?? {});

    return chatService.listMessages(authUser.id, params.id, pagination);
  });

  fastify.post('/channels/:id/messages', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = SendMessageSchema.parse({ ...(request.body as object), channelId: params.id });

    return chatService.createUserMessage(authUser.id, input);
  });
};
