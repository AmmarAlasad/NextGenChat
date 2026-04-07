/**
 * Agent Session Gateway
 *
 * Owns the complete lifecycle of an agent turn: session serialization, context
 * building, the LLM tool loop, real-token streaming to the socket, message
 * persistence, relay execution, and cascading agent triggers.
 *
 * All logic previously in agent.processor.ts#processAgentJob lives here.
 * The processor is now a thin shell that calls runAgentTurn().
 *
 * Inspired by OpenClaw's lane-based concurrency and event-bus patterns:
 *   - SessionLane ensures at most one active turn per agentId:channelId.
 *   - Real SSE streaming via provider.stream() replaces 40-char fake chunks.
 *   - agent:tool:start / agent:tool:end events let the frontend show activity.
 *
 * Phase 4 implementation status:
 * - Session lanes: serial execution per agentId:channelId.
 * - Real OpenAI streaming for final text rounds; non-streaming for tool rounds.
 * - Tool activity socket events emitted during tool loop.
 * - Static prefix caching via ContextBuilder (transparent — no gateway changes needed).
 * - Future phases: per-provider streaming, heartbeat events, retry budgets.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '@/db/client.js';
import { NO_REPLY_TOKEN, sanitizeAgentVisibleContent } from '@/modules/agents/agent-output.js';
import {
  buildTaskModeInstruction,
  evaluateTaskContinuation,
  evaluateTaskVerification,
  readPersistedTaskState,
  requestLikelyNeedsTaskMode,
  requestLikelyResumesTask,
  type TaskToolExecutionSummary,
  type TaskVerificationDecision,
} from '@/modules/agents/task-state.js';
import { ensureDefaultAgentTools } from '@/modules/agents/default-agent-tools.js';
import { chatService, serializeMessage } from '@/modules/chat/chat.service.js';
import { contextBuilder } from '@/modules/context/context-builder.js';
import { sessionLaneRegistry } from '@/modules/gateway/session-lane.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { toolRegistryService } from '@/modules/tools/tool-registry.service.js';
import { getChannelRoom, getChatNamespace } from '@/sockets/socket-server.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WRITE_TOOL_NAME = 'workspace_write_file';
const BASH_TOOL_NAME = 'workspace_bash';
const SEND_CHANNEL_MESSAGE_TOOL_NAME = 'channel_send_message';
const TODO_WRITE_TOOL_NAME = 'todowrite';
const SEND_REPLY_TOOL_NAME = 'send_reply';
const MAX_REQUIRED_TOOL_RETRIES = 8;

const RELAY_TAG_RE = /<<send:([^>]+)>>([\s\S]*?)<<\/send>>/gi;

// Strip the conversation-wrapper XML the context builder injects around colleague/user
// messages to prevent the LLM from echoing the format in its own replies.
const MESSAGE_WRAPPER_RE = /^<message\b[^>]*>\s*/i;
const MESSAGE_WRAPPER_CLOSE_RE = /\s*<\/message>\s*$/i;

// ── Pure helpers (moved verbatim from agent.processor.ts) ────────────────────

interface RelayCommand {
  channelName: string;
  content: string;
}

function safeParseToolArguments(raw: string) {
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { rawArguments: raw };
  }
}

function stripMessageWrapper(text: string): string {
  return text.replace(MESSAGE_WRAPPER_RE, '').replace(MESSAGE_WRAPPER_CLOSE_RE, '').trim();
}

function requestLikelyNeedsWriteTool(content: string) {
  const normalized = content.toLowerCase();
  return /(create|write|save|update|edit|modify|rename|delete).*(file|md|markdown|txt|json|ts|tsx|js|jsx|css|html)/.test(normalized)
    || /(file|md|markdown|txt|json|ts|tsx|js|jsx|css|html).*(create|write|save|update|edit|modify|rename|delete)/.test(normalized);
}

function requestLikelyNeedsBashTool(content: string) {
  const normalized = content.toLowerCase();
  return /(bash|shell|terminal|pwd|working directory|current path|run command|execute command|list files|\bls\b)/.test(normalized);
}

