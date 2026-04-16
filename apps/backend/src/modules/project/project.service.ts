/**
 * Project Service
 *
 * Projects are workspace-level containers that group related channels, shared
 * project files, and the project ticket deck used by both users and agents.
 *
 * Phase 6 implementation status:
 * - Project CRUD and project.md management remain supported.
 * - Projects now have a shared filesystem root, uploadable shared files, and a
 *   ticket deck with manual assignment or hidden auto-triggering for agents.
 * - Future phases can add richer board views, comments, due dates, and audit UI.
 */

import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CreateChannelInput,
  CreateProjectInput,
  CreateProjectTicketInput,
  ProjectFileRecord,
  ProjectSummary,
  ProjectTicketRecord,
  UpdateProjectInput,
  UpdateProjectTicketInput,
  UploadProjectFileInput,
  WorkspaceDocRecord,
} from '@nextgenchat/types';

import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { agentProcessQueue } from '@/lib/queues.js';
import { staticPrefixCache } from '@/modules/context/static-prefix-cache.js';

const PROJECT_FILE_NAME = 'project.md';
const PROJECT_MIME_TYPE = 'text/markdown';
const PROJECT_TICKET_SOURCE = 'project-ticket';
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'image/svg+xml',
]);

function projectDocKey(projectId: string) {
  return `projects/${projectId}/project.md`;
}

function projectSharedFileKey(projectId: string, relativePath: string) {
  return `projects/${projectId}/files/${relativePath}`;
}

function buildProjectFileDownloadPath(projectId: string, fileId: string) {
  return `/projects/${projectId}/files/${fileId}/download`;
}

function defaultProjectDoc(name: string, description: string | null | undefined) {
  return `# ${name}\n\n${description?.trim() ? `${description.trim()}\n\n` : ''}## Overview\nDescribe the goals, scope, and context of this project. Agents will read this file before responding in any of the project's channels.\n\n## Key Decisions\n- (add important decisions here)\n\n## Current Status\n- (add current status here)\n`;
}

function sanitizeProjectRelativePath(value: string) {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');

  if (!normalized) {
    throw new Error('Project file path is required.');
  }

  const resolved = path.posix.normalize(normalized);
  if (resolved.startsWith('../') || resolved === '..' || path.posix.isAbsolute(resolved)) {
    throw new Error('Project file path must stay inside the project workspace.');
  }

  return resolved;
}

function sanitizeProjectWorkspaceName(name: string) {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  return normalized || 'project';
}

function projectWorkspaceDir(projectName: string) {
  return path.join(env.projectWorkspacesDir, sanitizeProjectWorkspaceName(projectName));
}

async function migrateProjectWorkspaceDirIfNeeded(projectId: string, projectName: string, previousProjectName?: string | null) {
  const targetDir = projectWorkspaceDir(projectName);
  const legacyIdDir = path.join(env.projectWorkspacesDir, projectId);
  const previousNamedDir = previousProjectName ? projectWorkspaceDir(previousProjectName) : null;

  try {
    await access(targetDir);
    return targetDir;
  } catch {
    // continue
  }

  const candidates = [previousNamedDir, legacyIdDir].filter((value): value is string => Boolean(value) && value !== targetDir);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      await rename(candidate, targetDir);
      return targetDir;
    } catch {
      // try next candidate
    }
  }

  return targetDir;
}

function resolveProjectWorkspacePath(projectRoot: string, relativePath: string) {
  const safeRelativePath = sanitizeProjectRelativePath(relativePath);
  const resolved = path.resolve(projectRoot, safeRelativePath);
  const relative = path.relative(projectRoot, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Project file path must stay inside the project workspace.');
  }

  return { root: projectRoot, relativePath: safeRelativePath, absolutePath: resolved };
}

