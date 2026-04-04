/**
 * Workspace Service — Agent Workspace Docs
 *
 * Current scope implements the first real meaning of an agent private workspace:
 * persistent markdown docs plus a readable memory projection. Arbitrary file IO
 * and tool-driven workspace mutations will arrive later through the tools layer.
 */

import type { AgentDocAssistInput, AgentDocAssistResponse, AgentDocRecord, AgentDocType, UpdateAgentDocInput } from '@nextgenchat/types';

import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

const DOC_FILE_NAMES: Record<AgentDocType, string> = {
  'Agent.md': 'agent.md',
  'identity.md': 'identity.md',
  'agency.md': 'agency.md',
  'memory.md': 'memory.md',
  'Heartbeat.md': 'heartbeat.md',
};

const DOC_MIME_TYPE = 'text/markdown';

function resolveDocType(value: string): AgentDocType {
  switch (value) {
    case 'Agent.md':
    case 'identity.md':
    case 'agency.md':
    case 'memory.md':
    case 'Heartbeat.md':
      return value;
    default:
      throw new Error('Unsupported agent doc type.');
  }
}

function fromPrismaDocType(value: string | null): AgentDocType {
  switch (value) {
    case 'AGENT_MD':
      return 'Agent.md';
    case 'IDENTITY_MD':
      return 'identity.md';
    case 'AGENCY_MD':
      return 'agency.md';
    case 'MEMORY_MD':
      return 'memory.md';
    case 'HEARTBEAT_MD':
      return 'Heartbeat.md';
    default:
      return 'Agent.md';
  }
}

function createIdentityDoc(input: {
  agentName: string;
  persona: string | null;
  voiceTone: string | null;
  systemPrompt: string | null;
}) {
  return `# Identity\n\n## Agent\n- Name: ${input.agentName}\n- Persona: ${input.persona ?? 'Not defined yet.'}\n- Voice tone: ${input.voiceTone ?? 'Not defined yet.'}\n\n## Role\nThis file defines the stable identity of the agent. Keep it focused on role, tone, boundaries, and operator intent.\n\n## System Prompt\n${input.systemPrompt?.trim() || 'No system prompt defined yet.'}\n`;
}

function createAgentDoc(input: { agentName: string }) {
  return `# Agent Operations\n\n## Agent\n${input.agentName}\n\n## Purpose\nUse this file for durable operating guidance, task conventions, and admin-authored execution notes. Do not use it as hidden chain-of-thought storage.\n\n## Current Guidance\n- Start from the latest heartbeat state before continuing long-running work.\n- Prefer updating durable memory over repeating the same facts in chat.\n`;
}

function createAgencyDoc(input: { workspaceName: string }) {
  return `# Agency\n\n## Workspace\n${input.workspaceName}\n\n## Mission\nDefine the shared standards, operating principles, and collaboration rules for agents in this workspace.\n\n## Defaults\n- Work transparently\n- Preserve important decisions in memory\n- Keep long-running work resumable through heartbeat updates\n`;
}

function createHeartbeatDoc(input: { agentName: string }) {
  return `# Heartbeat\n\n## Agent\n${input.agentName}\n\n## Purpose\nTrack chunked work that spans multiple runs. This file should let the next run continue without the operator repeating instructions.\n\n## Active Work\n- No active heartbeat tasks yet.\n\n## Next Chunk\n- No pending chunk recorded.\n\n## Last Completed Chunk\n- None yet.\n`;
}

