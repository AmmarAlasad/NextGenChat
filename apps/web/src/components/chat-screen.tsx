/**
 * Chat Screen
 *
 * Full-page layout for one workspace / one channel / one agent.
 * Three-column structure: side-rail (nav + agent card), message canvas, right
 * inspector panel. The composer floats over the canvas as an absolute gradient
 * overlay matching the Stitch "refined-chat-interface" design.
 *
 * Phase 1 implementation status:
 * - One workspace, one channel, one active agent, persisted message history.
 * - Live streaming via Socket.io with animated thinking-dot state.
 * - Future phases: multi-channel nav, file attachments, presence, tool usage.
 */

'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { AgentSummary, ChannelSummary, MessageRecord, WorkspaceSummary } from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';
import { getChatSocket } from '@/lib/socket';

type AgentState = 'idle' | 'queued' | 'streaming' | 'error';

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isAgentFailure(message: MessageRecord) {
  if (message.senderType !== 'AGENT') return false;
  return message.contentType === 'SYSTEM' || typeof message.metadata?.error === 'string';
}

/** Three animated dots used for the agent "thinking" state. */
function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-2 w-2 rounded-full bg-primary/50 animate-typing" />
      <div className="h-2 w-2 rounded-full bg-primary/50 animate-typing [animation-delay:0.2s]" />
      <div className="h-2 w-2 rounded-full bg-primary/50 animate-typing [animation-delay:0.4s]" />
    </div>
  );
}

