/**
 * Workspace & Agent Doc Routes
 *
 * Current scope exposes agent-private markdown docs through backend-authenticated
 * APIs. Arbitrary workspace file operations will be added later via tools.
 */

import type { FastifyPluginAsync } from 'fastify';

import { AgentDocAssistSchema, UpdateAgentDocSchema } from '@nextgenchat/types';
import { z } from 'zod';

import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { agentWorkspaceToolsService } from '@/modules/workspace/agent-workspace-tools.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

const ReadWorkspaceFileSchema = z.object({
  fileName: z.string().min(1),
});

const ApplyWorkspacePatchSchema = z.object({
  fileName: z.string().min(1),
  patchText: z.string().min(1),
});

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agents/:id/docs', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };

    return workspaceService.listAgentDocs(authUser.id, params.id);
  });

  fastify.get('/agents/:id/docs/:docType', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string; docType: string };

    return workspaceService.getAgentDoc(authUser.id, params.id, params.docType);
  });

  fastify.put('/agents/:id/docs/:docType', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string; docType: string };
    const input = UpdateAgentDocSchema.parse(request.body);

    return workspaceService.updateAgentDoc(authUser.id, params.id, params.docType, input);
  });

  fastify.post('/agents/:id/docs/:docType/assist', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string; docType: string };
    const input = AgentDocAssistSchema.parse(request.body);

    return workspaceService.assistAgentDoc(authUser.id, params.id, params.docType, input);
  });

  fastify.post('/agents/:id/tools/read-file', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = ReadWorkspaceFileSchema.parse(request.body);

    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);
    return agentWorkspaceToolsService.readFile({ agentId: params.id, fileName: input.fileName });
  });

  fastify.post('/agents/:id/tools/apply-patch', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = ApplyWorkspacePatchSchema.parse(request.body);

    await workspaceService.assertAgentWorkspaceAccess(authUser.id, params.id);
    return agentWorkspaceToolsService.applyPatch({
      agentId: params.id,
      fileName: input.fileName,
      patchText: input.patchText,
    });
  });
};
