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
import { skillService } from '@/modules/agents/skill.service.js';
import { skillInstallerService } from '@/modules/agents/skill-installer.service.js';
import { chatService } from '@/modules/chat/chat.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';
import { NO_REPLY_TOKEN, sanitizeAgentVisibleContent } from '../agents/agent-output.js';
const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_LENGTH = 2_000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_BASH_OUTPUT_BYTES = 100 * 1024;
const TOOL_READ = 'workspace_read_file';
const TOOL_WRITE = 'workspace_write_file';
const TOOL_BASH = 'workspace_bash';
const TOOL_GLOB = 'workspace_glob';
const TOOL_GREP = 'workspace_grep';
const TOOL_SEND_CHANNEL_MESSAGE = 'channel_send_message';
const TOOL_SEND_REPLY = 'send_reply';
const TOOL_TODO_READ = 'todoread';
const TOOL_TODO_WRITE = 'todowrite';
const TOOL_WEBSEARCH = 'websearch';
const TOOL_WEBFETCH = 'webfetch';
const TOOL_SKILL_ACTIVATE = 'skill_activate';
const TOOL_SKILL_LIST = 'skill_list';
const TOOL_SKILL_INSTALL = 'skill_install';
const TOOL_STATE_DIR = '.nextgenchat';
const TODO_STATE_FILE = `${TOOL_STATE_DIR}/todo-state.json`;
const DEFAULT_SEARCH_LIMIT = 200;
const MESSAGE_WRAPPER_RE = /^<message\b[^>]*>\s*/i;
const MESSAGE_WRAPPER_CLOSE_RE = /\s*<\/message>\s*$/i;

const WEBSEARCH_TIMEOUT_MS = 25_000;
const WEBFETCH_TIMEOUT_MS = 30_000;
const WEBFETCH_MAX_TIMEOUT_MS = 120_000;
const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';

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

const GlobToolSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern to match, for example "**/*.ts" or "docs/**/*.md".'),
  path: z.string().min(1).optional().describe('Optional workspace-relative directory to search in.'),
});

const GrepToolSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression pattern to search for inside files.'),
  path: z.string().min(1).optional().describe('Optional workspace-relative directory to search in.'),
  include: z.string().min(1).optional().describe('Optional file glob filter such as "*.ts" or "*.md".'),
});

const SendChannelMessageToolSchema = z.object({
  channelName: z.string().min(1).describe('Exact channel name to send the message to.'),
  content: z.string().min(1).max(32_000).describe('Message content to post into that channel.'),
});

const SendReplyToolSchema = z.object({
  content: z.string().min(1).max(32_000).describe('Intermediate progress update to post into the current channel.'),
});

const TodoItemSchema = z.object({
  content: z.string().min(1).describe('Brief description of the task.'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('Current task status.'),
  priority: z.enum(['high', 'medium', 'low']).describe('Priority level.'),
});

const TodoWriteToolSchema = z.object({
  todos: z.array(TodoItemSchema).describe('The full updated todo list.'),
});

const TodoReadToolSchema = z.object({});

const WebSearchToolSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  numResults: z.number().int().positive().optional().describe('Number of results to return (default: 8)'),
  livecrawl: z.enum(['fallback', 'preferred']).optional().describe("Live crawl mode — 'fallback': use live crawling as backup if cached unavailable, 'preferred': prioritize live crawling"),
  type: z.enum(['auto', 'fast', 'deep']).optional().describe("Search type — 'auto': balanced (default), 'fast': quick results, 'deep': comprehensive"),
  contextMaxCharacters: z.number().int().positive().optional().describe('Maximum characters for context string (default: 10000)'),
});

const WebFetchToolSchema = z.object({
  url: z.string().min(1).describe('The URL to fetch content from'),
  format: z.enum(['text', 'markdown', 'html']).optional().describe('Format to return content in — text, markdown, or html (default: markdown)'),
  timeout: z.number().int().positive().optional().describe('Optional timeout in seconds (max 120)'),
});

const SkillActivateToolSchema = z.object({
  name: z.string().min(1).describe('Exact skill name (slug) to activate, as shown by skill_list.'),
});

