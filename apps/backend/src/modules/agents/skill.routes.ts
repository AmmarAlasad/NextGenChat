/**
 * Skill Routes
 *
 * REST API for agent skill CRUD.
 * All routes require authentication and verify agent workspace access.
 *
 * Phase 5 implementation status:
 * - Full CRUD: list, get, create, update, delete.
 * - Future phases: skill import/export, shared workspace skill library.
 */

import type { FastifyPluginAsync } from 'fastify';

import { CreateSkillSchema, UpdateSkillSchema } from '@nextgenchat/types';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { skillService } from '@/modules/agents/skill.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

export const skillRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agents/:id/skills', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, id);
    return skillService.list(id);
  });

  fastify.get('/agents/:id/skills/:name', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const { id, name } = request.params as { id: string; name: string };
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, id);
    const skill = await skillService.get(id, name);
    if (!skill) return reply.status(404).send({ error: 'Skill not found.' });
    return skill;
  });

  fastify.post('/agents/:id/skills', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, id);
    const input = CreateSkillSchema.parse(request.body);
    const skill = await skillService.create(id, input);
    return reply.status(201).send(skill);
  });

  fastify.put('/agents/:id/skills/:name', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id, name } = request.params as { id: string; name: string };
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, id);
    const input = UpdateSkillSchema.parse(request.body);
    return skillService.update(id, name, input);
  });

  fastify.delete('/agents/:id/skills/:name', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const { id, name } = request.params as { id: string; name: string };
    await workspaceService.assertAgentWorkspaceAccess(authUser.id, id);
    await skillService.delete(id, name);
    return reply.status(204).send();
  });
};
