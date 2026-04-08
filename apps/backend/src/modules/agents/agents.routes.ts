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

import { agentCronService } from '@/modules/agents/agent-cron.service.js';
import { CreateAgentSchema, UpdateAgentBrowserMcpSchema, UpdateAgentScheduleSchema, UpdateAgentSchema } from '@/modules/agents/agents.schema.js';
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

  fastify.get('/agents/:id/browser-mcp', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return agentsService.getAgentBrowserMcpState(authUser.id, params.id);
  });

  fastify.put('/agents/:id/browser-mcp', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = UpdateAgentBrowserMcpSchema.parse(request.body);

    return agentsService.setAgentBrowserMcpEnabled(authUser.id, params.id, input.enabled);
  });

  fastify.get('/agents/:id/schedules', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);
    return agentCronService.listAgentSchedules(params.id);
  });

  fastify.delete('/agents/:id/schedules/:scheduleId', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string; scheduleId: string };

    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);
    await agentCronService.deleteAgentSchedule(params.id, params.scheduleId);
    return reply.status(204).send();
  });

  fastify.patch('/agents/:id/schedules/:scheduleId', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string; scheduleId: string };
    const input = UpdateAgentScheduleSchema.parse(request.body);

    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);
    return agentCronService.updateAgentSchedule(params.id, params.scheduleId, input);
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
