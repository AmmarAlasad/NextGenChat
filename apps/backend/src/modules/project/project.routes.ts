/**
 * Project Routes
 *
 * Exposes project CRUD and project.md file management. Projects group related
 * group channels and share a project.md context file across all agent responses.
 *
 * Phase 4 implementation status:
 * - List and create projects per workspace
 * - Update project metadata
 * - Get and update project.md
 * - Create sub-channels within a project
 */

import type { FastifyPluginAsync } from 'fastify';

import { CreateProjectSchema, UpdateAgentDocSchema, UpdateProjectSchema } from '@nextgenchat/types';
import { z } from 'zod';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { projectService } from '@/modules/project/project.service.js';

const CreateProjectChannelSchema = z.object({
  name: z.string().min(1).max(100),
  agentIds: z.array(z.string().uuid()).default([]),
});

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/workspaces/:workspaceId/projects', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { workspaceId } = request.params as { workspaceId: string };
    return projectService.listProjects(authUser.id, workspaceId);
  });

  fastify.post('/workspaces/:workspaceId/projects', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const input = CreateProjectSchema.parse(request.body);
    return projectService.createProject(authUser.id, workspaceId, input);
  });

  fastify.patch('/projects/:id', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const input = UpdateProjectSchema.parse(request.body);
    return projectService.updateProject(authUser.id, id, input);
  });

  fastify.get('/projects/:id/file', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    return projectService.getProjectFile(authUser.id, id);
  });

  fastify.put('/projects/:id/file', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const { content } = UpdateAgentDocSchema.parse(request.body);
    return projectService.updateProjectFile(authUser.id, id, content);
  });

  fastify.post('/projects/:id/channels', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const input = CreateProjectChannelSchema.parse(request.body);
    return projectService.createProjectChannel(authUser.id, id, input);
  });
};