function createMemoryDoc(memoryEntries: Array<{
  scope: 'GLOBAL' | 'CHANNEL' | 'USER';
  key: string;
  value: unknown;
  channelId: string | null;
  userId: string | null;
  updatedAt: Date;
}>) {
  const lines = ['# Memory', '', 'Readable projection of durable structured agent memory.', ''];

  if (memoryEntries.length === 0) {
    lines.push('No durable memory entries yet.');
    return `${lines.join('\n')}\n`;
  }

  for (const entry of memoryEntries) {
    lines.push(`## ${entry.key}`);
    lines.push(`- Scope: ${entry.scope}`);
    if (entry.channelId) {
      lines.push(`- Channel: ${entry.channelId}`);
    }
    if (entry.userId) {
      lines.push(`- User: ${entry.userId}`);
    }
    lines.push(`- Updated: ${entry.updatedAt.toISOString()}`);
    lines.push('- Value:');
    lines.push('```json');
    lines.push(JSON.stringify(entry.value, null, 2));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function serializeDoc(doc: {
  docType: string | null;
  fileName: string;
  content: string | null;
  updatedAt: Date;
}): AgentDocRecord {
  return {
    docType: fromPrismaDocType(doc.docType),
    fileName: doc.fileName,
    content: doc.content ?? '',
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function ensureAgentWorkspaceAccess(userId: string, agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          memberships: {
            where: { userId },
            select: { id: true },
            take: 1,
          },
        },
      },
      identity: true,
    },
  });

  if (!agent || agent.workspace.memberships.length === 0) {
    throw new Error('You do not have access to this agent workspace.');
  }

  return agent;
}

export class WorkspaceService {
  async assertAgentWorkspaceAccess(userId: string, agentId: string) {
    return ensureAgentWorkspaceAccess(userId, agentId);
  }