function getForcedToolChoice(input: {
  writeToolRequired: boolean;
  bashToolRequired: boolean;
  successfulWriteToolCalls: number;
  successfulBashToolCalls: number;
}) {
  if (input.bashToolRequired && input.successfulBashToolCalls === 0) {
    return { type: 'function' as const, name: BASH_TOOL_NAME };
  }

  if (input.writeToolRequired && input.successfulWriteToolCalls === 0) {
    return { type: 'function' as const, name: WRITE_TOOL_NAME };
  }

  return undefined;
}

function buildToolFallbackContent(toolCalls: Array<Record<string, unknown>>) {
  const successful = toolCalls.filter((tc) => tc.success === true);

  if (successful.length === 0) return null;

  const last = successful[successful.length - 1];
  const toolName = typeof last.toolName === 'string' ? last.toolName : 'tool';
  const structured = typeof last.structuredOutput === 'object' && last.structuredOutput !== null
    ? (last.structuredOutput as Record<string, unknown>)
    : {};

  if (toolName === WRITE_TOOL_NAME) {
    const filePath = typeof structured.filePath === 'string' ? structured.filePath : 'the requested file';
    return `I created the file in my workspace: ${filePath}.`;
  }

  if (toolName === BASH_TOOL_NAME) {
    const output = typeof last.output === 'string' ? last.output.trim() : 'The command completed successfully.';
    return output || 'The command completed successfully.';
  }

  if (toolName === SEND_CHANNEL_MESSAGE_TOOL_NAME) {
    const channelName = typeof structured.channelName === 'string' ? structured.channelName : 'the requested channel';
    return `I sent the message to #${channelName}.`;
  }

  return typeof last.output === 'string' && last.output.trim() ? last.output.trim() : 'The requested tool action completed successfully.';
}

function extractRelayCommands(text: string): { commands: RelayCommand[]; cleanedContent: string } {
  const commands: RelayCommand[] = [];
  const cleanedContent = text.replace(RELAY_TAG_RE, (_match, channelName: string, content: string) => {
    const trimmedContent = content.trim();
    if (trimmedContent) {
      commands.push({ channelName: channelName.trim().toLowerCase(), content: trimmedContent });
    }
    return '';
  }).trim();

  return { commands, cleanedContent };
}

