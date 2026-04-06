/**
 * Tool Registry Service
 *
 * Provides the first autonomous tool runtime for agents. It resolves the set of
 * approved built-in tools for an agent, exposes provider-ready JSON schemas, and
 * executes tool calls inside the agent workspace or repository root.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { LLMTool } from '@nextgenchat/types';
import { z } from 'zod';

import { prisma } from '@/db/client.js';
import { chatService } from '@/modules/chat/chat.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';
const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_LENGTH = 2_000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_BASH_OUTPUT_BYTES = 100 * 1024;
const TOOL_READ = 'workspace_read_file';
const TOOL_WRITE = 'workspace_write_file';
const TOOL_BASH = 'workspace_bash';
const TOOL_SEND_CHANNEL_MESSAGE = 'channel_send_message';

const ReadToolSchema = z.object({
  filePath: z.string().min(1).describe('Absolute or root-relative path to a file or directory to read.'),
  offset: z.number().int().positive().optional().describe('Line number to start reading from (1-indexed).'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines or entries to read.'),
});

const WriteToolSchema = z.object({
  filePath: z.string().min(1).describe('Absolute or root-relative path to a file to write.'),
  content: z.string().describe('Full file content to write.'),
});

const BashToolSchema = z.object({
  command: z.string().min(1).describe('Command to execute.'),
  timeout: z.number().int().positive().optional().describe('Optional timeout in milliseconds.'),
  workdir: z.string().min(1).optional().describe('Working directory for the command.'),
  description: z.string().min(1).describe('Short description of what the command does.'),
});

const SendChannelMessageToolSchema = z.object({
  channelName: z.string().min(1).describe('Exact channel name to send the message to.'),
  content: z.string().min(1).max(32_000).describe('Message content to post into that channel.'),
});

type ToolExecutionResult = {
  output: string;
  structuredOutput: Record<string, unknown>;
};

type ToolExecutionContext = {
  agentId: string;
  channelId: string;
};

type BuiltInToolDefinition = {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  parameters: Record<string, unknown>;
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
};

function normalizeChannelLookupName(value: string) {
  return value.trim().replace(/^#/, '').toLowerCase();
}

function normalizeWorkspacePath(root: string, value: string) {
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }

  return path.resolve(root, value);
}

function displayWorkspacePath(agentId: string, filePath: string) {
  const root = path.resolve(workspaceService.getAgentWorkspaceDir(agentId));
  const relative = path.relative(root, path.resolve(filePath));

  if (!relative || relative === '') {
    return '.';
  }

  return relative;
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isBinaryFile(filePath: string, fileSize: number) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.jar', '.class', '.bin', '.wasm', '.pdf'].includes(ext)) {
    return true;
  }

  if (fileSize === 0) {
    return false;
  }

  const handle = await readFile(filePath);
  const sample = handle.subarray(0, Math.min(handle.byteLength, 4_096));
  let nonPrintable = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonPrintable += 1;
    }
  }

  return sample.length > 0 && nonPrintable / sample.length > 0.3;
}

function toDirectoryOutput(filePath: string, entries: string[], offset: number, totalEntries: number) {
  const end = offset - 1 + entries.length;
  return [`<path>${filePath}</path>`, '<type>directory</type>', '<entries>', entries.join('\n'), end < totalEntries ? `\n(Showing entries ${offset}-${end} of ${totalEntries}. Use offset=${end + 1} to continue.)` : `\n(${totalEntries} entries)`, '</entries>'].join('\n');
}

async function readTextFile(filePath: string, offset: number, limit: number) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const start = offset - 1;
  const lines: string[] = [];
  let totalLines = 0;
  let bytes = 0;
  let truncated = false;

  try {
    for await (const rawLine of rl) {
      totalLines += 1;

      if (totalLines <= start) {
        continue;
      }

      if (lines.length >= limit) {
        truncated = true;
        continue;
      }

      const line = rawLine.length > MAX_LINE_LENGTH ? `${rawLine.slice(0, MAX_LINE_LENGTH)}... (line truncated)` : rawLine;
      const size = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);

      if (bytes + size > MAX_BYTES) {
        truncated = true;
        break;
      }

      lines.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${totalLines} lines).`);
  }

  const numbered = lines.map((line, index) => `${index + offset}: ${line}`);
  const lastReadLine = offset + lines.length - 1;
  const footer = truncated ? `(Showing lines ${offset}-${lastReadLine} of ${Math.max(totalLines, lastReadLine)}. Use offset=${lastReadLine + 1} to continue.)` : `(End of file - total ${totalLines} lines)`;

  return [`<path>${filePath}</path>`, '<type>file</type>', '<content>', ...numbered, '', footer, '</content>'].join('\n');
}

function resolveAllowedPath(agentId: string, value: string) {
  const root = path.resolve(workspaceService.getAgentWorkspaceDir(agentId));
  const candidate = normalizeWorkspacePath(root, value);
  const relative = path.relative(root, candidate);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside the agent workspace.');
  }

  return candidate;
}

function resolveAllowedDirectory(agentId: string, value: string | undefined) {
  if (!value) {
    return path.resolve(workspaceService.getAgentWorkspaceDir(agentId));
  }

  return resolveAllowedPath(agentId, value);
}

const builtInTools: Record<string, BuiltInToolDefinition> = {
  [TOOL_READ]: {
    name: TOOL_READ,
    description: 'Read a file or directory from the agent workspace only.',
    schema: ReadToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: 'Absolute or root-relative path to a file or directory to read.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed).' },
        limit: { type: 'number', description: 'Maximum number of lines or entries to read.' },
      },
      required: ['filePath'],
    },
    async execute(args, context) {
      const input = ReadToolSchema.parse(args);
      const filePath = resolveAllowedPath(context.agentId, input.filePath);
      const displayPath = displayWorkspacePath(context.agentId, filePath);
      const fileStat = await stat(filePath).catch(() => null);

      if (!fileStat) {
        // Return a structured not-found result instead of throwing — prevents
        // agents from burning tool calls on missing files. Agent can see what's
        // available by calling workspace_read_file on '.' (the workspace root).
        return {
          output: `File not found: ${displayPath}\nTip: call workspace_read_file with filePath="." to list available files.`,
          structuredOutput: { filePath: displayPath, exists: false },
        };
      }

      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_READ_LIMIT;

      if (fileStat.isDirectory()) {
        const dirents = await readdir(filePath, { withFileTypes: true });
        const entries = dirents.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort((a, b) => a.localeCompare(b));
        const start = offset - 1;
        const sliced = entries.slice(start, start + limit);
        const output = toDirectoryOutput(displayPath, sliced, offset, entries.length);

        return {
          output,
          structuredOutput: { filePath: displayPath, type: 'directory', offset, returnedEntries: sliced.length },
        };
      }

      if (await isBinaryFile(filePath, Number(fileStat.size))) {
        throw new Error(`Cannot read binary file with ${TOOL_READ}.`);
      }

      const output = await readTextFile(filePath, offset, limit);
      return {
        output: output.replace(`<path>${filePath}</path>`, `<path>${displayPath}</path>`),
        structuredOutput: { filePath: displayPath, type: 'file', offset, limit },
      };
    },
  },
  [TOOL_WRITE]: {
    name: TOOL_WRITE,
    description: 'Write a full file inside the agent workspace only.',
    schema: WriteToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: 'Absolute or root-relative path to a file to write.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['filePath', 'content'],
    },
    async execute(args, context) {
      const input = WriteToolSchema.parse(args);
      const filePath = resolveAllowedPath(context.agentId, input.filePath);

      // Protect system-managed files from agent self-modification.
      // Only AgentCreatorAgent (admin API) may update these.
      const PROTECTED_FILES = ['soul.md', 'identity.md', 'agent.md', 'pickup.md', 'wakeup.md'];
      const baseName = path.basename(filePath).toLowerCase();
      if (PROTECTED_FILES.includes(baseName)) {
        throw new Error(`The file "${path.basename(filePath)}" is managed by AgentCreatorAgent and cannot be modified by agents directly. You can update user.md, memory.md, and heartbeat.md freely.`);
      }

      const displayPath = displayWorkspacePath(context.agentId, filePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      const existed = await pathExists(filePath);
      await writeFile(filePath, input.content, 'utf8');

      return {
        output: `Wrote ${existed ? 'existing' : 'new'} file successfully: ${displayPath}`,
        structuredOutput: {
          filePath: displayPath,
          existed,
          bytesWritten: Buffer.byteLength(input.content, 'utf8'),
        },
      };
    },
  },
  [TOOL_BASH]: {
    name: TOOL_BASH,
    description: 'Execute a shell command from the agent workspace only with timeout and output capture.',
    schema: BashToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Command to execute.' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds.' },
        workdir: { type: 'string', description: 'Working directory for the command.' },
        description: { type: 'string', description: 'Short description of what the command does.' },
      },
      required: ['command', 'description'],
    },
    async execute(args, context) {
      const input = BashToolSchema.parse(args);
      const workdir = resolveAllowedDirectory(context.agentId, input.workdir);
      const displayWorkdir = displayWorkspacePath(context.agentId, workdir);
      const timeout = input.timeout ?? DEFAULT_BASH_TIMEOUT_MS;

      const result = await new Promise<{ output: string; exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
        const proc = spawn(input.command, {
          cwd: workdir,
          shell: true,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let timedOut = false;
        const append = (chunk: Buffer) => {
          if (output.length >= MAX_BASH_OUTPUT_BYTES) {
            return;
          }

          output += chunk.toString();
          if (output.length > MAX_BASH_OUTPUT_BYTES) {
            output = `${output.slice(0, MAX_BASH_OUTPUT_BYTES)}\n\n[output truncated]`;
          }
        };

        proc.stdout?.on('data', append);
        proc.stderr?.on('data', append);

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, timeout);

        proc.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });

        proc.once('exit', (code) => {
          clearTimeout(timer);
          resolve({ output, exitCode: code, timedOut });
        });
      });

      const suffix = result.timedOut ? `\n\n<bash_metadata>Command timed out after ${timeout} ms.</bash_metadata>` : '';

      return {
        output: `${result.output || '[no output]'}${suffix}`,
        structuredOutput: {
          description: input.description,
          command: input.command,
          workdir: displayWorkdir,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
      };
    },
  },
  [TOOL_SEND_CHANNEL_MESSAGE]: {
    name: TOOL_SEND_CHANNEL_MESSAGE,
    description: 'Send a message to another non-direct channel that this agent already belongs to.',
    schema: SendChannelMessageToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channelName: { type: 'string', description: 'Exact channel name to send the message to.' },
        content: { type: 'string', description: 'Message content to post into that channel.' },
      },
      required: ['channelName', 'content'],
    },
    async execute(args, context) {
      const input = SendChannelMessageToolSchema.parse(args);
      const lookupName = normalizeChannelLookupName(input.channelName);
      const memberships = await prisma.agentChannelMembership.findMany({
        where: {
          agentId: context.agentId,
          channel: { type: { not: 'DIRECT' } },
        },
        include: {
          channel: {
            include: {
              project: {
                select: { name: true },
              },
            },
          },
        },
      });

      const target = memberships.find((membership) => normalizeChannelLookupName(membership.channel.name) === lookupName);

      if (!target) {
        throw new Error(`Agent does not have access to a non-direct channel named "${input.channelName}".`);
      }

      const message = await chatService.createAgentRelayMessage({
        channelId: target.channelId,
        senderId: context.agentId,
        content: input.content,
        contentType: 'TEXT',
        metadata: {
          viaTool: TOOL_SEND_CHANNEL_MESSAGE,
          channelName: target.channel.name,
          projectName: target.channel.project?.name ?? null,
        },
      });

      // Broadcast the new message to everyone in the target channel.
      getChatNamespace().to(getChannelRoom(target.channelId)).emit('message:new', message);

      // Let other agents in the target channel react to this message.
      // isRelay=true bypasses the agent-sender guard so pickup agents can decide
      // whether to respond — just like they would for a human-sent message.
      void chatService.triggerAgentsForMessage({
        channelId: target.channelId,
        senderId: context.agentId,
        senderType: 'AGENT',
        content: input.content,
        messageId: message.id,
        isRelay: true,
      });

      return {
        output: `Sent message to #${target.channel.name}${target.channel.project?.name ? ` (project: ${target.channel.project.name})` : ''}.`,
        structuredOutput: {
          channelId: target.channelId,
          channelName: target.channel.name,
          projectName: target.channel.project?.name ?? null,
          messageId: message.id,
          content: input.content,
        },
      };
    },
  },
};

export class ToolRegistryService {
  async getApprovedTools(agentId: string) {
    const tools = await prisma.agentTool.findMany({
      where: { agentId },
      orderBy: { toolName: 'asc' },
    });

    return tools.filter((tool) => builtInTools[tool.toolName] && (!tool.requiresApproval || tool.approvedAt));
  }

  async getProviderTools(agentId: string): Promise<LLMTool[]> {
    const tools = await this.getApprovedTools(agentId);

    return tools.map((tool) => {
      const definition = builtInTools[tool.toolName];

      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      };
    });
  }

  async summarizeApprovedTools(agentId: string) {
    const tools = await this.getApprovedTools(agentId);

    if (tools.length === 0) {
      return 'No approved tools are available.';
    }

    return tools.map((tool) => `- ${tool.toolName}: ${builtInTools[tool.toolName]?.description ?? 'No description.'}`).join('\n');
  }

  async executeToolCall(input: { agentId: string; channelId: string; toolName: string; args: string }) {
    const approved = await this.getApprovedTools(input.agentId);
    const match = approved.find((tool) => tool.toolName === input.toolName);

    if (!match) {
      throw new Error(`Tool is not approved for this agent: ${input.toolName}`);
    }

    const definition = builtInTools[input.toolName];

    if (!definition) {
      throw new Error(`Unsupported built-in tool: ${input.toolName}`);
    }

    const parsedArgs = input.args.trim() ? JSON.parse(input.args) : {};
    return definition.execute(parsedArgs, { agentId: input.agentId, channelId: input.channelId });
  }
}

export const toolRegistryService = new ToolRegistryService();
