/**
 * Tool Registry Service Tests
 *
 * Verifies the phase-4 built-in agent tools against a mocked runtime so new
 * workspace tools remain callable through the real registry entrypoints.
 *
 * Phase 4 implementation status:
 * - Covers the current workspace search, todo, and intermediate reply tools.
 * - Uses mocked Prisma/chat/socket dependencies while exercising the registry.
 * - Future phases can extend this to task-state and verification-loop behavior.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  workspaceRoot: '',
  approvedTools: [] as string[],
  emittedEvents: [] as Array<{ room: string; event: string; payload: unknown }>,
  relayedMessages: [] as Array<Record<string, unknown>>,
  schedules: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/db/client.js', () => ({
  prisma: {
    agentTool: {
      findMany: vi.fn(async () => state.approvedTools.map((toolName) => ({
        agentId: 'agent-1',
        toolName,
        requiresApproval: false,
        approvedAt: new Date(),
      }))),
    },
    agentChannelMembership: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/modules/workspace/workspace.service.js', () => ({
  workspaceService: {
    getAgentWorkspaceDir: vi.fn(() => state.workspaceRoot),
  },
}));

vi.mock('@/modules/chat/chat.service.js', () => ({
  chatService: {
    createAgentRelayMessage: vi.fn(async (input: { channelId: string; senderId: string; content: string; contentType: string; metadata?: Record<string, unknown> | null }) => {
      const message = {
        id: `msg-${state.relayedMessages.length + 1}`,
        channelId: input.channelId,
        senderId: input.senderId,
        senderType: 'AGENT',
        senderName: 'Agent',
        content: input.content,
        contentType: input.contentType,
        metadata: input.metadata ?? null,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
      };
      state.relayedMessages.push(message);
      return message;
    }),
    triggerAgentsForMessage: vi.fn(async () => ({ selectedAgentIds: [], diagnostics: [] })),
  },
}));

vi.mock('@/sockets/socket-server.js', () => ({
  getChannelRoom: vi.fn((channelId: string) => `channel:${channelId}`),
  getChatNamespace: vi.fn(() => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        state.emittedEvents.push({ room, event, payload });
      },
    }),
  })),
}));

vi.mock('@/modules/agents/skill.service.js', () => ({
  skillService: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/modules/agents/skill-installer.service.js', () => ({
  skillInstallerService: {
    installFromUrl: vi.fn(),
  },
}));

vi.mock('@/modules/mcp/mcp.service.js', () => ({
  mcpService: {
    executeToolCall: vi.fn(),
  },
}));

vi.mock('../agents/agent-cron.service.js', () => ({
  agentCronService: {
    getManifestRelativePath: vi.fn(() => '.nextgenchat/schedules.json'),
    syncWorkspaceManifest: vi.fn(async () => undefined),
    listAgentSchedules: vi.fn(async () => state.schedules),
    createAgentSchedule: vi.fn(async (_agentId: string, input: { channelId: string; kind: 'ONCE' | 'CRON'; schedule: string; task: string; timezone?: string }) => {
      const record = {
        id: `schedule-${state.schedules.length + 1}`,
        agentId: 'agent-1',
        channelId: input.channelId,
        channelName: 'general',
        kind: input.kind,
        schedule: input.schedule,
        scheduleDescription: input.kind === 'ONCE' ? 'Once later' : 'Every 5 minutes',
        task: input.task,
        deliveryDescription: `Wake the agent in #general to do: ${input.task}`,
        timezone: input.timezone ?? 'UTC',
        status: 'ACTIVE',
        lastRunAt: null,
        nextRunAt: input.kind === 'ONCE' ? input.schedule : new Date('2026-04-08T12:00:00.000Z').toISOString(),
        createdAt: new Date('2026-04-08T10:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-04-08T10:00:00.000Z').toISOString(),
      };
      state.schedules.push(record);
      return record;
    }),
    deleteAgentSchedule: vi.fn(async (_agentId: string, scheduleId: string) => {
      state.schedules = state.schedules.filter((schedule) => schedule.id !== scheduleId);
    }),
    syncManifestChanges: vi.fn(async (_agentId: string, content: string) => {
      const parsed = JSON.parse(content) as { schedules: Array<{ id: string }> };
      const keepIds = new Set(parsed.schedules.map((schedule) => schedule.id));
      const deletedIds = state.schedules
        .map((schedule) => String(schedule.id))
        .filter((id) => !keepIds.has(id));
      state.schedules = state.schedules.filter((schedule) => keepIds.has(String(schedule.id)));
      return { updatedCount: 0, deletedCount: deletedIds.length, deletedIds };
    }),
    triggerDueSchedules: vi.fn(async () => undefined),
  },
}));

import { toolRegistryService } from './tool-registry.service.js';

describe('toolRegistryService', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'nextgenchat-tools-'));
    state.workspaceRoot = workspaceRoot;
    state.approvedTools = ['workspace_glob', 'workspace_grep', 'todowrite', 'todoread', 'send_reply'];
    state.emittedEvents = [];
    state.relayedMessages = [];
    state.schedules = [];

    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), ['export function greet() {', '  return "hello";', '}', ''].join('\n'), 'utf8');
    await writeFile(path.join(workspaceRoot, 'src', 'util.ts'), ['export const answer = 42;', '// TODO: add formatter', ''].join('\n'), 'utf8');
    await writeFile(path.join(workspaceRoot, 'docs', 'notes.md'), ['# Notes', 'workspace search works', ''].join('\n'), 'utf8');
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('finds files with workspace_glob', async () => {
    const result = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'workspace_glob',
      args: JSON.stringify({ pattern: '**/*.ts' }),
    });

    expect(result.output).toContain(path.join('src', 'app.ts'));
    expect(result.output).toContain(path.join('src', 'util.ts'));
  });

  it('searches file contents with workspace_grep', async () => {
    const result = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'workspace_grep',
      args: JSON.stringify({ pattern: 'TODO|greet', include: '*.ts' }),
    });

    expect(result.output).toContain(`${path.join('src', 'app.ts')}:1: export function greet()`);
    expect(result.output).toContain(`${path.join('src', 'util.ts')}:2: // TODO: add formatter`);
  });

  it('persists todo state across todowrite and todoread', async () => {
    await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'todowrite',
      args: JSON.stringify({
        todos: [
          { content: 'Inspect files', status: 'completed', priority: 'high' },
          { content: 'Run verification', status: 'in_progress', priority: 'medium' },
        ],
      }),
    });

    const result = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'todoread',
      args: '{}',
    });

    expect(JSON.parse(result.output)).toEqual([
      { content: 'Inspect files', status: 'completed', priority: 'high' },
      { content: 'Run verification', status: 'in_progress', priority: 'medium' },
    ]);
  });

  it('sends sanitized intermediate replies with send_reply', async () => {
    await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'send_reply',
      args: JSON.stringify({ content: '<message speaker="Agent">Checking the workspace now.</message>' }),
    });

    expect(state.relayedMessages).toHaveLength(1);
    expect(state.relayedMessages[0]?.content).toBe('Checking the workspace now.');
    expect(state.emittedEvents).toContainEqual(expect.objectContaining({
      room: 'channel:channel-1',
      event: 'message:new',
    }));
  });

  it('includes detailed guidance for newly approved tools', async () => {
    const summary = await toolRegistryService.summarizeApprovedTools('agent-1');

    expect(summary).toContain('### workspace_grep');
    expect(summary).toContain('### send_reply');
    expect(summary).toContain('Use `todoread` if you need to inspect the current task list before updating it.');
  });

  it('creates and deletes schedules with the scheduling tools', async () => {
    state.approvedTools = ['schedule_task', 'schedule_list', 'schedule_delete', 'workspace_write_file'];

    const created = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'schedule_task',
      args: JSON.stringify({
        task: 'Remind the user to review the draft',
        delayMinutes: 60,
      }),
    });

    expect(created.output).toContain('Scheduled task created: schedule-1');

    const listed = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'schedule_list',
      args: '{}',
    });

    expect(listed.output).toContain('schedule-1');
    expect(listed.output).toContain('Remind the user to review the draft');

    const deletedFromManifest = await toolRegistryService.executeToolCall({
      agentId: 'agent-1',
      agentSlug: 'agent-1',
      channelId: 'channel-1',
      toolName: 'workspace_write_file',
      args: JSON.stringify({
        filePath: '.nextgenchat/schedules.json',
        content: JSON.stringify({ schedules: [] }, null, 2),
      }),
    });

    expect(deletedFromManifest.output).toContain('Deleted 1 scheduled task');
    expect(state.schedules).toHaveLength(0);
  });
});
