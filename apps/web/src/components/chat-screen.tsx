/**
 * Chat Screen
 *
 * Teams-style chat shell: fixed sidebar with Direct Messages, Groups, and
 * Projects sections; a main content area that renders either a chat thread or
 * a project detail panel; and streaming agent responses with per-agent bubbles.
 *
 * Phase 6 implementation status:
 * - Direct Messages: one item per agent, clicking opens or creates a DM channel
 * - Groups: standalone group channels (not in a project), show only group name
 * - Projects: expandable containers with sub-channels and an editable project.md
 * - Project detail panel: edit project name, description, and project.md inline
 * - New-agent and new-group modals remain in place
 * - Live tool-call timeline now renders inside streaming agent bubbles with expandable details
 */

'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  ProjectSummary,
  WorkspaceSummary,
  WorkspaceDocRecord,
} from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';
import { getChatSocket } from '@/lib/socket';

type AgentState = 'idle' | 'queued' | 'streaming' | 'error';
type NavView = 'chat' | 'project-detail';

interface SlashSuggestion {
  label: string;
  value: string;
  hint: string;
}

interface AgentStream { agentId: string; text: string }

type ToolCallStatus = 'running' | 'success' | 'failed';

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

const emptyAgentForm: CreateAgentInput = {
  name: '',
  persona: '',
  systemPrompt: '',
  voiceTone: '',
  triggerMode: 'AUTO',
};

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isAgentFailure(message: MessageRecord) {
  return message.senderType === 'AGENT' && (message.contentType === 'SYSTEM' || typeof message.metadata?.error === 'string');
}

function getMessageToolCalls(message: MessageRecord): ToolCallDetail[] {
  const raw = message.metadata?.toolCalls;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((entry): entry is ToolCallDetail => typeof entry === 'object' && entry !== null);
}

