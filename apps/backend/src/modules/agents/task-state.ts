/**
 * Agent Task State Helpers
 *
 * Centralizes todo-backed task-state parsing, prompt context formatting, and
 * runtime continuation rules for multi-step agent work.
 *
 * Phase 5 implementation status:
 * - Reads persisted todo state from the agent workspace.
 * - Classifies likely task-mode requests and evaluates whether a turn should continue.
 * - Future phases will add richer verification policies and database-backed task sessions.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { workspaceService } from '../workspace/workspace.service.js';

export const TODO_STATE_RELATIVE_PATH = '.nextgenchat/todo-state.json';

export type TaskTodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
};

export type PersistedTaskState = {
  todos: TaskTodoItem[];
  totalTodos: number;
  completedTodos: number;
  incompleteTodos: TaskTodoItem[];
  hasInProgress: boolean;
};

export type TaskContinuationDecision = {
  shouldContinue: boolean;
  blocked: boolean;
  reminder?: string;
};

export type TaskVerificationDecision = {
  shouldContinue: boolean;
  blocked: boolean;
  status: 'not_needed' | 'needs_checklist' | 'needs_readback' | 'needs_runtime_verification' | 'command_failed' | 'verified';
  reminder?: string;
};

export type TaskToolExecutionSummary = {
  toolName: string;
  success: boolean;
  durationMs?: number;
  arguments?: unknown;
  output?: string;
  structuredOutput?: Record<string, unknown>;
  outputPreview?: string;
};

const TOOL_READ = 'workspace_read_file';
const TOOL_WRITE = 'workspace_write_file';
const TOOL_BASH = 'workspace_bash';

function isTaskTodoItem(value: unknown): value is TaskTodoItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.content === 'string'
    && ['pending', 'in_progress', 'completed', 'cancelled'].includes(String(record.status))
    && ['high', 'medium', 'low'].includes(String(record.priority));
}

function summarizeTodos(todos: TaskTodoItem[]): PersistedTaskState {
  const incompleteTodos = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress');
  const completedTodos = todos.filter((todo) => todo.status === 'completed').length;

  return {
    todos,
    totalTodos: todos.length,
    completedTodos,
    incompleteTodos,
    hasInProgress: todos.some((todo) => todo.status === 'in_progress'),
  };
}

export function requestLikelyNeedsTaskMode(content: string) {
  const normalized = content.toLowerCase();

  return /(checklist|todo list|todo|plan|steps|step-by-step|phase|milestone|progress|resume|continue|next step)/.test(normalized)
    || /(build|implement|fix|debug|investigate|trace|refactor|migrate|set up|setup|install|configure|repair|audit|review|create).*(project|app|application|script|workflow|integration|feature|bug|issue|error|file|files|code)/.test(normalized)
    || /(project|app|application|script|workflow|integration|feature|bug|issue|error|file|files|code).*(build|implement|fix|debug|investigate|trace|refactor|migrate|set up|setup|install|configure|repair|audit|review|create)/.test(normalized);
}

export function requestLikelyResumesTask(content: string) {
  return /(continue|resume|pick up|status|progress|what's left|what is left|next step|finish it|keep going)/i.test(content);
}

export function responseLikelySignalsBlocked(content: string) {
  const normalized = content.toLowerCase();

  return /(blocked|cannot continue|can't continue|need more information|need more info|missing information|missing details|missing permission|missing access|waiting on|need your input|need your confirmation|need credentials|need permission)/.test(normalized);
}

export function requestLikelyNeedsRuntimeVerification(content: string) {
  const normalized = content.toLowerCase();

  return /(run|build|test|verify|verification|debug|fix|repair|install|launch|start|execute|working|works|passing|pass)/.test(normalized);
}

function getBashOutcome(summary: TaskToolExecutionSummary) {
  const structured = summary.structuredOutput ?? {};
  const exitCode = typeof structured.exitCode === 'number' ? structured.exitCode : null;
  const timedOut = structured.timedOut === true;

  return {
    exitCode,
    timedOut,
    succeeded: summary.success && exitCode === 0 && !timedOut,
    failed: !summary.success || timedOut || (typeof exitCode === 'number' && exitCode !== 0),
  };
}

export function buildTaskModeInstruction() {
  return [
    'This request looks like non-trivial multi-step work. Treat it as a task, not a one-shot answer.',
    'Follow this loop: inspect, plan, execute, verify, then report.',
    'Use `workspace_glob`, `workspace_grep`, and `workspace_read_file` to inspect before changing things when you need context.',
    'Use `todowrite` early to create or update a checklist for the work.',
    'Use `send_reply` for short, useful progress updates if the task will take multiple steps.',
    'After changing files or running commands, verify the result. If verification fails, fix it and try again before giving the final answer.',
    'Do not give the final answer while checklist items remain incomplete unless you are clearly blocked and explain the blocker.',
  ].join(' ');
}

export function evaluateTaskContinuation(input: {
  taskMode: boolean;
  state: PersistedTaskState;
  finalContent: string;
}) : TaskContinuationDecision {
  if (!input.taskMode) {
    return { shouldContinue: false, blocked: false };
  }

  if (input.state.totalTodos === 0) {
    return {
      shouldContinue: true,
      blocked: false,
      reminder: 'This is a multi-step task. Before finalizing, create or update a checklist with `todowrite`, then continue the work. Only give the final answer when the task is complete or you are clearly blocked.',
    };
  }

  if (input.state.incompleteTodos.length === 0) {
    return { shouldContinue: false, blocked: false };
  }

  if (responseLikelySignalsBlocked(input.finalContent)) {
    return { shouldContinue: false, blocked: true };
  }

  return {
    shouldContinue: true,
    blocked: false,
    reminder: `This task is not finished yet. Incomplete checklist items remain: ${input.state.incompleteTodos.map((todo) => todo.content).join('; ')}. Continue working, update the checklist, and only give the final answer when the remaining steps are done or you are clearly blocked.`,
  };
}

export function evaluateTaskVerification(input: {
  taskMode: boolean;
  requestContent: string;
  state: PersistedTaskState;
  toolCalls: TaskToolExecutionSummary[];
  finalContent: string;
}) : TaskVerificationDecision {
  if (!input.taskMode) {
    return { shouldContinue: false, blocked: false, status: 'not_needed' };
  }

  if (responseLikelySignalsBlocked(input.finalContent)) {
    return { shouldContinue: false, blocked: true, status: 'not_needed' };
  }

  if (input.state.totalTodos === 0) {
    return {
      shouldContinue: true,
      blocked: false,
      status: 'needs_checklist',
      reminder: 'Before you finish this task, create or update a checklist with `todowrite`, then continue the work.',
    };
  }

  const lastBash = [...input.toolCalls].reverse().find((toolCall) => toolCall.toolName === TOOL_BASH);
  if (lastBash && getBashOutcome(lastBash).failed) {
    return {
      shouldContinue: true,
      blocked: false,
      status: 'command_failed',
      reminder: 'A shell command failed or timed out. Inspect the output, fix the problem, and run another verification command before giving the final answer.',
    };
  }

  const lastWriteIndex = [...input.toolCalls].map((toolCall, index) => ({ toolCall, index }))
    .filter(({ toolCall }) => toolCall.toolName === TOOL_WRITE && toolCall.success)
    .map(({ index }) => index)
    .pop() ?? -1;

  const hasReadbackAfterWrite = lastWriteIndex >= 0 && input.toolCalls.slice(lastWriteIndex + 1)
    .some((toolCall) => toolCall.success && toolCall.toolName === TOOL_READ);
  const hasSuccessfulBashAfterWrite = lastWriteIndex >= 0 && input.toolCalls.slice(lastWriteIndex + 1)
    .some((toolCall) => toolCall.toolName === TOOL_BASH && getBashOutcome(toolCall).succeeded);

  if (lastWriteIndex >= 0 && !hasReadbackAfterWrite && !hasSuccessfulBashAfterWrite) {
    return {
      shouldContinue: true,
      blocked: false,
      status: 'needs_readback',
      reminder: 'You changed files in this task but have not verified the result yet. Read the changed file back or run a command that verifies the change before giving the final answer.',
    };
  }

  if (requestLikelyNeedsRuntimeVerification(input.requestContent)) {
    const hasSuccessfulVerificationCommand = input.toolCalls
      .some((toolCall) => toolCall.toolName === TOOL_BASH && getBashOutcome(toolCall).succeeded);

    if (!hasSuccessfulVerificationCommand) {
      return {
        shouldContinue: true,
        blocked: false,
        status: 'needs_runtime_verification',
        reminder: 'This task likely needs execution or command verification. Run an appropriate command with `workspace_bash`, inspect the result, and continue fixing if it fails.',
      };
    }
  }

  return {
    shouldContinue: false,
    blocked: false,
    status: 'verified',
  };
}

export function formatTaskStateContext(state: PersistedTaskState) {
  if (state.totalTodos === 0) {
    return null;
  }

  const lines = [
    '# task-state.md',
    '',
    'Persisted checklist from previous work in this workspace:',
    ...state.todos.map((todo) => `- [${todo.status === 'completed' ? 'x' : todo.status === 'cancelled' ? '-' : ' '}] (${todo.priority}) ${todo.content}`),
  ];

  if (state.incompleteTodos.length > 0) {
    lines.push('', `Incomplete items: ${state.incompleteTodos.map((todo) => todo.content).join('; ')}`);
  }

  return lines.join('\n');
}

export async function readPersistedTaskState(agentId: string): Promise<PersistedTaskState> {
  const workspaceRoot = workspaceService.getAgentWorkspaceDir(agentId);
  const filePath = path.resolve(workspaceRoot, TODO_STATE_RELATIVE_PATH);

  try {
    await access(filePath);
  } catch {
    return summarizeTodos([]);
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const todos = Array.isArray(parsed) ? parsed.filter(isTaskTodoItem) : [];
    return summarizeTodos(todos);
  } catch {
    return summarizeTodos([]);
  }
}
