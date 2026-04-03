/**
 * Agent Routes — Fastify Route Registration
 *
 * Phase 1 implementation status:
 * - This file now exposes the minimal read path needed by the first chat milestone.
 * - Current scope lists agents for a workspace so the web chat can show the active AI.
 * - Future phases will add agent CRUD, provider management, memory, tools, and cron.
 */

import type { FastifyPluginAsync } from 'fastify';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { agentsService } from '@/modules/agents/agents.service.js';

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/workspaces/:id/agents', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return agentsService.listWorkspaceAgents(authUser.id, params.id);
  });
};
