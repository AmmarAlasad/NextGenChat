/**
 * Agent Task State Tests
 *
 * Verifies the task-mode heuristics and continuation decisions that drive the
 * multi-step execution loop.
 *
 * Phase 5 implementation status:
 * - Covers request classification, blocked detection, checklist continuation,
 *   and task-state prompt formatting.
 * - Future phases can add integration coverage for gateway loop behavior.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../workspace/workspace.service.js', () => ({
  workspaceService: {
    getAgentWorkspaceDir: () => '/tmp/unused',
  },
}));

import {
  buildTaskModeInstruction,
  evaluateTaskContinuation,
  evaluateTaskVerification,
  formatTaskStateContext,
  requestLikelyNeedsTaskMode,
  requestLikelyNeedsRuntimeVerification,
  requestLikelyResumesTask,
  responseLikelySignalsBlocked,
} from './task-state.js';

describe('task-state helpers', () => {
  it('detects non-trivial task requests', () => {
    expect(requestLikelyNeedsTaskMode('Please build a small Python project and verify it works.')).toBe(true);
    expect(requestLikelyNeedsTaskMode('Fix this bug in the code and keep going until it passes.')).toBe(true);
    expect(requestLikelyNeedsTaskMode('What does Redis do?')).toBe(false);
    expect(requestLikelyNeedsRuntimeVerification('Run the build and make sure it passes.')).toBe(true);
  });

  it('detects resume-style follow-ups', () => {
    expect(requestLikelyResumesTask('continue from where you stopped')).toBe(true);
    expect(requestLikelyResumesTask('what is the next step?')).toBe(true);
    expect(requestLikelyResumesTask('hello there')).toBe(false);
  });

  it('keeps working when no checklist exists yet', () => {
    const result = evaluateTaskContinuation({
      taskMode: true,
      finalContent: 'I created the first file.',
      state: {
        todos: [],
        totalTodos: 0,
        completedTodos: 0,
        incompleteTodos: [],
        hasInProgress: false,
      },
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.reminder).toContain('todowrite');
  });

  it('keeps working when checklist items remain incomplete', () => {
    const result = evaluateTaskContinuation({
      taskMode: true,
      finalContent: 'I made some progress.',
      state: {
        todos: [
          { content: 'Inspect files', status: 'completed', priority: 'high' },
          { content: 'Run the script', status: 'in_progress', priority: 'high' },
        ],
        totalTodos: 2,
        completedTodos: 1,
        incompleteTodos: [{ content: 'Run the script', status: 'in_progress', priority: 'high' }],
        hasInProgress: true,
      },
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reminder).toContain('Run the script');
  });

  it('allows a blocked response to stop cleanly', () => {
    expect(responseLikelySignalsBlocked('I cannot continue because I need credentials from you.')).toBe(true);

    const result = evaluateTaskContinuation({
      taskMode: true,
      finalContent: 'I cannot continue because I need credentials from you.',
      state: {
        todos: [{ content: 'Run migration', status: 'pending', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 0,
        incompleteTodos: [{ content: 'Run migration', status: 'pending', priority: 'high' }],
        hasInProgress: false,
      },
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it('formats persisted task context for future turns', () => {
    const text = formatTaskStateContext({
      todos: [
        { content: 'Inspect files', status: 'completed', priority: 'high' },
        { content: 'Verify output', status: 'pending', priority: 'medium' },
      ],
      totalTodos: 2,
      completedTodos: 1,
      incompleteTodos: [{ content: 'Verify output', status: 'pending', priority: 'medium' }],
      hasInProgress: false,
    });

    expect(buildTaskModeInstruction()).toContain('todowrite');
    expect(text).toContain('# task-state.md');
    expect(text).toContain('Verify output');
  });

  it('requires readback after file writes before finalizing', () => {
    const result = evaluateTaskVerification({
      taskMode: true,
      requestContent: 'Create a markdown file with the summary.',
      finalContent: 'I created the file.',
      state: {
        todos: [{ content: 'Write summary', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      toolCalls: [
        { toolName: 'workspace_write_file', success: true, structuredOutput: { filePath: 'summary.md' } },
      ],
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.status).toBe('needs_readback');
  });

  it('requires successful runtime verification for execution tasks', () => {
    const result = evaluateTaskVerification({
      taskMode: true,
      requestContent: 'Build the script and make sure it runs.',
      finalContent: 'I updated the files.',
      state: {
        todos: [{ content: 'Build project', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      toolCalls: [
        { toolName: 'workspace_write_file', success: true },
        { toolName: 'workspace_read_file', success: true },
      ],
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.status).toBe('needs_runtime_verification');
  });

  it('requires fixing failed commands before finalizing', () => {
    const result = evaluateTaskVerification({
      taskMode: true,
      requestContent: 'Fix the script and run it.',
      finalContent: 'I made the fix.',
      state: {
        todos: [{ content: 'Run script', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      toolCalls: [
        { toolName: 'workspace_bash', success: true, structuredOutput: { exitCode: 1, timedOut: false } },
      ],
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.status).toBe('command_failed');
  });

  it('accepts verified task completions', () => {
    const result = evaluateTaskVerification({
      taskMode: true,
      requestContent: 'Build the script and make sure it runs.',
      finalContent: 'Everything is done.',
      state: {
        todos: [{ content: 'Build project', status: 'completed', priority: 'high' }],
        totalTodos: 1,
        completedTodos: 1,
        incompleteTodos: [],
        hasInProgress: false,
      },
      toolCalls: [
        { toolName: 'workspace_write_file', success: true },
        { toolName: 'workspace_read_file', success: true },
        { toolName: 'workspace_bash', success: true, structuredOutput: { exitCode: 0, timedOut: false } },
      ],
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.status).toBe('verified');
  });
});