async function executeRelayCommands(commands: RelayCommand[], agentId: string): Promise<void> {
  if (commands.length === 0) return;

  for (const cmd of commands) {
    try {
      const candidates = await prisma.channel.findMany({
        where: {
          agentMemberships: { some: { agentId } },
          type: { not: 'DIRECT' },
        },
        select: { id: true, name: true },
      });

      const target = candidates.find((ch) => ch.name.toLowerCase() === cmd.channelName.toLowerCase());

      if (!target) {
        console.warn(`[gateway] Agent ${agentId} tried to relay to unknown channel "${cmd.channelName}" (available: ${candidates.map((c) => c.name).join(', ')})`);
        continue;
      }

      const relayMsg = await chatService.createAgentRelayMessage({
        channelId: target.id,
        senderId: agentId,
        content: cmd.content,
        contentType: 'TEXT',
      });

      getChatNamespace().to(getChannelRoom(target.id)).emit('message:new', relayMsg);
    } catch (relayError) {
      console.error(`[gateway] Failed to relay to channel "${cmd.channelName}":`, relayError);
    }
  }
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export class AgentSessionGateway {
  /**
   * Entry point called by agent.processor.ts (BullMQ worker) and local queue.
   * Enqueues the turn on the agent's session lane to ensure serial execution
   * per agentId:channelId.
   */
  async runAgentTurn(agentId: string, channelId: string, messageId: string): Promise<void> {
    const lane = sessionLaneRegistry.getLane(agentId, channelId);
    await lane.enqueue(() => this.executeTurn(agentId, channelId, messageId));
  }

  /**
   * Core turn execution. Runs inside the session lane (serial, no concurrency
   * for the same agent+channel pair).
   */
  private async executeTurn(agentId: string, channelId: string, messageId: string): Promise<void> {
    const tempId = randomUUID();
    const chatNamespace = getChatNamespace();

    try {
      await ensureDefaultAgentTools(agentId);

      const triggeringMessage = await prisma.message.findUnique({
        where: { id: messageId },
        select: { content: true, createdAt: true },
      });

      // Reject stale jobs — e.g. Redis retries for messages from a previous session.
      // A job whose triggering message is older than 5 minutes is discarded silently.
      const MESSAGE_AGE_LIMIT_MS = 5 * 60 * 1_000;
      if (triggeringMessage && Date.now() - triggeringMessage.createdAt.getTime() > MESSAGE_AGE_LIMIT_MS) {
        console.warn(`[gateway] Discarding stale job for agent ${agentId}: message ${messageId} is too old.`);
        return;
      }

      const provider = await providerRegistry.get(agentId);
      const context = await contextBuilder.build(agentId, channelId, messageId);
      const providerTools = await toolRegistryService.getProviderTools(agentId);
      const messages = [...context.messages];
      const toolExecutionSummaries: TaskToolExecutionSummary[] = [];
      const triggerContent = triggeringMessage?.content ?? '';
      const initialTaskState = await readPersistedTaskState(agentId);

      const writeToolRequired = requestLikelyNeedsWriteTool(triggerContent);
      const bashToolRequired = requestLikelyNeedsBashTool(triggerContent);
      let taskMode = requestLikelyNeedsTaskMode(triggerContent)
        || (initialTaskState.totalTodos > 0 && requestLikelyResumesTask(triggerContent));
      const taskModeReason = taskMode
        ? (initialTaskState.totalTodos > 0 && requestLikelyResumesTask(triggerContent) ? 'resume-existing-task' : 'heuristic')
        : 'none';
      const maxToolRounds = (await import('@/config/env.js')).env.agentMaxToolRounds;

      let successfulWriteToolCalls = 0;
      let successfulBashToolCalls = 0;
      let requiredToolRetryCount = 0;
      let taskState = initialTaskState;
      let continuedTaskRounds = 0;
      let taskBlocked = false;
      let verificationDecision: TaskVerificationDecision = {
        shouldContinue: false,
        blocked: false,
        status: 'not_needed',
      };
      let finalResponse:
        | { id: string; content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }; providerMetadata?: Record<string, unknown> }
        | undefined;

      if (taskMode) {
        messages.push({ role: 'system', content: buildTaskModeInstruction() });
      }

      // ── Tool loop (non-streaming) ──────────────────────────────────────────
      for (let round = 0; maxToolRounds === 0 || round < maxToolRounds; round += 1) {
        const forcedToolChoice = getForcedToolChoice({
          writeToolRequired,
          bashToolRequired,
          successfulWriteToolCalls,
          successfulBashToolCalls,
        });

        const response = await provider.complete({
          messages,
          tools: providerTools,
          toolChoice: forcedToolChoice,
          maxTokens: 1024,
          temperature: 0.4,
        });

        if (response.finishReason !== 'tool_calls' || !response.toolCalls || response.toolCalls.length === 0) {
          if (writeToolRequired && successfulWriteToolCalls === 0) {
            requiredToolRetryCount += 1;
            if (requiredToolRetryCount >= MAX_REQUIRED_TOOL_RETRIES) {
              throw new Error('Agent failed to use workspace_write_file after repeated retries.');
            }
            messages.push({ role: 'system', content: 'The user asked for a file change. You must use workspace_write_file successfully before claiming the file was created or updated. Try again and perform the tool call first.' });
            continue;
          }

          if (bashToolRequired && successfulBashToolCalls === 0) {
            requiredToolRetryCount += 1;
            if (requiredToolRetryCount >= MAX_REQUIRED_TOOL_RETRIES) {
              throw new Error('Agent failed to use workspace_bash after repeated retries.');
            }
            messages.push({ role: 'system', content: 'The user asked for shell or path information. You must use workspace_bash successfully before claiming you ran a command or know the current working directory. Try again and perform the tool call first.' });
            continue;
          }

          taskState = await readPersistedTaskState(agentId);
          const taskDecision = evaluateTaskContinuation({
            taskMode,
            state: taskState,
            finalContent: response.content,
          });

          if (taskDecision.shouldContinue && taskDecision.reminder) {
            continuedTaskRounds += 1;
            messages.push({ role: 'system', content: taskDecision.reminder });
            continue;
          }

          taskBlocked = taskDecision.blocked;

          verificationDecision = evaluateTaskVerification({
            taskMode,
            requestContent: triggerContent,
            state: taskState,
            toolCalls: toolExecutionSummaries,
            finalContent: response.content,
          });

          if (verificationDecision.shouldContinue && verificationDecision.reminder) {
            continuedTaskRounds += 1;
            messages.push({ role: 'system', content: verificationDecision.reminder });
            continue;
          }

          finalResponse = response;
          break;
        }

        requiredToolRetryCount = 0;

        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const startedAt = Date.now();
          let success = true;
          let output = '';
          let structuredOutput: Record<string, unknown> = {};
          const parsedArguments: unknown = safeParseToolArguments(toolCall.arguments);

          // Notify frontend that a tool is starting.
          chatNamespace.to(getChannelRoom(channelId)).emit('agent:tool:start', {
            agentId,
            channelId,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            turnId: tempId,
            arguments: parsedArguments,
          });

          try {
            const result = await toolRegistryService.executeToolCall({
              agentId,
              channelId,
              toolName: toolCall.name,
              args: toolCall.arguments,
            });
            output = result.output;
            structuredOutput = result.structuredOutput;
          } catch (toolError) {
            success = false;
            output = `Tool execution failed: ${toolError instanceof Error ? toolError.message : 'Unknown tool error.'}`;
            structuredOutput = { error: output };
          }

          const durationMs = Date.now() - startedAt;

          // Notify frontend that the tool finished.
          chatNamespace.to(getChannelRoom(channelId)).emit('agent:tool:end', {
            agentId,
            channelId,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            turnId: tempId,
            success,
            durationMs,
            arguments: parsedArguments,
            output,
            structuredOutput,
          });

          await prisma.agentToolCall.create({
            data: {
              agentId,
              messageId,
              toolName: toolCall.name,
              input: { rawArguments: toolCall.arguments },
              output: JSON.parse(JSON.stringify(structuredOutput)),
              durationMs,
              success,
            },
          });

          toolExecutionSummaries.push({
            toolName: toolCall.name,
            success,
            durationMs,
            arguments: parsedArguments,
            output,
            structuredOutput,
            outputPreview: output.slice(0, 500),
          });

          if (success && toolCall.name === WRITE_TOOL_NAME) successfulWriteToolCalls += 1;
          if (success && toolCall.name === BASH_TOOL_NAME) successfulBashToolCalls += 1;
          if (success && [TODO_WRITE_TOOL_NAME, WRITE_TOOL_NAME, BASH_TOOL_NAME, SEND_REPLY_TOOL_NAME].includes(toolCall.name)) {
            taskMode = taskMode || [TODO_WRITE_TOOL_NAME, SEND_REPLY_TOOL_NAME].includes(toolCall.name);
            taskState = await readPersistedTaskState(agentId);
          }

          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: output,
          });
        }
      }

      // ── Fallback if tool loop exhausted without text response ─────────────
      if (!finalResponse) {
        taskState = await readPersistedTaskState(agentId);
        const fallbackContent = buildToolFallbackContent(toolExecutionSummaries);

        if (taskMode) {
          finalResponse = {
            id: `task-fallback-${tempId}`,
            content: taskState.incompleteTodos.length > 0
              ? `I made progress but did not finish the task within this turn. Remaining checklist items: ${taskState.incompleteTodos.map((todo) => todo.content).join('; ')}.`
              : (fallbackContent ?? 'I made progress on the task, but I ran out of tool rounds before producing a final report.'),
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
            providerMetadata: { fallback: 'task-loop-exhausted' },
          };
        }

        if (!finalResponse && !fallbackContent) {
          throw new Error('Agent exhausted the maximum number of tool rounds without producing a final response.');
        }

        if (!finalResponse) {
          finalResponse = {
            id: `tool-fallback-${tempId}`,
            content: fallbackContent ?? 'The requested tool action completed successfully.',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
            providerMetadata: { fallback: 'tool-loop-exhausted' },
          };
        }
      }

      if (!finalResponse) {
        throw new Error('Agent finished the tool loop without a final response.');
      }

      const ensuredFinalResponse = finalResponse;

      // ── Sanitize content ──────────────────────────────────────────────────
      const rawContent = sanitizeAgentVisibleContent(stripMessageWrapper(ensuredFinalResponse.content));

      if (rawContent === NO_REPLY_TOKEN) {
        // Agent decided not to reply — close the stream silently.
        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
          tempId,
          finalMessageId: '',
          channelId,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      // ── Stream the final response ─────────────────────────────────────────
      // Emit the already-collected content as a single chunk. The content came
      // from the tool loop's provider.complete() call — making a second LLM
      // call via provider.stream() would waste tokens and produce different text.
      // True token-level streaming (restructuring the last tool loop round to use
      // stream() directly) is a follow-up optimization.
      chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:chunk', {
        tempId,
        agentId,
        channelId,
        delta: rawContent,
      });

      const finalContent = rawContent;

      if (!finalContent || finalContent === NO_REPLY_TOKEN) {
        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
          tempId,
          finalMessageId: '',
          channelId,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      // ── Extract relay commands, persist message ───────────────────────────
      const { commands: relayCommands, cleanedContent } = extractRelayCommands(finalContent);
      const persistedContent = cleanedContent || finalContent;

      const metadata = JSON.parse(
        JSON.stringify({
          provider: provider.name,
          model: provider.model,
          responseId: ensuredFinalResponse.id,
          usage: ensuredFinalResponse.usage,
          providerMetadata: ensuredFinalResponse.providerMetadata ?? null,
          context: {
            promptTokens: context.totalTokens,
            budgetUsed: context.budgetUsed,
            budgetLimit: context.budgetLimit,
            compactionTriggered: context.compactionTriggered,
            summaryUsed: context.summaryUsed,
            staticPrefixKey: context.staticPrefixKey,
            staticPrefixCacheHit: context.staticPrefixCacheHit ?? false,
          },
          toolCalls: toolExecutionSummaries,
          task: {
            mode: taskMode ? 'multi_step' : 'chat',
            reason: taskModeReason,
            continuedRounds: continuedTaskRounds,
            blocked: taskBlocked,
            verificationStatus: verificationDecision.status,
            totalTodos: taskState.totalTodos,
            completedTodos: taskState.completedTodos,
            incompleteTodos: taskState.incompleteTodos.map((todo) => todo.content),
            hasInProgress: taskState.hasInProgress,
          },
          relayedChannels: relayCommands.length > 0 ? relayCommands.map((cmd) => cmd.channelName) : undefined,
        }),
      );

      const message = await prisma.message.create({
        data: {
          channelId,
          senderId: agentId,
          senderType: 'AGENT',
          content: persistedContent,
          contentType: 'MARKDOWN',
          metadata,
        },
      });

      const agentRecord = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { name: true },
      });

      chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
        tempId,
        finalMessageId: message.id,
        channelId,
        createdAt: message.createdAt.toISOString(),
      });

      chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage({
        ...message,
        senderName: agentRecord?.name ?? null,
      }));

      // ── Relay commands ────────────────────────────────────────────────────
      await executeRelayCommands(relayCommands, agentId);

      // ── Cascade agent triggers ────────────────────────────────────────────
      await chatService.triggerAgentsForMessage({
        channelId,
        senderId: agentId,
        senderType: 'AGENT',
        content: persistedContent,
        messageId: message.id,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Agent processing failed.';

      const fallbackMessage = await prisma.message.create({
        data: {
          channelId,
          senderId: agentId,
          senderType: 'AGENT',
          content: errorMessage.includes('Incorrect API key')
            ? 'I could not respond because the configured OpenAI API key is invalid. Update `.env` with a valid key and try again.'
            : `I could not respond right now: ${errorMessage}`,
          contentType: 'SYSTEM',
          metadata: { error: errorMessage },
        },
      });

      const agentRecord = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { name: true },
      });

      chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:end', {
        tempId,
        finalMessageId: fallbackMessage.id,
        channelId,
        createdAt: fallbackMessage.createdAt.toISOString(),
      });

      chatNamespace.to(getChannelRoom(channelId)).emit('message:new', serializeMessage({
        ...fallbackMessage,
        senderName: agentRecord?.name ?? null,
      }));

      throw error;
    }
  }
}

export const agentSessionGateway = new AgentSessionGateway();
