/**
 * Project Service
 *
 * Projects are workspace-level containers that group related group channels.
 * Each project has a shared project.md file injected into agent context for all
 * channels in that project.
 *
 * Phase 4 implementation status:
 * - Project CRUD (create, list, update name/description)
 * - project.md file: get and update via WorkspaceFile table
 * - Sub-channel creation within a project
 * - Context injection is handled by the context builder
 */

import type { CreateChannelInput, CreateProjectInput, ProjectSummary, UpdateProjectInput } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { staticPrefixCache } from '@/modules/context/static-prefix-cache.js';

const PROJECT_FILE_NAME = 'project.md';
const PROJECT_MIME_TYPE = 'text/markdown';

function projectFileKey(projectId: string) {
  return `projects/${projectId}/project.md`;
}

function defaultProjectDoc(name: string, description: string | null | undefined) {
  return `# ${name}\n\n${description?.trim() ? `${description.trim()}\n\n` : ''}## Overview\nDescribe the goals, scope, and context of this project. Agents will read this file before responding in any of the project's channels.\n\n## Key Decisions\n- (add important decisions here)\n\n## Current Status\n- (add current status here)\n`;
}

async function ensureWorkspaceMembership(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
  });

  if (!membership) {
    throw new Error('You do not have access to this workspace.');
  }
}

function serializeProject(project: {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}): ProjectSummary {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
  };
}

export class ProjectService {
  async listProjects(userId: string, workspaceId: string): Promise<ProjectSummary[]> {
    await ensureWorkspaceMembership(userId, workspaceId);

    const projects = await prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    return projects.map(serializeProject);
  }

  async createProject(userId: string, workspaceId: string, input: CreateProjectInput): Promise<ProjectSummary> {
    await ensureWorkspaceMembership(userId, workspaceId);

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description ?? null,
      },
    });

    // Bootstrap the project.md file.
    const content = defaultProjectDoc(project.name, project.description);
    const key = projectFileKey(project.id);

    await prisma.workspaceFile.upsert({
      where: { key },
      create: {
        workspaceId,
        agentId: null,
        uploadedBy: userId,
        docType: null,
        key,
        fileName: PROJECT_FILE_NAME,
        fileSize: Buffer.byteLength(content, 'utf8'),
        mimeType: PROJECT_MIME_TYPE,
        content,
      },
      update: {},
    });

    return serializeProject(project);
  }

  async updateProject(userId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectSummary> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      throw new Error('Project not found.');
    }

    await ensureWorkspaceMembership(userId, project.workspaceId);

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: input.name ?? project.name,
        description: input.description !== undefined ? input.description : project.description,
      },
    });

    return serializeProject(updated);
  }

  async getProjectFile(userId: string, projectId: string) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      throw new Error('Project not found.');
    }

    await ensureWorkspaceMembership(userId, project.workspaceId);

    const key = projectFileKey(projectId);
    let file = await prisma.workspaceFile.findUnique({ where: { key } });

    if (!file) {
      const content = defaultProjectDoc(project.name, project.description);
      file = await prisma.workspaceFile.upsert({
        where: { key },
        create: {
          workspaceId: project.workspaceId,
          agentId: null,
          uploadedBy: userId,
          docType: null,
          key,
          fileName: PROJECT_FILE_NAME,
          fileSize: Buffer.byteLength(content, 'utf8'),
          mimeType: PROJECT_MIME_TYPE,
          content,
        },
        update: {},
      });
    }

    return {
      fileName: file.fileName,
      content: file.content ?? '',
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async updateProjectFile(userId: string, projectId: string, content: string) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      throw new Error('Project not found.');
    }

    await ensureWorkspaceMembership(userId, project.workspaceId);

    // Ensure file exists first.
    await this.getProjectFile(userId, projectId);

    const key = projectFileKey(projectId);
    const updated = await prisma.workspaceFile.update({
      where: { key },
      data: {
        content,
        fileSize: Buffer.byteLength(content, 'utf8'),
        version: { increment: 1 },
      },
    });

    // Invalidate static prefix cache for all channels in this project so the
    // updated project.md is reflected on the next agent turn.
    const channels = await prisma.channel.findMany({
      where: { projectId },
      select: { id: true },
    });
    for (const ch of channels) {
      staticPrefixCache.invalidateByChannel(ch.id);
    }

    return {
      fileName: updated.fileName,
      content: updated.content ?? '',
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async createProjectChannel(
    userId: string,
    projectId: string,
    input: Pick<CreateChannelInput, 'name' | 'agentIds'>,
  ) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      throw new Error('Project not found.');
    }

    await ensureWorkspaceMembership(userId, project.workspaceId);

    const channel = await prisma.channel.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        name: input.name,
        type: 'PUBLIC',
        memberships: {
          create: { userId },
        },
        agentMemberships: input.agentIds && input.agentIds.length > 0
          ? {
              create: input.agentIds.map((agentId) => ({ agentId })),
            }
          : undefined,
      },
      include: {
        agentMemberships: {
          include: { agent: { select: { name: true } } },
        },
        messages: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return {
      id: channel.id,
      workspaceId: channel.workspaceId,
      projectId: channel.projectId,
      name: channel.name,
      type: channel.type,
      participantAgentIds: channel.agentMemberships.map((m) => m.agentId),
      participantAgentNames: channel.agentMemberships.map((m) => m.agent.name),
      lastMessageAt: channel.messages[0]?.createdAt.toISOString() ?? null,
    };
  }
}

export const projectService = new ProjectService();