function isTextProjectFile(fileName: string, mimeType: string, fileSize: number) {
  if (fileSize > 512 * 1024) {
    return false;
  }

  const normalizedMime = mimeType.toLowerCase();
  if (TEXT_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) {
    return true;
  }

  if (TEXT_MIME_EXACT.has(normalizedMime)) {
    return true;
  }

  return ['.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.xml', '.yml', '.yaml', '.svg', '.csv'].includes(path.extname(fileName).toLowerCase());
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

function serializeProjectFile(file: {
  id: string;
  projectId: string | null;
  fileName: string;
  key: string;
  mimeType: string;
  fileSize: number;
  updatedAt: Date;
}): ProjectFileRecord {
  if (!file.projectId) {
    throw new Error('Project file is missing project ownership.');
  }

  const relativePath = file.key === projectDocKey(file.projectId)
    ? PROJECT_FILE_NAME
    : file.key.replace(`projects/${file.projectId}/files/`, '');

  return {
    id: file.id,
    projectId: file.projectId,
    fileName: file.fileName,
    relativePath,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    updatedAt: file.updatedAt.toISOString(),
    downloadPath: buildProjectFileDownloadPath(file.projectId, file.id),
    editable: isTextProjectFile(file.fileName, file.mimeType, file.fileSize),
  };
}

function serializeProjectTicket(ticket: {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: 'TODO' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | 'CANCELLED';
  assignedAgentId: string | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUser: { id: string; username: string };
  assignedAgent: { name: string } | null;
}): ProjectTicketRecord {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    assignedAgentId: ticket.assignedAgentId,
    assignedAgentName: ticket.assignedAgent?.name ?? null,
    createdByUserId: ticket.createdByUser.id,
    createdByUsername: ticket.createdByUser.username,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    claimedAt: ticket.claimedAt?.toISOString() ?? null,
    completedAt: ticket.completedAt?.toISOString() ?? null,
  };
}

async function ensureWorkspaceMembership(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
  });

  if (!membership) {
    throw new Error('You do not have access to this workspace.');
  }
}

async function ensureProjectAccess(userId: string, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) {
    throw new Error('Project not found.');
  }

  await ensureWorkspaceMembership(userId, project.workspaceId);
  return project;
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function invalidateProjectChannels(projectId: string) {
  const channels = await prisma.channel.findMany({
    where: { projectId },
    select: { id: true },
  });

  for (const channel of channels) {
    staticPrefixCache.invalidateByChannel(channel.id);
  }
}

function buildProjectTicketInternalMessage(input: {
  projectName: string;
  ticketTitle: string;
  ticketId: string;
  assignedAgentName?: string | null;
  explicitlyAssigned: boolean;
}) {
  return [
    `Project ticket update for ${input.projectName}.`,
    `Ticket ID: ${input.ticketId}`,
    `Title: ${input.ticketTitle}`,
    input.explicitlyAssigned && input.assignedAgentName
      ? `You were assigned this ticket directly. Claim it only if it fits your role and current context.`
      : 'A new unassigned ticket was added to the project deck. Claim it only if it clearly fits your role, skills, and current workload.',
    'If you decide to take it, immediately claim it with the project ticket tools before doing substantive work, then keep the ticket updated as you work.',
    'If it is not a good fit, do nothing and end the turn quietly.',
  ].join('\n');
}

async function upsertProjectFileRecord(input: {
  projectId: string;
  workspaceId: string;
  uploadedBy: string | null;
  relativePath: string;
  fileName: string;
  mimeType: string;
  contentBuffer: Buffer;
  textContent?: string | null;
}) {
  const key = input.relativePath === PROJECT_FILE_NAME
    ? projectDocKey(input.projectId)
    : projectSharedFileKey(input.projectId, input.relativePath);

  const existing = await prisma.workspaceFile.findUnique({
    where: { key },
    select: { id: true, version: true },
  });

  const nextVersion = (existing?.version ?? 0) + 1;
  const file = existing
    ? await prisma.workspaceFile.update({
        where: { key },
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          uploadedBy: input.uploadedBy,
          fileName: input.fileName,
          fileSize: input.contentBuffer.byteLength,
          mimeType: input.mimeType,
          content: input.textContent ?? null,
          version: nextVersion,
        },
      })
    : await prisma.workspaceFile.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          uploadedBy: input.uploadedBy,
          key,
          fileName: input.fileName,
          fileSize: input.contentBuffer.byteLength,
          mimeType: input.mimeType,
          content: input.textContent ?? null,
          version: nextVersion,
        },
      });

  await prisma.workspaceFileVersion.create({
    data: {
      fileId: file.id,
      key: `${key}@v${nextVersion}`,
      fileSize: input.contentBuffer.byteLength,
      mimeType: input.mimeType,
      content: input.textContent ?? null,
      version: nextVersion,
    },
  });

  return file;
}

