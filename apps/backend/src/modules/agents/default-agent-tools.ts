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
      toolName: 'workspace_glob',
      config: {
        description: 'Find files by glob pattern inside the agent workspace.',
        access: 'workspace-only',
      },
      requiresApproval: false,
    },
    {
      toolName: 'workspace_grep',
      config: {
        description: 'Search file contents by pattern inside the agent workspace.',
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
    {
      toolName: 'send_reply',
      config: {
        description: 'Send an intermediate progress update to the current channel.',
        access: 'current-channel',
      },
      requiresApproval: false,
    },
    {
      toolName: 'todowrite',
      config: {
        description: 'Create or update a structured todo list for multi-step work.',
        access: 'workspace-state',
      },
      requiresApproval: false,
    },
    {
      toolName: 'todoread',
      config: {
        description: 'Read the current structured todo list.',
        access: 'workspace-state',
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