const SkillListToolSchema = z.object({});

const SkillInstallToolSchema = z.object({
  url: z.string().min(1).describe('URL or source reference for the skill. Supports GitHub repos/directories/files, clawhub.ai, gists, npm/unpkg, direct markdown URLs, and generic public pages that expose skill markdown.'),
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional().describe('Override the skill name (slug). Derived from URL or frontmatter if omitted.'),
  skill: z.string().min(1).max(100).optional().describe('Optional skill selector for multi-skill repositories, for example "obsidian-markdown". Also supported as ?skill=... or #skill=... in the URL.'),
  type: z.enum(['PASSIVE', 'ON_DEMAND', 'TOOL_BASED']).optional().describe('Override the skill type. Parsed from frontmatter if omitted, defaults to ON_DEMAND.'),
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
  usageGuidance: string[];
  schema: z.AnyZodObject;
  parameters: Record<string, unknown>;
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
};

function normalizeChannelLookupName(value: string) {
  return value.trim().replace(/^#/, '').toLowerCase();
}

function stripMessageWrapper(text: string) {
  return text.replace(MESSAGE_WRAPPER_RE, '').replace(MESSAGE_WRAPPER_CLOSE_RE, '').trim();
}

function sanitizeVisibleText(text: string) {
  return sanitizeAgentVisibleContent(stripMessageWrapper(text)).trim();
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

async function runProcess(input: { command: string; args: string[]; cwd: string }) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const proc = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const next = chunk.toString();
      if (target === 'stdout') {
        stdout = `${stdout}${next}`;
        if (stdout.length > MAX_BASH_OUTPUT_BYTES) {
          stdout = `${stdout.slice(0, MAX_BASH_OUTPUT_BYTES)}\n\n[output truncated]`;
        }
        return;
      }

      stderr = `${stderr}${next}`;
      if (stderr.length > MAX_BASH_OUTPUT_BYTES) {
        stderr = `${stderr.slice(0, MAX_BASH_OUTPUT_BYTES)}\n\n[output truncated]`;
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    proc.once('error', reject);
    proc.once('exit', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

function shouldUseSearchFallback(error: unknown) {
  return error instanceof Error && /ENOENT/i.test(error.message);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosixPath(value: string) {
  return value.split(path.sep).join('/');
}

function globToRegExp(pattern: string) {
  const normalized = toPosixPath(pattern);
  const escaped = escapeRegex(normalized)
    .replace(/\\\*\\\*/g, '::DOUBLE_STAR::')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]');
  return new RegExp(`^${escaped.replace(/::DOUBLE_STAR::/g, '.*')}$`);
}

function matchesGlob(pattern: string, relativePath: string) {
  const normalizedPath = toPosixPath(relativePath);
  const matcher = globToRegExp(pattern);

  if (!pattern.includes('/')) {
    return matcher.test(path.posix.basename(normalizedPath));
  }

  return matcher.test(normalizedPath);
}

async function listFilesRecursive(root: string, current = root): Promise<string[]> {
  const dirents = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const dirent of dirents) {
    const fullPath = path.join(current, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await listFilesRecursive(root, fullPath)));
      continue;
    }

    if (dirent.isFile()) {
      files.push(toPosixPath(path.relative(root, fullPath)));
    }
  }

  return files;
}

async function fallbackGlobMatches(searchRoot: string, pattern: string) {
  const files = await listFilesRecursive(searchRoot);
  return files.filter((filePath) => matchesGlob(pattern, filePath));
}

async function fallbackGrepMatches(searchRoot: string, pattern: string, include?: string) {
  const files = await listFilesRecursive(searchRoot);
  const matchedFiles = include ? files.filter((filePath) => matchesGlob(include, filePath)) : files;
  const regex = new RegExp(pattern);
  const matches: string[] = [];

  for (const relativePath of matchedFiles) {
    const absolutePath = path.join(searchRoot, relativePath);
    const fileStat = await stat(absolutePath);
    if (await isBinaryFile(absolutePath, Number(fileStat.size))) {
      continue;
    }

    const lines = (await readFile(absolutePath, 'utf8')).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push(`${relativePath}:${index + 1}: ${line}`);
      }
    }
  }

  return matches;
}

