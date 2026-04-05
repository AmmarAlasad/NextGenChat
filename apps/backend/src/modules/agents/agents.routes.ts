/**
 * Agent Routes — Fastify Route Registration
 *
 * Phase 1 implementation status:
 * - This file now exposes the minimal read path needed by the first chat milestone.
 * - Current scope lists agents for a workspace so the web chat can show the active AI.
 * - Future phases will add agent CRUD, provider management, memory, tools, and cron.
 */

import type { FastifyPluginAsync } from 'fastify';

import { AgentCreatorChatInputSchema } from '@nextgenchat/types';

import { CreateAgentSchema, UpdateAgentSchema } from '@/modules/agents/agents.schema.js';
import { agentCreatorService } from '@/modules/agents/agent-creator.service.js';
import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { agentsService } from '@/modules/agents/agents.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/workspaces/:id/agents', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return agentsService.listWorkspaceAgents(authUser.id, params.id);
  });

  fastify.get('/agents/:id', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return agentsService.getAgentDetail(authUser.id, params.id);
  });

  fastify.post('/workspaces/:id/agents', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = CreateAgentSchema.parse(request.body);

    return agentsService.createAgent(authUser.id, params.id, input);
  });

  fastify.patch('/agents/:id', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = UpdateAgentSchema.parse(request.body);

    return agentsService.updateAgent(authUser.id, params.id, input);
  });

  fastify.post('/agents/:id/creator/chat', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = AgentCreatorChatInputSchema.parse(request.body);

    // Verify the user has access to this agent before running the creator.
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);

    return agentCreatorService.chatWithCreator(params.id, input.message, input.history);
  });
};
