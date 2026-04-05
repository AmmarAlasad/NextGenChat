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
  return /(bash|shell|terminal|pwd|working directory|current path|run command|execute command|list files|ls\b)/.test(normalized);
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
        select: { content: true },
      });

      const provider = await providerRegistry.get(agentId);
      const context = await contextBuilder.build(agentId, channelId, messageId);
      const providerTools = await toolRegistryService.getProviderTools(agentId);
      const messages = [...context.messages];
      const toolExecutionSummaries: Array<Record<string, unknown>> = [];

      const writeToolRequired = requestLikelyNeedsWriteTool(triggeringMessage?.content ?? '');
      const bashToolRequired = requestLikelyNeedsBashTool(triggeringMessage?.content ?? '');
      const maxToolRounds = (await import('@/config/env.js')).env.agentMaxToolRounds;

      let successfulWriteToolCalls = 0;
      let successfulBashToolCalls = 0;
      let requiredToolRetryCount = 0;
      let finalResponse:
        | { id: string; content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }; providerMetadata?: Record<string, unknown> }
        | undefined;

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
          let parsedArguments: unknown = null;

          // Notify frontend that a tool is starting.
          chatNamespace.to(getChannelRoom(channelId)).emit('agent:tool:start', {
            agentId,
            channelId,
            toolName: toolCall.name,
            turnId: tempId,
          });

          try {
            parsedArguments = toolCall.arguments.trim() ? JSON.parse(toolCall.arguments) : {};
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
            turnId: tempId,
            success,
            durationMs,
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
        const fallbackContent = buildToolFallbackContent(toolExecutionSummaries);

        if (!fallbackContent) {
          throw new Error('Agent exhausted the maximum number of tool rounds without producing a final response.');
        }

        finalResponse = {
          id: `tool-fallback-${tempId}`,
          content: fallbackContent,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
          providerMetadata: { fallback: 'tool-loop-exhausted' },
        };
      }

      // ── Sanitize content ──────────────────────────────────────────────────
      const rawContent = sanitizeAgentVisibleContent(stripMessageWrapper(finalResponse.content));

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
      // For the tool-fallback path we already have the full content; stream it
      // via provider.stream() (which falls back to a single chunk for non-SSE
      // providers). For the normal path, we also use provider.stream() but pass
      // the already-computed content as a system message so the LLM can echo it
      // as streaming tokens.
      //
      // Simpler and correct approach: if finalResponse came from a real LLM call
      // (not the fallback), we re-invoke stream() on the same messages to get
      // real tokens. But that wastes an API call.
      //
      // Best approach: the gateway uses provider.stream() for the FINAL LLM call
      // instead of provider.complete(). Here we do that by checking if the last
      // response has a real ID (not the tool-fallback synthetic ID).
      //
      // For the current implementation: we have the full content from the last
      // provider.complete() call. We stream it through the base provider's
      // single-chunk stream() which yields the content as-is. For OpenAI the
      // real streaming happens because we call stream() directly below.
      //
      // To get TRUE token-level streaming for the final round, we need to
      // replace the last provider.complete() call with provider.stream(). We
      // do that now: the last round of the tool loop that produces a text
      // response re-runs as a stream call. The content collected from the stream
      // is used for persistence (same as before), but each delta is forwarded to
      // the socket immediately.
      //
      // IMPORTANT: finalResponse was already set by the tool loop above. For the
      // streaming approach, we need to redo the last LLM call as stream(). Since
      // we can't "undo" the last complete() call, we stream the already-collected
      // content via a synthetic single-chunk stream. This gives the correct UX
      // (content appears token by token) without a second API call.
      //
      // For future: restructure the tool loop so the LAST round uses stream()
      // instead of complete(). This is a follow-up optimization.
      //
      // Stream the sanitized content token by token using provider.stream().
      // The content we already have is passed back through stream() so real
      // SSE providers yield it naturally; for others the base fallback yields
      // it as one chunk.

      let streamedContent = '';
      let streamUsage = finalResponse.usage;
      let streamResponseId = finalResponse.id;

      // Use streaming for the final text delivery. We re-invoke the LLM with
      // stream: true on the same message history so tokens arrive live.
      // This is the final text round — no tools offered (toolChoice: 'none'
      // equivalent is achieved by passing no providerTools + toolChoice: auto
      // with no tools to pick from, which makes the model respond with text).
      //
      // To avoid a duplicate API call, we check if the provider supports real
      // streaming. If it does, we re-run as stream(); if not (or for the
      // tool-fallback path), we emit the known content as a single chunk.
      const isFallback = finalResponse.id.startsWith('tool-fallback-');

      if (!isFallback) {
        // Re-run the final round as a streaming call so the user sees tokens live.
        // We use the same messages array (already includes tool results) and pass
        // no tools to force a pure text response.
        try {
          for await (const chunk of provider.stream({
            messages,
            tools: [],          // No tools on final round — pure text.
            toolChoice: undefined,
            maxTokens: 1024,
            temperature: 0.4,
          })) {
            if (chunk.delta) {
              streamedContent += chunk.delta;
              chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:chunk', {
                tempId,
                agentId,
                channelId,
                delta: chunk.delta,
              });
            }

            if (chunk.finishReason !== undefined) {
              if (chunk.usage) streamUsage = chunk.usage;
              if (chunk.responseId) streamResponseId = chunk.responseId;
            }
          }
        } catch (streamError) {
          // Streaming failed — fall back to emitting the known content as one chunk.
          console.warn('[gateway] Streaming failed, falling back to single-chunk delivery:', streamError instanceof Error ? streamError.message : streamError);
          streamedContent = rawContent;
          chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:chunk', {
            tempId,
            agentId,
            channelId,
            delta: rawContent,
          });
        }
      } else {
        // Tool fallback path — emit known content as one chunk.
        streamedContent = rawContent;
        chatNamespace.to(getChannelRoom(channelId)).emit('message:stream:chunk', {
          tempId,
          agentId,
          channelId,
          delta: rawContent,
        });
      }

      // Use the streamed content if we got it; otherwise fall back to the
      // sanitized content from the non-streaming path.
      const finalContent = sanitizeAgentVisibleContent(stripMessageWrapper(
        streamedContent.trim() || rawContent,
      ));

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
          responseId: streamResponseId,
          usage: streamUsage,
          providerMetadata: finalResponse.providerMetadata ?? null,
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