  async ensureAgentDocs(agentId: string) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        workspace: true,
        identity: true,
        memoryEntries: {
          orderBy: [{ scope: 'asc' }, { key: 'asc' }],
        },
      },
    });

    if (!agent) {
      throw new Error('Agent not found.');
    }

    const defaults: Record<AgentDocType, string> = {
      'Agent.md': createAgentDoc({ agentName: agent.name }),
      'identity.md': createIdentityDoc({
        agentName: agent.name,
        persona: agent.identity?.persona ?? null,
        voiceTone: agent.identity?.voiceTone ?? null,
        systemPrompt: agent.identity?.systemPrompt ?? null,
      }),
      'agency.md': createAgencyDoc({ workspaceName: agent.workspace.name }),
      'memory.md': createMemoryDoc(
        agent.memoryEntries.map((entry) => ({
          scope: entry.scope,
          key: entry.key,
          value: entry.value,
          channelId: entry.channelId,
          userId: entry.userId,
          updatedAt: entry.updatedAt,
        })),
      ),
      'Heartbeat.md': createHeartbeatDoc({ agentName: agent.name }),
    };

    for (const [docType, content] of Object.entries(defaults) as Array<[AgentDocType, string]>) {
      const fileName = DOC_FILE_NAMES[docType];
      const key = `workspaces/agents/${agent.id}/${fileName}`;

      // upsert avoids a unique-constraint race when two concurrent requests
      // (e.g. double-click on Save) both see no existing doc and both try to create.
      await prisma.workspaceFile.upsert({
        where: { key },
        create: {
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          uploadedBy: agent.createdBy,
          docType: this.toPrismaDocType(docType),
          key,
          fileName,
          fileSize: Buffer.byteLength(content, 'utf8'),
          mimeType: DOC_MIME_TYPE,
          content,
        },
        update: {}, // never overwrite content that the operator has already edited
      });
    }
  }

  async listAgentDocs(userId: string, agentId: string) {
    await ensureAgentWorkspaceAccess(userId, agentId);
    await this.ensureAgentDocs(agentId);

    const docs = await prisma.workspaceFile.findMany({
      where: {
        agentId,
        docType: {
          in: ['AGENT_MD', 'IDENTITY_MD', 'AGENCY_MD', 'MEMORY_MD', 'HEARTBEAT_MD'],
        },
      },
      select: {
        docType: true,
        fileName: true,
        content: true,
        updatedAt: true,
      },
      orderBy: { fileName: 'asc' },
    });

    return docs.map(serializeDoc);
  }

  async getAgentDoc(userId: string, agentId: string, docTypeInput: string) {
    await ensureAgentWorkspaceAccess(userId, agentId);
    await this.ensureAgentDocs(agentId);

    const docType = resolveDocType(docTypeInput);
    const file = await prisma.workspaceFile.findFirst({
      where: {
        agentId,
        docType: this.toPrismaDocType(docType),
      },
      select: {
        docType: true,
        fileName: true,
        content: true,
        updatedAt: true,
      },
    });

    if (!file) {
      throw new Error('Agent document not found.');
    }

    return serializeDoc(file);
  }

  async updateAgentDoc(userId: string, agentId: string, docTypeInput: string, input: UpdateAgentDocInput) {
    await ensureAgentWorkspaceAccess(userId, agentId);
    await this.ensureAgentDocs(agentId);

    const docType = resolveDocType(docTypeInput);
    const file = await prisma.workspaceFile.findFirst({
      where: {
        agentId,
        docType: this.toPrismaDocType(docType),
      },
    });

    if (!file) {
      throw new Error('Agent document not found.');
    }

    await prisma.$transaction(async (tx) => {
      // Snapshot the current version before overwriting. A concurrent save at the
      // same version would violate the unique (fileId, version) constraint; treat
      // that as a benign conflict and skip the snapshot rather than crashing.
      const versionKey = `${file.key}.v${file.version}`;
      const versionExists = await tx.workspaceFileVersion.findFirst({
        where: { fileId: file.id, version: file.version },
        select: { id: true },
      });

      if (!versionExists) {
        await tx.workspaceFileVersion.create({
          data: {
            fileId: file.id,
            key: versionKey,
            fileSize: file.fileSize,
            mimeType: file.mimeType,
            content: file.content,
            version: file.version,
          },
        });
      }

      await tx.workspaceFile.update({
        where: { id: file.id },
        data: {
          content: input.content,
          fileSize: Buffer.byteLength(input.content, 'utf8'),
          version: file.version + 1,
        },
      });
    });

    if (docType === 'identity.md') {
      await prisma.agentIdentity.upsert({
        where: { agentId },
        update: { systemPrompt: input.content },
        create: { agentId, systemPrompt: input.content },
      });
    }

    return this.getAgentDoc(userId, agentId, docType);
  }

  async assistAgentDoc(userId: string, agentId: string, docTypeInput: string, input: AgentDocAssistInput): Promise<AgentDocAssistResponse> {
    await ensureAgentWorkspaceAccess(userId, agentId);
    const docType = resolveDocType(docTypeInput);

    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
      return {
        content: `${input.currentContent.trim()}\n\n<!-- Assistant suggestion unavailable because no OpenAI API key is configured. -->\n`,
      };
    }

    const provider = new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o-mini');
    const response = await provider.complete({
      messages: [
        {
          role: 'system',
          content: `You are a writing assistant for ${docType}. Rewrite or improve the markdown file according to the user's instruction. Keep it concise, structured, and production-ready. Return only the revised markdown.`,
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              instruction: input.instruction,
              currentMarkdown: input.currentContent,
            },
            null,
            2,
          ),
        },
      ],
      maxTokens: 1600,
      temperature: 0.2,
    });

    return {
      content: response.content.trim() || input.currentContent,
    };
  }

  async syncMemoryDoc(agentId: string) {
    await this.ensureAgentDocs(agentId);

    const [memoryEntries, memoryDoc] = await Promise.all([
      prisma.agentMemory.findMany({
        where: { agentId },
        orderBy: [{ scope: 'asc' }, { key: 'asc' }],
      }),
      prisma.workspaceFile.findFirst({
        where: {
          agentId,
          docType: 'MEMORY_MD',
        },
      }),
    ]);

    if (!memoryDoc) {
      return;
    }

    const content = createMemoryDoc(
      memoryEntries.map((entry) => ({
        scope: entry.scope,
        key: entry.key,
        value: entry.value,
        channelId: entry.channelId,
        userId: entry.userId,
        updatedAt: entry.updatedAt,
      })),
    );

    await prisma.workspaceFile.update({
      where: { id: memoryDoc.id },
      data: {
        content,
        fileSize: Buffer.byteLength(content, 'utf8'),
      },
    });
  }

  private toPrismaDocType(docType: AgentDocType) {
    switch (docType) {
      case 'Agent.md':
        return 'AGENT_MD' as const;
      case 'identity.md':
        return 'IDENTITY_MD' as const;
      case 'agency.md':
        return 'AGENCY_MD' as const;
      case 'memory.md':
        return 'MEMORY_MD' as const;
      case 'Heartbeat.md':
        return 'HEARTBEAT_MD' as const;
    }
  }
}

export const workspaceService = new WorkspaceService();