function formatToolData(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolCallStatus(toolCall: ToolCallDetail): ToolCallStatus {
  if (toolCall.status) {
    return toolCall.status;
  }

  return toolCall.success ? 'success' : 'failed';
}

function humanizeToolName(toolName?: string) {
  if (!toolName) {
    return 'Tool';
  }

  return toolName.replace(/^workspace_/, '').replace(/_/g, ' ');
}

function describeToolCall(toolCall: ToolCallDetail) {
  const args = (toolCall.arguments && typeof toolCall.arguments === 'object') ? toolCall.arguments as Record<string, unknown> : {};
  const toolName = toolCall.toolName ?? 'tool';

  switch (toolName) {
    case 'workspace_read_file':
      return {
        title: `Reading ${typeof args.filePath === 'string' ? args.filePath : 'workspace file'}`,
        subtitle: typeof args.offset === 'number' ? `Starting at line ${args.offset}` : 'Inspecting workspace contents',
      };
    case 'workspace_write_file':
      return {
        title: `Writing ${typeof args.filePath === 'string' ? args.filePath : 'workspace file'}`,
        subtitle: 'Saving updated file contents',
      };
    case 'workspace_glob':
      return {
        title: `Finding files${typeof args.pattern === 'string' ? ` matching ${args.pattern}` : ''}`,
        subtitle: typeof args.path === 'string' ? `Inside ${args.path}` : 'Searching the workspace',
      };
    case 'workspace_grep':
      return {
        title: `Searching${typeof args.pattern === 'string' ? ` for ${args.pattern}` : ' workspace contents'}`,
        subtitle: typeof args.include === 'string' ? `Within ${args.include}` : 'Scanning matching files',
      };
    case 'workspace_bash':
      return {
        title: typeof args.description === 'string' ? args.description : 'Running command',
        subtitle: typeof args.command === 'string' ? args.command : 'Shell execution',
      };
    case 'send_reply':
      return {
        title: 'Sending progress update',
        subtitle: 'Posting an intermediate reply in this chat',
      };
    case 'todowrite':
      return {
        title: 'Updating task checklist',
        subtitle: Array.isArray(args.todos) ? `${args.todos.length} checklist item${args.todos.length === 1 ? '' : 's'}` : 'Saving task progress',
      };
    case 'todoread':
      return {
        title: 'Reading task checklist',
        subtitle: 'Loading saved task progress',
      };
    case 'channel_send_message':
      return {
        title: `Sending message${typeof args.channelName === 'string' ? ` to #${args.channelName}` : ''}`,
        subtitle: 'Relaying to another channel',
      };
    default:
      return {
        title: `Using ${humanizeToolName(toolName)}`,
        subtitle: 'Tool execution in progress',
      };
  }
}

function getToolStatusClasses(status: ToolCallStatus) {
  if (status === 'running') {
    return 'border-amber-200/70 bg-amber-50 text-amber-700';
  }

  if (status === 'success') {
    return 'border-emerald-200/70 bg-emerald-50 text-emerald-700';
  }

  return 'border-rose-200/70 bg-rose-50 text-rose-700';
}

function ToolCallTimeline({ toolCalls, live = false }: { toolCalls: ToolCallDetail[]; live?: boolean }) {
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <div className={`mt-3 space-y-2 ${live ? '' : ''}`}>
      {toolCalls.map((toolCall, index) => {
        const status = getToolCallStatus(toolCall);
        const description = describeToolCall(toolCall);

        return (
          <details className={`overflow-hidden rounded-2xl border ${getToolStatusClasses(status)}`} key={toolCall.toolCallId ?? `${toolCall.toolName ?? 'tool'}-${index}`}>
            <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${status === 'running' ? 'border-amber-200 bg-amber-100/80' : status === 'success' ? 'border-emerald-200 bg-emerald-100/80' : 'border-rose-200 bg-rose-100/80'}`}>
                {status === 'running' ? (
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
                ) : status === 'success' ? (
                  <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg className="h-3.5 w-3.5 text-rose-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{description.title}</div>
                <div className="truncate text-[11px] opacity-80">{description.subtitle}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wide opacity-80">
                <span>{status === 'running' ? 'running' : status}</span>
                {typeof toolCall.durationMs === 'number' ? <span className="normal-case tracking-normal">{toolCall.durationMs} ms</span> : null}
              </div>
            </summary>
            <div className="space-y-2 border-t border-current/10 bg-white/50 px-3 py-3 text-xs text-on-surface-variant dark:bg-black/10">
              <div>
                <div className="mb-1 font-semibold text-on-surface/80">Tool</div>
                <div className="rounded-lg bg-black/5 px-2 py-2 text-[11px] leading-5 dark:bg-white/5">{toolCall.toolName ?? 'tool'}</div>
              </div>
              <div>
                <div className="mb-1 font-semibold text-on-surface/80">Arguments</div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/5 px-2 py-2 text-[11px] leading-5 dark:bg-white/5">{formatToolData(toolCall.arguments ?? {})}</pre>
              </div>
              <div>
                <div className="mb-1 font-semibold text-on-surface/80">Output</div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/5 px-2 py-2 text-[11px] leading-5 dark:bg-white/5">{formatToolData(toolCall.output ?? (status === 'running' ? 'Still running…' : ''))}</pre>
              </div>
              <div>
                <div className="mb-1 font-semibold text-on-surface/80">Structured result</div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/5 px-2 py-2 text-[11px] leading-5 dark:bg-white/5">{formatToolData(toolCall.structuredOutput ?? {})}</pre>
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function buildSlashSuggestions(input: {
  draft: string;
  activeAgents: AgentSummary[];
}): SlashSuggestion[] {
  if (!input.draft.startsWith('/')) {
    return [];
  }

  const trimmed = input.draft.trimStart();

  if (trimmed === '/' || '/compact'.startsWith(trimmed)) {
    return [
      {
        label: '/compact',
        value: '/compact ',
        hint: 'Compact this session for one agent or all agents',
      },
    ];
  }

  if (trimmed.startsWith('/compact')) {
    const rawTarget = trimmed.slice('/compact'.length).trim().toLowerCase();
    const suggestions: SlashSuggestion[] = [
      {
        label: '/compact all',
        value: '/compact all',
        hint: 'Compact the current session for all active channel agents',
      },
      ...input.activeAgents.map((agent) => ({
        label: `/compact ${agent.slug}`,
        value: `/compact ${agent.slug}`,
        hint: `Compact the current session for ${agent.name}`,
      })),
    ];

    return suggestions.filter((suggestion) => rawTarget.length === 0 || suggestion.value.toLowerCase().includes(rawTarget));
  }

  return [];
}

function parseCompactCommand(draft: string) {
  const trimmed = draft.trim();

  if (!trimmed.startsWith('/compact')) {
    return null;
  }

  const target = trimmed.slice('/compact'.length).trim();

  if (!target || target.toLowerCase() === 'all') {
    return { all: true } as const;
  }

  return { agentSlug: target } as const;
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[1.75rem] border border-outline/15 bg-surface-container-lowest p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-on-surface">{title}</h3>
          <button className="rounded-full border border-outline/20 px-3 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container" onClick={onClose} type="button">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Sidebar section with collapse toggle ─────────────────────────────────────

function SidebarSection({
  label,
  children,
  onAdd,
  addLabel,
}: {
  label: string;
  children: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center gap-1 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <svg
          className={`h-3 w-3 shrink-0 text-on-surface-variant/40 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="currentColor"
          viewBox="0 0 6 10"
        >
          <path d="M0 0l6 5-6 5V0z" />
        </svg>
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/50">{label}</span>
        {onAdd ? (
          <span
            className="flex h-5 w-5 items-center justify-center rounded text-on-surface-variant/40 transition hover:bg-surface-container hover:text-on-surface-variant"
            onClick={(e) => { e.stopPropagation(); onAdd(); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onAdd(); } }}
            title={addLabel ?? 'Add'}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </span>
        ) : null}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

// ── Sidebar items ─────────────────────────────────────────────────────────────

function DMItem({ channel, active, onClick }: { channel: ChannelSummary; active: boolean; onClick: () => void }) {
  const agentName = channel.participantAgentNames[0] ?? channel.name;
  const initial = agentName.slice(0, 1).toUpperCase();

  return (
    <button
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${active ? 'bg-primary/15 text-on-surface' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}`}
      onClick={onClick}
      type="button"
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${active ? 'bg-primary text-on-primary' : 'bg-primary/20 text-primary'}`}>{initial}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{agentName}</div>
      </div>
      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">AI</span>
    </button>
  );
}

function GroupItem({ channel, active, onClick }: { channel: ChannelSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${active ? 'bg-primary/15 text-on-surface' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}`}
      onClick={onClick}
      type="button"
    >
      <span className="shrink-0 text-xs font-bold text-on-surface-variant/50">#</span>
      <span className="truncate text-sm font-medium">{channel.name}</span>
    </button>
  );
}

function ProjectItem({
  project,
  subChannels,
  activeChannelId,
  activeProjectId,
  onSelectChannel,
  onSelectProject,
  onAddChannel,
}: {
  project: ProjectSummary;
  subChannels: ChannelSummary[];
  activeChannelId: string | null;
  activeProjectId: string | null;
  onSelectChannel: (id: string) => void;
  onSelectProject: (id: string) => void;
  onAddChannel: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const projectActive = activeProjectId === project.id && !activeChannelId;

  return (
    <div>
      <div className={`flex items-center gap-1 rounded-lg transition ${projectActive ? 'bg-primary/15' : 'hover:bg-surface-container'}`}>
        <button className="flex flex-1 items-center gap-2 px-3 py-2 text-left" onClick={() => { onSelectProject(project.id); setOpen(true); }} type="button">
          <svg className={`h-3 w-3 shrink-0 text-on-surface-variant/40 transition-transform ${open ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 6 10"><path d="M0 0l6 5-6 5V0z" /></svg>
          <svg className="h-3.5 w-3.5 shrink-0 text-primary/60" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={`truncate text-sm font-medium ${projectActive ? 'text-on-surface' : 'text-on-surface-variant'}`}>{project.name}</span>
        </button>
        <button
          className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-on-surface-variant/30 hover:bg-surface-container-high hover:text-on-surface-variant"
          onClick={(e) => { e.stopPropagation(); setOpen(true); onAddChannel(project.id); }}
          title="Add channel"
          type="button"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
        </button>
      </div>
      {open ? (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-outline/10 pl-2">
          {subChannels.map((ch) => (
            <button
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition ${activeChannelId === ch.id ? 'bg-primary/15 text-on-surface' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}`}
              key={ch.id}
              onClick={() => onSelectChannel(ch.id)}
              type="button"
            >
              <span className="text-xs font-bold text-on-surface-variant/40">#</span>
              <span className="truncate text-sm">{ch.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Project detail panel ──────────────────────────────────────────────────────

function ProjectDetailPanel({
  project,
  accessToken,
  onProjectUpdated,
}: {
  project: ProjectSummary;
  accessToken: string;
  onProjectUpdated: (p: ProjectSummary) => void;
}) {
  const [fileDoc, setFileDoc] = useState<WorkspaceDocRecord | null>(null);
  const [fileDraft, setFileDraft] = useState('');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
    void apiJson<WorkspaceDocRecord>(`/projects/${project.id}/file`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((doc) => {
      setFileDoc(doc);
      setFileDraft(doc.content);
    }).catch(() => undefined);
  }, [accessToken, project.description, project.id, project.name]);

  async function saveInfo() {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiJson<ProjectSummary>(`/projects/${project.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name, description }),
      });
      onProjectUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save project.');
    } finally {
      setSaving(false);
    }
  }

  async function saveFile() {
    setSavingFile(true);
    setError(null);
    try {
      const updated = await apiJson<WorkspaceDocRecord>(`/projects/${project.id}/file`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ content: fileDraft }),
      });
      setFileDoc(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save project.md.');
    } finally {
      setSavingFile(false);
    }
  }

  const hasInfoChanges = name !== project.name || description !== (project.description ?? '');
  const hasFileChanges = fileDraft !== (fileDoc?.content ?? '');

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-outline/10 bg-surface-container-lowest/80 px-8 py-6 backdrop-blur">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">Project</p>
              <h1 className="text-2xl font-bold text-on-surface">{project.name}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50 hover:bg-primary-dim" disabled={!hasInfoChanges || saving} onClick={saveInfo} type="button">{saving ? 'Saving…' : 'Save info'}</button>
            <button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50 hover:bg-primary-dim" disabled={!hasFileChanges || savingFile} onClick={saveFile} type="button">{savingFile ? 'Saving…' : 'Save project.md'}</button>
          </div>
        </div>
      </header>

      {error ? <div className="mx-8 mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}

      <div className="flex flex-1 gap-6 p-8">
        {/* Left: info + file */}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <section className="rounded-2xl border border-outline/10 bg-surface-container-lowest p-6 shadow-sm">
            <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">Project info</p>
            <div className="space-y-3">
              <input
                className="w-full rounded-xl border border-outline/15 bg-transparent px-4 py-2.5 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/30"
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
                value={name}
              />
              <textarea
                className="min-h-20 w-full resize-none rounded-xl border border-outline/15 bg-transparent px-4 py-2.5 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/30"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description (optional)"
                value={description}
              />
            </div>
          </section>

          <section className="flex flex-1 flex-col rounded-2xl border border-outline/10 bg-surface-container-lowest shadow-sm">
            <div className="border-b border-outline/10 px-6 py-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">project.md</p>
              <p className="mt-1.5 text-sm text-on-surface-variant">This file is shared with all agents when they respond in any channel within this project.</p>
              {fileDoc ? <p className="mt-1 text-xs text-on-surface-variant/40">Last saved {new Date(fileDoc.updatedAt).toLocaleString()}</p> : null}
            </div>
            <textarea
              className="min-h-[40vh] flex-1 resize-none bg-transparent px-6 py-5 font-mono text-sm leading-7 text-on-surface outline-none"
              onChange={(e) => setFileDraft(e.target.value)}
              placeholder="# Project name&#10;&#10;Describe the project goals, context, and key decisions…"
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
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [channelSession, setChannelSession] = useState<ChannelSessionSummary | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [navView, setNavView] = useState<NavView>('chat');
  const [agentStreams, setAgentStreams] = useState<Map<string, AgentStream>>(new Map());
  const [liveToolCalls, setLiveToolCalls] = useState<Map<string, LiveToolCall[]>>(new Map());
  const [agentState, setAgentState] = useState<AgentState>('idle');

  // Modals
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showAddProjectChannel, setShowAddProjectChannel] = useState<string | null>(null); // projectId

  // Forms
  const [agentForm, setAgentForm] = useState<CreateAgentInput>(emptyAgentForm);
  const [groupName, setGroupName] = useState('');
  const [groupAgentIds, setGroupAgentIds] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [projectChannelName, setProjectChannelName] = useState('');
  const [projectChannelAgentIds, setProjectChannelAgentIds] = useState<string[]>([]);
  const [selectedChannelAgentIds, setSelectedChannelAgentIds] = useState<string[]>([]);
  const [savingAgent, setSavingAgent] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [savingProjectChannel, setSavingProjectChannel] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);

  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const isNearBottomRef = useRef(true);
  const routingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  // Clear the safety-net timeout whenever we receive an agent event.
  const clearRoutingTimeout = useCallback(() => {
    if (routingTimeoutRef.current) {
      clearTimeout(routingTimeoutRef.current);
      routingTimeoutRef.current = null;
    }
  }, []);

  const workspace = workspaces[0] ?? null;
  const selectedChannel = channels.find((ch) => ch.id === selectedChannelId) ?? null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const directChannels = channels.filter((ch) => ch.type === 'DIRECT');
  const groupChannels = channels.filter((ch) => ch.type !== 'DIRECT' && !ch.projectId);
  const selectedChannelIsGroup = selectedChannel?.type !== 'DIRECT';

  const activeAgents = useMemo(
    () => agents.filter((a) => selectedChannel?.participantAgentIds.includes(a.id)),
    [agents, selectedChannel?.participantAgentIds],
  );
  const slashSuggestions = useMemo(
    () => buildSlashSuggestions({ draft, activeAgents }),
    [activeAgents, draft],
  );

  useEffect(() => {
    setSelectedChannelAgentIds(selectedChannel?.participantAgentIds ?? []);
  }, [selectedChannel?.id, selectedChannel?.participantAgentIds]);

  const loadBootstrap = useCallback(async (token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    const nextWorkspaces = await apiJson<WorkspaceSummary[]>('/workspaces', { headers });

    if (nextWorkspaces.length === 0) {
      return { workspaces: [], channels: [], agents: [], projects: [] };
    }

    const ws = nextWorkspaces[0];
    const [nextChannels, nextAgents, nextProjects] = await Promise.all([
      apiJson<ChannelSummary[]>(`/workspaces/${ws.id}/channels`, { headers }),
      apiJson<AgentSummary[]>(`/workspaces/${ws.id}/agents`, { headers }),
      apiJson<ProjectSummary[]>(`/workspaces/${ws.id}/projects`, { headers }),
    ]);

    return { workspaces: nextWorkspaces, channels: nextChannels, agents: nextAgents, projects: nextProjects };
  }, []);

  const loadMessages = useCallback(async (token: string, channelId: string) => {
    return apiJson<MessageRecord[]>(`/channels/${channelId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }, []);

  const loadChannelSession = useCallback(async (token: string, channelId: string) => {
    return apiJson<ChannelSessionSummary>(`/channels/${channelId}/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) { router.replace('/setup'); return; }
    if (!user) { router.replace('/login'); return; }
    if (!accessToken) {
      void refresh().then((ok) => { if (!ok) router.replace('/login'); });
      return;
    }

    let cancelled = false;

    void loadBootstrap(accessToken).then((data) => {
      if (cancelled) return;
      startTransition(() => {
        setWorkspaces(data.workspaces);
        setChannels(data.channels);
        setAgents(data.agents);
        setProjects(data.projects);
        const firstChannel = data.channels.find((ch) => ch.type !== 'DIRECT') ?? data.channels[0];
        setSelectedChannelId((cur) => cur ?? firstChannel?.id ?? null);
        setLoading(false);
      });
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : 'Failed to load.');
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [accessToken, loadBootstrap, ready, refresh, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken || !selectedChannelId) return;
    let cancelled = false;
    // Switching channels must always reset streaming state so the new channel
    // is never locked by a previous channel's in-flight routing or stream.
    setAgentStreams(new Map());
    setLiveToolCalls(new Map());
    setAgentState('idle');
    setChannelSession(null);
    clearRoutingTimeout();

    void Promise.all([
      loadMessages(accessToken, selectedChannelId),
      loadChannelSession(accessToken, selectedChannelId),
    ]).then(([msgs, session]) => {
      if (!cancelled) {
        setMessages(msgs);
        setChannelSession(session);
      }
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load messages.');
    });

    return () => { cancelled = true; };
  }, [accessToken, clearRoutingTimeout, loadChannelSession, loadMessages, selectedChannelId]);

  useEffect(() => {
    if (!accessToken || !selectedChannelId) return;

    const socket = getChatSocket(accessToken);

    const handleMessage = (message: MessageRecord) => {
      if (message.channelId === selectedChannelId) {
        setMessages((cur) => (cur.some((m) => m.id === message.id) ? cur : [...cur, message]));
        if (isAgentFailure(message)) setAgentState('error');
      }
      setChannels((cur) => cur.map((ch) => ch.id === message.channelId ? { ...ch, lastMessageAt: message.createdAt } : ch));

      if (message.channelId === selectedChannelId && accessToken && (message.senderType === 'AGENT' || message.metadata?.compaction)) {
        void loadChannelSession(accessToken, selectedChannelId).then(setChannelSession).catch(() => undefined);
      }
    };

    const handleStreamChunk = (payload: { channelId: string; delta: string; tempId: string; agentId: string }) => {
      if (payload.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setAgentState('streaming');
      setAgentStreams((cur) => {
        const next = new Map(cur);
        const existing = next.get(payload.tempId);
        next.set(payload.tempId, { agentId: payload.agentId, text: (existing?.text ?? '') + payload.delta });
        return next;
      });
    };

    const handleStreamEnd = (payload: { channelId: string; tempId: string }) => {
      if (payload.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setAgentStreams((cur) => {
        const next = new Map(cur);
        next.delete(payload.tempId);
        return next;
      });
      setLiveToolCalls((cur) => {
        const next = new Map(cur);
        next.delete(payload.tempId);
        return next;
      });
    };

    const handleToolStart = (payload: { channelId: string; toolName: string; toolCallId: string; turnId: string; agentId: string; arguments?: unknown }) => {
      if (payload.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setAgentState('streaming');
      setAgentStreams((cur) => {
        const next = new Map(cur);
        if (!next.has(payload.turnId)) {
          next.set(payload.turnId, { agentId: payload.agentId, text: '' });
        }
        return next;
      });
      setLiveToolCalls((cur) => {
        const next = new Map(cur);
        const calls = next.get(payload.turnId) ?? [];
        const existingIndex = calls.findIndex((call) => call.toolCallId === payload.toolCallId);
        const nextCall: LiveToolCall = {
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          arguments: payload.arguments,
          status: 'running',
        };

        if (existingIndex >= 0) {
          const updated = [...calls];
          updated[existingIndex] = { ...updated[existingIndex], ...nextCall };
          next.set(payload.turnId, updated);
        } else {
          next.set(payload.turnId, [...calls, nextCall]);
        }
        return next;
      });
    };

    const handleToolEnd = (payload: { channelId: string; turnId: string; toolCallId: string; toolName: string; success: boolean; durationMs: number; arguments?: unknown; output?: string; structuredOutput?: Record<string, unknown> }) => {
      if (payload.channelId !== selectedChannelId) return;
      clearRoutingTimeout();
      setLiveToolCalls((cur) => {
        const next = new Map(cur);
        const calls = next.get(payload.turnId) ?? [];
        next.set(
          payload.turnId,
          calls.map((call) => call.toolCallId === payload.toolCallId ? {
            ...call,
            toolName: payload.toolName,
            arguments: payload.arguments ?? call.arguments,
            output: payload.output,
            structuredOutput: payload.structuredOutput,
            durationMs: payload.durationMs,
            success: payload.success,
            status: payload.success ? 'success' : 'failed',
          } : call),
        );
        return next;
      });
    };

    // If the socket drops mid-stream, reset immediately so the input is never
    // permanently locked.
    const handleDisconnect = () => {
      clearRoutingTimeout();
      setAgentState('idle');
      setAgentStreams(new Map());
      setLiveToolCalls(new Map());
    };

    const handleRoutingComplete = (payload: { channelId: string; selectedCount: number }) => {
      if (payload.channelId !== selectedChannelId) return;
      // When no agents were selected routing is over — reset immediately.
      if (payload.selectedCount === 0) {
        clearRoutingTimeout();
        setAgentState('idle');
        setAgentStreams(new Map());
        setLiveToolCalls(new Map());
      }
    };

    socket.connect();
    socket.emit('channel:join', { channelId: selectedChannelId });
    socket.on('message:new', handleMessage);
    socket.on('message:stream:chunk', handleStreamChunk);
    socket.on('message:stream:end', handleStreamEnd);
    socket.on('message:routing:complete', handleRoutingComplete);
    socket.on('agent:tool:start', handleToolStart);
    socket.on('agent:tool:end', handleToolEnd);
    socket.on('disconnect', handleDisconnect);
    socket.on('error', (p: { message: string }) => { clearRoutingTimeout(); setAgentState('error'); setError(p.message); });

    return () => {
      socket.emit('channel:leave', { channelId: selectedChannelId });
      socket.off('message:new', handleMessage);
      socket.off('message:stream:chunk', handleStreamChunk);
      socket.off('message:stream:end', handleStreamEnd);
      socket.off('message:routing:complete', handleRoutingComplete);
      socket.off('agent:tool:start', handleToolStart);
      socket.off('agent:tool:end', handleToolEnd);
      socket.off('disconnect', handleDisconnect);
      socket.off('error');
    };
  }, [accessToken, clearRoutingTimeout, loadChannelSession, selectedChannelId]);

  const handleScroll = useCallback(() => {
    const c = scrollContainerRef.current;
    if (c) isNearBottomRef.current = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, [messages, agentStreams, liveToolCalls, agentState]);

  // Never lock the input on agent state — the user can always send a follow-up.
  // The only hard requirements are: text exists, authenticated, and channel selected.
  const canSend = Boolean(draft.trim() && accessToken && selectedChannelId && navView === 'chat');

  const runCompactCommand = useCallback(async (command: { all: true } | { agentSlug: string }) => {
    if (!accessToken || !selectedChannelId) return;

    setError(null);

    try {
      await apiJson<CompactChannelSessionResult>(`/channels/${selectedChannelId}/session/compact`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(command),
      });
      const session = await loadChannelSession(accessToken, selectedChannelId);
      setChannelSession(session);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to compact session.');
    }
  }, [accessToken, loadChannelSession, selectedChannelId]);

  const submitMessage = useCallback(() => {
    if (!canSend || !accessToken || !selectedChannelId) return;
    const compactCommand = parseCompactCommand(draft);

    if (compactCommand) {
      void runCompactCommand(compactCommand);
      return;
    }

    const socket = getChatSocket(accessToken);

    // Clear any previous in-flight state so the new send starts fresh.
    clearRoutingTimeout();
    setAgentState('queued');
    setAgentStreams(new Map());
    setLiveToolCalls(new Map());
    setError(null);

    // Safety net: if no stream event arrives within 20 s (server error, network
    // blip, pickup agents timing out), reset the indicator so the input is never
    // permanently stuck.
    routingTimeoutRef.current = setTimeout(() => {
      setAgentState('idle');
      setAgentStreams(new Map());
      setLiveToolCalls(new Map());
    }, 20_000);

    if (!socket.connected) { socket.connect(); socket.emit('channel:join', { channelId: selectedChannelId }); }
    socket.emit('message:send', { channelId: selectedChannelId, content: draft.trim(), contentType: 'TEXT' });
    setDraft('');
  }, [accessToken, canSend, clearRoutingTimeout, draft, runCompactCommand, selectedChannelId]);

  function selectChannel(id: string) {
    setSelectedChannelId(id);
    setSelectedProjectId(null);
    setNavView('chat');
  }

  function selectProject(id: string) {
    setSelectedProjectId(id);
    setSelectedChannelId(null);
    setNavView('project-detail');
  }

  const createAgent = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingAgent(true);
    try {
      const created = await apiJson<AgentSummary>(`/workspaces/${workspace.id}/agents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(agentForm),
      });
      setAgents((cur) => [...cur, created]);
      setShowNewAgent(false);
      setAgentForm(emptyAgentForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create agent.');
    } finally {
      setSavingAgent(false);
    }
  }, [accessToken, agentForm, workspace]);

  const openDirectChat = useCallback(async (agentId: string) => {
    if (!accessToken) return;
    try {
      const channel = await apiJson<ChannelSummary>(`/agents/${agentId}/direct-channel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({}),
      });
      setChannels((cur) => (cur.some((ch) => ch.id === channel.id) ? cur.map((ch) => ch.id === channel.id ? channel : ch) : [...cur, channel]));
      selectChannel(channel.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open direct chat.');
    }
  }, [accessToken]);

  const createGroupChat = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingGroup(true);
    try {
      const payload: CreateChannelInput = { name: groupName.trim(), type: 'PUBLIC', agentIds: groupAgentIds };
      const created = await apiJson<ChannelSummary>(`/workspaces/${workspace.id}/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });
      setChannels((cur) => [...cur, created]);
      selectChannel(created.id);
      setShowNewGroup(false);
      setGroupName('');
      setGroupAgentIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group.');
    } finally {
      setSavingGroup(false);
    }
  }, [accessToken, groupAgentIds, groupName, workspace]);

  const createProject = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingProject(true);
    try {
      const created = await apiJson<ProjectSummary>(`/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: projectName.trim(), description: projectDesc.trim() || undefined }),
      });
      setProjects((cur) => [...cur, created]);
      selectProject(created.id);
      setShowNewProject(false);
      setProjectName('');
      setProjectDesc('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project.');
    } finally {
      setSavingProject(false);
    }
  }, [accessToken, projectDesc, projectName, workspace]);

  const createProjectChannel = useCallback(async () => {
    if (!accessToken || !showAddProjectChannel) return;
    setSavingProjectChannel(true);
    try {
      const created = await apiJson<ChannelSummary>(`/projects/${showAddProjectChannel}/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: projectChannelName.trim(), agentIds: projectChannelAgentIds }),
      });
      setChannels((cur) => [...cur, created]);
      selectChannel(created.id);
      setShowAddProjectChannel(null);
      setProjectChannelName('');
      setProjectChannelAgentIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create channel.');
    } finally {
      setSavingProjectChannel(false);
    }
  }, [accessToken, projectChannelAgentIds, projectChannelName, showAddProjectChannel]);

  const saveGroupMembers = useCallback(async () => {
    if (!accessToken || !selectedChannel || !selectedChannelIsGroup) return;
    setSavingMembers(true);
    try {
      const updated = await apiJson<ChannelSummary>(`/channels/${selectedChannel.id}/agents`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ agentIds: selectedChannelAgentIds }),
      });
      setChannels((cur) => cur.map((ch) => ch.id === updated.id ? updated : ch));
      setShowMembers(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update members.');
    } finally {
      setSavingMembers(false);
    }
  }, [accessToken, selectedChannel, selectedChannelAgentIds, selectedChannelIsGroup]);

  const activeTurnIds = useMemo(
    () => new Set([...agentStreams.keys(), ...liveToolCalls.keys()]),
    [agentStreams, liveToolCalls],
  );
  const activeStreamCount = activeTurnIds.size;
  const agentStateLabel =
    activeStreamCount > 1 ? `${activeStreamCount} agents replying`
      : agentState === 'streaming' ? 'Replying'
      : agentState === 'queued' ? 'Routing'
      : agentState === 'error' ? 'Error'
      : 'Ready';

  useEffect(() => {
    if (agentState === 'streaming' && activeStreamCount === 0) {
      setAgentState('idle');
    }
  }, [activeStreamCount, agentState]);

  if (loading || !ready) {
    return <main className="flex min-h-screen items-center justify-center text-on-surface-variant">Loading…</main>;
  }

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full overflow-hidden">

        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-outline/10 bg-surface-container-lowest">
          {/* Logo */}
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-outline/10 px-4">
            <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg bg-primary shadow-sm">
              <Image alt="NextGenChat" className="h-full w-full object-cover" height={28} priority src="/nextgenchat-brand-mark.png" width={28} />
            </div>
            <span className="font-headline text-sm font-bold tracking-tight text-on-surface">NextGenChat</span>
          </div>

          {/* Nav list */}
          <div className="flex-1 overflow-y-auto py-3">

            {/* Direct Messages */}
            <SidebarSection label="Direct messages">
              {agents.map((agent) => {
                const dm = directChannels.find((ch) => ch.participantAgentIds.includes(agent.id));
                return (
                  <DMItem
                    active={selectedChannelId === dm?.id}
                    channel={dm ?? { id: '', workspaceId: '', name: agent.name, type: 'DIRECT', participantAgentIds: [agent.id], participantAgentNames: [agent.name] }}
                    key={agent.id}
                    onClick={() => void openDirectChat(agent.id)}
                  />
                );
              })}
            </SidebarSection>

            {/* Groups */}
            <SidebarSection label="Groups" addLabel="New group" onAdd={() => setShowNewGroup(true)}>
              {groupChannels.map((ch) => (
                <GroupItem active={selectedChannelId === ch.id} channel={ch} key={ch.id} onClick={() => selectChannel(ch.id)} />
              ))}
            </SidebarSection>

            {/* Projects */}
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
                />
              ))}
            </SidebarSection>
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-outline/10 p-3">
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{user?.username.slice(0, 1).toUpperCase()}</div>
              <span className="flex-1 truncate text-sm text-on-surface-variant">{user?.username}</span>
              <button className="rounded text-xs text-on-surface-variant/50 hover:text-on-surface-variant" onClick={() => logout()} type="button">Sign out</button>
            </div>
            <div className="mt-2 flex gap-1.5 px-2">
              <button className="rounded-md border border-outline/15 px-2.5 py-1 text-xs text-on-surface-variant hover:bg-surface-container" onClick={() => setShowNewAgent(true)} type="button">+ Agent</button>
            </div>
          </div>
        </aside>

        {/* ── Main area ───────────────────────────────────────────────────── */}
        <section className="flex min-w-0 flex-1 flex-col bg-background">

          {/* Project detail panel */}
          {navView === 'project-detail' && selectedProject && accessToken ? (
            <ProjectDetailPanel
              accessToken={accessToken}
              onProjectUpdated={(p) => setProjects((cur) => cur.map((pr) => pr.id === p.id ? p : pr))}
              project={selectedProject}
            />
          ) : null}

          {/* Chat panel */}
          {navView === 'chat' ? (
            <>
              {/* Header */}
              <header className="flex h-14 shrink-0 items-center justify-between border-b border-outline/10 bg-surface-container-lowest/80 px-5 backdrop-blur">
                <div className="flex items-center gap-3">
                  {selectedChannel ? (
                    <>
                      <span className="text-sm font-bold text-on-surface-variant/40">{selectedChannel.type === 'DIRECT' ? '' : '#'}</span>
                      <span className="text-base font-semibold text-on-surface">
                        {selectedChannel.type === 'DIRECT' ? (selectedChannel.participantAgentNames[0] ?? selectedChannel.name) : selectedChannel.name}
                      </span>
                      {selectedChannel.projectId ? (
                        <button
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/15"
                          onClick={() => selectProject(selectedChannel.projectId!)}
                          type="button"
                        >
                          {projects.find((p) => p.id === selectedChannel.projectId)?.name ?? 'Project'}
                        </button>
                      ) : null}
                      {channelSession ? (
                        <>
                          <span className="hidden rounded-full bg-surface-container px-2.5 py-0.5 text-[11px] font-semibold text-on-surface-variant lg:inline-flex">
                            Session {channelSession.sessionId.slice(0, 8)}
                          </span>
                          {channelSession.model ? (
                            <span className="hidden rounded-full bg-surface-container px-2.5 py-0.5 text-[11px] font-semibold text-on-surface-variant xl:inline-flex">
                              {channelSession.model}
                            </span>
                          ) : null}
                          {channelSession.latestContextUsagePercent !== null ? (
                            <span className="hidden rounded-full bg-surface-container px-2.5 py-0.5 text-[11px] font-semibold text-on-surface-variant xl:inline-flex">
                              Context {channelSession.latestContextUsagePercent}%
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden rounded-full bg-surface-container px-3 py-1 text-xs font-semibold text-on-surface-variant md:inline-flex">{agentStateLabel}</span>
                  {selectedChannel?.type === 'DIRECT' && activeAgents[0] ? (
                    <Link className="rounded-full border border-outline/20 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5" href={`/agents/${activeAgents[0].id}`}>Open workspace</Link>
                  ) : null}
                  {selectedChannelIsGroup && selectedChannel ? (
                    <button className="rounded-full border border-outline/20 px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:bg-surface-container" onClick={() => setShowMembers(true)} type="button">Manage members</button>
                  ) : null}
                </div>
              </header>

              {/* Messages */}
              <section className="flex-1 overflow-y-auto" onScroll={handleScroll} ref={scrollContainerRef}>
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8 pb-44">
                  {messages.map((message) => {
                    const failure = isAgentFailure(message);
                    const isAgent = message.senderType === 'AGENT';
                    const isSystem = message.contentType === 'SYSTEM';
                    const toolCalls = getMessageToolCalls(message);

                    if (isSystem) {
                      return (
                        <div className="flex justify-center" key={message.id}>
                          <div className="rounded-full bg-surface-container px-4 py-1.5 text-xs text-on-surface-variant">{message.content}</div>
                        </div>
                      );
                    }

                    return (
                      <article className="flex gap-3" key={message.id}>
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${isAgent ? 'bg-primary/90 text-on-primary' : 'bg-surface-container text-on-surface'}`}>
                          {(message.senderName ?? 'U').slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-sm font-semibold text-on-surface">{message.senderName ?? (isAgent ? 'Agent' : user?.username ?? 'You')}</span>
                            {isAgent ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-tight text-primary">Agent</span> : null}
                            {failure ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-tight text-rose-700">Error</span> : null}
                            <span className="text-[10px] text-on-surface-variant/40">{formatTime(message.createdAt)}</span>
                          </div>
                          <div className={`rounded-2xl px-4 py-3 shadow-sm ring-1 ${isAgent ? (failure ? 'bg-rose-50 ring-rose-200/80' : 'bg-surface-container-lowest ring-primary/12') : 'bg-surface-container-lowest ring-outline/8'}`}>
                            <p className="whitespace-pre-wrap text-[14px] leading-7 text-on-surface/90">{message.content}</p>
                            {isAgent ? <ToolCallTimeline toolCalls={toolCalls} /> : null}
                          </div>
                        </div>
                      </article>
                    );
                  })}

                  {Array.from(activeTurnIds).map((tempId) => {
                    const stream = agentStreams.get(tempId);
                    const liveCalls = liveToolCalls.get(tempId) ?? [];
                    if (!stream) {
                      return null;
                    }
                    const streamingAgent = agents.find((a) => a.id === stream.agentId);
                    const label = streamingAgent?.name ?? 'Agent';
                    return (
                      <article className="flex gap-3" key={tempId}>
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/90 text-xs font-bold text-on-primary">{label.slice(0, 1).toUpperCase()}</div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-sm font-semibold text-on-surface">{label}</span>
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-tight text-primary">Agent</span>
                            {liveCalls.length > 0
                              ? <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600">Using tools…</span>
                              : <span className="text-[10px] text-on-surface-variant/40">Replying…</span>}
                          </div>
                          <div className="rounded-2xl bg-surface-container-lowest px-4 py-3 shadow-sm ring-1 ring-primary/12">
                            <ToolCallTimeline live toolCalls={liveCalls} />
                            {stream.text ? <p className="whitespace-pre-wrap text-[14px] leading-7 text-on-surface/90">{stream.text}</p> : <p className="text-[18px] leading-7 text-on-surface/60">...</p>}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {/* Composer */}
              <div className="shrink-0 border-t border-outline/10 bg-surface-container-lowest/80 px-5 py-3 backdrop-blur">
                {error ? <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div> : null}
                <div className="mx-auto max-w-3xl rounded-2xl bg-surface-container-lowest shadow-sm ring-1 ring-outline/10">
                  {slashSuggestions.length > 0 ? (
                    <div className="border-b border-outline/10 px-3 py-2">
                      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Commands</div>
                      <div className="space-y-1">
                        {slashSuggestions.slice(0, 6).map((suggestion) => (
                          <button
                            className="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-surface-container"
                            key={suggestion.value}
                            onClick={() => setDraft(suggestion.value)}
                            type="button"
                          >
                            <span className="text-sm font-medium text-on-surface">{suggestion.label}</span>
                            <span className="text-xs text-on-surface-variant">{suggestion.hint}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <textarea
                    className="min-h-20 w-full resize-none bg-transparent px-4 py-3 text-sm text-on-surface outline-none placeholder:text-on-surface-variant/40"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitMessage(); }
                    }}
                    placeholder={selectedChannel?.type === 'DIRECT' ? `Message ${selectedChannel.participantAgentNames[0] ?? selectedChannel.name}…` : selectedChannel ? `Message #${selectedChannel.name}…` : 'Select a conversation…'}
                    value={draft}
                  />
                  <div className="flex items-center justify-between gap-3 px-4 pb-3">
                    <span className="text-xs text-on-surface-variant/40">{agentState === 'error' ? 'Agent run failed.' : activeStreamCount > 1 ? `${activeStreamCount} agents replying…` : agentState === 'streaming' ? 'Replying…' : agentState === 'queued' ? 'Routing…' : `${isMac ? '⌘' : 'Ctrl'} + Enter`}</span>
                    <button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-dim active:scale-95 disabled:opacity-50" disabled={!canSend} onClick={submitMessage} type="button">Send</button>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* Empty state */}
          {navView === 'chat' && !selectedChannel ? (
            <div className="flex flex-1 items-center justify-center text-sm text-on-surface-variant/50">
              Select a conversation to start chatting.
            </div>
          ) : null}
        </section>
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}

      {showNewAgent ? (
        <Modal onClose={() => { setShowNewAgent(false); setAgentForm(emptyAgentForm); }} title="Create agent">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setAgentForm((c) => ({ ...c, name: e.target.value }))} placeholder="Agent name" value={agentForm.name} />
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setAgentForm((c) => ({ ...c, persona: e.target.value }))} placeholder="Persona" value={agentForm.persona ?? ''} />
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setAgentForm((c) => ({ ...c, voiceTone: e.target.value }))} placeholder="Voice tone" value={agentForm.voiceTone ?? ''} />
            <select className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setAgentForm((c) => ({ ...c, triggerMode: e.target.value as CreateAgentInput['triggerMode'] }))} value={agentForm.triggerMode}>
              <option value="AUTO">Auto</option>
              <option value="MENTIONS_ONLY">Mentions only</option>
              <option value="ALL_MESSAGES">All messages</option>
              <option value="DISABLED">Disabled</option>
            </select>
            <textarea className="min-h-28 rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setAgentForm((c) => ({ ...c, systemPrompt: e.target.value }))} placeholder="System prompt" value={agentForm.systemPrompt ?? ''} />
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!agentForm.name.trim() || savingAgent} onClick={() => void createAgent()} type="button">{savingAgent ? 'Creating…' : 'Create agent'}</button>
          </div>
        </Modal>
      ) : null}

      {showNewGroup ? (
        <Modal onClose={() => { setShowNewGroup(false); setGroupName(''); setGroupAgentIds([]); }} title="New group">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" value={groupName} />
            <div className="space-y-2 rounded-2xl bg-surface-container p-4">
              {agents.map((agent) => (
                <label className="flex items-center gap-2 text-sm text-on-surface" key={agent.id}>
                  <input checked={groupAgentIds.includes(agent.id)} onChange={() => setGroupAgentIds((c) => (c.includes(agent.id) ? c.filter((id) => id !== agent.id) : [...c, agent.id]))} type="checkbox" />
                  {agent.name}
                </label>
              ))}
            </div>
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!groupName.trim() || savingGroup} onClick={() => void createGroupChat()} type="button">{savingGroup ? 'Creating…' : 'Create group'}</button>
          </div>
        </Modal>
      ) : null}

      {showNewProject ? (
        <Modal onClose={() => { setShowNewProject(false); setProjectName(''); setProjectDesc(''); }} title="New project">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setProjectName(e.target.value)} placeholder="Project name" value={projectName} />
            <textarea className="min-h-20 rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setProjectDesc(e.target.value)} placeholder="Description (optional)" value={projectDesc} />
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!projectName.trim() || savingProject} onClick={() => void createProject()} type="button">{savingProject ? 'Creating…' : 'Create project'}</button>
          </div>
        </Modal>
      ) : null}

      {showAddProjectChannel ? (
        <Modal onClose={() => { setShowAddProjectChannel(null); setProjectChannelName(''); setProjectChannelAgentIds([]); }} title="Add channel to project">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(e) => setProjectChannelName(e.target.value)} placeholder="Channel name" value={projectChannelName} />
            <div className="space-y-2 rounded-2xl bg-surface-container p-4">
              {agents.map((agent) => (
                <label className="flex items-center gap-2 text-sm text-on-surface" key={agent.id}>
                  <input checked={projectChannelAgentIds.includes(agent.id)} onChange={() => setProjectChannelAgentIds((c) => (c.includes(agent.id) ? c.filter((id) => id !== agent.id) : [...c, agent.id]))} type="checkbox" />
                  {agent.name}
                </label>
              ))}
            </div>
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!projectChannelName.trim() || savingProjectChannel} onClick={() => void createProjectChannel()} type="button">{savingProjectChannel ? 'Creating…' : 'Add channel'}</button>
          </div>
        </Modal>
      ) : null}

      {showMembers && selectedChannel && selectedChannelIsGroup ? (
        <Modal onClose={() => setShowMembers(false)} title={`Manage #${selectedChannel.name}`}>
          <div className="space-y-4">
            <div className="space-y-2 rounded-2xl bg-surface-container p-4">
              {agents.map((agent) => (
                <label className="flex items-center gap-2 text-sm text-on-surface" key={agent.id}>
                  <input checked={selectedChannelAgentIds.includes(agent.id)} onChange={() => setSelectedChannelAgentIds((c) => (c.includes(agent.id) ? c.filter((id) => id !== agent.id) : [...c, agent.id]))} type="checkbox" />
                  {agent.name}
                </label>
              ))}
            </div>
            <button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={savingMembers} onClick={() => void saveGroupMembers()} type="button">{savingMembers ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