export class ProjectService {
  getProjectWorkspaceDir(projectName: string) {
    return projectWorkspaceDir(projectName);
  }

  private async ensureProjectWorkspace(projectId: string, projectName: string, previousProjectName?: string | null) {
    const root = await migrateProjectWorkspaceDirIfNeeded(projectId, projectName, previousProjectName);
    await mkdir(root, { recursive: true });
    return root;
  }

  private async writeProjectWorkspaceFile(projectId: string, projectName: string, relativePath: string, contentBuffer: Buffer, previousProjectName?: string | null) {
    const projectRoot = await this.ensureProjectWorkspace(projectId, projectName, previousProjectName);
    const resolved = resolveProjectWorkspacePath(projectRoot, relativePath);
    await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, contentBuffer);
    return resolved;
  }

  private async readProjectWorkspaceBinaryFile(projectId: string, projectName: string, relativePath: string) {
    const projectRoot = await this.ensureProjectWorkspace(projectId, projectName);
    const resolved = resolveProjectWorkspacePath(projectRoot, relativePath);

    if (!(await pathExists(resolved.absolutePath))) {
      throw new Error('Project file not found.');
    }

    const [content, fileStat] = await Promise.all([
      readFile(resolved.absolutePath),
      stat(resolved.absolutePath),
    ]);

    return {
      relativePath: resolved.relativePath,
      content,
      updatedAt: fileStat.mtime.toISOString(),
    };
  }

  private async getProjectScopedAgentContext(agentId: string, channelId: string) {
    const membership = await prisma.agentChannelMembership.findFirst({
      where: { agentId, channelId },
      include: {
        channel: {
          include: {
            project: true,
          },
        },
      },
    });

    if (!membership?.channel.project) {
      throw new Error('This tool is only available in project channels.');
    }

    return membership.channel.project;
  }

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

    await this.ensureProjectWorkspace(project.id, project.name);
    const content = defaultProjectDoc(project.name, project.description);
    await this.writeProjectWorkspaceFile(project.id, project.name, PROJECT_FILE_NAME, Buffer.from(content, 'utf8'));
    await upsertProjectFileRecord({
      projectId: project.id,
      workspaceId,
      uploadedBy: userId,
      relativePath: PROJECT_FILE_NAME,
      fileName: PROJECT_FILE_NAME,
      mimeType: PROJECT_MIME_TYPE,
      contentBuffer: Buffer.from(content, 'utf8'),
      textContent: content,
    });

    return serializeProject(project);
  }

  async updateProject(userId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectSummary> {
    const project = await ensureProjectAccess(userId, projectId);

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: input.name ?? project.name,
        description: input.description !== undefined ? input.description : project.description,
      },
    });

    await this.ensureProjectWorkspace(updated.id, updated.name, project.name);

    return serializeProject(updated);
  }

  async getProjectFile(userId: string, projectId: string): Promise<WorkspaceDocRecord> {
    const project = await ensureProjectAccess(userId, projectId);
    await this.ensureProjectWorkspace(projectId, project.name);

    const existing = await prisma.workspaceFile.findUnique({
      where: { key: projectDocKey(projectId) },
    });

    if (!existing) {
      const content = defaultProjectDoc(project.name, project.description);
      await this.writeProjectWorkspaceFile(projectId, project.name, PROJECT_FILE_NAME, Buffer.from(content, 'utf8'));
      const file = await upsertProjectFileRecord({
        projectId,
        workspaceId: project.workspaceId,
        uploadedBy: userId,
        relativePath: PROJECT_FILE_NAME,
        fileName: PROJECT_FILE_NAME,
        mimeType: PROJECT_MIME_TYPE,
        contentBuffer: Buffer.from(content, 'utf8'),
        textContent: content,
      });

      return {
        fileName: file.fileName,
        content,
        updatedAt: file.updatedAt.toISOString(),
      };
    }

    const fileOnDisk = await this.readProjectWorkspaceBinaryFile(projectId, project.name, PROJECT_FILE_NAME).catch(() => null);
    const content = fileOnDisk?.content.toString('utf8') ?? existing.content ?? '';

    return {
      fileName: existing.fileName,
      content,
      updatedAt: existing.updatedAt.toISOString(),
    };
  }

  async updateProjectFile(userId: string, projectId: string, content: string): Promise<WorkspaceDocRecord> {
    const project = await ensureProjectAccess(userId, projectId);
    const buffer = Buffer.from(content, 'utf8');

    await this.ensureProjectWorkspace(projectId, project.name);
    await this.writeProjectWorkspaceFile(projectId, project.name, PROJECT_FILE_NAME, buffer);
    const file = await upsertProjectFileRecord({
      projectId,
      workspaceId: project.workspaceId,
      uploadedBy: userId,
      relativePath: PROJECT_FILE_NAME,
      fileName: PROJECT_FILE_NAME,
      mimeType: PROJECT_MIME_TYPE,
      contentBuffer: buffer,
      textContent: content,
    });

    await invalidateProjectChannels(projectId);

    return {
      fileName: file.fileName,
      content,
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async listProjectFiles(userId: string, projectId: string): Promise<ProjectFileRecord[]> {
    await ensureProjectAccess(userId, projectId);

    const files = await prisma.workspaceFile.findMany({
      where: {
        projectId,
        NOT: { key: projectDocKey(projectId) },
      },
      orderBy: [{ updatedAt: 'desc' }, { fileName: 'asc' }],
    });

    return files.map(serializeProjectFile);
  }

  async uploadProjectFile(userId: string, projectId: string, input: UploadProjectFileInput): Promise<ProjectFileRecord> {
    const project = await ensureProjectAccess(userId, projectId);
    const contentBuffer = Buffer.from(input.contentBase64, 'base64');
    const relativePath = sanitizeProjectRelativePath(input.fileName);
    const textContent = isTextProjectFile(input.fileName, input.mimeType, contentBuffer.byteLength)
      ? contentBuffer.toString('utf8')
      : null;

    await this.ensureProjectWorkspace(projectId, project.name);
    await this.writeProjectWorkspaceFile(projectId, project.name, relativePath, contentBuffer);
    const file = await upsertProjectFileRecord({
      projectId,
      workspaceId: project.workspaceId,
      uploadedBy: userId,
      relativePath,
      fileName: path.posix.basename(relativePath),
      mimeType: input.mimeType,
      contentBuffer,
      textContent,
    });

    return serializeProjectFile({
      id: file.id,
      projectId: file.projectId,
      fileName: file.fileName,
      key: file.key,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      updatedAt: file.updatedAt,
    });
  }

  async downloadProjectFile(userId: string, projectId: string, fileId: string) {
    const project = await ensureProjectAccess(userId, projectId);

    const file = await prisma.workspaceFile.findFirst({
      where: { id: fileId, projectId },
      select: { fileName: true, key: true, mimeType: true },
    });

    if (!file) {
      throw new Error('Project file not found.');
    }

    const relativePath = file.key === projectDocKey(projectId)
      ? PROJECT_FILE_NAME
      : file.key.replace(`projects/${projectId}/files/`, '');
    const binary = await this.readProjectWorkspaceBinaryFile(projectId, project.name, relativePath);

    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      content: binary.content,
    };
  }

  async listProjectTickets(userId: string, projectId: string): Promise<ProjectTicketRecord[]> {
    await ensureProjectAccess(userId, projectId);

    const tickets = await prisma.projectTicket.findMany({
      where: { projectId },
      include: {
        createdByUser: { select: { id: true, username: true } },
        assignedAgent: { select: { name: true } },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    return tickets.map(serializeProjectTicket);
  }

  private async notifyAgentsAboutTicket(input: {
    projectId: string;
    ticketId: string;
    createdBy: string;
    preferredAgentId?: string | null;
    explicitlyAssigned: boolean;
  }) {
    const [project, ticket, memberships] = await Promise.all([
      prisma.project.findUnique({ where: { id: input.projectId }, select: { name: true } }),
      prisma.projectTicket.findUnique({
        where: { id: input.ticketId },
        include: {
          assignedAgent: { select: { name: true } },
        },
      }),
      prisma.agentChannelMembership.findMany({
        where: {
          channel: { projectId: input.projectId },
          ...(input.preferredAgentId ? { agentId: input.preferredAgentId } : {}),
          agent: { status: 'ACTIVE' },
        },
        select: {
          agentId: true,
          channelId: true,
        },
        orderBy: { addedAt: 'asc' },
      }),
    ]);

    if (!project || !ticket) {
      return;
    }

    const agentTargets = new Map<string, string>();
    for (const membership of memberships) {
      if (!agentTargets.has(membership.agentId)) {
        agentTargets.set(membership.agentId, membership.channelId);
      }
    }

    await Promise.all(Array.from(agentTargets.entries()).map(async ([agentId, channelId]) => {
      const triggerMessage = await prisma.message.create({
        data: {
          channelId,
          senderId: input.createdBy,
          senderType: 'USER',
          content: buildProjectTicketInternalMessage({
            projectName: project.name,
            ticketTitle: ticket.title,
            ticketId: ticket.id,
            assignedAgentName: ticket.assignedAgent?.name ?? null,
            explicitlyAssigned: input.explicitlyAssigned,
          }),
          contentType: 'SYSTEM',
          metadata: {
            internal: true,
            source: PROJECT_TICKET_SOURCE,
            projectId: input.projectId,
            ticketId: input.ticketId,
          },
        },
      });

      await agentProcessQueue.add('agent:process', {
        agentId,
        channelId,
        messageId: triggerMessage.id,
      }, {
        jobId: `project-ticket:${input.ticketId}:${agentId}:${triggerMessage.id}`,
      });
    }));
  }

  async createProjectTicket(userId: string, projectId: string, input: CreateProjectTicketInput): Promise<ProjectTicketRecord> {
    await ensureProjectAccess(userId, projectId);

    if (input.assignedAgentId) {
      const projectAgent = await prisma.agentChannelMembership.findFirst({
        where: {
          agentId: input.assignedAgentId,
          channel: { projectId },
        },
        select: { agentId: true },
      });

      if (!projectAgent) {
        throw new Error('Assigned agent is not part of this project.');
      }
    }

    const ticket = await prisma.projectTicket.create({
      data: {
        projectId,
        createdBy: userId,
        assignedAgentId: input.assignedAgentId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: input.assignedAgentId ? 'ASSIGNED' : 'TODO',
      },
      include: {
        createdByUser: { select: { id: true, username: true } },
        assignedAgent: { select: { name: true } },
      },
    });

    if (input.assignmentMode === 'AUTO') {
      void this.notifyAgentsAboutTicket({
        projectId,
        ticketId: ticket.id,
        createdBy: userId,
        explicitlyAssigned: false,
      });
    } else if (input.assignedAgentId) {
      void this.notifyAgentsAboutTicket({
        projectId,
        ticketId: ticket.id,
        createdBy: userId,
        preferredAgentId: input.assignedAgentId,
        explicitlyAssigned: true,
      });
    }

    return serializeProjectTicket(ticket);
  }

  async updateProjectTicket(userId: string, projectId: string, ticketId: string, input: UpdateProjectTicketInput): Promise<ProjectTicketRecord> {
    await ensureProjectAccess(userId, projectId);

    const ticket = await prisma.projectTicket.findFirst({
      where: { id: ticketId, projectId },
    });

    if (!ticket) {
      throw new Error('Project ticket not found.');
    }

    if (input.assignedAgentId) {
      const projectAgent = await prisma.agentChannelMembership.findFirst({
        where: {
          agentId: input.assignedAgentId,
          channel: { projectId },
        },
        select: { agentId: true },
      });

      if (!projectAgent) {
        throw new Error('Assigned agent is not part of this project.');
      }
    }

    const nextAssignedAgentId = input.assignedAgentId !== undefined ? input.assignedAgentId : ticket.assignedAgentId;
    const nextStatus = input.status
      ?? (input.assignedAgentId === null ? 'TODO' : input.assignedAgentId ? 'ASSIGNED' : ticket.status);

    const updated = await prisma.projectTicket.update({
      where: { id: ticketId },
      data: {
        title: input.title ?? ticket.title,
        description: input.description !== undefined ? input.description : ticket.description,
        assignedAgentId: nextAssignedAgentId,
        status: nextStatus,
        claimedAt: nextStatus === 'IN_PROGRESS' ? (ticket.claimedAt ?? new Date()) : nextStatus === 'TODO' || nextStatus === 'ASSIGNED' ? null : ticket.claimedAt,
        completedAt: nextStatus === 'DONE' ? new Date() : null,
      },
      include: {
        createdByUser: { select: { id: true, username: true } },
        assignedAgent: { select: { name: true } },
      },
    });

    const shouldNotifyAssignedAgent = Boolean(input.assignedAgentId && input.assignedAgentId !== ticket.assignedAgentId);
    const shouldNotifyAutoPickup = input.status === 'IN_PROGRESS' && !nextAssignedAgentId && ticket.status !== 'IN_PROGRESS';

    if (shouldNotifyAssignedAgent) {
      void this.notifyAgentsAboutTicket({
        projectId,
        ticketId,
        createdBy: userId,
        preferredAgentId: input.assignedAgentId,
        explicitlyAssigned: true,
      });
    } else if (shouldNotifyAutoPickup) {
      void this.notifyAgentsAboutTicket({
        projectId,
        ticketId,
        createdBy: userId,
        explicitlyAssigned: false,
      });
    }

    return serializeProjectTicket(updated);
  }

  async createProjectChannel(
    userId: string,
    projectId: string,
    input: Pick<CreateChannelInput, 'name' | 'agentIds'>,
  ) {
    const project = await ensureProjectAccess(userId, projectId);

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
      participantAgentIds: channel.agentMemberships.map((membership) => membership.agentId),
      participantAgentNames: channel.agentMemberships.map((membership) => membership.agent.name),
      lastMessageAt: channel.messages[0]?.createdAt.toISOString() ?? null,
    };
  }

  async getProjectAgentContext(projectId: string, currentAgentId?: string | null) {
    const [project, files, tickets] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      prisma.workspaceFile.findMany({
        where: {
          projectId,
          NOT: { key: projectDocKey(projectId) },
        },
        orderBy: [{ updatedAt: 'desc' }, { fileName: 'asc' }],
        take: 25,
        select: {
          id: true,
          projectId: true,
          fileName: true,
          key: true,
          mimeType: true,
          fileSize: true,
          updatedAt: true,
        },
      }),
      prisma.projectTicket.findMany({
        where: {
          projectId,
          status: { in: ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] },
        },
        include: {
          createdByUser: { select: { id: true, username: true } },
          assignedAgent: { select: { name: true } },
        },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: 20,
      }),
    ]);

    return {
      projectWorkspaceRoot: this.getProjectWorkspaceDir(project.name),
      files: files.map(serializeProjectFile),
      tickets: tickets.map(serializeProjectTicket),
      myAssignedTickets: tickets.filter((ticket) => ticket.assignedAgentId === currentAgentId).map(serializeProjectTicket),
    };
  }

  async listProjectFilesForAgent(agentId: string, channelId: string) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    return this.getProjectAgentContext(project.id, agentId);
  }

  async readProjectSharedFileForAgent(agentId: string, channelId: string, filePath: string) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    const relativePath = sanitizeProjectRelativePath(filePath);
    const key = relativePath === PROJECT_FILE_NAME ? projectDocKey(project.id) : projectSharedFileKey(project.id, relativePath);
    const record = await prisma.workspaceFile.findUnique({
      where: { key },
      select: { fileName: true, mimeType: true },
    });

    if (!record) {
      throw new Error('Project file not found.');
    }

    const file = await this.readProjectWorkspaceBinaryFile(project.id, project.name, relativePath);
    return {
      fileName: record.fileName,
      mimeType: record.mimeType,
      relativePath,
      content: file.content,
    };
  }

  async writeProjectSharedFileForAgent(agentId: string, channelId: string, filePath: string, content: string) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    const relativePath = sanitizeProjectRelativePath(filePath);
    const buffer = Buffer.from(content, 'utf8');

    await this.ensureProjectWorkspace(project.id, project.name);
    await this.writeProjectWorkspaceFile(project.id, project.name, relativePath, buffer);
    const file = await upsertProjectFileRecord({
      projectId: project.id,
      workspaceId: project.workspaceId,
      uploadedBy: null,
      relativePath,
      fileName: path.posix.basename(relativePath),
      mimeType: isTextProjectFile(relativePath, 'text/plain', buffer.byteLength) ? 'text/plain' : 'application/octet-stream',
      contentBuffer: buffer,
      textContent: content,
    });

    if (relativePath === PROJECT_FILE_NAME) {
      await invalidateProjectChannels(project.id);
    }

    return serializeProjectFile({
      id: file.id,
      projectId: file.projectId,
      fileName: file.fileName,
      key: file.key,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      updatedAt: file.updatedAt,
    });
  }

  async listProjectTicketsForAgent(agentId: string, channelId: string) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    return this.getProjectAgentContext(project.id, agentId);
  }

  async claimProjectTicketForAgent(agentId: string, channelId: string, ticketId: string) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    const updated = await prisma.projectTicket.updateMany({
      where: {
        id: ticketId,
        projectId: project.id,
        status: { in: ['TODO', 'ASSIGNED', 'IN_PROGRESS'] },
        OR: [
          { assignedAgentId: null },
          { assignedAgentId: agentId },
        ],
      },
      data: {
        assignedAgentId: agentId,
        status: 'IN_PROGRESS',
        claimedAt: new Date(),
        completedAt: null,
      },
    });

    if (updated.count === 0) {
      throw new Error('Ticket is already claimed or unavailable.');
    }

    const ticket = await prisma.projectTicket.findUniqueOrThrow({
      where: { id: ticketId },
      include: {
        createdByUser: { select: { id: true, username: true } },
        assignedAgent: { select: { name: true } },
      },
    });

    return serializeProjectTicket(ticket);
  }

  async updateProjectTicketForAgent(agentId: string, channelId: string, ticketId: string, input: {
    status?: UpdateProjectTicketInput['status'];
    description?: UpdateProjectTicketInput['description'];
    channelMessage?: string;
  }) {
    const project = await this.getProjectScopedAgentContext(agentId, channelId);
    const ticket = await prisma.projectTicket.findFirst({
      where: { id: ticketId, projectId: project.id },
    });

    if (!ticket) {
      throw new Error('Project ticket not found.');
    }

    if (ticket.assignedAgentId && ticket.assignedAgentId !== agentId) {
      throw new Error('This ticket is assigned to another agent.');
    }

    const nextStatus = input.status ?? ticket.status;
    const updated = await prisma.projectTicket.update({
      where: { id: ticketId },
      data: {
        assignedAgentId: ticket.assignedAgentId ?? agentId,
        description: input.description !== undefined ? input.description : ticket.description,
        status: nextStatus,
        claimedAt: nextStatus === 'IN_PROGRESS' ? (ticket.claimedAt ?? new Date()) : ticket.claimedAt,
        completedAt: nextStatus === 'DONE' ? new Date() : null,
      },
      include: {
        createdByUser: { select: { id: true, username: true } },
        assignedAgent: { select: { name: true } },
      },
    });

    return serializeProjectTicket(updated);
  }
}

export const projectService = new ProjectService();
