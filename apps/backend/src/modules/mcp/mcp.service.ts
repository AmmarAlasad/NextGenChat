/**
 * MCP Service — Browser MCP Runtime Integration
 *
 * Implements the first working MCP client path for agent tools by managing a
 * workspace-scoped Browser MCP server over stdio, syncing discovered MCP tools
 * into Prisma, and exposing per-agent enable/disable helpers.
 *
 * Phase 5 implementation status:
 * - Supports a default Browser MCP server per workspace using the official stdio client SDK.
 * - Syncs discovered Browser MCP tools into McpServerTool and AgentTool rows.
 * - Future phases can expand this into generic multi-server registration, approvals, and richer health checks.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentBrowserMcpState, BrowserMcpServerStatus } from '@nextgenchat/types';
import { Prisma } from '@prisma/client';

import { prisma } from '@/db/client.js';
import { decryptJson, encryptJson } from '@/lib/crypto.js';

const BROWSER_MCP_SERVER_NAME = 'Browser MCP';
const BROWSER_MCP_SERVER_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const BROWSER_MCP_SERVER_ARGS = ['-y', '@browsermcp/mcp@latest'];
const BROWSER_MCP_ENV_VERSION = 1;
const MCP_CLIENT_INFO = {
  name: 'NextGenChat Browser MCP Client',
  version: '0.1.0',
} as const;

type StoredMcpEnv = {
  version: number;
  vars: Record<string, string>;
};

type RuntimeClient = {
  client: Client;
  transport: StdioClientTransport;
};

function isMcpStatus(value: string): value is Exclude<BrowserMcpServerStatus, 'NOT_CONFIGURED'> {
  return ['STOPPED', 'STARTING', 'RUNNING', 'UNHEALTHY', 'FAILED'].includes(value);
}

function getBrowserMcpStoredEnv() {
  return encryptJson({
    version: BROWSER_MCP_ENV_VERSION,
    vars: {},
  });
}

function parseBrowserMcpEnv(payload: string | null): Record<string, string> {
  if (!payload) {
    return {};
  }

  const decoded = decryptJson<StoredMcpEnv>(payload);
  return decoded.vars ?? {};
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function describeToolResult(result: { [key: string]: unknown }) {
  if (!('content' in result) || !Array.isArray(result.content)) {
    return JSON.stringify('toolResult' in result ? result.toolResult : result, null, 2);
  }

  const typedResult = result as CallToolResult;
  const blocks = typedResult.content ?? [];
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
        parts.push(`[image:${block.mimeType}]`);
        break;
      case 'audio':
        parts.push(`[audio:${block.mimeType}]`);
        break;
      case 'resource':
        parts.push(`[resource:${block.resource?.uri ?? 'embedded-resource'}]`);
        break;
      default:
        parts.push(JSON.stringify(block));
        break;
    }
  }

  if (parts.length > 0) {
    return parts.join('\n\n').trim();
  }

  if (typedResult.structuredContent) {
    return JSON.stringify(typedResult.structuredContent, null, 2);
  }

  return typedResult.isError ? 'Browser MCP returned an error with no message.' : 'Browser MCP completed with no text output.';
}

class McpService {
  private readonly runtimeClients = new Map<string, Promise<RuntimeClient>>();

  private async getWorkspaceBrowserServer(workspaceId: string) {
    return prisma.mcpServer.findFirst({
      where: { workspaceId, name: BROWSER_MCP_SERVER_NAME },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async ensureWorkspaceBrowserServer(workspaceId: string, userId: string) {
    const existing = await this.getWorkspaceBrowserServer(workspaceId);
    if (existing) {
      return existing;
    }

    return prisma.mcpServer.create({
      data: {
        workspaceId,
        createdBy: userId,
        name: BROWSER_MCP_SERVER_NAME,
        command: BROWSER_MCP_SERVER_COMMAND,
        args: BROWSER_MCP_SERVER_ARGS,
        env: getBrowserMcpStoredEnv(),
        status: 'STOPPED',
      },
    });
  }

  private async getRuntimeClient(serverId: string) {
    let runtimePromise = this.runtimeClients.get(serverId);

    if (!runtimePromise) {
      runtimePromise = this.createRuntimeClient(serverId);
      this.runtimeClients.set(serverId, runtimePromise);
    }

    try {
      return await runtimePromise;
    } catch (error) {
      this.runtimeClients.delete(serverId);
      throw error;
    }
  }

  private async createRuntimeClient(serverId: string): Promise<RuntimeClient> {
    const server = await prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!server) {
      throw new Error('MCP server not found.');
    }

    await prisma.mcpServer.update({
      where: { id: serverId },
      data: { status: 'STARTING' },
    });

    const args = Array.isArray(server.args) ? server.args.filter((value): value is string => typeof value === 'string') : [];
    const env = Object.fromEntries(Object.entries({
      ...process.env,
      ...parseBrowserMcpEnv(server.env),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

    const transport = new StdioClientTransport({
      command: server.command,
      args,
      env,
      stderr: 'pipe',
    });

    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: {},
    });

    transport.stderr?.on('data', () => {
      void prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'UNHEALTHY' },
      }).catch(() => undefined);
    });

    transport.onclose = () => {
      this.runtimeClients.delete(serverId);
      void prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'STOPPED' },
      }).catch(() => undefined);
    };

    transport.onerror = () => {
      void prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'FAILED' },
      }).catch(() => undefined);
    };

    try {
      await client.connect(transport);
      await prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'RUNNING' },
      });
      return { client, transport };
    } catch (error) {
      this.runtimeClients.delete(serverId);
      await prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'FAILED' },
      });
      throw error;
    }
  }

  async stopServer(serverId: string) {
    const runtimePromise = this.runtimeClients.get(serverId);
    this.runtimeClients.delete(serverId);

    if (runtimePromise) {
      try {
        const runtime = await runtimePromise;
        await runtime.transport.close();
      } catch {
        // Ignore shutdown errors and converge DB state below.
      }
    }

    await prisma.mcpServer.update({
      where: { id: serverId },
      data: { status: 'STOPPED' },
    });
  }

  async discoverTools(serverId: string) {
    const runtime = await this.getRuntimeClient(serverId);
    const result = await runtime.client.listTools();
    const tools = result.tools ?? [];

    for (const tool of tools) {
      await prisma.mcpServerTool.upsert({
        where: {
          serverId_name: {
            serverId,
            name: tool.name,
          },
        },
        create: {
          serverId,
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: toJsonValue(tool.inputSchema),
          approved: true,
        },
        update: {
          description: tool.description ?? null,
          inputSchema: toJsonValue(tool.inputSchema),
          approved: true,
        },
      });
    }

    const discoveredNames = new Set(tools.map((tool) => tool.name));
    const removedTools = await prisma.mcpServerTool.findMany({
      where: {
        serverId,
        name: { notIn: [...discoveredNames] },
      },
      select: { id: true },
    });

    if (removedTools.length > 0) {
      await prisma.agentTool.deleteMany({
        where: {
          mcpServerToolId: {
            in: removedTools.map((tool) => tool.id),
          },
        },
      });

      await prisma.mcpServerTool.deleteMany({
        where: {
          id: { in: removedTools.map((tool) => tool.id) },
        },
      });
    }

    return tools;
  }

  async executeToolCall(serverId: string, toolName: string, args: Record<string, unknown>) {
    const runtime = await this.getRuntimeClient(serverId);
    const result = await runtime.client.callTool({
      name: toolName,
      arguments: args,
    });

    return {
      output: describeToolResult(result),
      structuredOutput: {
        isError: 'isError' in result ? Boolean(result.isError) : false,
        structuredContent: 'structuredContent' in result ? result.structuredContent ?? null : null,
        content: 'content' in result ? result.content ?? null : null,
        raw: result,
      },
    };
  }

  private async getAgentBrowserServer(agentId: string, userId: string) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        workspaceId: true,
        workspace: {
          select: {
            memberships: {
              where: { userId },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!agent || agent.workspace.memberships.length === 0) {
      throw new Error('You do not have access to this agent.');
    }

    const server = await this.getWorkspaceBrowserServer(agent.workspaceId);
    return { agent, server };
  }

  async getAgentBrowserMcpState(agentId: string, userId: string): Promise<AgentBrowserMcpState> {
    const { server } = await this.getAgentBrowserServer(agentId, userId);

    if (!server) {
      return {
        enabled: false,
        serverId: null,
        serverName: null,
        serverStatus: 'NOT_CONFIGURED',
        toolCount: 0,
        toolNames: [],
      };
    }

    const agentTools = await prisma.agentTool.findMany({
      where: {
        agentId,
        mcpServerTool: {
          serverId: server.id,
        },
      },
      include: {
        mcpServerTool: {
          select: { name: true },
        },
      },
      orderBy: { toolName: 'asc' },
    });

    return {
      enabled: agentTools.length > 0,
      serverId: server.id,
      serverName: server.name,
      serverStatus: isMcpStatus(server.status) ? server.status : 'FAILED',
      toolCount: agentTools.length,
      toolNames: agentTools.map((tool) => tool.mcpServerTool?.name ?? tool.toolName),
    };
  }

  async setAgentBrowserMcpEnabled(agentId: string, userId: string, enabled: boolean): Promise<AgentBrowserMcpState> {
    const { agent, server } = await this.getAgentBrowserServer(agentId, userId);
    const workspaceServer = enabled
      ? await this.ensureWorkspaceBrowserServer(agent.workspaceId, userId)
      : server;

    if (!workspaceServer) {
      return this.getAgentBrowserMcpState(agentId, userId);
    }

    if (enabled) {
      const discoveredTools = await this.discoverTools(workspaceServer.id);
      const syncedTools = await prisma.mcpServerTool.findMany({
        where: { serverId: workspaceServer.id },
      });
      const toolIdsByName = new Map(syncedTools.map((tool) => [tool.name, tool.id]));

      for (const tool of discoveredTools) {
        const mcpServerToolId = toolIdsByName.get(tool.name);
        if (!mcpServerToolId) {
          continue;
        }

        await prisma.agentTool.upsert({
          where: {
            agentId_toolName: {
              agentId,
              toolName: tool.name,
            },
          },
          create: {
            agentId,
            toolName: tool.name,
            mcpServerToolId,
            config: {
              source: 'browser-mcp',
              serverName: workspaceServer.name,
              inputSchema: toJsonValue(tool.inputSchema),
            },
            requiresApproval: false,
          },
          update: {
            mcpServerToolId,
            config: {
              source: 'browser-mcp',
              serverName: workspaceServer.name,
              inputSchema: toJsonValue(tool.inputSchema),
            },
            requiresApproval: false,
          },
        });
      }
    } else {
      await prisma.agentTool.deleteMany({
        where: {
          agentId,
          mcpServerTool: {
            serverId: workspaceServer.id,
          },
        },
      });

      const remainingAssignments = await prisma.agentTool.count({
        where: {
          mcpServerTool: {
            serverId: workspaceServer.id,
          },
        },
      });

      if (remainingAssignments === 0) {
        await this.stopServer(workspaceServer.id);
      }
    }

    return this.getAgentBrowserMcpState(agentId, userId);
  }
}

export const mcpService = new McpService();