export function ChatScreen() {
  const router = useRouter();
  const { accessToken, ready, refresh, setupRequired, user, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);

  // Detect platform for keyboard shortcut hint
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const workspace = workspaces[0] ?? null;
  const channel = channels[0] ?? null;
  const agent = agents[0] ?? null;

  const loadChatData = useCallback(async (token: string) => {
    const authHeaders = { Authorization: `Bearer ${token}` };
    const nextWorkspaces = await apiJson<WorkspaceSummary[]>('/workspaces', { headers: authHeaders });

    if (nextWorkspaces.length === 0) {
      return { workspaces: nextWorkspaces, channels: [] as ChannelSummary[], agents: [] as AgentSummary[], messages: [] as MessageRecord[] };
    }

    const currentWorkspace = nextWorkspaces[0];
    const [nextChannels, nextAgents] = await Promise.all([
      apiJson<ChannelSummary[]>(`/workspaces/${currentWorkspace.id}/channels`, { headers: authHeaders }),
      apiJson<AgentSummary[]>(`/workspaces/${currentWorkspace.id}/agents`, { headers: authHeaders }),
    ]);

    let nextMessages: MessageRecord[] = [];
    if (nextChannels.length > 0) {
      nextMessages = await apiJson<MessageRecord[]>(`/channels/${nextChannels[0].id}/messages?limit=50`, { headers: authHeaders });
    }

    return { workspaces: nextWorkspaces, channels: nextChannels, agents: nextAgents, messages: nextMessages };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) { router.replace('/setup'); return; }
    if (!user) { router.replace('/login'); return; }
    if (!accessToken) {
      refresh().then((ok) => { if (!ok) router.replace('/login'); });
      return;
    }

    let cancelled = false;
    loadChatData(accessToken)
      .then((data) => {
        if (cancelled) return;
        startTransition(() => {
          setWorkspaces(data.workspaces);
          setChannels(data.channels);
          setAgents(data.agents);
          setMessages(data.messages);
          setLoading(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        startTransition(() => {
          setError(err instanceof Error ? err.message : 'Failed to load chat.');
          setLoading(false);
        });
      });

    return () => { cancelled = true; };
  }, [accessToken, loadChatData, ready, refresh, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken || !channel) return;

    const socket = getChatSocket(accessToken);

    const handleMessage = (message: MessageRecord) => {
      setMessages((current) => {
        if (current.some((entry) => entry.id === message.id)) return current;
        return [...current, message];
      });
      setStreamingText('');
      setAgentState(isAgentFailure(message) ? 'error' : 'idle');
      if (isAgentFailure(message)) setError(message.content);
    };

    const handleStreamChunk = (payload: { channelId: string; delta: string }) => {
      if (payload.channelId !== channel.id) return;
      setAgentState('streaming');
      setStreamingText((current) => current + payload.delta);
    };

    const handleStreamEnd = (payload: { channelId: string }) => {
      if (payload.channelId !== channel.id) return;
      setStreamingText('');
      setAgentState('idle');
    };

    const handleSocketError = (payload: { message: string }) => {
      setAgentState('error');
      setError(payload.message);
    };

    socket.connect();
    socket.emit('channel:join', { channelId: channel.id });
    socket.on('message:new', handleMessage);
    socket.on('message:stream:chunk', handleStreamChunk);
    socket.on('message:stream:end', handleStreamEnd);
    socket.on('error', handleSocketError);

    return () => {
      socket.emit('channel:leave', { channelId: channel.id });
      socket.off('message:new', handleMessage);
      socket.off('message:stream:chunk', handleStreamChunk);
      socket.off('message:stream:end', handleStreamEnd);
      socket.off('error', handleSocketError);
    };
  }, [accessToken, channel]);

  // Track whether user is near the bottom of the scroll container
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 120;
    isNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // Only auto-scroll when user is near the bottom — prevents jitter when reading history
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, streamingText, agentState]);

  const canSend = useMemo(
    () => Boolean(draft.trim() && accessToken && channel && agentState !== 'queued' && agentState !== 'streaming'),
    [accessToken, channel, draft, agentState],
  );

  const submitMessage = useCallback(async () => {
    if (!canSend || !accessToken || !channel) return;

    const value = draft.trim();
    setDraft('');
    setError(null);
    setAgentState('queued');

    const socket = getChatSocket(accessToken);
    if (!socket.connected) {
      socket.connect();
      socket.emit('channel:join', { channelId: channel.id });
    }

    socket.emit('message:send', { channelId: channel.id, content: value, contentType: 'TEXT' });
  }, [accessToken, canSend, channel, draft]);

  if (loading || !ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-on-surface-variant">
        Loading chat…
      </main>
    );
  }

  const agentStatusLabel =
    agentState === 'streaming' ? 'Replying now'
    : agentState === 'queued'   ? 'Thinking…'
    : agentState === 'error'    ? 'Needs attention'
    : 'Online';

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full overflow-hidden">

        {/* ── Left rail ─────────────────────────────────────── */}
        <aside className="hidden w-72 shrink-0 border-r border-outline/20 bg-surface-low/90 lg:flex lg:flex-col">
          {/* Workspace logo */}
          <div className="flex items-center gap-3 px-6 py-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-on-primary shadow-sm">
              N
            </div>
            <div>
              <div className="font-headline text-xl font-bold tracking-tight text-primary">NextGenChat</div>
              <div className="text-[10px] uppercase tracking-[0.24em] text-on-surface-variant/60">Local Compute</div>
            </div>
          </div>

          <nav className="flex-1 space-y-6 overflow-y-auto px-4 py-2">
            <section>
              <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">
                Workspace
              </div>
              <div className="rounded-xl bg-surface-high/75 px-3 py-3 text-sm font-semibold text-on-surface shadow-sm">
                {workspace?.name ?? 'Workspace'}
              </div>
            </section>

            <section>
              <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">
                Active Channel
              </div>
              <div className="rounded-xl bg-surface-container-lowest px-3 py-3 shadow-sm ring-1 ring-outline/10">
                <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                  <span className="text-primary">#</span>
                  <span>{channel?.name ?? 'general'}</span>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-on-surface-variant/70">
                  Main workspace for local-first collaboration with one focused AI agent.
                </p>
              </div>
            </section>

            <section>
              <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">
                Active Agent
              </div>
              <div className="rounded-xl bg-surface-container-lowest p-3 shadow-sm ring-1 ring-outline/10">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-container text-xs font-bold text-primary">
                      AI
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-container-lowest bg-emerald-500" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-on-surface">{agent?.name ?? 'Agent'}</div>
                    <div className={`text-[10px] font-medium ${agentState === 'error' ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {agentStatusLabel}
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-on-surface-variant/70">
                  Focused technical assistant for the first local milestone.
                </p>
              </div>
            </section>
          </nav>

          <div className="p-4">
            <button
              className="w-full rounded-xl border border-outline/20 px-4 py-2.5 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-low"
              onClick={() => logout()}
              type="button"
            >
              Log Out
            </button>
          </div>
        </aside>

        {/* ── Main canvas ───────────────────────────────────── */}
        <section className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
          {/* Top bar */}
          <header className="flex h-16 items-center justify-between border-b border-outline/15 bg-surface-container-lowest/80 px-5 shadow-sm shadow-slate-200/40 backdrop-blur sm:px-8">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-primary/60">#</span>
                <h2 className="text-base font-semibold text-on-surface">{channel?.name ?? 'general'}</h2>
              </div>
              <div className="hidden h-4 w-px bg-outline/30 sm:block" />
              <nav className="hidden gap-6 sm:flex">
                <span className="border-b-2 border-primary pb-1 text-sm font-semibold text-primary">Overview</span>
                <span className="pb-1 text-sm font-semibold text-on-surface-variant/50">History</span>
                <span className="pb-1 text-sm font-semibold text-on-surface-variant/50">Files</span>
              </nav>
            </div>
            <div className="rounded-full bg-surface-low px-4 py-1.5 text-sm text-on-surface-variant/60">
              Single-user local mode
            </div>
          </header>

          {/* Scrollable messages */}
          <section className="flex-1 overflow-y-auto" onScroll={handleScroll} ref={scrollContainerRef}>
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10 pb-56 sm:px-8">

              {/* Channel welcome */}
              <div className="flex flex-col items-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-container text-primary shadow-sm">
                  <span className="font-mono font-bold">#</span>
                </div>
                <h3 className="font-headline mt-4 text-xl font-bold text-on-surface">
                  Beginning of #{channel?.name ?? 'general'}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-on-surface-variant">
                  This channel is dedicated to the first working milestone: one human, one agent, one provider.
                </p>
              </div>

              {/* Message list */}
              {messages.map((message) => {
                const failure = isAgentFailure(message);
                const isAgent = message.senderType === 'AGENT';

                return (
                  <article key={message.id} className="flex gap-5">
                    <div
                      className={
                        isAgent
                          ? 'mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-xs font-bold text-primary'
                          : 'mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-xs font-bold text-on-surface'
                      }
                    >
                      {isAgent ? 'AI' : (user?.username?.[0]?.toUpperCase() ?? 'U')}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-sm font-bold text-on-surface">
                          {isAgent ? (agent?.name ?? 'Agent') : (user?.username ?? 'You')}
                        </span>
                        {isAgent && !failure && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-primary">
                            Local Agent
                          </span>
                        )}
                        {failure && (
                          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-rose-700">
                            Error
                          </span>
                        )}
                        <span className="text-[10px] text-on-surface-variant/50">{formatTime(message.createdAt)}</span>
                      </div>

                      {isAgent ? (
                        <div className={`rounded-2xl p-6 shadow-sm ring-1 ${failure ? 'bg-rose-50 ring-rose-200/80' : 'bg-surface-container-lowest ring-primary-container/40'}`}>
                          <p className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface/85">
                            {message.content}
                          </p>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface/85">
                          {message.content}
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}

              {/* Thinking state */}
              {agentState === 'queued' && !streamingText ? (
                <article className="flex gap-5">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/50 text-xs font-bold text-primary/60">
                    AI
                  </div>
                  <div className="rounded-2xl bg-surface-container-lowest p-5 shadow-sm ring-1 ring-primary-container/30">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-sm font-bold text-on-surface/60">{agent?.name ?? 'Agent'}</span>
                      <span className="rounded bg-primary/8 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-primary/70">
                        Thinking
                      </span>
                    </div>
                    <ThinkingDots />
                  </div>
                </article>
              ) : null}

              {/* Streaming state */}
              {streamingText ? (
                <article className="flex gap-5">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-xs font-bold text-primary">
                    AI
                  </div>
                  <div className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm ring-1 ring-primary-container/40">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-sm font-bold text-on-surface">{agent?.name ?? 'Agent'}</span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-primary">
                        Replying
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface/85">{streamingText}</p>
                  </div>
                </article>
              ) : null}

              <div ref={endRef} />
            </div>
          </section>

          {/* ── Floating composer overlay ─────────────────── */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent px-5 pb-5 pt-20 sm:px-8">
            <div className="pointer-events-auto mx-auto max-w-4xl">
              {error ? (
                <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
                  {error}
                </div>
              ) : null}

              <div className="rounded-[1.75rem] bg-surface-container-lowest/95 p-3 shadow-[0_12px_30px_rgba(44,52,51,0.10)] ring-1 ring-outline/10 transition-shadow focus-within:ring-2 focus-within:ring-primary/20">
                <textarea
                  className="min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm text-on-surface outline-none placeholder:text-on-surface-variant/40"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submitMessage();
                    }
                  }}
                  placeholder={`Message ${agent?.name ?? 'your agent'}…`}
                  value={draft}
                />

                <div className="mt-3 flex items-center justify-between gap-3 px-2 pb-1">
                  <span className="text-xs text-on-surface-variant/50">
                    {agentState === 'error'
                      ? 'The last agent run failed. Update the provider key and try again.'
                      : agentState === 'streaming'
                        ? `${agent?.name ?? 'Agent'} is actively replying.`
                        : agentState === 'queued'
                          ? `${agent?.name ?? 'Agent'} job is queued…`
                          : `${isMac ? '⌘' : 'Ctrl'} + Enter to send`}
                  </span>

                  <button
                    className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-dim active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canSend}
                    onClick={submitMessage}
                    type="button"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Right inspector panel ──────────────────────── */}
        <aside className="hidden w-80 shrink-0 border-l border-outline/15 bg-surface-container-lowest/85 xl:block">
          <div className="p-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Primary Agent</p>
            <h3 className="font-headline mt-4 text-3xl font-bold tracking-tight text-on-surface">
              {agent?.name ?? 'Agent'}
            </h3>
            <div className="mt-3 flex items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${agentState === 'error' ? 'bg-rose-500' : 'bg-emerald-500'}`} />
              <span className={`text-sm font-medium ${agentState === 'error' ? 'text-rose-700' : 'text-emerald-700'}`}>
                {agentStatusLabel}
              </span>
            </div>

            <div className="mt-8 rounded-2xl bg-surface-container p-5 ring-1 ring-outline/10">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-on-surface-variant/50">System Prompt</p>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-8 text-on-surface/75">
                {agent?.systemPrompt ?? 'The first phase agent prompt will appear here after setup.'}
              </p>
            </div>
          </div>
        </aside>

      </div>
    </main>
  );
}
