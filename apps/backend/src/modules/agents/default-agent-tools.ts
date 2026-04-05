/**
 * Default Agent Tools
 *
 * Centralizes the built-in tool set that newly created and existing local agents
 * should have available for autonomous workspace and repository work.
 */

import { prisma } from '@/db/client.js';

export function buildDefaultAgentTools() {
  return [
    {
      toolName: 'workspace_read_file',
      config: {
        description: 'Read a file or directory from the agent workspace only.',
        access: 'workspace-only',
      },
      requiresApproval: false,
    },
    {
      toolName: 'workspace_write_file',
      config: {
        description: 'Write a full file inside the agent workspace only.',
        access: 'workspace-only',
      },
      requiresApproval: false,
    },
    {
      toolName: 'workspace_bash',
      config: {
        description: 'Run shell commands from the agent workspace only.',
        access: 'workspace-only',
      },
      requiresApproval: false,
    },
    {
      toolName: 'channel_send_message',
      config: {
        description: 'Send a message to another non-direct channel the agent already belongs to.',
        access: 'membership-only',
      },
      requiresApproval: false,
    },
  ];
}

export async function ensureDefaultAgentTools(agentId: string) {
  for (const tool of buildDefaultAgentTools()) {
    await prisma.agentTool.upsert({
      where: {
        agentId_toolName: {
          agentId,
          toolName: tool.toolName,
        },
      },
      create: {
        agentId,
        toolName: tool.toolName,
        config: tool.config,
        requiresApproval: tool.requiresApproval,
      },
      update: {
        config: tool.config,
        requiresApproval: tool.requiresApproval,
      },
    });
  }
}