function truncateOutputLines(lines: string[], limit: number) {
  const sliced = lines.slice(0, limit);
  let bytes = 0;
  const kept: string[] = [];

  for (const line of sliced) {
    const size = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      break;
    }
    kept.push(line);
    bytes += size;
  }

  return {
    lines: kept,
    truncated: kept.length < lines.length,
    total: lines.length,
  };
}

function getTodoStatePath(agentId: string) {
  return resolveAllowedPath(agentId, TODO_STATE_FILE);
}

async function readTodoState(agentId: string) {
  const filePath = getTodoStatePath(agentId);
  if (!(await pathExists(filePath))) {
    return [] as Array<z.infer<typeof TodoItemSchema>>;
  }

  const raw = await readFile(filePath, 'utf8');
  return z.array(TodoItemSchema).parse(JSON.parse(raw));
}

async function writeTodoState(agentId: string, todos: Array<z.infer<typeof TodoItemSchema>>) {
  const filePath = getTodoStatePath(agentId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(todos, null, 2)}\n`, 'utf8');
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

function stripHtmlTags(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => `${'#'.repeat(Number(level))} ${stripHtmlTags(text)}\n\n`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_m, text: string) => `**${stripHtmlTags(text)}**`)
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_m, text: string) => `**${stripHtmlTags(text)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_m, text: string) => `_${stripHtmlTags(text)}_`)
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_m, text: string) => `_${stripHtmlTags(text)}_`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `[${stripHtmlTags(text)}](${href})`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text: string) => `- ${stripHtmlTags(text)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, text: string) => `${stripHtmlTags(text)}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const builtInTools: Record<string, BuiltInToolDefinition> = {
  [TOOL_READ]: {
    name: TOOL_READ,
    description: 'Read a file or directory from the agent workspace only. Use this for exact file contents before editing or after writing.',
    usageGuidance: [
      'Use this when you already know the file path and need the exact contents.',
      'Use `filePath="."` to list the workspace root or any directory contents.',
      'Prefer this over `workspace_bash` for normal file reads.',
    ],
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
    description: 'Write a full file inside the agent workspace only. Use this only after you know the final full contents.',
    usageGuidance: [
      'Use this to create a new file or fully overwrite an existing file inside the workspace.',
      'Read a file first before overwriting it unless you are creating it from scratch.',
      'Do not claim a file changed unless this tool succeeded.',
    ],
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
    description: 'Execute a shell command from the agent workspace only with timeout and output capture. Use this for commands, builds, git, package managers, and runtime verification.',
    usageGuidance: [
      'Use this when a shell command is genuinely needed, such as running a build, test, git command, or external CLI.',
      'Prefer `workspace_read_file`, `workspace_glob`, and `workspace_grep` for normal inspection instead of shell commands.',
      'Set `workdir` instead of using `cd` inside the command whenever possible.',
    ],
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
  [TOOL_GLOB]: {
    name: TOOL_GLOB,
    description: 'Find files by name pattern inside the agent workspace. Use this before reading when you do not know the exact path.',
    usageGuidance: [
      'Use this to discover files by glob pattern, for example `**/*.ts` or `docs/**/*.md`.',
      'Prefer this over `workspace_bash` for filename discovery.',
      'Use `path` to narrow the search to a subdirectory when the workspace is large.',
    ],
    schema: GlobToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match, for example "**/*.ts".' },
        path: { type: 'string', description: 'Optional workspace-relative directory to search in.' },
      },
      required: ['pattern'],
    },
    async execute(args, context) {
      const input = GlobToolSchema.parse(args);
      const searchRoot = resolveAllowedDirectory(context.agentId, input.path);
      let relativeMatches: string[];

      try {
        const result = await runProcess({
          command: 'rg',
          args: ['--files', '-g', input.pattern, '.'],
          cwd: searchRoot,
        });

        if (![0, 1].includes(result.exitCode ?? 1)) {
          throw new Error(result.stderr.trim() || `workspace_glob failed with exit code ${result.exitCode ?? 'unknown'}.`);
        }

        relativeMatches = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => toPosixPath(line));
      } catch (error) {
        if (!shouldUseSearchFallback(error)) {
          throw error;
        }
        relativeMatches = await fallbackGlobMatches(searchRoot, input.pattern);
      }

      const matches = relativeMatches
        .map((line) => displayWorkspacePath(context.agentId, path.resolve(searchRoot, line)))
        .sort((a, b) => a.localeCompare(b));

      if (matches.length === 0) {
        return {
          output: `No files matched pattern: ${input.pattern}`,
          structuredOutput: {
            pattern: input.pattern,
            path: displayWorkspacePath(context.agentId, searchRoot),
            returnedMatches: 0,
          },
        };
      }

      const truncated = truncateOutputLines(matches, DEFAULT_SEARCH_LIMIT);
      return {
        output: [
          `<pattern>${input.pattern}</pattern>`,
          `<path>${displayWorkspacePath(context.agentId, searchRoot)}</path>`,
          '<matches>',
          truncated.lines.join('\n'),
          truncated.truncated ? `\n(Showing ${truncated.lines.length} of ${truncated.total} matches. Narrow the pattern or path to refine results.)` : `\n(${truncated.total} matches)`,
          '</matches>',
        ].join('\n'),
        structuredOutput: {
          pattern: input.pattern,
          path: displayWorkspacePath(context.agentId, searchRoot),
          returnedMatches: truncated.lines.length,
          totalMatches: truncated.total,
          truncated: truncated.truncated,
        },
      };
    },
  },
  [TOOL_GREP]: {
    name: TOOL_GREP,
    description: 'Search file contents with a regular expression inside the agent workspace. Use this when you know what text or pattern you need to find.',
    usageGuidance: [
      'Use this to find content across many files, such as function names, config keys, or error messages.',
      'Use `include` to narrow the search to a file pattern like `*.ts` or `*.md`.',
      'Prefer this over `workspace_bash` for normal content search.',
    ],
    schema: GrepToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for.' },
        path: { type: 'string', description: 'Optional workspace-relative directory to search in.' },
        include: { type: 'string', description: 'Optional file glob filter, for example "*.ts".' },
      },
      required: ['pattern'],
    },
    async execute(args, context) {
      const input = GrepToolSchema.parse(args);
      const searchRoot = resolveAllowedDirectory(context.agentId, input.path);
      let rawMatches: string[];

      try {
        const rgArgs = ['-n', '--no-heading', '--color', 'never'];
        if (input.include) {
          rgArgs.push('-g', input.include);
        }
        rgArgs.push('--', input.pattern, '.');

        const result = await runProcess({ command: 'rg', args: rgArgs, cwd: searchRoot });
        if (![0, 1].includes(result.exitCode ?? 1)) {
          throw new Error(result.stderr.trim() || `workspace_grep failed with exit code ${result.exitCode ?? 'unknown'}.`);
        }

        rawMatches = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      } catch (error) {
        if (!shouldUseSearchFallback(error)) {
          throw error;
        }
        rawMatches = await fallbackGrepMatches(searchRoot, input.pattern, input.include);
      }

      const matches = rawMatches.map((line) => {
        const match = line.match(/^([^:]+):(\d+):\s?(.*)$/);
        if (!match) {
          return line;
        }

        const [, filePath, lineNumber, content] = match;
        const displayPath = displayWorkspacePath(context.agentId, path.resolve(searchRoot, filePath));
        return `${displayPath}:${lineNumber}: ${content}`;
      });

      if (matches.length === 0) {
        return {
          output: `No matches found for pattern: ${input.pattern}`,
          structuredOutput: {
            pattern: input.pattern,
            path: displayWorkspacePath(context.agentId, searchRoot),
            include: input.include ?? null,
            returnedMatches: 0,
          },
        };
      }

      const truncated = truncateOutputLines(matches, DEFAULT_SEARCH_LIMIT);
      return {
        output: [
          `<pattern>${input.pattern}</pattern>`,
          `<path>${displayWorkspacePath(context.agentId, searchRoot)}</path>`,
          input.include ? `<include>${input.include}</include>` : '',
          '<matches>',
          truncated.lines.join('\n'),
          truncated.truncated ? `\n(Showing ${truncated.lines.length} of ${truncated.total} matches. Narrow the pattern, include, or path to refine results.)` : `\n(${truncated.total} matches)`,
          '</matches>',
        ].filter(Boolean).join('\n'),
        structuredOutput: {
          pattern: input.pattern,
          path: displayWorkspacePath(context.agentId, searchRoot),
          include: input.include ?? null,
          returnedMatches: truncated.lines.length,
          totalMatches: truncated.total,
          truncated: truncated.truncated,
        },
      };
    },
  },
  [TOOL_SEND_CHANNEL_MESSAGE]: {
    name: TOOL_SEND_CHANNEL_MESSAGE,
    description: 'Send a message to another non-direct channel that this agent already belongs to. Use this only when the user explicitly asked you to post somewhere else.',
    usageGuidance: [
      'Use this only for a different channel, not the current one.',
      'This posts immediately and can wake up agents in the target channel.',
      'Do not claim a message was sent unless this tool succeeded.',
    ],
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
  [TOOL_SEND_REPLY]: {
    name: TOOL_SEND_REPLY,
    description: 'Send an intermediate progress update to the current channel without ending the turn. Use this for multi-step work when a short progress message helps before the final reply.',
    usageGuidance: [
      'Use this for a short, useful intermediate update in the current channel while you keep working.',
      'Do not use this for the final answer, for filler, or to post to a different channel.',
      'The normal final reply is still produced automatically at the end of the turn.',
    ],
    schema: SendReplyToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'Intermediate progress update to post into the current channel.' },
      },
      required: ['content'],
    },
    async execute(args, context) {
      const input = SendReplyToolSchema.parse(args);
      const content = sanitizeVisibleText(input.content);

      if (!content || content === NO_REPLY_TOKEN) {
        throw new Error('send_reply requires visible, user-safe content.');
      }

      const message = await chatService.createAgentRelayMessage({
        channelId: context.channelId,
        senderId: context.agentId,
        content,
        contentType: 'MARKDOWN',
        metadata: {
          viaTool: TOOL_SEND_REPLY,
          intermediate: true,
        },
      });

      getChatNamespace().to(getChannelRoom(context.channelId)).emit('message:new', message);

      return {
        output: 'Sent intermediate reply to the current channel.',
        structuredOutput: {
          channelId: context.channelId,
          messageId: message.id,
          content,
        },
      };
    },
  },
  [TOOL_TODO_WRITE]: {
    name: TOOL_TODO_WRITE,
    description: 'Create or update a structured todo list for the current task. Use this for multi-step work so you can track progress across turns.',
    usageGuidance: [
      'Use this when the work has multiple distinct steps, dependencies, or verification stages.',
      'Keep exactly one item in progress whenever possible and mark items complete as soon as they are done.',
      'Use `todoread` if you need to inspect the current task list before updating it.',
    ],
    schema: TodoWriteToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          description: 'The full updated todo list.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: 'Brief description of the task.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['content', 'status', 'priority'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(args, context) {
      const input = TodoWriteToolSchema.parse(args);
      await writeTodoState(context.agentId, input.todos);
      return {
        output: JSON.stringify(input.todos, null, 2),
        structuredOutput: {
          todoCount: input.todos.length,
          pendingCount: input.todos.filter((todo) => todo.status !== 'completed').length,
          filePath: displayWorkspacePath(context.agentId, getTodoStatePath(context.agentId)),
        },
      };
    },
  },
  [TOOL_TODO_READ]: {
    name: TOOL_TODO_READ,
    description: 'Read the current structured todo list for this workspace task state.',
    usageGuidance: [
      'Use this before updating a todo list if you need the latest saved state.',
      'Use this to resume multi-step work without rebuilding the plan from scratch.',
      'If there is no saved todo list yet, this returns an empty list.',
    ],
    schema: TodoReadToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, context) {
      const todos = await readTodoState(context.agentId);
      return {
        output: JSON.stringify(todos, null, 2),
        structuredOutput: {
          todoCount: todos.length,
          filePath: displayWorkspacePath(context.agentId, getTodoStatePath(context.agentId)),
        },
      };
    },
  },
  [TOOL_WEBSEARCH]: {
    name: TOOL_WEBSEARCH,
    description: `Search the web using Exa AI. Returns up-to-date information from real websites. Use this for current events, recent documentation, or anything beyond your knowledge cutoff. The current year is ${new Date().getFullYear()}.`,
    usageGuidance: [
      'Use this when you need live or recent information not in your training data.',
      'Be specific — a precise query returns better results than a vague one.',
      "Use type='deep' for research tasks where comprehensive coverage matters.",
      "Use type='fast' for quick factual lookups.",
      `Always use the current year (${new Date().getFullYear()}) when searching for recent news or releases.`,
    ],
    schema: WebSearchToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query' },
        numResults: { type: 'number', description: 'Number of results to return (default: 8)' },
        livecrawl: { type: 'string', enum: ['fallback', 'preferred'], description: "Live crawl mode — 'fallback': use live crawling as backup, 'preferred': prioritize live crawling" },
        type: { type: 'string', enum: ['auto', 'fast', 'deep'], description: "Search type — 'auto': balanced (default), 'fast': quick results, 'deep': comprehensive" },
        contextMaxCharacters: { type: 'number', description: 'Maximum characters for context string (default: 10000)' },
      },
      required: ['query'],
    },
    async execute(args, context) {
      void context;
      const input = WebSearchToolSchema.parse(args);

      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query: input.query,
            type: input.type ?? 'auto',
            numResults: input.numResults ?? 8,
            livecrawl: input.livecrawl ?? 'fallback',
            ...(input.contextMaxCharacters ? { contextMaxCharacters: input.contextMaxCharacters } : {}),
          },
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBSEARCH_TIMEOUT_MS);

      try {
        const response = await fetch(EXA_MCP_URL, {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Web search failed (${response.status}): ${errorText}`);
        }

        const responseText = await response.text();

        // Parse SSE response — find the first data line with results
        for (const line of responseText.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6)) as { result?: { content?: Array<{ type: string; text: string }> } };
            if (data.result?.content?.[0]?.text) {
              return {
                output: data.result.content[0].text,
                structuredOutput: { query: input.query, numResults: input.numResults ?? 8 },
              };
            }
          }
        }

        return {
          output: 'No search results found. Try a different or more specific query.',
          structuredOutput: { query: input.query, numResults: 0 },
        };
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Web search timed out after 25 seconds.', { cause: error });
        }
        throw error;
      }
    },
  },
  [TOOL_WEBFETCH]: {
    name: TOOL_WEBFETCH,
    description: 'Fetch the content of any public URL and return it as text or markdown. Use this to read documentation pages, articles, API references, or any web resource.',
    usageGuidance: [
      'Use this to read a specific URL when you already have the link.',
      'Prefer websearch when you need to discover relevant pages first.',
      "Use format='markdown' (default) for readable content; 'html' only if you need the raw markup.",
      'Content larger than 5MB will be rejected.',
    ],
    schema: WebFetchToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL to fetch content from' },
        format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Format to return content in — text, markdown, or html (default: markdown)' },
        timeout: { type: 'number', description: 'Optional timeout in seconds (max 120)' },
      },
      required: ['url'],
    },
    async execute(args, context) {
      void context;
      const input = WebFetchToolSchema.parse(args);

      if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://');
      }

      const timeoutMs = Math.min((input.timeout ?? WEBFETCH_TIMEOUT_MS / 1_000) * 1_000, WEBFETCH_MAX_TIMEOUT_MS);
      const format = input.format ?? 'markdown';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(input.url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        clearTimeout(timer);

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > WEBFETCH_MAX_BYTES) {
          throw new Error('Response too large (exceeds 5MB limit)');
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > WEBFETCH_MAX_BYTES) {
          throw new Error('Response too large (exceeds 5MB limit)');
        }

        const contentType = response.headers.get('content-type') ?? '';
        const isHtml = contentType.includes('text/html');
        const rawText = new TextDecoder().decode(buffer);

        let output: string;
        if (format === 'html') {
          output = rawText;
        } else if (format === 'markdown' && isHtml) {
          output = htmlToMarkdown(rawText);
        } else if (format === 'text' && isHtml) {
          output = stripHtmlTags(rawText);
        } else {
          output = rawText;
        }

        return {
          output,
          structuredOutput: {
            url: input.url,
            format,
            contentType,
            byteLength: buffer.byteLength,
          },
        };
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Web fetch timed out after ${timeoutMs / 1_000} seconds.`, { cause: error });
        }
        throw error;
      }
    },
  },
  [TOOL_SKILL_ACTIVATE]: {
    name: TOOL_SKILL_ACTIVATE,
    description: 'Activate an on-demand or tool-based skill for this turn. The skill\'s instructions are injected into your context so you can follow them immediately.',
    usageGuidance: [
      'Use this at the start of a turn when you recognise the task matches one of your skills.',
      'Call skill_list first if you are not sure what skills are available.',
      'Passive skills are already in your context — you do not need to activate them.',
      'After activation, follow the skill instructions for the rest of this turn.',
    ],
    schema: SkillActivateToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Exact skill name (slug) to activate.' },
      },
      required: ['name'],
    },
    async execute(args, context) {
      const input = SkillActivateToolSchema.parse(args);
      const skill = await prisma.agentSkill.findUnique({
        where: { agentId_name: { agentId: context.agentId, name: input.name } },
      });

      if (!skill || !skill.isActive) {
        throw new Error(`Skill "${input.name}" not found or is inactive. Call skill_list to see available skills.`);
      }

      if (skill.type === 'PASSIVE') {
        return {
          output: `Skill "${input.name}" is passive — its instructions are already in your context at all times. No activation needed.`,
          structuredOutput: { name: input.name, type: 'PASSIVE', alreadyActive: true },
        };
      }

      const files = await skillService.readSkillFiles(context.agentId, input.name);
      const content = files.find((file: { path: string; content: string }) => file.path === 'SKILL.md')?.content ?? '';

      if (!content.trim()) {
        throw new Error(`Skill "${input.name}" exists but has no content. Edit it in the agent workspace.`);
      }

      const toolNames: string[] = skill.toolNames ? (JSON.parse(skill.toolNames) as string[]) : [];
      const toolSection = toolNames.length > 0
        ? `\n\n**Tools this skill focuses on:** ${toolNames.join(', ')}`
        : '';
      const resources = files
        .filter((file: { path: string; content: string }) => file.path !== 'SKILL.md')
        .map((file: { path: string; content: string }) => file.path)
        .sort((left: string, right: string) => left.localeCompare(right));
      const resourceSection = resources.length > 0
        ? `\n\n<skill_resources>\n${resources.map((file: string) => `<file>${file}</file>`).join('\n')}\n</skill_resources>`
        : '';

      return {
        output: `<skill_content name="${skill.name}">\n# Skill activated: ${skill.name}\n**Type:** ${skill.type}${skill.description ? `\n**Purpose:** ${skill.description}` : ''}\n\n---\n\n${content}${toolSection}${resourceSection}\n</skill_content>`,
        structuredOutput: { name: skill.name, type: skill.type, description: skill.description ?? null, toolNames },
      };
    },
  },
  [TOOL_SKILL_LIST]: {
    name: TOOL_SKILL_LIST,
    description: 'List all skills available to you, grouped by type (PASSIVE, ON_DEMAND, TOOL_BASED).',
    usageGuidance: [
      'Use this when you want to know which skills you have before activating one.',
      'Passive skills are already active — they appear here for reference only.',
    ],
    schema: SkillListToolSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, context) {
      const skills = await prisma.agentSkill.findMany({
        where: { agentId: context.agentId, isActive: true },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      });

      if (skills.length === 0) {
        return {
          output: 'No skills are configured for this agent yet.',
          structuredOutput: { skills: [] },
        };
      }

      const grouped: Record<string, string[]> = { PASSIVE: [], ON_DEMAND: [], TOOL_BASED: [] };
      for (const s of skills) {
        const line = `  - **${s.name}**${s.description ? `: ${s.description}` : ''}`;
        grouped[s.type]?.push(line);
      }

      const sections: string[] = ['## Your Skills'];
      for (const [type, lines] of Object.entries(grouped)) {
        if (lines.length === 0) continue;
        const label = type === 'PASSIVE' ? 'Passive (always active)'
          : type === 'ON_DEMAND' ? 'On-demand (activate with skill_activate)'
          : 'Tool-based (activate with skill_activate)';
        sections.push(`\n### ${label}\n${lines.join('\n')}`);
      }

      return {
        output: sections.join('\n'),
        structuredOutput: { skills: skills.map((s) => ({ name: s.name, type: s.type, description: s.description ?? null })) },
      };
    },
  },
  [TOOL_SKILL_INSTALL]: {
    name: TOOL_SKILL_INSTALL,
    description: 'Download and install a skill from any public source — GitHub, clawhub.ai, or a direct markdown URL. Fetches the raw content, parses frontmatter for metadata, and registers the skill. Always tell the user what type of skill was installed.',
    usageGuidance: [
      'Use this when the user asks you to install or download a skill from a URL.',
      'Supported sources include GitHub repos, directories, blob/raw URLs, clawhub.ai pages, gists, npm/unpkg, direct .md URLs, and generic public pages that expose skill markdown.',
      'For multi-skill repositories, pass the specific skill name in `skill`, or use `?skill=name` on the source URL.',
      'Frontmatter in the skill file (name, description, type, toolNames) is parsed automatically, including simple list syntax for toolNames.',
      'If the skill has no frontmatter, pass a "name" and optionally a "type" parameter.',
      'After installing, always tell the user: the skill name, its type (PASSIVE / ON_DEMAND / TOOL_BASED), and how to use it.',
      'PASSIVE skills are injected automatically every turn — no activation needed.',
      'ON_DEMAND and TOOL_BASED skills require calling skill_activate("name") at the start of a relevant turn.',
    ],
    schema: SkillInstallToolSchema,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Skill source reference such as a GitHub repo/file URL, clawhub page, gist, npm package, or direct markdown URL.' },
          name: { type: 'string', description: 'Override skill name slug (lowercase, hyphens only). Derived from URL/frontmatter if omitted.' },
          skill: { type: 'string', description: 'Optional selector for a specific skill inside a multi-skill repository.' },
          type: { type: 'string', enum: ['PASSIVE', 'ON_DEMAND', 'TOOL_BASED'], description: 'Override skill type. Parsed from frontmatter or defaults to ON_DEMAND.' },
        },
      required: ['url'],
    },
    async execute(args, context) {
      const input = SkillInstallToolSchema.parse(args);
      const installed = await skillInstallerService.installFromSource(context.agentId, input);
      const { skill } = installed;

      const typeNote = skill.type === 'PASSIVE'
        ? `**Passive skill** — automatically injected into your context every turn. No activation needed.`
        : skill.type === 'ON_DEMAND'
          ? `**On-demand skill** — call \`skill_activate("${skill.name}")\` at the start of a relevant turn to load its instructions.`
          : `**Tool-based skill** — call \`skill_activate("${skill.name}")\` to load its instructions and tool guidance.`;

      return {
        output: [
          `Skill **${skill.name}** ${installed.action} successfully.`,
          `**Type:** ${skill.type}`,
          skill.description ? `**Description:** ${skill.description}` : '',
          skill.toolNames.length > 0 ? `**Tools:** ${skill.toolNames.join(', ')}` : '',
          `**Source Type:** ${installed.sourceKind}`,
          `**Source:** ${installed.resolvedFrom}`,
          '',
          typeNote,
        ].filter(Boolean).join('\n'),
        structuredOutput: {
          name: skill.name,
          type: skill.type,
          description: skill.description,
          toolNames: skill.toolNames,
          action: installed.action,
          source: installed.resolvedFrom,
          sourceKind: installed.sourceKind,
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

    return tools.map((tool) => {
      const definition = builtInTools[tool.toolName];
      return [
        `### ${tool.toolName}`,
        definition?.description ?? 'No description.',
        ...(definition?.usageGuidance ?? []).map((item) => `- ${item}`),
      ].join('\n');
    }).join('\n\n');
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
