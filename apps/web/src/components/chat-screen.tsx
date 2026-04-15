/**
 * Chat Screen
 *
 * Teams-style chat shell: fixed sidebar with Direct Messages, Channels, and
 * Projects sections; a main content area that renders either a chat thread or
 * a project detail panel; and streaming agent responses with per-agent bubbles.
 *
 * Phase 6 implementation status:
 * - Direct Messages: one item per agent, clicking opens or creates a DM channel
 * - Groups: standalone group channels (not in a project), show only group name
 * - Projects: expandable containers with sub-channels and an editable project.md
 * - Project detail panel: edit project name, description, and project.md inline
 * - New-agent and new-group modals remain in place
 * - Live tool-call log streams tool calls in real-time, then the agent answer streams below
 */

'use client';

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type {
  AgentSummary,
  CompactChannelSessionResult,
  ChannelSessionSummary,
  ChannelSummary,
  CreateAgentInput,
  CreateChannelInput,
  MessageRecord,
  ProviderModelsResponse,
  ProviderStatus,
  ProjectSummary,
  WorkspaceSummary,
  WorkspaceDocRecord,
} from '@nextgenchat/types';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';
import { getChatSocket } from '@/lib/socket';

type AgentState = 'idle' | 'queued' | 'streaming' | 'error';
type NavView = 'chat' | 'project-detail';

interface SlashSuggestion { label: string; value: string; hint: string; }
interface AgentStream { agentId: string; text: string }
type ToolCallStatus = 'running' | 'success' | 'failed';

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type TodoPriority = 'high' | 'medium' | 'low';
interface AgentTodo { content: string; status: TodoStatus; priority: TodoPriority; }
interface AgentTodoList { agentId: string; agentName: string; todos: AgentTodo[]; }
type NewAgentForm = CreateAgentInput & {
  providerName?: ProviderStatus['providerName'];
  model?: string;
};
interface DraftAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentBase64: string;
}

interface ToolCallDetail {
  toolCallId?: string;
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  arguments?: unknown;
  output?: string;
  structuredOutput?: unknown;
  status?: ToolCallStatus;
}

interface LiveToolCall extends ToolCallDetail {
  toolCallId: string;
  status: ToolCallStatus;
}

const emptyAgentForm: NewAgentForm = {
  name: '', persona: '', systemPrompt: '', voiceTone: '', triggerMode: 'AUTO', providerName: 'openai', model: 'gpt-5.4',
};

const SELECTED_CHANNEL_STORAGE_KEY = 'nextgenchat:selected-channel-id';
const UNREAD_COUNTS_STORAGE_KEY = 'nextgenchat:unread-counts';

function readStoredSelectedChannelId() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SELECTED_CHANNEL_STORAGE_KEY);
}

function readStoredUnreadCounts() {
  if (typeof window === 'undefined') return {} as Record<string, number>;

  try {
    const raw = window.localStorage.getItem(UNREAD_COUNTS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0),
    );
  } catch {
    return {};
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isAgentFailure(message: MessageRecord) {
  return message.senderType === 'AGENT' && (message.contentType === 'SYSTEM' || typeof message.metadata?.error === 'string');
}

function getMessageToolCalls(message: MessageRecord): ToolCallDetail[] {
  const raw = message.metadata?.toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ToolCallDetail => typeof entry === 'object' && entry !== null);
}

function getMessageAttachments(message: MessageRecord) {
  const raw = message.metadata?.attachments;
  if (!Array.isArray(raw)) return [] as Array<{
    id?: string;
    fileName: string;
    mimeType: string;
    fileSize?: number;
    relativePath?: string;
  }>;

  return raw.filter((entry): entry is {
    id?: string;
    fileName: string;
    mimeType: string;
    fileSize?: number;
    relativePath?: string;
  } => typeof entry === 'object' && entry !== null && typeof (entry as { fileName?: unknown }).fileName === 'string' && typeof (entry as { mimeType?: unknown }).mimeType === 'string');
}

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return window.btoa(binary);
}

async function filesToDraftAttachments(files: File[]) {
  return Promise.all(files.map(async (file) => ({
    id: crypto.randomUUID(),
    fileName: file.name || `pasted-image-${Date.now()}.png`,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    contentBase64: await fileToBase64(file),
  })));
}

function getScheduledMessageKind(message: MessageRecord): 'ONCE' | 'CRON' | null {
  const raw = message.metadata?.schedule;
  if (!raw || typeof raw !== 'object') return null;

  const source = 'source' in raw ? raw.source : null;
  const kind = 'kind' in raw ? raw.kind : null;

  if (source !== 'agent-cron') return null;
  return kind === 'ONCE' || kind === 'CRON' ? kind : 'CRON';
}

function formatToolData(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function getToolCallStatus(tc: ToolCallDetail): ToolCallStatus {
  if (tc.status) return tc.status;
  return tc.success ? 'success' : 'failed';
}

// ── @mention highlighter ──────────────────────────────────────────────────────

const MENTION_RE = /(@\w+)/g;

/** Recursively walk React children; wrap @word tokens in a red mention span. */
function mentionify(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string' && MENTION_RE.test(child)) {
      MENTION_RE.lastIndex = 0; // reset after .test()
      const parts = child.split(MENTION_RE);
      return parts.map((part, i) =>
        MENTION_RE.test(part)
          ? (
            <span
              key={i}
              className="font-semibold"
              style={{ color: 'var(--sr-400)' }}
            >
              {part}
            </span>
          )
          : part,
      );
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
      return React.cloneElement(child, {}, mentionify(child.props.children));
    }
    return child;
  });
}

// ── Inline todos — compact list shown inside a message bubble ────────────────

