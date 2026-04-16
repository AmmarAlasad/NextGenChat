/**
 * Agent Session Gateway Scenario Tests
 *
 * Exercises the task-mode execution loop at the gateway boundary so multi-step
 * continuation, verification, and retry behavior are validated end-to-end.
 *
 * Phase 6 implementation status:
 * - Covers checklist continuation, failed-command retry, and write-readback verification.
 * - Uses mocked provider, tool registry, Prisma, and socket dependencies.
 * - Future phases can add richer route/socket integration and browser-level checks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockTaskState = {
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority: 'high' | 'medium' | 'low' }>;
  totalTodos: number;
  completedTodos: number;
  incompleteTodos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority: 'high' | 'medium' | 'low' }>;
  hasInProgress: boolean;
};

type MockToolSummary = {
  toolName: string;
  success: boolean;
  structuredOutput?: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  triggerContent: 'build a project and verify it works',
  providerResponses: [] as Array<Record<string, unknown>>,
  toolExecutionQueue: [] as Array<{ output: string; structuredOutput: Record<string, unknown> }>,
  toolExecutionCalls: [] as Array<{ toolName: string; args: string }>,
  createdMessages: [] as Array<Record<string, unknown>>,
  emittedEvents: [] as Array<{ room: string; event: string; payload: unknown }>,
  readTaskStates: [] as MockTaskState[],
  continuationDecisions: [] as Array<{ shouldContinue: boolean; blocked: boolean; reminder?: string }>,
  verificationDecisions: [] as Array<{ shouldContinue: boolean; blocked: boolean; status: string; reminder?: string }>,
}));

function emptyTaskState(): MockTaskState {
  return {
    todos: [],
    totalTodos: 0,
    completedTodos: 0,
    incompleteTodos: [],
    hasInProgress: false,
  };
}

function lastBashFailed(toolCalls: MockToolSummary[]) {
  const lastBash = [...toolCalls].reverse().find((toolCall) => toolCall.toolName === 'workspace_bash');
  if (!lastBash) {
    return false;
  }

  const exitCode = typeof lastBash.structuredOutput?.exitCode === 'number' ? lastBash.structuredOutput.exitCode : 0;
  return !lastBash.success || exitCode !== 0 || lastBash.structuredOutput?.timedOut === true;
}

function hasReadAfterWrite(toolCalls: MockToolSummary[]) {
  const lastWriteIndex = toolCalls.map((toolCall) => toolCall.toolName).lastIndexOf('workspace_write_file');
  if (lastWriteIndex === -1) {
    return true;
  }

  return toolCalls.slice(lastWriteIndex + 1).some((toolCall) => toolCall.toolName === 'workspace_read_file' && toolCall.success);
}

function hasSuccessfulBash(toolCalls: MockToolSummary[]) {
  return toolCalls.some((toolCall) => toolCall.toolName === 'workspace_bash' && toolCall.success && toolCall.structuredOutput?.exitCode === 0);
}

function defaultContinuationDecision(input: { taskMode: boolean; state: MockTaskState; finalContent: string }) {
  if (!input.taskMode) {
    return { shouldContinue: false, blocked: false };
  }
  if (/need credentials|blocked|cannot continue/i.test(input.finalContent)) {
    return { shouldContinue: false, blocked: true };
  }
  if (input.state.totalTodos === 0 || input.state.incompleteTodos.length > 0) {
    return { shouldContinue: true, blocked: false, reminder: 'continue-task' };
  }
  return { shouldContinue: false, blocked: false };
}

function defaultVerificationDecision(input: { taskMode: boolean; requestContent: string; toolCalls: MockToolSummary[]; finalContent: string; state: MockTaskState }) {
  if (!input.taskMode || /need credentials|blocked|cannot continue/i.test(input.finalContent)) {
    return { shouldContinue: false, blocked: false, status: 'not_needed' };
  }
  if (input.state.totalTodos === 0) {
    return { shouldContinue: true, blocked: false, status: 'needs_checklist', reminder: 'create-checklist' };
  }
  if (lastBashFailed(input.toolCalls)) {
    return { shouldContinue: true, blocked: false, status: 'command_failed', reminder: 'retry-command' };
  }
  if (!hasReadAfterWrite(input.toolCalls)) {
    return { shouldContinue: true, blocked: false, status: 'needs_readback', reminder: 'verify-write' };
  }
  if (/(build|run|test|verify|fix)/i.test(input.requestContent) && !hasSuccessfulBash(input.toolCalls)) {
    return { shouldContinue: true, blocked: false, status: 'needs_runtime_verification', reminder: 'run-verification' };
  }
  return { shouldContinue: false, blocked: false, status: 'verified' };
}

vi.mock('@/db/client.js', () => ({
  prisma: {
    message: {
      findUnique: vi.fn(async () => ({ content: state.triggerContent, createdAt: new Date() })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const message = {
          id: `message-${state.createdMessages.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.createdMessages.push(message);
        return message;
      }),
    },
    agent: {
      findUnique: vi.fn(async () => ({ name: 'Builder Agent' })),
    },
    agentToolCall: {
      create: vi.fn(async () => null),
    },
    channel: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/modules/agents/agent-output.js', () => ({
  NO_REPLY_TOKEN: '__NO_REPLY__',
  sanitizeAgentVisibleContent: (text: string) => text,
}));

vi.mock('@/modules/agents/default-agent-tools.js', () => ({
  ensureDefaultAgentTools: vi.fn(async () => undefined),
}));

vi.mock('@/modules/chat/chat.service.js', () => ({
  serializeMessage: (message: Record<string, unknown>) => message,
  chatService: {
    triggerAgentsForMessage: vi.fn(async () => ({ selectedAgentIds: [], diagnostics: [] })),
    createAgentRelayMessage: vi.fn(async () => ({ id: 'relay-message' })),
  },
}));

vi.mock('@/modules/context/context-builder.js', () => ({
  contextBuilder: {
    build: vi.fn(async () => ({
      messages: [{ role: 'system', content: 'context' }],
      totalTokens: 10,
      budgetUsed: 10,
      budgetLimit: 1000,
      compactionTriggered: false,
      summaryUsed: false,
      staticPrefixKey: 'prefix-key',
      staticPrefixCacheHit: false,
    })),
  },
}));

vi.mock('@/config/env.js', () => ({
  env: {
    agentMaxToolRounds: 8,
  },
}));

vi.mock('@/modules/gateway/session-lane.js', () => ({
  sessionLaneRegistry: {
    getLane: () => ({
      enqueue: async <T>(task: () => Promise<T>) => task(),
    }),
    registerActiveTurn: vi.fn(() => undefined),
    getActiveTurn: vi.fn(() => null),
    clearActiveTurn: vi.fn(() => undefined),
    cancelActiveTurn: vi.fn(() => null),
    appendTurnText: vi.fn(() => undefined),
    updateToolCall: vi.fn(() => undefined),
    updateTodos: vi.fn(() => undefined),
    markChannelError: vi.fn(() => undefined),
    getLiveState: vi.fn(() => ({ channelId: 'channel-1', agentState: 'idle', turns: [], todos: [] })),
  },
}));

vi.mock('@/modules/providers/registry.js', () => ({
  providerRegistry: {
    get: vi.fn(async () => ({
      name: 'openai',
      model: 'gpt-5.4',
      stream: vi.fn(async function* () {
        const next = state.providerResponses.shift();
        if (!next) {
          throw new Error('No more provider responses queued.');
        }

        if (typeof next.content === 'string' && next.content.length > 0) {
          yield { delta: next.content };
        }

        yield {
          delta: '',
          toolCalls: next.toolCalls as Array<{ id: string; name: string; arguments: string }> | undefined,
          finishReason: next.finishReason as 'stop' | 'tool_calls' | 'length' | 'error',
          responseId: next.id as string,
          usage: next.usage as { promptTokens: number; completionTokens: number; totalTokens: number },
        };
      }),
      complete: vi.fn(async () => {
        const next = state.providerResponses.shift();
        if (!next) {
          throw new Error('No more provider responses queued.');
        }
        return next;
      }),
    })),
  },
}));

vi.mock('@/modules/tools/tool-registry.service.js', () => ({
  toolRegistryService: {
    getProviderTools: vi.fn(async () => []),
    executeToolCall: vi.fn(async ({ toolName, args }: { toolName: string; args: string }) => {
      state.toolExecutionCalls.push({ toolName, args });
      const next = state.toolExecutionQueue.shift();
      if (!next) {
        throw new Error(`No queued tool result for ${toolName}.`);
      }
      return next;
    }),
  },
}));

vi.mock('@/sockets/socket-server.js', () => ({
  getChannelRoom: (channelId: string) => `channel:${channelId}`,
  getChatNamespace: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        state.emittedEvents.push({ room, event, payload });
      },
    }),
  }),
}));

vi.mock('@/modules/agents/task-state.js', () => ({
  buildTaskModeInstruction: () => 'task-mode-instruction',
  requestLikelyNeedsTaskMode: (content: string) => /(build|fix|verify|run|task)/i.test(content),
  requestLikelyResumesTask: (content: string) => /continue|resume/i.test(content),
  readPersistedTaskState: vi.fn(async () => state.readTaskStates.shift() ?? emptyTaskState()),
  evaluateTaskContinuation: vi.fn((input: { taskMode: boolean; state: MockTaskState; finalContent: string }) => {
    return state.continuationDecisions.shift() ?? defaultContinuationDecision(input);
  }),
  evaluateTaskVerification: vi.fn((input: { taskMode: boolean; requestContent: string; toolCalls: MockToolSummary[]; finalContent: string; state: MockTaskState }) => {
    return state.verificationDecisions.shift() ?? defaultVerificationDecision(input);
  }),
}));

import { agentSessionGateway } from './agent-session.gateway.js';

describe('agentSessionGateway task-mode scenarios', () => {
  beforeEach(() => {
    state.triggerContent = 'build a project and verify it works';
    state.providerResponses = [];
    state.toolExecutionQueue = [];
    state.toolExecutionCalls = [];
    state.createdMessages = [];
    state.emittedEvents = [];
    state.readTaskStates = [];
    state.continuationDecisions = [];
    state.verificationDecisions = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('continues when checklist items remain incomplete before accepting final output', async () => {
    state.triggerContent = 'continue task until it is complete';
    state.providerResponses = [
      {
        id: 'resp-1',
        content: 'I am done already.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-2',
        content: 'The build is now complete and verified.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];

    state.readTaskStates = [
      {
        todos: [{ content: 'Build project', status: 'in_progress', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 0,
        incompleteTodos: [{ content: 'Build project', status: 'in_progress', priority: 'high' }],
        hasInProgress: true,
      },
      {
        todos: [{ content: 'Build project', status: 'in_progress', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 0,
        incompleteTodos: [{ content: 'Build project', status: 'in_progress', priority: 'high' }],
        hasInProgress: true,
      },
      {
        todos: [{ content: 'Build project', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
    ];
    state.continuationDecisions = [
      { shouldContinue: true, blocked: false, reminder: 'continue-task' },
      { shouldContinue: false, blocked: false },
    ];
    state.verificationDecisions = [
      { shouldContinue: false, blocked: false, status: 'verified' },
    ];

    await agentSessionGateway.runAgentTurn('agent-1', 'channel-1', 'message-1');

    expect(state.createdMessages).toHaveLength(1);
    const finalMessage = state.createdMessages[0];
    expect(finalMessage?.content).toBe('The build is now complete and verified.');
    expect((finalMessage?.metadata as Record<string, unknown>)?.task).toEqual(expect.objectContaining({
      mode: 'multi_step',
      continuedRounds: 1,
      verificationStatus: 'verified',
      completedTodos: 1,
    }));
  });

  it('retries after a failed verification command before finalizing', async () => {
    state.triggerContent = 'fix the script and run it until it works';
    state.providerResponses = [
      {
        id: 'resp-1',
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc-1', name: 'workspace_bash', arguments: JSON.stringify({ command: 'node script.js' }) }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-2',
        content: 'The fix is complete.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-3',
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc-2', name: 'workspace_bash', arguments: JSON.stringify({ command: 'node script.js' }) }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-4',
        content: 'The script now runs successfully.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];

    state.toolExecutionQueue = [
      {
        output: 'script failed',
        structuredOutput: { exitCode: 1, timedOut: false },
      },
      {
        output: 'script ok',
        structuredOutput: { exitCode: 0, timedOut: false },
      },
    ];

    state.readTaskStates = [
      {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
    ];
    state.continuationDecisions = [
      { shouldContinue: false, blocked: false },
      { shouldContinue: false, blocked: false },
    ];
    state.verificationDecisions = [
      { shouldContinue: true, blocked: false, status: 'command_failed', reminder: 'retry-command' },
      { shouldContinue: false, blocked: false, status: 'verified' },
    ];

    await agentSessionGateway.runAgentTurn('agent-1', 'channel-1', 'message-1');

    expect(state.toolExecutionCalls.map((call) => call.toolName)).toEqual(['workspace_bash', 'workspace_bash']);
    const finalMessage = state.createdMessages[0];
    expect(finalMessage?.content).toBe('The script now runs successfully.');
    expect((finalMessage?.metadata as Record<string, unknown>)?.task).toEqual(expect.objectContaining({
      mode: 'multi_step',
      continuedRounds: 1,
      verificationStatus: 'verified',
    }));
  });

  it('requires a readback after file writes before finalizing', async () => {
    state.triggerContent = 'create a summary file as a multi-step task';
    state.providerResponses = [
      {
        id: 'resp-1',
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc-1', name: 'workspace_write_file', arguments: JSON.stringify({ filePath: 'summary.md', content: '# Summary' }) }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-2',
        content: 'I created the summary file.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-3',
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc-2', name: 'workspace_read_file', arguments: JSON.stringify({ filePath: 'summary.md' }) }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'resp-4',
        content: 'The summary file is created and verified.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];

    state.toolExecutionQueue = [
      {
        output: 'wrote summary.md',
        structuredOutput: { filePath: 'summary.md' },
      },
      {
        output: '<path>summary.md</path>\n<type>file</type>',
        structuredOutput: { filePath: 'summary.md', type: 'file' },
      },
    ];

    state.readTaskStates = [
      {
        todos: [{ content: 'Create summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Create summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Create summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Create summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      {
        todos: [{ content: 'Create summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
    ];
    state.continuationDecisions = [
      { shouldContinue: false, blocked: false },
      { shouldContinue: false, blocked: false },
    ];
    state.verificationDecisions = [
      { shouldContinue: true, blocked: false, status: 'needs_readback', reminder: 'verify-write' },
      { shouldContinue: false, blocked: false, status: 'verified' },
    ];

    await agentSessionGateway.runAgentTurn('agent-1', 'channel-1', 'message-1');

    expect(state.toolExecutionCalls.map((call) => call.toolName)).toEqual(['workspace_write_file', 'workspace_read_file']);
    const finalMessage = state.createdMessages[0];
    expect(finalMessage?.content).toBe('The summary file is created and verified.');
    expect((finalMessage?.metadata as Record<string, unknown>)?.task).toEqual(expect.objectContaining({
      mode: 'multi_step',
      continuedRounds: 1,
      verificationStatus: 'verified',
    }));
  });
});
