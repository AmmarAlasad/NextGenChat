/**
 * Project Routes
 *
 * Exposes project CRUD, shared project files, and the project ticket deck used
 * by users and agents inside project-scoped collaboration flows.
 *
 * Phase 6 implementation status:
 * - List and create projects per workspace
 * - Update project metadata
 * - Get and update project.md
 * - Upload/list/download shared project files
 * - Create/list/update project tickets
 * - Create sub-channels within a project
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  CreateProjectSchema,
  CreateProjectTicketSchema,
  UpdateAgentDocSchema,
  UpdateProjectSchema,
  UpdateProjectTicketSchema,
  UploadProjectFileSchema,
} from '@nextgenchat/types';
import { z } from 'zod';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { projectService } from '@/modules/project/project.service.js';

const CreateProjectChannelSchema = z.object({
  name: z.string().min(1).max(100),
  agentIds: z.array(z.string().uuid()).default([]),
});

const PROJECT_FILE_UPLOAD_BODY_LIMIT = 70 * 1024 * 1024;

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

  fastify.get('/projects/:id/files', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    return projectService.listProjectFiles(authUser.id, id);
  });

  fastify.post('/projects/:id/files', { preHandler: authenticateRequest, bodyLimit: PROJECT_FILE_UPLOAD_BODY_LIMIT }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const input = UploadProjectFileSchema.parse(request.body);
    return projectService.uploadProjectFile(authUser.id, id, input);
  });

  fastify.get('/projects/:projectId/files/:fileId/download', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const { projectId, fileId } = request.params as { projectId: string; fileId: string };
    const file = await projectService.downloadProjectFile(authUser.id, projectId, fileId);

    reply
      .header('Content-Type', file.mimeType)
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`)
      .send(file.content);
  });

  fastify.get('/projects/:id/tickets', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    return projectService.listProjectTickets(authUser.id, id);
  });

  fastify.post('/projects/:id/tickets', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const input = CreateProjectTicketSchema.parse(request.body);
    return projectService.createProjectTicket(authUser.id, id, input);
  });

  fastify.patch('/projects/:projectId/tickets/:ticketId', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { projectId, ticketId } = request.params as { projectId: string; ticketId: string };
    const input = UpdateProjectTicketSchema.parse(request.body);
    return projectService.updateProjectTicket(authUser.id, projectId, ticketId, input);
  });

  fastify.post('/projects/:id/channels', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const input = CreateProjectChannelSchema.parse(request.body);
    return projectService.createProjectChannel(authUser.id, id, input);
  });
};