function InlineTodos({ todos }: { todos: AgentTodo[] }) {
  if (todos.length === 0) return null;
  return (
    <div
      className="mt-3 space-y-0.5 rounded-lg px-3 py-2"
      style={{ background: 'rgba(13,15,22,0.5)', border: '1px solid var(--outline-variant)' }}
    >
      {todos.map((todo, i) => {
        const isDone      = todo.status === 'completed';
        const isCancelled = todo.status === 'cancelled';
        const isActive    = todo.status === 'in_progress';
        return (
          <div className="flex items-center gap-2 py-[3px]" key={i}>
            {/* status icon */}
            <span
              className="shrink-0 text-[11px] leading-none"
              style={{
                color: isDone ? '#22c55e' : isActive ? 'var(--ib-400)' : isCancelled ? 'var(--sr-600)' : 'var(--ib-700)',
                animation: isActive ? 'typing 2s ease-in-out infinite' : 'none',
              }}
            >
              {isDone ? '✓' : isActive ? '◎' : isCancelled ? '✕' : '○'}
            </span>
            {/* text */}
            <span
              className="text-[12px] leading-[1.4]"
              style={{
                color: isDone || isCancelled ? 'var(--ib-700)' : isActive ? 'var(--ib-200)' : 'var(--ib-500)',
                textDecoration: isCancelled ? 'line-through' : 'none',
              }}
            >
              {todo.content}
            </span>
            {/* priority pip — only on pending/active */}
            {!isDone && !isCancelled && (
              <span
                className="ml-auto h-1 w-1 shrink-0 rounded-full"
                style={{ background: todo.priority === 'high' ? 'var(--sr-500)' : todo.priority === 'medium' ? 'var(--ib-500)' : 'var(--ib-800)' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Code block with language label + copy button ─────────────────────────────

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') ?? 'code';
  const displayLang: Record<string, string> = {
    js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
    jsx: 'JSX', tsx: 'TSX', py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby',
    rs: 'Rust', rust: 'Rust', go: 'Go', java: 'Java', cs: 'C#', cpp: 'C++', c: 'C',
    sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish', ps1: 'PowerShell',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', html: 'HTML',
    css: 'CSS', scss: 'SCSS', sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL',
    md: 'Markdown', markdown: 'Markdown', dockerfile: 'Dockerfile', swift: 'Swift',
    kt: 'Kotlin', kotlin: 'Kotlin', php: 'PHP', r: 'R', lua: 'Lua', vim: 'Vim',
  };
  const label = displayLang[lang] ?? lang;

  function copy() {
    const text = typeof children === 'string'
      ? children
      : Array.isArray(children)
        ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
        : '';
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <div
      className="my-3 overflow-hidden rounded-xl"
      style={{ background: 'var(--ti-950)', border: '1px solid var(--ti-700)' }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ background: 'var(--ti-900)', borderBottom: '1px solid var(--ti-800)' }}
      >
        <span className="font-mono text-[11px] font-medium" style={{ color: 'var(--ib-500)' }}>
          {label}
        </span>
        <button
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          onClick={copy}
          style={{
            color: copied ? '#22c55e' : 'var(--ib-500)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = copied ? '#22c55e' : 'var(--ib-300)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = copied ? '#22c55e' : 'var(--ib-500)'; }}
          type="button"
        >
          {copied ? (
            <>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect height="13" rx="2" width="13" x="9" y="9" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      {/* Code body */}
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-6" style={{ color: 'var(--ib-200)', margin: 0 }}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

// ── Agent markdown renderer ───────────────────────────────────────────────────

function AgentMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="agent-md text-[14px] leading-[1.8]" style={{ color: 'var(--ib-100)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings
          h1: ({ children }) => (
            <h1 className="font-headline mt-5 mb-3 text-[20px] font-bold leading-tight" style={{ color: 'var(--on-surface)' }}>{mentionify(children)}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="font-headline mt-4 mb-2.5 text-[17px] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>{mentionify(children)}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="font-headline mt-3 mb-2 text-[15px] font-semibold leading-tight" style={{ color: 'var(--ib-200)' }}>{mentionify(children)}</h3>
          ),
          // Paragraph — no extra margin on first child
          p: ({ children }) => (
            <p className="mb-3 last:mb-0">{mentionify(children)}</p>
          ),
          // Bold / italic
          strong: ({ children }) => (
            <strong className="font-semibold" style={{ color: 'var(--on-surface)' }}>{mentionify(children)}</strong>
          ),
          em: ({ children }) => (
            <em className="italic" style={{ color: 'var(--ib-200)' }}>{mentionify(children)}</em>
          ),
          // Inline code vs block code
          code: ({ children, className }) => {
            const isBlock = className?.startsWith('language-');
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
            return (
              <code
                className="rounded px-1.5 py-0.5 font-mono text-[12.5px]"
                style={{ background: 'var(--ti-800)', color: 'var(--ib-300)', border: '1px solid var(--ti-700)' }}
              >
                {children}
              </code>
            );
          },
          // pre is a passthrough — CodeBlock renders its own pre
          pre: ({ children }) => <>{children}</>,
          // Lists
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 pl-5 list-decimal">{children}</ol>
          ),
          li: ({ children, ...props }) => {
            // ordered list items use list-decimal (CSS), unordered get a custom dot
            const ordered = (props as { ordered?: boolean }).ordered;
            return (
              <li className={`relative ${ordered ? 'pl-0' : 'pl-1 list-none'}`}>
                {!ordered && (
                  <span
                    className="absolute -left-3 top-[0.62em] h-1.5 w-1.5 rounded-full"
                    style={{ background: 'var(--ib-500)' }}
                  />
                )}
                {mentionify(children)}
              </li>
            );
          },
          // Blockquote
          blockquote: ({ children }) => (
            <blockquote
              className="my-3 pl-4 italic"
              style={{
                borderLeft: '3px solid var(--ib-600)',
                color: 'var(--ib-400)',
              }}
            >
              {mentionify(children)}
            </blockquote>
          ),
          // Horizontal rule
          hr: () => (
            <hr className="my-4" style={{ borderColor: 'var(--outline-variant)', borderTopWidth: '1px' }} />
          ),
          // Links
          a: ({ href, children }) => (
            <a
              className="underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
              href={href}
              rel="noopener noreferrer"
              style={{ color: 'var(--ib-400)' }}
              target="_blank"
            >
              {children}
            </a>
          ),
          // Tables
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-xl" style={{ border: '1px solid var(--outline-variant)' }}>
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead style={{ background: 'var(--ti-900)', borderBottom: '1px solid var(--outline-variant)' }}>{children}</thead>
          ),
          th: ({ children }) => (
            <th
              className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: 'var(--ib-400)' }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="px-4 py-2.5"
              style={{ color: 'var(--ib-100)', borderTop: '1px solid var(--outline-variant)' }}
            >
              {mentionify(children)}
            </td>
          ),
          // Checkboxes in task lists
          input: ({ checked }) => (
            <span
              className="mr-1.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[9px]"
              style={{
                background: checked ? 'var(--primary)' : 'transparent',
                border: `1px solid ${checked ? 'var(--primary)' : 'var(--outline)'}`,
                color: '#fff',
              }}
            >
              {checked ? '✓' : ''}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
      {streaming && (
        <span
          className="inline-block h-4 w-[2px] ml-0.5 align-middle"
          style={{ background: 'var(--ib-400)', animation: 'blink 1s step-end infinite' }}
        />
      )}
    </div>
  );
}

/** Generate a stable avatar color from a name string */
function avatarColor(name: string): string {
  const palette = [
    '#7289c0', // ink-black-400
    '#5e6ca1', // twilight-indigo-500
    '#766f90', // vintage-grape-500
    '#5e5973', // vintage-grape-600
    '#7e89b4', // twilight-indigo-400
    '#4f6cb0', // ink-black-500
    '#918ca6', // vintage-grape-400
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
  return palette[Math.abs(h) % palette.length];
}

function getToolLabel(tc: ToolCallDetail): string {
  const args = (tc.arguments && typeof tc.arguments === 'object') ? tc.arguments as Record<string, unknown> : {};
  switch (tc.toolName) {
    case 'workspace_read_file':   return `read  ${typeof args.filePath === 'string' ? args.filePath : 'file'}`;
    case 'workspace_write_file':  return `write ${typeof args.filePath === 'string' ? args.filePath : 'file'}`;
    case 'workspace_glob':        return `glob  ${typeof args.pattern === 'string' ? args.pattern : '**'}`;
    case 'workspace_grep':        return `grep  ${typeof args.pattern === 'string' ? `"${args.pattern}"` : ''}`;
    case 'workspace_bash':        return `bash  ${typeof args.command === 'string' ? args.command.slice(0, 48) : ''}`;
    case 'send_reply':            return 'send_reply';
    case 'todowrite':             return 'todowrite';
    case 'todoread':              return 'todoread';
    case 'channel_send_message':  return `relay → ${typeof args.channelName === 'string' ? `#${args.channelName}` : 'channel'}`;
    default: return tc.toolName ?? 'tool';
  }
}

// ── Tool Log ──────────────────────────────────────────────────────────────────
// Shared component used for both live streaming and completed messages.

function ToolLog({ calls, live = false }: { calls: ToolCallDetail[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(live);

  // Keep expanded whenever the live prop flips on (e.g. new tool call arrives).
  // Using a layout effect keeps it synchronous and avoids the react-hooks/set-state-in-effect lint rule.
  if (live && !expanded) setExpanded(true);

  if (calls.length === 0) return null;

  const runningCount = calls.filter((c) => getToolCallStatus(c) === 'running').length;
  const failedCount  = calls.filter((c) => getToolCallStatus(c) === 'failed').length;
  const totalMs      = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0);

  return (
    <div className="mb-3" style={{ fontFamily: 'var(--font-geist-mono)' }}>
      {/* Header toggle */}
      <button
        className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left text-[11px] transition-colors"
        onClick={() => setExpanded((v) => !v)}
        style={{
          background: expanded ? 'var(--ti-800)' : 'var(--ti-900)',
          border: '1px solid var(--ib-700)',
          borderBottom: expanded ? '1px solid var(--ib-800)' : '1px solid var(--ib-700)',
          borderRadius: expanded ? '8px 8px 0 0' : '8px',
          color: 'var(--ib-300)',
        }}
        type="button"
      >
        <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="flex-1 font-semibold uppercase tracking-widest text-[10px]">
          {live ? 'Tool Activity' : 'Tools'}
        </span>
        <div className="flex items-center gap-2" style={{ color: 'var(--ib-400)' }}>
          <span>{calls.length} call{calls.length !== 1 ? 's' : ''}</span>
          {runningCount > 0 && (
            <span style={{ color: 'var(--warning)' }} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse inline-block" />
              {runningCount} running
            </span>
          )}
          {failedCount > 0 && <span style={{ color: 'var(--sr-300)' }}>{failedCount} failed</span>}
          {!live && totalMs > 0 && <span style={{ color: 'var(--ib-600)' }}>{totalMs}ms</span>}
          <svg
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>

      {/* Log lines */}
      {expanded && (
        <div
          className="overflow-hidden rounded-b-lg"
          style={{ border: '1px solid var(--ib-700)', borderTop: 'none', background: 'var(--ib-950)' }}
        >
          {calls.map((tc, idx) => {
            const status = getToolCallStatus(tc);
            const label  = getToolLabel(tc);
            return (
              <ToolLogLine key={tc.toolCallId ?? `${tc.toolName ?? 'tool'}-${idx}`} tc={tc} status={status} label={label} live={live} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolLogLine({ tc, status, label, live }: { tc: ToolCallDetail; status: ToolCallStatus; label: string; live: boolean }) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div className="tool-line-enter" style={{ borderBottom: '1px solid var(--ti-900)' }}>
      <button
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-white/[0.03]"
        onClick={() => !live && setDetailOpen((v) => !v)}
        style={{ cursor: live ? 'default' : 'pointer' }}
        type="button"
      >
        {/* Status icon */}
        <span className="shrink-0 w-4 text-center">
          {status === 'running' ? (
            <span className="inline-block h-2 w-2 animate-spin rounded-full" style={{ border: '1.5px solid var(--ib-400)', borderTopColor: 'transparent' }} />
          ) : status === 'success' ? (
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" style={{ color: 'var(--success)' }}>
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" style={{ color: 'var(--sr-400)' }}>
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>

        {/* Tool label */}
        <span
          className="flex-1 truncate"
          style={{
            color: status === 'running' ? 'var(--ib-200)' : status === 'success' ? 'var(--ib-400)' : 'var(--sr-300)',
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          {label}
        </span>

        {/* Duration */}
        {typeof tc.durationMs === 'number' && (
          <span className="shrink-0 tabular-nums" style={{ color: 'var(--ib-700)' }}>
            {tc.durationMs}ms
          </span>
        )}

        {/* Expand indicator */}
        {!live && (tc.arguments != null || tc.output) && (
          <svg
            className={`h-3 w-3 shrink-0 transition-transform ${detailOpen ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
            style={{ color: 'var(--ib-700)' }}
          >
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Expanded detail */}
      {detailOpen && (tc.arguments != null || tc.output) && (
        <div
          className="px-3 py-2 text-[11px]"
          style={{ background: 'var(--ti-950)', borderTop: '1px solid var(--ti-800)' }}
        >
          {tc.arguments != null && (
            <div className="mb-2">
              <span className="block mb-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--ib-600)' }}>args</span>
              <pre className="overflow-x-auto whitespace-pre-wrap" style={{ color: 'var(--ib-300)', fontFamily: 'var(--font-geist-mono)' }}>
                {formatToolData(tc.arguments)}
              </pre>
            </div>
          )}
          {tc.output && (
            <div>
              <span className="block mb-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--ib-600)' }}>output</span>
              <pre className="overflow-x-auto whitespace-pre-wrap max-h-32" style={{ color: 'var(--ib-300)', fontFamily: 'var(--font-geist-mono)' }}>
                {formatToolData(tc.output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Slash suggestions ─────────────────────────────────────────────────────────

function buildSlashSuggestions(input: { draft: string; activeAgents: AgentSummary[] }): SlashSuggestion[] {
  if (!input.draft.startsWith('/')) return [];
  const trimmed = input.draft.trimStart();
  if (trimmed === '/' || '/compact'.startsWith(trimmed)) {
    return [{ label: '/compact', value: '/compact ', hint: 'Compact session for one agent or all' }];
  }
  if (trimmed.startsWith('/compact')) {
    const raw = trimmed.slice('/compact'.length).trim().toLowerCase();
    const list: SlashSuggestion[] = [
      { label: '/compact all', value: '/compact all', hint: 'Compact for all active agents' },
      ...input.activeAgents.map((a) => ({ label: `/compact ${a.slug}`, value: `/compact ${a.slug}`, hint: `Compact for ${a.name}` })),
    ];
    return list.filter((s) => raw.length === 0 || s.value.toLowerCase().includes(raw));
  }
  return [];
}

function parseCompactCommand(draft: string) {
  const t = draft.trim();
  if (!t.startsWith('/compact')) return null;
  const target = t.slice('/compact'.length).trim();
  if (!target || target.toLowerCase() === 'all') return { all: true } as const;
  return { agentSlug: target } as const;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      style={{ background: 'rgba(5,7,14,0.85)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6"
        style={{
          background: 'var(--ti-900)',
          border: '1px solid var(--ib-700)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          animation: 'slide-up 0.2s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="font-headline text-[14px] font-semibold" style={{ color: 'var(--ib-100)' }}>{title}</h3>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            onClick={onClose}
            style={{ color: 'var(--ib-500)' }}
            type="button"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const mIS = { background: 'var(--ib-900)', border: '1px solid var(--ib-800)', color: 'var(--ib-100)' };
const mFC = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.target.style.borderColor = 'var(--ib-400)'; };
const mFB = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.target.style.borderColor = 'var(--ib-800)'; };
const mIC = 'w-full rounded-xl px-3 py-2 text-[13px] outline-none placeholder:opacity-30';

function MI({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input className={mIC} onBlur={mFB} onChange={(e) => onChange(e.target.value)} onFocus={mFC} placeholder={placeholder} style={mIS} type={type} value={value} />;
}
function MT({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <textarea className={`${mIC} resize-none min-h-20`} onBlur={mFB as unknown as React.FocusEventHandler<HTMLTextAreaElement>} onChange={(e) => onChange(e.target.value)} onFocus={mFC as unknown as React.FocusEventHandler<HTMLTextAreaElement>} placeholder={placeholder} rows={3} style={{ ...mIS, minHeight: '80px' }} value={value} />;
}
function MS({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return <select className={mIC} onBlur={mFB as unknown as React.FocusEventHandler<HTMLSelectElement>} onChange={(e) => onChange(e.target.value)} onFocus={mFC as unknown as React.FocusEventHandler<HTMLSelectElement>} style={mIS} value={value}>{children}</select>;
}
function MB({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      className="font-headline mt-1 w-full rounded-xl py-2.5 text-[13px] font-semibold transition active:scale-[0.98] disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      style={{ background: 'var(--ib-500)', color: 'var(--ib-50)' }}
      type="button"
    >
      {children}
    </button>
  );
}
function AgentCheckList({ agents, ids, toggle }: { agents: AgentSummary[]; ids: string[]; toggle: (id: string) => void }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--ib-800)' }}>
      {agents.map((agent) => (
        <label
          className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] transition-colors hover:bg-white/5"
          key={agent.id}
          style={{ borderBottom: '1px solid var(--ib-900)', color: 'var(--ib-200)' }}
        >
          <div
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
            style={{ background: avatarColor(agent.name), color: 'var(--ib-50)' }}
          >
            {agent.name.slice(0, 1).toUpperCase()}
          </div>
          <span className="flex-1">{agent.name}</span>
          <input
            checked={ids.includes(agent.id)}
            className="accent-primary h-4 w-4"
            onChange={() => toggle(agent.id)}
            type="checkbox"
          />
        </label>
      ))}
    </div>
  );
}

// ── Sidebar Section ───────────────────────────────────────────────────────────

function SidebarSection({ label, children, onAdd, addLabel }: {
  label: string; children: React.ReactNode; onAdd?: () => void; addLabel?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center px-3">
        <button
          className="flex flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <svg
            className={`h-2 w-2 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="currentColor"
            style={{ color: 'var(--ib-600)' }}
            viewBox="0 0 6 10"
          >
            <path d="M0 0l6 5-6 5V0z" />
          </svg>
          <span
            className="font-headline text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: 'var(--ib-600)' }}
          >
            {label}
          </span>
        </button>
        {onAdd && (
          <button
            className="flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-white/10"
            onClick={onAdd}
            style={{ color: 'var(--ib-500)' }}
            title={addLabel}
            type="button"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {open && <div className="space-y-0.5 px-2">{children}</div>}
    </div>
  );
}

// ── Sidebar items ─────────────────────────────────────────────────────────────

function UnreadBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;

  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
      style={{
        background: active ? 'var(--ib-300)' : 'var(--primary)',
        color: active ? 'var(--ib-950)' : '#fff',
        minWidth: count > 9 ? '22px' : '18px',
        textAlign: 'center',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function DMItem({ channel, active, onClick, agent, unreadCount }: {
  channel: ChannelSummary; active: boolean; onClick: () => void; agent: AgentSummary; unreadCount: number;
}) {
  const name   = channel.participantAgentNames[0] ?? channel.name;
  const color  = avatarColor(name);
  const initials = name.slice(0, 2).toUpperCase();

  return (
    <button
      className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all"
      onClick={onClick}
      style={{
        background: active ? 'rgba(114,137,192,0.18)' : 'transparent',
        border: active ? '1px solid rgba(114,137,192,0.22)' : '1px solid transparent',
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      type="button"
    >
      {/* Avatar with status dot */}
      <div className="relative shrink-0">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold"
          style={{ background: color, color: '#fff' }}
        >
          {initials}
        </div>
        {/* Online dot — always on for agents */}
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
          style={{
            background: agent.status === 'ACTIVE' ? '#22c55e' : 'var(--cs-600)',
            border: '2px solid var(--ti-950)',
          }}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[13px] font-medium leading-none"
          style={{ color: active ? 'var(--ib-100)' : 'var(--ib-300)' }}
        >
          {name}
        </div>
        <div
          className="mt-0.5 text-[10px]"
          style={{ color: active ? 'var(--ib-400)' : 'var(--ib-600)' }}
        >
          {agent.triggerMode === 'AUTO' ? 'auto' : agent.triggerMode === 'DISABLED' ? 'off' : agent.triggerMode.toLowerCase().replace('_', ' ')}
        </div>
      </div>

      {/* AI badge */}
      <div className="flex shrink-0 items-center gap-1.5">
        <UnreadBadge active={active} count={unreadCount} />
        <span
          className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide"
          style={{
            background: active ? 'rgba(114,137,192,0.25)' : 'rgba(114,137,192,0.1)',
            color: active ? 'var(--ib-200)' : 'var(--ib-500)',
          }}
        >
          AI
        </span>
      </div>
    </button>
  );
}

function ChannelItem({ channel, active, onClick, unreadCount }: { channel: ChannelSummary; active: boolean; onClick: () => void; unreadCount: number }) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-all"
      onClick={onClick}
      style={{
        background: active ? 'rgba(114,137,192,0.18)' : 'transparent',
        border: active ? '1px solid rgba(114,137,192,0.22)' : '1px solid transparent',
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      type="button"
    >
      <span className="shrink-0 text-[13px] font-semibold" style={{ color: active ? 'var(--ib-400)' : 'var(--ib-600)' }}>#</span>
      <span
        className="truncate text-[13px] font-medium"
        style={{ color: active ? 'var(--ib-100)' : 'var(--ib-400)' }}
      >
        {channel.name}
      </span>
      <div className="ml-auto">
        <UnreadBadge active={active} count={unreadCount} />
      </div>
    </button>
  );
}

function ProjectItem({ project, subChannels, activeChannelId, activeProjectId, onSelectChannel, onSelectProject, onAddChannel, unreadCounts }: {
  project: ProjectSummary; subChannels: ChannelSummary[];
  activeChannelId: string | null; activeProjectId: string | null;
  onSelectChannel: (id: string) => void; onSelectProject: (id: string) => void;
  onAddChannel: (projectId: string) => void;
  unreadCounts: Record<string, number>;
}) {
  const [open, setOpen] = useState(true);
  const pa = activeProjectId === project.id && !activeChannelId;
  const unreadTotal = subChannels.reduce((sum, channel) => sum + (unreadCounts[channel.id] ?? 0), 0);

  return (
    <div>
      <div className="flex items-center rounded-xl pr-1">
        <button
          className="flex flex-1 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left transition-all"
          onClick={() => { onSelectProject(project.id); setOpen(true); }}
          style={{
            background: pa ? 'rgba(114,137,192,0.18)' : 'transparent',
            border: pa ? '1px solid rgba(114,137,192,0.22)' : '1px solid transparent',
          }}
          onMouseEnter={(e) => { if (!pa) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
          onMouseLeave={(e) => { if (!pa) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          type="button"
        >
          <svg
            className={`h-2 w-2 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="currentColor"
            style={{ color: 'var(--ib-600)' }}
            viewBox="0 0 6 10"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          >
            <path d="M0 0l6 5-6 5V0z" />
          </svg>
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: 'var(--ib-500)' }} viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span
            className="truncate text-[13px] font-medium"
            style={{ color: pa ? 'var(--ib-100)' : 'var(--ib-400)' }}
          >
            {project.name}
          </span>
          <UnreadBadge active={pa} count={unreadTotal} />
        </button>
        <button
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-lg transition-colors hover:bg-white/10"
          onClick={(e) => { e.stopPropagation(); setOpen(true); onAddChannel(project.id); }}
          style={{ color: 'var(--ib-600)' }}
          title="Add channel"
          type="button"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {open && subChannels.length > 0 && (
        <div className="mt-0.5 space-y-0.5 pl-5">
          {subChannels.map((ch) => (
            <button
              className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium transition-all"
              key={ch.id}
              onClick={() => onSelectChannel(ch.id)}
              style={{
                background: activeChannelId === ch.id ? 'rgba(114,137,192,0.15)' : 'transparent',
                color: activeChannelId === ch.id ? 'var(--ib-200)' : 'var(--ib-500)',
              }}
              onMouseEnter={(e) => { if (activeChannelId !== ch.id) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseLeave={(e) => { if (activeChannelId !== ch.id) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              type="button"
            >
              <span style={{ color: 'var(--ib-600)', fontWeight: 700 }}>#</span>
              <span className="truncate">{ch.name}</span>
              <div className="ml-auto">
                <UnreadBadge active={activeChannelId === ch.id} count={unreadCounts[ch.id] ?? 0} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project Detail Panel ──────────────────────────────────────────────────────

function ProjectDetailPanel({ project, accessToken, onProjectUpdated }: {
  project: ProjectSummary; accessToken: string; onProjectUpdated: (p: ProjectSummary) => void;
}) {
  const [fileDoc, setFileDoc] = useState<WorkspaceDocRecord | null>(null);
  const [fileDraft, setFileDraft] = useState('');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name); setDescription(project.description ?? '');
    void apiJson<WorkspaceDocRecord>(`/projects/${project.id}/file`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((doc) => { setFileDoc(doc); setFileDraft(doc.content); }).catch(() => undefined);
  }, [accessToken, project.description, project.id, project.name]);

  async function saveInfo() {
    setSaving(true); setError(null);
    try {
      const u = await apiJson<ProjectSummary>(`/projects/${project.id}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ name, description }),
      });
      onProjectUpdated(u);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setSaving(false); }
  }

  async function saveFile() {
    setSavingFile(true); setError(null);
    try {
      const u = await apiJson<WorkspaceDocRecord>(`/projects/${project.id}/file`, {
        method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ content: fileDraft }),
      });
      setFileDoc(u);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setSavingFile(false); }
  }

  const hasInfo = name !== project.name || description !== (project.description ?? '');
  const hasFile = fileDraft !== (fileDoc?.content ?? '');
  const panelStyle = { background: 'var(--ti-900)', border: '1px solid var(--ib-800)' };

  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ background: 'var(--ib-950)' }}>
      <header
        className="shrink-0 flex items-center justify-between px-8 py-5"
        style={{ borderBottom: '1px solid var(--ib-800)', background: 'var(--ti-950)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'var(--ib-800)' }}>
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: 'var(--ib-300)' }} viewBox="0 0 24 24">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="font-headline text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ib-600)' }}>Project</p>
            <h1 className="font-headline text-xl font-bold" style={{ color: 'var(--ib-100)' }}>{project.name}</h1>
          </div>
        </div>
        <div className="flex gap-2">
          {(['info', 'file'] as const).map((type) => {
            const dis = type === 'info' ? !hasInfo || saving : !hasFile || savingFile;
            const loading = type === 'info' ? saving : savingFile;
            const label = type === 'info' ? 'Save info' : 'Save project.md';
            const onClick = type === 'info' ? saveInfo : saveFile;
            return (
              <button
                key={type}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-30"
                disabled={dis}
                onClick={onClick}
                style={{ background: 'var(--ib-500)', color: 'var(--ib-50)' }}
                type="button"
              >
                {loading ? 'Saving…' : label}
              </button>
            );
          })}
        </div>
      </header>
      {error && (
        <div className="mx-8 mt-4 rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--sr-950)', border: '1px solid var(--sr-800)', color: 'var(--sr-300)' }}>
          {error}
        </div>
      )}
      <div className="flex flex-1 gap-6 p-8">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <section className="rounded-xl p-5" style={panelStyle}>
            <p className="font-headline mb-4 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ib-600)' }}>Info</p>
            <div className="space-y-3">
              {[
                { value: name, onChange: setName, placeholder: 'Project name' },
                { value: description, onChange: setDescription, placeholder: 'Description (optional)' },
              ].map((p, i) => (
                i === 0 ? (
                  <input key={i} className="w-full rounded-lg px-3 py-2 text-sm outline-none" onBlur={mFB} onChange={(e) => p.onChange(e.target.value)} onFocus={mFC} placeholder={p.placeholder} style={{ background: 'var(--ib-900)', border: '1px solid var(--ib-800)', color: 'var(--ib-100)' }} value={p.value} />
                ) : (
                  <textarea key={i} className="w-full resize-none rounded-lg px-3 py-2 text-sm outline-none" onBlur={mFB as unknown as React.FocusEventHandler<HTMLTextAreaElement>} onChange={(e) => p.onChange(e.target.value)} onFocus={mFC as unknown as React.FocusEventHandler<HTMLTextAreaElement>} placeholder={p.placeholder} rows={2} style={{ background: 'var(--ib-900)', border: '1px solid var(--ib-800)', color: 'var(--ib-100)' }} value={p.value} />
                )
              ))}
            </div>
          </section>
          <section className="flex flex-1 flex-col rounded-xl" style={panelStyle}>
            <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--ib-800)' }}>
              <p className="font-headline text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ib-600)' }}>project.md</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--ib-500)' }}>Injected into every agent in this project.</p>
              {fileDoc && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ib-700)' }}>Saved {new Date(fileDoc.updatedAt).toLocaleString()}</p>}
            </div>
            <textarea
              className="min-h-[40vh] flex-1 resize-none bg-transparent px-5 py-4 font-mono text-sm leading-7 outline-none"
              onChange={(e) => setFileDraft(e.target.value)}
              placeholder="# Project&#10;&#10;Context, goals, decisions…"
              style={{ color: 'var(--ib-200)' }}
              value={fileDraft}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChatScreen() {
  const router = useRouter();
  const { accessToken, ready, refresh, setupRequired, user, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<DraftAttachment[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [channelSession, setChannelSession] = useState<ChannelSessionSummary | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(() => readStoredSelectedChannelId());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [navView, setNavView] = useState<NavView>('chat');
  const [agentStreams, setAgentStreams] = useState<Map<string, AgentStream>>(new Map());
  const [liveToolCalls, setLiveToolCalls] = useState<Map<string, LiveToolCall[]>>(new Map());
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [agentTodos, setAgentTodos] = useState<Map<string, AgentTodoList>>(new Map());
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(() => readStoredUnreadCounts());

  const [showNewAgent, setShowNewAgent]           = useState(false);
  const [showNewGroup, setShowNewGroup]           = useState(false);
  const [showNewProject, setShowNewProject]       = useState(false);
  const [showMembers, setShowMembers]             = useState(false);
  const [showAddProjectChannel, setShowAddProjectChannel] = useState<string | null>(null);

  const [agentForm, setAgentForm] = useState<NewAgentForm>(emptyAgentForm);
  const [groupName, setGroupName] = useState('');
  const [groupAgentIds, setGroupAgentIds] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [projectChannelName, setProjectChannelName] = useState('');
  const [projectChannelAgentIds, setProjectChannelAgentIds] = useState<string[]>([]);
  const [selectedChannelAgentIds, setSelectedChannelAgentIds] = useState<string[]>([]);
  const [savingAgent, setSavingAgent]                   = useState(false);
  const [savingGroup, setSavingGroup]                   = useState(false);
  const [savingProject, setSavingProject]               = useState(false);
  const [savingProjectChannel, setSavingProjectChannel] = useState(false);
  const [savingMembers, setSavingMembers]               = useState(false);
  const [providerStatuses, setProviderStatuses]         = useState<ProviderStatus[]>([]);
  const [agentProviderModels, setAgentProviderModels]   = useState<Array<{ id: string; name: string }>>([]);
  const [loadingAgentProviderModels, setLoadingAgentProviderModels] = useState(false);

  const scrollContainerRef  = useRef<HTMLElement | null>(null);
  const attachmentInputRef  = useRef<HTMLInputElement | null>(null);
  const isNearBottomRef     = useRef(true);
  const routingTimeoutRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const clearRoutingTimeout = useCallback(() => {
    if (routingTimeoutRef.current) { clearTimeout(routingTimeoutRef.current); routingTimeoutRef.current = null; }
  }, []);

  const markChannelAsRead = useCallback((channelId: string) => {
    setUnreadCounts((current) => {
      if (!current[channelId]) return current;

      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }, []);

  const workspace             = workspaces[0] ?? null;
  const selectedChannel       = channels.find((ch) => ch.id === selectedChannelId) ?? null;
  const selectedProject       = projects.find((p) => p.id === selectedProjectId) ?? null;
  const directChannels        = channels.filter((ch) => ch.type === 'DIRECT');
  const groupChannels         = channels.filter((ch) => ch.type !== 'DIRECT' && !ch.projectId);
  const selectedChannelIsGroup = selectedChannel?.type !== 'DIRECT';

  const activeAgents = useMemo(
    () => agents.filter((a) => selectedChannel?.participantAgentIds.includes(a.id)),
    [agents, selectedChannel?.participantAgentIds],
  );
  const configuredProviders = useMemo(
    () => providerStatuses.filter((provider) => provider.isConfigured),
    [providerStatuses],
  );
  const slashSuggestions = useMemo(
    () => buildSlashSuggestions({ draft, activeAgents }),
    [activeAgents, draft],
  );

  useEffect(() => { setSelectedChannelAgentIds(selectedChannel?.participantAgentIds ?? []); },
    [selectedChannel?.id, selectedChannel?.participantAgentIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (selectedChannelId) {
      window.localStorage.setItem(SELECTED_CHANNEL_STORAGE_KEY, selectedChannelId);
    } else {
      window.localStorage.removeItem(SELECTED_CHANNEL_STORAGE_KEY);
    }
  }, [selectedChannelId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(UNREAD_COUNTS_STORAGE_KEY, JSON.stringify(unreadCounts));
  }, [unreadCounts]);

  useEffect(() => {
    const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) NextGenChat` : 'NextGenChat';
  }, [unreadCounts]);

  const loadBootstrap = useCallback(async (token: string) => {
    const h = { Authorization: `Bearer ${token}` };
    const ws = await apiJson<WorkspaceSummary[]>('/workspaces', { headers: h });
    if (ws.length === 0) return { workspaces: [], channels: [], agents: [], projects: [] };
    const [ch, ag, pr, providers] = await Promise.all([
      apiJson<ChannelSummary[]>(`/workspaces/${ws[0].id}/channels`, { headers: h }),
      apiJson<AgentSummary[]>(`/workspaces/${ws[0].id}/agents`, { headers: h }),
      apiJson<ProjectSummary[]>(`/workspaces/${ws[0].id}/projects`, { headers: h }),
      apiJson<ProviderStatus[]>('/providers', { headers: h }),
    ]);
    return { workspaces: ws, channels: ch, agents: ag, projects: pr, providers };
  }, []);

  const loadMessages      = useCallback((t: string, cid: string) =>
    apiJson<MessageRecord[]>(`/channels/${cid}/messages?limit=50`, { headers: { Authorization: `Bearer ${t}` } }), []);
  const loadChannelSession = useCallback((t: string, cid: string) =>
    apiJson<ChannelSessionSummary>(`/channels/${cid}/session`, { headers: { Authorization: `Bearer ${t}` } }), []);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) { router.replace('/setup'); return; }
    if (!user) { router.replace('/login'); return; }
    if (!accessToken) { void refresh().then((ok) => { if (!ok) router.replace('/login'); }); return; }
    let cancelled = false;
    void loadBootstrap(accessToken).then((data) => {
      if (cancelled) return;
      startTransition(() => {
        setWorkspaces(data.workspaces); setChannels(data.channels);
        setAgents(data.agents); setProjects(data.projects); setProviderStatuses(data.providers ?? []);
        const storedChannelId = readStoredSelectedChannelId();
        const storedChannel = storedChannelId ? data.channels.find((channel) => channel.id === storedChannelId) : null;
        const first = data.channels.find((c) => c.type !== 'DIRECT') ?? data.channels[0];
        setSelectedChannelId((cur) => {
          const currentChannel = cur ? data.channels.find((channel) => channel.id === cur) : null;
          return currentChannel?.id ?? storedChannel?.id ?? first?.id ?? null;
        });
        setLoading(false);
      });
    }).catch((e) => { if (cancelled) return; setError(e instanceof Error ? e.message : 'Failed to load.'); setLoading(false); });
    return () => { cancelled = true; };
  }, [accessToken, loadBootstrap, ready, refresh, router, setupRequired, user]);

  useEffect(() => {
    if (channels.length === 0 || !selectedChannelId) return;
    if (channels.some((channel) => channel.id === selectedChannelId)) return;

    const fallback = channels.find((channel) => channel.type !== 'DIRECT') ?? channels[0] ?? null;
    setSelectedChannelId(fallback?.id ?? null);
  }, [channels, selectedChannelId]);

  useEffect(() => {
    if (!accessToken || !selectedChannelId) return;
    let cancelled = false;
    setAgentStreams(new Map()); setLiveToolCalls(new Map());
    setAgentState('idle'); setChannelSession(null); clearRoutingTimeout();
    void Promise.all([loadMessages(accessToken, selectedChannelId), loadChannelSession(accessToken, selectedChannelId)])
      .then(([msgs, sess]) => { if (!cancelled) { setMessages(msgs); setChannelSession(sess); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load messages.'); });
    return () => { cancelled = true; };
  }, [accessToken, clearRoutingTimeout, loadChannelSession, loadMessages, selectedChannelId]);

  useEffect(() => {
    if (!selectedChannelId) return;
    markChannelAsRead(selectedChannelId);
  }, [markChannelAsRead, selectedChannelId]);

  useEffect(() => {
    if (!accessToken || !showNewAgent || !agentForm.providerName) return;

    let cancelled = false;
    setLoadingAgentProviderModels(true);

    void apiJson<ProviderModelsResponse>(`/providers/${agentForm.providerName}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((response) => {
      if (cancelled) return;

      const models = response.models.map((model) => ({ id: model.id, name: model.name }));
      setAgentProviderModels(models);
      setAgentForm((current) => ({
        ...current,
        model: models.some((model) => model.id === current.model) ? current.model : (models[0]?.id ?? current.model),
      }));
    }).catch((e) => {
      if (cancelled) return;
      setAgentProviderModels([]);
      setError(e instanceof Error ? e.message : 'Failed to load provider models.');
    }).finally(() => {
      if (!cancelled) setLoadingAgentProviderModels(false);
    });

    return () => { cancelled = true; };
  }, [accessToken, agentForm.providerName, showNewAgent]);

  useEffect(() => {
    if (!showNewAgent) return;

    const currentProvider = configuredProviders.find((provider) => provider.providerName === agentForm.providerName);
    if (currentProvider || configuredProviders.length === 0) return;

    setAgentForm((current) => ({
      ...current,
      providerName: configuredProviders[0]?.providerName,
      model: undefined,
    }));
  }, [agentForm.providerName, configuredProviders, showNewAgent]);

  useEffect(() => {
    if (!accessToken || channels.length === 0) return;
    const socket = getChatSocket(accessToken);

    const onMsg = (m: MessageRecord) => {
      if (m.channelId === selectedChannelId) {
        setMessages((cur) => cur.some((x) => x.id === m.id) ? cur : [...cur, m]);
        if (isAgentFailure(m)) setAgentState('error');
        markChannelAsRead(m.channelId);
      } else if (m.senderId !== user?.id) {
        setUnreadCounts((current) => ({
          ...current,
          [m.channelId]: (current[m.channelId] ?? 0) + 1,
        }));
      }
      setChannels((cur) => cur.map((ch) => ch.id === m.channelId ? { ...ch, lastMessageAt: m.createdAt } : ch));
      if (m.channelId === selectedChannelId && accessToken && (m.senderType === 'AGENT' || m.metadata?.compaction)) {
        void loadChannelSession(accessToken, selectedChannelId).then(setChannelSession).catch(() => undefined);
      }
    };

    const onChunk = (p: { channelId: string; delta: string; tempId: string; agentId: string }) => {
      if (p.channelId !== selectedChannelId) return;
      clearRoutingTimeout(); setAgentState('streaming');
      setAgentStreams((cur) => { const n = new Map(cur); const e = n.get(p.tempId); n.set(p.tempId, { agentId: p.agentId, text: (e?.text ?? '') + p.delta }); return n; });
    };

    const onEnd = (p: { channelId: string; tempId: string }) => {
      if (p.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setAgentStreams((cur) => { const n = new Map(cur); n.delete(p.tempId); return n; });
      setLiveToolCalls((cur) => { const n = new Map(cur); n.delete(p.tempId); return n; });
    };

    const onToolStart = (p: { channelId: string; toolName: string; toolCallId: string; turnId: string; agentId: string; arguments?: unknown }) => {
      if (p.channelId !== selectedChannelId) return;
      clearRoutingTimeout(); setAgentState('streaming');
      setAgentStreams((cur) => { const n = new Map(cur); if (!n.has(p.turnId)) n.set(p.turnId, { agentId: p.agentId, text: '' }); return n; });
      setLiveToolCalls((cur) => {
        const n = new Map(cur);
        const calls = n.get(p.turnId) ?? [];
        const idx = calls.findIndex((c) => c.toolCallId === p.toolCallId);
        const next: LiveToolCall = { toolCallId: p.toolCallId, toolName: p.toolName, arguments: p.arguments, status: 'running' };
        if (idx >= 0) { const u = [...calls]; u[idx] = { ...u[idx], ...next }; n.set(p.turnId, u); }
        else { n.set(p.turnId, [...calls, next]); }
        return n;
      });
    };

    const onToolEnd = (p: { channelId: string; turnId: string; toolCallId: string; toolName: string; success: boolean; durationMs: number; arguments?: unknown; output?: string; structuredOutput?: Record<string, unknown> }) => {
      if (p.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setLiveToolCalls((cur) => {
        const n = new Map(cur);
        n.set(p.turnId, (n.get(p.turnId) ?? []).map((c) => c.toolCallId === p.toolCallId ? {
          ...c, toolName: p.toolName, arguments: p.arguments ?? c.arguments,
          output: p.output, durationMs: p.durationMs, success: p.success,
          status: p.success ? 'success' : 'failed',
        } : c));
        return n;
      });
    };

    const onDisconnect = () => { clearRoutingTimeout(); setAgentState('idle'); setAgentStreams(new Map()); setLiveToolCalls(new Map()); };

    const onRouting = (p: { channelId: string; selectedCount: number }) => {
      if (p.channelId !== selectedChannelId) return;
      if (p.selectedCount === 0) { clearRoutingTimeout(); setAgentState('idle'); setAgentStreams(new Map()); setLiveToolCalls(new Map()); }
    };

    const onTodosUpdate = (p: { agentId: string; channelId: string; agentName: string; todos: AgentTodo[] }) => {
      if (p.channelId !== selectedChannelId) return;
      setAgentTodos((cur) => {
        const n = new Map(cur);
        n.set(p.agentId, { agentId: p.agentId, agentName: p.agentName, todos: p.todos });
        return n;
      });
    };

    socket.connect();
    channels.forEach((channel) => {
      socket.emit('channel:join', { channelId: channel.id });
    });
    socket.on('message:new', onMsg);
    socket.on('message:stream:chunk', onChunk);
    socket.on('message:stream:end', onEnd);
    socket.on('message:routing:complete', onRouting);
    socket.on('agent:tool:start', onToolStart);
    socket.on('agent:tool:end', onToolEnd);
    socket.on('agent:todos:update', onTodosUpdate);
    socket.on('disconnect', onDisconnect);
    socket.on('error', (p: { message: string }) => { clearRoutingTimeout(); setAgentState('error'); setError(p.message); });

    return () => {
      channels.forEach((channel) => {
        socket.emit('channel:leave', { channelId: channel.id });
      });
      (['message:new','message:stream:chunk','message:stream:end','message:routing:complete',
       'agent:tool:start','agent:tool:end','agent:todos:update','disconnect','error'] as const).forEach((e) => socket.off(e));
    };
  }, [accessToken, channels, clearRoutingTimeout, loadChannelSession, markChannelAsRead, selectedChannelId, user?.id]);

  const handleScroll = useCallback(() => {
    const c = scrollContainerRef.current;
    if (c) isNearBottomRef.current = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, [messages, agentStreams, liveToolCalls, agentState]);

  const canSend = Boolean((draft.trim() || pendingAttachments.length > 0) && accessToken && selectedChannelId && navView === 'chat');

  const runCompactCommand = useCallback(async (cmd: { all: true } | { agentSlug: string }) => {
    if (!accessToken || !selectedChannelId) return;
    setError(null);
    try {
      await apiJson<CompactChannelSessionResult>(`/channels/${selectedChannelId}/session/compact`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(cmd),
      });
      setChannelSession(await loadChannelSession(accessToken, selectedChannelId));
      setDraft('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to compact.'); }
  }, [accessToken, loadChannelSession, selectedChannelId]);

  const submitMessage = useCallback(async () => {
    if (!canSend || !accessToken || !selectedChannelId) return;
    const cmd = parseCompactCommand(draft);
    if (cmd) { void runCompactCommand(cmd); return; }
    clearRoutingTimeout(); setAgentState('queued');
    setAgentStreams(new Map()); setLiveToolCalls(new Map()); setError(null);
    routingTimeoutRef.current = setTimeout(() => { setAgentState('idle'); setAgentStreams(new Map()); setLiveToolCalls(new Map()); }, 20_000);

    try {
      await apiJson<MessageRecord>(`/channels/${selectedChannelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          content: draft.trim(),
          contentType: 'TEXT',
          attachments: pendingAttachments.map((attachment) => ({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            contentBase64: attachment.contentBase64,
          })),
        }),
      });

      setDraft('');
      setPendingAttachments([]);
    } catch (e) {
      clearRoutingTimeout();
      setAgentState('error');
      setError(e instanceof Error ? e.message : 'Failed to send message.');
    }
  }, [accessToken, canSend, clearRoutingTimeout, draft, pendingAttachments, runCompactCommand, selectedChannelId]);

  const handleAttachmentSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    try {
      const additions = await filesToDraftAttachments(files);

      setPendingAttachments((current) => [...current, ...additions]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to read attachment.');
    } finally {
      event.target.value = '';
    }
  }, []);

  const handleComposerPaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) {
      return;
    }

    event.preventDefault();

    try {
      const additions = await filesToDraftAttachments(files);
      setPendingAttachments((current) => [...current, ...additions]);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to read pasted image.');
    }
  }, []);

  function selectChannel(id: string) {
    markChannelAsRead(id);
    setSelectedChannelId(id);
    setSelectedProjectId(null);
    setNavView('chat');
  }
  function selectProject(id: string)  { setSelectedProjectId(id); setSelectedChannelId(null); setNavView('project-detail'); }

  const createAgent = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingAgent(true);
    try {
      const c = await apiJson<AgentSummary>(`/workspaces/${workspace.id}/agents`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(agentForm) });
      setAgents((cur) => [...cur, c]); setShowNewAgent(false); setAgentForm(emptyAgentForm);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); } finally { setSavingAgent(false); }
  }, [accessToken, agentForm, workspace]);

  const openDirectChat = useCallback(async (agentId: string) => {
    if (!accessToken) return;
    try {
      const ch = await apiJson<ChannelSummary>(`/agents/${agentId}/direct-channel`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({}) });
      setChannels((cur) => cur.some((c) => c.id === ch.id) ? cur.map((c) => c.id === ch.id ? ch : c) : [...cur, ch]);
      selectChannel(ch.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
  }, [accessToken]);

  const createGroupChat = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingGroup(true);
    try {
      const p: CreateChannelInput = { name: groupName.trim(), type: 'PUBLIC', agentIds: groupAgentIds };
      const c = await apiJson<ChannelSummary>(`/workspaces/${workspace.id}/channels`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(p) });
      setChannels((cur) => [...cur, c]); selectChannel(c.id);
      setShowNewGroup(false); setGroupName(''); setGroupAgentIds([]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); } finally { setSavingGroup(false); }
  }, [accessToken, groupAgentIds, groupName, workspace]);

  const createProject = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingProject(true);
    try {
      const c = await apiJson<ProjectSummary>(`/workspaces/${workspace.id}/projects`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ name: projectName.trim(), description: projectDesc.trim() || undefined }) });
      setProjects((cur) => [...cur, c]); selectProject(c.id);
      setShowNewProject(false); setProjectName(''); setProjectDesc('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); } finally { setSavingProject(false); }
  }, [accessToken, projectDesc, projectName, workspace]);

  const createProjectChannel = useCallback(async () => {
    if (!accessToken || !showAddProjectChannel) return;
    setSavingProjectChannel(true);
    try {
      const c = await apiJson<ChannelSummary>(`/projects/${showAddProjectChannel}/channels`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ name: projectChannelName.trim(), agentIds: projectChannelAgentIds }) });
      setChannels((cur) => [...cur, c]); selectChannel(c.id);
      setShowAddProjectChannel(null); setProjectChannelName(''); setProjectChannelAgentIds([]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); } finally { setSavingProjectChannel(false); }
  }, [accessToken, projectChannelAgentIds, projectChannelName, showAddProjectChannel]);

  const saveGroupMembers = useCallback(async () => {
    if (!accessToken || !selectedChannel || !selectedChannelIsGroup) return;
    setSavingMembers(true);
    try {
      const u = await apiJson<ChannelSummary>(`/channels/${selectedChannel.id}/agents`, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ agentIds: selectedChannelAgentIds }) });
      setChannels((cur) => cur.map((ch) => ch.id === u.id ? u : ch)); setShowMembers(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); } finally { setSavingMembers(false); }
  }, [accessToken, selectedChannel, selectedChannelAgentIds, selectedChannelIsGroup]);

  const activeTurnIds   = useMemo(() => new Set([...agentStreams.keys(), ...liveToolCalls.keys()]), [agentStreams, liveToolCalls]);
  const activeStreamCount = activeTurnIds.size;
  const agentStateLabel = activeStreamCount > 1 ? `${activeStreamCount} agents replying`
    : agentState === 'streaming' ? 'Replying'
    : agentState === 'queued'   ? 'Routing…'
    : agentState === 'error'    ? 'Error'
    : 'Ready';

  useEffect(() => { if (agentState === 'streaming' && activeStreamCount === 0) setAgentState('idle'); },
    [activeStreamCount, agentState]);

  if (loading || !ready) {
    return (
      <main className="flex min-h-screen items-center justify-center" style={{ background: 'var(--ib-950)' }}>
        <span className="text-sm" style={{ color: 'var(--ib-600)' }}>Loading…</span>
      </main>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const sdBg   = 'var(--ti-950)';  /* sidebar */
  const sdBdr  = '1px solid rgba(47,65,106,0.5)';

  return (
    <main className="h-screen overflow-hidden" style={{ background: 'var(--ib-950)', color: 'var(--ib-100)' }}>
      <div className="flex h-full overflow-hidden">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside
          className="flex w-[240px] shrink-0 flex-col"
          style={{ background: sdBg, borderRight: sdBdr }}
        >
          {/* Workspace header */}
          <div
            className="flex h-[52px] shrink-0 items-center gap-2.5 px-4"
            style={{ borderBottom: sdBdr }}
          >
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-md"
              style={{ background: 'var(--ib-500)' }}
            >
              <Image alt="NextGenChat" className="h-full w-full object-cover" height={28} priority src="/nextgenchat-brand-mark.png" width={28} />
            </div>
            <span
              className="font-headline flex-1 truncate text-[14px] font-semibold"
              style={{ color: 'var(--ib-100)' }}
            >
              {workspace?.name ?? 'NextGenChat'}
            </span>
          </div>

          {/* Nav */}
          <div className="flex-1 overflow-y-auto py-4 px-2">
            <SidebarSection label="Direct Messages">
              {agents.map((agent) => {
                const dm = directChannels.find((ch) => ch.participantAgentIds.includes(agent.id));
                return (
                  <DMItem
                    active={selectedChannelId === dm?.id}
                    agent={agent}
                    channel={dm ?? { id: '', workspaceId: '', name: agent.name, type: 'DIRECT', participantAgentIds: [agent.id], participantAgentNames: [agent.name] }}
                    key={agent.id}
                    onClick={() => void openDirectChat(agent.id)}
                    unreadCount={dm ? (unreadCounts[dm.id] ?? 0) : 0}
                  />
                );
              })}
            </SidebarSection>

            <SidebarSection label="Channels" addLabel="New channel" onAdd={() => setShowNewGroup(true)}>
              {groupChannels.map((ch) => (
                <ChannelItem active={selectedChannelId === ch.id} channel={ch} key={ch.id} onClick={() => selectChannel(ch.id)} unreadCount={unreadCounts[ch.id] ?? 0} />
              ))}
            </SidebarSection>

            <SidebarSection label="Projects" addLabel="New project" onAdd={() => setShowNewProject(true)}>
              {projects.map((project) => (
                <ProjectItem
                  activeChannelId={selectedChannelId}
                  activeProjectId={selectedProjectId}
                  key={project.id}
                  onAddChannel={(pid) => setShowAddProjectChannel(pid)}
                  onSelectChannel={selectChannel}
                  onSelectProject={selectProject}
                  project={project}
                  subChannels={channels.filter((ch) => ch.projectId === project.id)}
                  unreadCounts={unreadCounts}
                />
              ))}
            </SidebarSection>
          </div>

          {/* Footer */}
          <div
            className="shrink-0 px-3 pb-4"
            style={{ borderTop: sdBdr }}
          >
            <div className="mt-3 flex items-center gap-2 rounded-xl px-2 py-2">
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                style={{ background: avatarColor(user?.username ?? 'U'), color: '#fff' }}
              >
                {user?.username.slice(0, 1).toUpperCase()}
              </div>
              <span className="flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--ib-300)' }}>
                {user?.username}
              </span>
              <button
                className="flex h-6 w-6 items-center justify-center rounded-lg transition-colors hover:bg-white/10"
                onClick={logout}
                style={{ color: 'var(--ib-600)' }}
                title="Sign out"
                type="button"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <button
              className="mt-1.5 w-full rounded-xl py-2 text-[12px] font-medium transition-colors hover:bg-white/10"
              onClick={() => setShowNewAgent(true)}
              style={{ border: '1px solid var(--ib-800)', color: 'var(--ib-500)' }}
              type="button"
            >
              + New Agent
            </button>
            <Link
              className="mt-1.5 block w-full rounded-xl py-2 text-center text-[12px] font-medium transition-colors hover:bg-white/10"
              href="/settings"
              style={{ border: '1px solid var(--ib-800)', color: 'var(--ib-500)' }}
            >
              Provider Settings
            </Link>
          </div>
        </aside>

        {/* ── Main area ────────────────────────────────────────────────────── */}
        <section className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--ib-950)' }}>

          {navView === 'project-detail' && selectedProject && accessToken ? (
            <ProjectDetailPanel
              accessToken={accessToken}
              onProjectUpdated={(p) => setProjects((cur) => cur.map((pr) => pr.id === p.id ? p : pr))}
              project={selectedProject}
            />
          ) : null}

          {navView === 'chat' ? (
            <>
              {/* Header */}
              <header
                className="flex h-[52px] shrink-0 items-center justify-between px-5"
                style={{
                  borderBottom: '1px solid rgba(47,65,106,0.4)',
                  background: 'rgba(11,15,25,0.75)',
                  backdropFilter: 'blur(10px)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  {selectedChannel && (
                    <>
                      {selectedChannel.type !== 'DIRECT' && (
                        <span className="font-bold" style={{ color: 'var(--ib-600)', fontSize: '16px' }}>#</span>
                      )}
                      <span className="font-headline text-[14px] font-semibold" style={{ color: 'var(--ib-100)' }}>
                        {selectedChannel.type === 'DIRECT'
                          ? (selectedChannel.participantAgentNames[0] ?? selectedChannel.name)
                          : selectedChannel.name}
                      </span>
                      {selectedChannel.projectId && (
                        <button
                          className="rounded-lg px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
                          onClick={() => selectProject(selectedChannel.projectId!)}
                          style={{ background: 'var(--ti-800)', color: 'var(--ib-300)', border: '1px solid var(--ib-700)' }}
                          type="button"
                        >
                          {projects.find((p) => p.id === selectedChannel.projectId)?.name ?? 'Project'}
                        </button>
                      )}
                      {channelSession?.model && (
                        <span className="hidden rounded-md px-1.5 py-0.5 text-[10px] lg:inline" style={{ background: 'var(--ti-800)', color: 'var(--ib-500)', border: '1px solid var(--ib-800)' }}>
                          {channelSession.model}
                        </span>
                      )}
                      {channelSession?.latestContextUsagePercent != null && (
                        <span className="hidden rounded-md px-1.5 py-0.5 text-[10px] xl:inline" style={{ background: 'var(--ti-800)', color: 'var(--ib-500)', border: '1px solid var(--ib-800)' }}>
                          ctx {channelSession.latestContextUsagePercent}%
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* State indicator */}
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: agentState === 'streaming' ? '#22c55e'
                          : agentState === 'queued' ? 'var(--warning)'
                          : agentState === 'error'   ? 'var(--sr-500)'
                          : 'var(--ib-800)',
                        boxShadow: agentState === 'streaming' ? '0 0 6px #22c55e88'
                          : agentState === 'queued' ? '0 0 6px rgba(245,158,11,0.5)'
                          : undefined,
                        animation: (agentState === 'streaming' || agentState === 'queued') ? 'typing 1.4s ease-in-out infinite' : undefined,
                      }}
                    />
                    <span className="text-[11px]" style={{ color: 'var(--ib-600)' }}>{agentStateLabel}</span>
                  </div>
                  {selectedChannel?.type === 'DIRECT' && activeAgents[0] && (
                    <Link
                      className="rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/10"
                      href={`/agents/${activeAgents[0].id}`}
                      style={{ border: '1px solid var(--ib-800)', color: 'var(--ib-400)' }}
                    >
                      Workspace
                    </Link>
                  )}
                  {selectedChannelIsGroup && selectedChannel && (
                    <button
                      className="rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/10"
                      onClick={() => setShowMembers(true)}
                      style={{ border: '1px solid var(--ib-800)', color: 'var(--ib-400)' }}
                      type="button"
                    >
                      Members
                    </button>
                  )}
                </div>
              </header>

              {/* Messages */}
              <section
                className="flex-1 overflow-y-auto"
                onScroll={handleScroll}
                ref={scrollContainerRef}
              >
                <div className="mx-auto flex w-full max-w-3xl flex-col px-5 py-6 pb-40">
	                  {messages.map((msg, idx) => {
	                    const failure  = isAgentFailure(msg);
	                    const isAgent  = msg.senderType === 'AGENT';
	                    const isSystem = msg.contentType === 'SYSTEM';
	                    const toolCalls = getMessageToolCalls(msg);
	                    const attachments = getMessageAttachments(msg);
	                    const scheduledKind = getScheduledMessageKind(msg);

                    const prev = messages[idx - 1];
                    const grouped = prev
                      && prev.senderName === msg.senderName
                      && prev.senderType === msg.senderType
                      && (new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000);

                    if (isSystem) {
                      return (
                        <div className="flex justify-center py-4" key={msg.id}>
                          <span
                            className="rounded-full px-3 py-1 text-[11px]"
                            style={{ background: 'var(--ti-800)', color: 'var(--ib-500)', border: '1px solid var(--ib-700)' }}
                          >
                            {msg.content}
                          </span>
                        </div>
                      );
                    }

                    const senderColor = isAgent ? avatarColor(msg.senderName ?? 'A') : avatarColor(user?.username ?? 'U');

                    return (
                      <div
                        className={`group flex gap-3 rounded-xl px-3 py-1.5 transition-colors ${grouped ? 'mt-0.5' : 'mt-5'}`}
                        key={msg.id}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                      >
                        {/* Avatar column */}
                        <div className="w-9 shrink-0 pt-0.5">
                          {!grouped ? (
                            <div
                              className="flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-bold"
                              style={{
                                background: senderColor,
                                color: '#fff',
                                boxShadow: isAgent ? `0 0 0 2px var(--ib-950), 0 0 0 3px ${senderColor}55` : undefined,
                              }}
                            >
                              {(msg.senderName ?? 'U').slice(0, 2).toUpperCase()}
                            </div>
                          ) : (
                            <span
                              className="block text-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ color: 'var(--ib-700)', paddingTop: '4px' }}
                            >
                              {formatTime(msg.createdAt).split(' ').pop()}
                            </span>
                          )}
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {!grouped && (
                            <div className="mb-1 flex items-center gap-2">
                              <span
                                className="text-[14px] font-semibold leading-none"
                                style={{ color: senderColor }}
                              >
                                {msg.senderName ?? (isAgent ? 'Agent' : user?.username ?? 'You')}
                              </span>
	                              {isAgent && (
	                                <span
	                                  className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
	                                  style={{ background: 'rgba(114,137,192,0.15)', color: 'var(--ib-400)', border: '1px solid var(--ib-700)' }}
	                                >
	                                  AI
	                                </span>
	                              )}
	                              {scheduledKind && (
	                                <span
	                                  className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
	                                  style={{ background: 'rgba(245,158,11,0.12)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.24)' }}
	                                >
	                                  {scheduledKind === 'CRON' ? 'Cron' : 'Reminder'}
	                                </span>
	                              )}
	                              {failure && (
	                                <span
                                  className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                                  style={{ background: 'var(--sr-950)', color: 'var(--sr-300)', border: '1px solid var(--sr-800)' }}
                                >
                                  Failed
                                </span>
                              )}
                              <span className="text-[11px]" style={{ color: 'var(--ib-700)' }}>
                                {formatTime(msg.createdAt)}
                              </span>
                            </div>
                          )}

                          {/* Tool calls (completed messages) */}
                          {isAgent && toolCalls.length > 0 && (
                            <ToolLog calls={toolCalls} live={false} />
                          )}

                          {/* Message text */}
                          {msg.content ? (
                            isAgent && !failure ? (
                              <AgentMarkdown content={msg.content} />
                            ) : (
                              <p
                                className="whitespace-pre-wrap text-[14px] leading-[1.8]"
                                style={{ color: failure ? 'var(--sr-300)' : 'var(--ib-100)' }}
                              >
                                {msg.content}
                              </p>
                            )
                          ) : null}

                          {attachments.length > 0 && (
                            <div className="mt-3 space-y-2">
                              {attachments.map((attachment) => (
                                <div
                                  className="rounded-xl px-3 py-2 text-[12px]"
                                  key={attachment.id ?? `${msg.id}:${attachment.fileName}`}
                                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--ib-800)', color: 'var(--ib-200)' }}
                                >
                                  <div className="font-medium">{attachment.fileName}</div>
                                  <div className="mt-0.5 text-[10px]" style={{ color: 'var(--ib-600)' }}>
                                    {attachment.mimeType}
                                    {typeof attachment.fileSize === 'number' ? ` · ${Math.max(1, Math.round(attachment.fileSize / 1024))} KB` : ''}
                                  </div>
                                  {attachment.relativePath ? (
                                    <div className="mt-1 text-[10px] font-mono" style={{ color: 'var(--ib-500)' }}>
                                      Workspace path: {attachment.relativePath}
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Inline todos from todowrite calls in this message */}
                          {isAgent && !failure && (() => {
                            const tc = toolCalls.find((t) => t.toolName === 'todowrite');
                            const raw = (tc?.structuredOutput as { todos?: AgentTodo[] } | undefined)?.todos;
                            return raw && raw.length > 0 ? <InlineTodos todos={raw} /> : null;
                          })()}
                        </div>
                      </div>
                    );
                  })}

                  {/* ── Streaming messages ─────────────────────────────────── */}
                  {Array.from(activeTurnIds).map((tempId) => {
                    const stream    = agentStreams.get(tempId);
                    const liveCalls = liveToolCalls.get(tempId) ?? [];
                    if (!stream) return null;
                    const streamingAgent = agents.find((a) => a.id === stream.agentId);
                    const label  = streamingAgent?.name ?? 'Agent';
                    const color  = avatarColor(label);
                    const hasText = stream.text.length > 0;

                    return (
                      <div className="mt-5 flex gap-3 rounded-xl px-3 py-1.5" key={tempId}>
                        {/* Avatar with pulsing ring */}
                        <div className="w-9 shrink-0 pt-0.5">
                          <div
                            className="flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-bold"
                            style={{
                              background: color,
                              color: '#fff',
                              boxShadow: `0 0 0 2px var(--ib-950), 0 0 0 3px ${color}88, 0 0 12px ${color}44`,
                            }}
                          >
                            {label.slice(0, 2).toUpperCase()}
                          </div>
                        </div>

                        <div className="min-w-0 flex-1">
                          {/* Header */}
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-[14px] font-semibold leading-none" style={{ color }}>
                              {label}
                            </span>
                            <span
                              className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                              style={{ background: 'rgba(114,137,192,0.15)', color: 'var(--ib-400)', border: '1px solid var(--ib-700)' }}
                            >
                              AI
                            </span>
                            <span
                              className="flex items-center gap-1 text-[11px]"
                              style={{ color: hasText ? 'var(--ib-500)' : liveCalls.length > 0 ? 'var(--warning)' : 'var(--success)' }}
                            >
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{
                                  background: hasText ? 'var(--success)' : liveCalls.length > 0 ? 'var(--warning)' : '#22c55e',
                                  animation: 'typing 1.4s ease-in-out infinite',
                                  boxShadow: `0 0 5px currentColor`,
                                }}
                              />
                              {hasText ? 'Replying' : liveCalls.length > 0 ? `Using ${liveCalls.length} tool${liveCalls.length > 1 ? 's' : ''}` : 'Thinking…'}
                            </span>
                          </div>

                          {/* Live tool log */}
                          {liveCalls.length > 0 && (
                            <ToolLog calls={liveCalls} live={true} />
                          )}

                          {/* Streaming text */}
                          {hasText ? (
                            <AgentMarkdown content={stream.text} streaming={true} />
                          ) : (
                            !liveCalls.length && (
                              <div className="flex items-center gap-1 py-0.5">
                                {[0, 200, 400].map((d) => (
                                  <span
                                    key={d}
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{ background: 'var(--ib-500)', animation: `typing 1.4s ease-in-out ${d}ms infinite` }}
                                  />
                                ))}
                              </div>
                            )
                          )}

                          {/* Inline todos — shown inside the bubble when agent has an active task list */}
                          {(() => { const tl = agentTodos.get(stream.agentId); return tl && tl.todos.length > 0 ? <InlineTodos todos={tl.todos} /> : null; })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Composer */}
              <div
                className="shrink-0 px-5 pb-5 pt-2"
                style={{ borderTop: '1px solid rgba(47,65,106,0.35)' }}
              >
                {error && (
                  <div
                    className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]"
                    style={{ background: 'var(--sr-950)', border: '1px solid var(--sr-800)', color: 'var(--sr-300)' }}
                  >
                    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {error}
                  </div>
                )}
                <div
                  className="mx-auto max-w-3xl overflow-hidden rounded-2xl"
                  style={{ background: 'var(--ti-900)', border: '1px solid var(--ib-700)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
                >
                  {slashSuggestions.length > 0 && (
                    <div
                      className="px-4 py-2"
                      style={{ borderBottom: '1px solid var(--ib-800)' }}
                    >
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ib-600)' }}>Commands</div>
                      <div className="space-y-0.5">
                        {slashSuggestions.slice(0, 6).map((s) => (
                          <button
                            className="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                            key={s.value}
                            onClick={() => setDraft(s.value)}
                            type="button"
                          >
                            <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--ib-200)' }}>{s.label}</span>
                            <span className="text-[11px]" style={{ color: 'var(--ib-600)' }}>{s.hint}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {pendingAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-4 pt-3">
                      {pendingAttachments.map((attachment) => (
                        <div
                          className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]"
                          key={attachment.id}
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--ib-800)', color: 'var(--ib-200)' }}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{attachment.fileName}</div>
                            <div className="text-[10px]" style={{ color: 'var(--ib-600)' }}>
                              {Math.max(1, Math.round(attachment.fileSize / 1024))} KB
                            </div>
                          </div>
                          <button
                            className="rounded-full px-1.5 py-0.5 text-[11px]"
                            onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                            style={{ color: 'var(--ib-500)' }}
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    className="min-h-[72px] w-full resize-none bg-transparent px-4 pt-3 text-[14px] leading-relaxed outline-none"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submitMessage(); }
                    }}
                    onPaste={(e) => { void handleComposerPaste(e); }}
                    placeholder={
                      selectedChannel?.type === 'DIRECT'
                        ? `Message ${selectedChannel.participantAgentNames[0] ?? selectedChannel.name}…`
                        : selectedChannel ? `Message #${selectedChannel.name}…`
                        : 'Select a conversation…'
                    }
                    style={{ color: 'var(--ib-100)', caretColor: 'var(--ib-400)' }}
                    value={draft}
                  />
                  <input
                    hidden
                    multiple
                    onChange={handleAttachmentSelect}
                    ref={attachmentInputRef}
                    type="file"
                  />
                  <div className="flex items-center justify-between px-4 pb-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-white/10"
                        onClick={() => attachmentInputRef.current?.click()}
                        style={{ border: '1px solid var(--ib-800)', color: 'var(--ib-400)' }}
                        type="button"
                      >
                        Add file
                      </button>
                      <span
                        className="text-[11px]"
                        style={{
                          color: agentState === 'error' ? 'var(--sr-400)' : 'var(--ib-700)',
                        }}
                      >
                        {agentState === 'error' ? 'Agent run failed'
                          : agentState === 'streaming' ? 'Agent is replying…'
                          : agentState === 'queued'   ? 'Routing to agents…'
                          : `${isMac ? '⌘' : 'Ctrl'}↵`}
                      </span>
                    </div>
                    <button
                      className="font-headline rounded-xl px-5 py-1.5 text-[13px] font-semibold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                      disabled={!canSend}
                      onClick={() => { void submitMessage(); }}
                      style={{ background: 'var(--ib-500)', color: 'var(--ib-50)', boxShadow: canSend ? '0 0 16px rgba(79,108,176,0.3)' : undefined }}
                      type="button"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {navView === 'chat' && !selectedChannel && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <div
                className="font-headline text-6xl font-bold"
                style={{ color: 'var(--ib-900)' }}
              >
                NGC
              </div>
              <p className="text-sm" style={{ color: 'var(--ib-700)' }}>Select a conversation to start</p>
            </div>
          )}
        </section>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      {showNewAgent && (
        <Modal onClose={() => { setShowNewAgent(false); setAgentForm(emptyAgentForm); }} title="New Agent">
          <div className="space-y-2.5">
            <MI value={agentForm.name} onChange={(v) => setAgentForm((c) => ({ ...c, name: v }))} placeholder="Agent name" />
            <MI value={agentForm.persona ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, persona: v }))} placeholder="Persona" />
            <MI value={agentForm.voiceTone ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, voiceTone: v }))} placeholder="Voice tone" />
            <MS value={agentForm.providerName ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, providerName: v as CreateAgentInput['providerName'] }))}>
              {configuredProviders.map((provider) => (
                <option key={provider.providerName} value={provider.providerName}>{provider.label}</option>
              ))}
            </MS>
            <MS value={agentForm.model ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, model: v }))}>
              {agentProviderModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </MS>
            <div className="px-1 text-[11px]" style={{ color: 'var(--ib-600)' }}>
              {loadingAgentProviderModels ? 'Loading models…' : configuredProviders.length > 0 ? 'Choose from providers already connected in Settings.' : 'No providers configured yet. Connect one in Provider Settings first.'}
            </div>
            <MS value={agentForm.triggerMode} onChange={(v) => setAgentForm((c) => ({ ...c, triggerMode: v as CreateAgentInput['triggerMode'] }))}>
              <option value="AUTO">Auto</option>
              <option value="MENTIONS_ONLY">Mentions only</option>
              <option value="ALL_MESSAGES">All messages</option>
              <option value="DISABLED">Disabled</option>
            </MS>
            <MT value={agentForm.systemPrompt ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, systemPrompt: v }))} placeholder="System prompt (optional)" />
            <MB onClick={() => void createAgent()} disabled={!agentForm.name.trim() || !agentForm.providerName || !agentForm.model || configuredProviders.length === 0 || savingAgent}>
              {savingAgent ? 'Creating…' : 'Create Agent →'}
            </MB>
          </div>
        </Modal>
      )}

      {showNewGroup && (
        <Modal onClose={() => { setShowNewGroup(false); setGroupName(''); setGroupAgentIds([]); }} title="New Channel">
          <div className="space-y-2.5">
            <MI value={groupName} onChange={setGroupName} placeholder="Channel name" />
            <AgentCheckList agents={agents} ids={groupAgentIds} toggle={(id) => setGroupAgentIds((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])} />
            <MB onClick={() => void createGroupChat()} disabled={!groupName.trim() || savingGroup}>
              {savingGroup ? 'Creating…' : 'Create Channel →'}
            </MB>
          </div>
        </Modal>
      )}

      {showNewProject && (
        <Modal onClose={() => { setShowNewProject(false); setProjectName(''); setProjectDesc(''); }} title="New Project">
          <div className="space-y-2.5">
            <MI value={projectName} onChange={setProjectName} placeholder="Project name" />
            <MT value={projectDesc} onChange={setProjectDesc} placeholder="Description (optional)" />
            <MB onClick={() => void createProject()} disabled={!projectName.trim() || savingProject}>
              {savingProject ? 'Creating…' : 'Create Project →'}
            </MB>
          </div>
        </Modal>
      )}

      {showAddProjectChannel && (
        <Modal onClose={() => { setShowAddProjectChannel(null); setProjectChannelName(''); setProjectChannelAgentIds([]); }} title="Add Channel to Project">
          <div className="space-y-2.5">
            <MI value={projectChannelName} onChange={setProjectChannelName} placeholder="Channel name" />
            <AgentCheckList agents={agents} ids={projectChannelAgentIds} toggle={(id) => setProjectChannelAgentIds((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])} />
            <MB onClick={() => void createProjectChannel()} disabled={!projectChannelName.trim() || savingProjectChannel}>
              {savingProjectChannel ? 'Creating…' : 'Add Channel →'}
            </MB>
          </div>
        </Modal>
      )}

      {showMembers && selectedChannel && selectedChannelIsGroup && (
        <Modal onClose={() => setShowMembers(false)} title={`#${selectedChannel.name} — Members`}>
          <div className="space-y-3">
            <AgentCheckList agents={agents} ids={selectedChannelAgentIds} toggle={(id) => setSelectedChannelAgentIds((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])} />
            <MB onClick={() => void saveGroupMembers()} disabled={savingMembers}>
              {savingMembers ? 'Saving…' : 'Save Members →'}
            </MB>
          </div>
        </Modal>
      )}
    </main>
  );
}
