/**
 * Chat Screen
 *
 * WhatsApp / Teams-inspired chat shell for the local-first multi-agent app.
 * Keeps the left side focused on conversations and uses lightweight modals for
 * creating chats or managing group members. Agent editing lives in the profile
 * workspace, not inside the chat thread itself.
 */

'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { AgentSummary, ChannelSummary, CreateAgentInput, CreateChannelInput, MessageRecord, WorkspaceSummary } from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';
import { getChatSocket } from '@/lib/socket';

type AgentState = 'idle' | 'queued' | 'streaming' | 'error';

interface AgentStream {
  agentId: string;
  text: string;
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

function formatConversationTitle(channel: ChannelSummary) {
  return channel.type === 'DIRECT' ? channel.participantAgentNames[0] ?? channel.name : channel.name;
}

function getConversationSubtitle(channel: ChannelSummary) {
  if (channel.type === 'DIRECT') {
    return 'Private conversation';
  }

  return channel.participantAgentNames.length > 0 ? channel.participantAgentNames.join(', ') : 'No agents added yet';
}

function conversationAvatarLabel(channel: ChannelSummary) {
  if (channel.type === 'DIRECT') {
    return (channel.participantAgentNames[0] ?? channel.name).slice(0, 1).toUpperCase();
  }

  return '#';
}

function isAgentFailure(message: MessageRecord) {
  return message.senderType === 'AGENT' && (message.contentType === 'SYSTEM' || typeof message.metadata?.error === 'string');
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-2 w-2 animate-typing rounded-full bg-primary/60" />
      <div className="h-2 w-2 animate-typing rounded-full bg-primary/60 [animation-delay:0.2s]" />
      <div className="h-2 w-2 animate-typing rounded-full bg-primary/60 [animation-delay:0.4s]" />
    </div>
  );
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[1.75rem] border border-outline/15 bg-surface-container-lowest p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h3 className="text-xl font-semibold text-on-surface">{title}</h3>
          <button className="rounded-full border border-outline/20 px-3 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container" onClick={onClose} type="button">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ChatScreen() {
  const router = useRouter();
  const { accessToken, ready, refresh, setupRequired, user, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  // Per-agent streaming state keyed by tempId. Each agent has its own bubble
  // so one agent finishing doesn't wipe another agent's in-progress stream.
  const [agentStreams, setAgentStreams] = useState<Map<string, AgentStream>>(new Map());
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [agentForm, setAgentForm] = useState<CreateAgentInput>(emptyAgentForm);
  const [groupName, setGroupName] = useState('');
  const [groupAgentIds, setGroupAgentIds] = useState<string[]>([]);
  const [selectedChannelAgentIds, setSelectedChannelAgentIds] = useState<string[]>([]);
  const [savingAgent, setSavingAgent] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const isNearBottomRef = useRef(true);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const workspace = workspaces[0] ?? null;
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const directChannels = channels.filter((channel) => channel.type === 'DIRECT');
  const groupChannels = channels.filter((channel) => channel.type !== 'DIRECT');
  const selectedChannelIsGroup = selectedChannel?.type !== 'DIRECT';
  const activeAgents = useMemo(
    () => agents.filter((agent) => selectedChannel?.participantAgentIds.includes(agent.id)),
    [agents, selectedChannel?.participantAgentIds],
  );

  useEffect(() => {
    setSelectedChannelAgentIds(selectedChannel?.participantAgentIds ?? []);
  }, [selectedChannel?.id, selectedChannel?.participantAgentIds]);

  const loadBootstrap = useCallback(async (token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    const nextWorkspaces = await apiJson<WorkspaceSummary[]>('/workspaces', { headers });

    if (nextWorkspaces.length === 0) {
      return { workspaces: [], channels: [], agents: [] };
    }

    const currentWorkspace = nextWorkspaces[0];
    const [nextChannels, nextAgents] = await Promise.all([
      apiJson<ChannelSummary[]>(`/workspaces/${currentWorkspace.id}/channels`, { headers }),
      apiJson<AgentSummary[]>(`/workspaces/${currentWorkspace.id}/agents`, { headers }),
    ]);

    return { workspaces: nextWorkspaces, channels: nextChannels, agents: nextAgents };
  }, []);

  const loadMessages = useCallback(async (token: string, channelId: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    return apiJson<MessageRecord[]>(`/channels/${channelId}/messages?limit=50`, { headers });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) {
      router.replace('/setup');
      return;
    }
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!accessToken) {
      void refresh().then((ok) => {
        if (!ok) router.replace('/login');
      });
      return;
    }

    let cancelled = false;

    void loadBootstrap(accessToken)
      .then((data) => {
        if (cancelled) return;
        startTransition(() => {
          setWorkspaces(data.workspaces);
          setChannels(data.channels);
          setAgents(data.agents);
          setSelectedChannelId((current) => current ?? data.channels[0]?.id ?? null);
          setLoading(false);
        });
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Failed to load conversations.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, loadBootstrap, ready, refresh, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken || !selectedChannelId) return;

    let cancelled = false;
    setAgentStreams(new Map());

    void loadMessages(accessToken, selectedChannelId)
      .then((nextMessages) => {
        if (!cancelled) {
          setMessages(nextMessages);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load message history.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, loadMessages, selectedChannelId]);

  useEffect(() => {
    if (!accessToken || !selectedChannelId) return;

    const socket = getChatSocket(accessToken);

    const handleMessage = (message: MessageRecord) => {
      if (message.channelId === selectedChannelId) {
        setMessages((current) => (current.some((entry) => entry.id === message.id) ? current : [...current, message]));
        if (isAgentFailure(message)) {
          setAgentState('error');
        }
      }

      setChannels((current) =>
        current.map((channel) => (channel.id === message.channelId ? { ...channel, lastMessageAt: message.createdAt } : channel)),
      );
    };

    const handleStreamChunk = (payload: { channelId: string; delta: string; tempId: string; agentId: string }) => {
      if (payload.channelId !== selectedChannelId) return;
      setAgentState('streaming');
      setAgentStreams((current) => {
        const next = new Map(current);
        const existing = next.get(payload.tempId);
        next.set(payload.tempId, {
          agentId: payload.agentId,
          text: (existing?.text ?? '') + payload.delta,
        });
        return next;
      });
    };

    const handleStreamEnd = (payload: { channelId: string; tempId: string }) => {
      if (payload.channelId !== selectedChannelId) return;
      setAgentStreams((current) => {
        const next = new Map(current);
        next.delete(payload.tempId);
        // Only go idle once every active stream has finished.
        if (next.size === 0) {
          setAgentState('idle');
        }
        return next;
      });
    };

    const handleSocketError = (payload: { message: string }) => {
      setAgentState('error');
      setError(payload.message);
    };

    socket.connect();
    socket.emit('channel:join', { channelId: selectedChannelId });
    socket.on('message:new', handleMessage);
    socket.on('message:stream:chunk', handleStreamChunk);
    socket.on('message:stream:end', handleStreamEnd);
    socket.on('error', handleSocketError);

    return () => {
      socket.emit('channel:leave', { channelId: selectedChannelId });
      socket.off('message:new', handleMessage);
      socket.off('message:stream:chunk', handleStreamChunk);
      socket.off('message:stream:end', handleStreamEnd);
      socket.off('error', handleSocketError);
    };
  }, [accessToken, selectedChannelId]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, agentStreams, agentState]);

  const canSend = Boolean(draft.trim() && accessToken && selectedChannelId && agentState !== 'queued' && agentState !== 'streaming' && agentStreams.size === 0);

  const submitMessage = useCallback(() => {
    if (!canSend || !accessToken || !selectedChannelId) return;

    const socket = getChatSocket(accessToken);
    setAgentState('queued');
    setAgentStreams(new Map());
    setError(null);

    if (!socket.connected) {
      socket.connect();
      socket.emit('channel:join', { channelId: selectedChannelId });
    }

    socket.emit('message:send', { channelId: selectedChannelId, content: draft.trim(), contentType: 'TEXT' });
    setDraft('');
  }, [accessToken, canSend, draft, selectedChannelId]);

  const createAgent = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingAgent(true);
    setError(null);

    try {
      const created = await apiJson<AgentSummary>(`/workspaces/${workspace.id}/agents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(agentForm),
      });
      setAgents((current) => [...current, created]);
      setShowNewAgent(false);
      setAgentForm(emptyAgentForm);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create agent.');
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
      setChannels((current) => (current.some((entry) => entry.id === channel.id) ? current.map((entry) => (entry.id === channel.id ? channel : entry)) : [...current, channel]));
      setSelectedChannelId(channel.id);
    } catch (directError) {
      setError(directError instanceof Error ? directError.message : 'Failed to open direct chat.');
    }
  }, [accessToken]);

  const createGroupChat = useCallback(async () => {
    if (!accessToken || !workspace) return;
    setSavingGroup(true);
    setError(null);

    try {
      const payload: CreateChannelInput = {
        name: groupName.trim(),
        type: 'PUBLIC',
        agentIds: groupAgentIds,
      };
      const created = await apiJson<ChannelSummary>(`/workspaces/${workspace.id}/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });
      setChannels((current) => [...current, created]);
      setSelectedChannelId(created.id);
      setShowNewGroup(false);
      setGroupName('');
      setGroupAgentIds([]);
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : 'Failed to create group chat.');
    } finally {
      setSavingGroup(false);
    }
  }, [accessToken, groupAgentIds, groupName, workspace]);

  const saveGroupMembers = useCallback(async () => {
    if (!accessToken || !selectedChannel || !selectedChannelIsGroup) return;
    setSavingMembers(true);
    setError(null);

    try {
      const updated = await apiJson<ChannelSummary>(`/channels/${selectedChannel.id}/agents`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ agentIds: selectedChannelAgentIds }),
      });
      setChannels((current) => current.map((channel) => (channel.id === updated.id ? updated : channel)));
      setShowMembers(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update group members.');
    } finally {
      setSavingMembers(false);
    }
  }, [accessToken, selectedChannel, selectedChannelAgentIds, selectedChannelIsGroup]);

  const activeStreamCount = agentStreams.size;
  const agentStateLabel =
    activeStreamCount > 1 ? `${activeStreamCount} agents replying`
      : agentState === 'streaming' ? 'Replying'
      : agentState === 'queued' ? 'Routing'
      : agentState === 'error' ? 'Needs attention'
      : 'Ready';

  if (loading || !ready) {
    return <main className="flex min-h-screen items-center justify-center text-on-surface-variant">Loading chat…</main>;
  }

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full overflow-hidden">
        <aside className="w-[320px] shrink-0 border-r border-outline/15 bg-surface-container-lowest/90">
          <div className="flex h-full flex-col">
            <div className="border-b border-outline/10 px-5 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-surface-container shadow-sm ring-1 ring-outline/10">
                  <Image alt="NextGenChat logo" className="h-full w-full object-cover" height={64} priority src="/nextgenchat-brand-mark.png" width={64} />
                </div>
                <div>
                  <div className="font-headline text-xl font-semibold tracking-tight text-primary">NextGenChat</div>
                  <div className="text-xs text-on-surface-variant/60">Conversations</div>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button className="rounded-full border border-outline/20 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5" onClick={() => setShowNewGroup(true)} type="button">New group</button>
                <button className="rounded-full border border-outline/20 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5" onClick={() => setShowNewAgent(true)} type="button">New agent</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Direct messages</div>
              <div className="space-y-1.5">
                {directChannels.map((channel) => (
                  <button className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${selectedChannelId === channel.id ? 'bg-primary/12 text-on-surface' : 'hover:bg-surface-container'}`} key={channel.id} onClick={() => setSelectedChannelId(channel.id)} type="button">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/90 text-sm font-bold text-on-primary">{conversationAvatarLabel(channel)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-on-surface">{formatConversationTitle(channel)}</div>
                      <div className="truncate text-xs text-on-surface-variant/60">{getConversationSubtitle(channel)}</div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-6 px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Groups</div>
              <div className="space-y-1.5">
                {groupChannels.map((channel) => (
                  <button className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${selectedChannelId === channel.id ? 'bg-primary/12 text-on-surface' : 'hover:bg-surface-container'}`} key={channel.id} onClick={() => setSelectedChannelId(channel.id)} type="button">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container text-sm font-bold text-primary ring-1 ring-outline/10">{conversationAvatarLabel(channel)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-on-surface">{formatConversationTitle(channel)}</div>
                      <div className="truncate text-xs text-on-surface-variant/60">{getConversationSubtitle(channel)}</div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-6 px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Agents</div>
              <div className="space-y-1.5">
                {agents.map((agent) => (
                  <button className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-surface-container" key={agent.id} onClick={() => void openDirectChat(agent.id)} type="button">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/75 text-sm font-bold text-on-primary">{agent.name.slice(0, 1).toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-on-surface">{agent.name}</div>
                      <div className="truncate text-xs text-on-surface-variant/60">{agent.persona || agent.triggerMode.replaceAll('_', ' ')}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-outline/10 p-4">
              <button className="w-full rounded-2xl border border-outline/20 px-4 py-3 text-sm font-medium text-on-surface-variant hover:bg-surface-container" onClick={() => logout()} type="button">Log Out</button>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-18 items-center justify-between border-b border-outline/10 bg-surface-container-lowest/80 px-6 backdrop-blur">
            <div className="flex items-center gap-4">
              {selectedChannel ? (
                <>
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/90 text-sm font-bold text-on-primary">{conversationAvatarLabel(selectedChannel)}</div>
                  <div>
                    <div className="text-lg font-semibold text-on-surface">{formatConversationTitle(selectedChannel)}</div>
                    <div className="text-sm text-on-surface-variant/60">{selectedChannel.type === 'DIRECT' ? 'Direct message' : getConversationSubtitle(selectedChannel)}</div>
                  </div>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden rounded-full bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface-variant md:inline-flex">{agentStateLabel}</span>
              {selectedChannel?.type === 'DIRECT' && activeAgents[0] ? (
                <Link className="rounded-full border border-outline/20 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5" href={`/agents/${activeAgents[0].id}`}>Open profile</Link>
              ) : null}
              {selectedChannelIsGroup && selectedChannel ? (
                <button className="rounded-full border border-outline/20 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5" onClick={() => setShowMembers(true)} type="button">Manage members</button>
              ) : null}
            </div>
          </header>

          <section className="flex-1 overflow-y-auto" onScroll={handleScroll} ref={scrollContainerRef}>
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-7 px-6 py-8 pb-44">
              {messages.map((message) => {
                const failure = isAgentFailure(message);
                const isAgent = message.senderType === 'AGENT';
                const isSystem = message.contentType === 'SYSTEM';

                if (isSystem) {
                  return (
                    <div className="flex justify-center" key={message.id}>
                      <div className="rounded-full bg-surface-container px-4 py-2 text-xs text-on-surface-variant">{message.content}</div>
                    </div>
                  );
                }

                return (
                  <article className="flex gap-4" key={message.id}>
                    <div className={isAgent ? 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/90 text-sm font-bold text-on-primary' : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-container text-sm font-bold text-on-surface'}>
                      {(message.senderName ?? 'U').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-sm font-semibold text-on-surface">{message.senderName ?? (isAgent ? 'Agent' : user?.username ?? 'You')}</span>
                        {isAgent ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-primary">Agent</span> : null}
                        {failure ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-rose-700">Error</span> : null}
                        <span className="text-[10px] text-on-surface-variant/50">{formatTime(message.createdAt)}</span>
                      </div>
                      <div className={`rounded-[1.5rem] p-5 shadow-sm ring-1 ${isAgent ? (failure ? 'bg-rose-50 ring-rose-200/80' : 'bg-surface-container-lowest ring-primary/15') : 'bg-surface-container-lowest ring-outline/10'}`}>
                        <p className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface/90">{message.content}</p>
                      </div>
                    </div>
                  </article>
                );
              })}

              {agentState === 'queued' && agentStreams.size === 0 ? (
                <article className="flex gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/40 text-sm font-bold text-primary">AI</div>
                  <div className="rounded-[1.5rem] bg-surface-container-lowest p-5 shadow-sm ring-1 ring-primary/10">
                    <div className="mb-3 text-sm font-semibold text-on-surface/70">Routing and thinking…</div>
                    <ThinkingDots />
                  </div>
                </article>
              ) : null}

              {Array.from(agentStreams.entries()).map(([tempId, stream]) => {
                const streamingAgent = agents.find((agent) => agent.id === stream.agentId);
                const label = streamingAgent?.name ?? 'Agent';
                return (
                  <article className="flex gap-4" key={tempId}>
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/90 text-sm font-bold text-on-primary">{label.slice(0, 1).toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-sm font-semibold text-on-surface">{label}</span>
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-primary">Agent</span>
                        <span className="text-[10px] text-on-surface-variant/50">Replying…</span>
                      </div>
                      <div className="rounded-[1.5rem] bg-surface-container-lowest p-5 shadow-sm ring-1 ring-primary/15">
                        {stream.text ? (
                          <p className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface/90">{stream.text}</p>
                        ) : (
                          <ThinkingDots />
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="border-t border-outline/10 bg-surface-container-lowest/80 px-6 py-4">
            {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
            <div className="mx-auto max-w-4xl rounded-[1.75rem] bg-surface-container-lowest p-3 shadow-[0_12px_30px_rgba(44,52,51,0.10)] ring-1 ring-outline/10">
              <textarea
                className="min-h-28 w-full resize-none bg-transparent px-3 py-2 text-sm text-on-surface outline-none placeholder:text-on-surface-variant/40"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submitMessage();
                  }
                }}
                placeholder={selectedChannel?.type === 'DIRECT' ? `Message ${formatConversationTitle(selectedChannel)}…` : 'Message the group…'}
                value={draft}
              />
              <div className="mt-3 flex items-center justify-between gap-3 px-3 pb-1">
                <span className="text-xs text-on-surface-variant/50">{agentState === 'error' ? 'The last agent run failed.' : activeStreamCount > 1 ? `${activeStreamCount} agents are replying…` : agentState === 'streaming' ? 'Agent reply in progress.' : agentState === 'queued' ? 'Selecting the right collaborators…' : `${isMac ? '⌘' : 'Ctrl'} + Enter to send`}</span>
                <button className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-dim active:scale-95 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSend} onClick={submitMessage} type="button">Send</button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {showNewAgent ? (
        <Modal onClose={() => { setShowNewAgent(false); setAgentForm(emptyAgentForm); }} title="Create agent">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))} placeholder="Agent name" value={agentForm.name} />
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, persona: event.target.value }))} placeholder="Persona" value={agentForm.persona ?? ''} />
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, voiceTone: event.target.value }))} placeholder="Voice tone" value={agentForm.voiceTone ?? ''} />
            <select className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, triggerMode: event.target.value as CreateAgentInput['triggerMode'] }))} value={agentForm.triggerMode}>
              <option value="AUTO">Auto</option>
              <option value="MENTIONS_ONLY">Mentions only</option>
              <option value="ALL_MESSAGES">All messages</option>
              <option value="DISABLED">Disabled</option>
            </select>
            <textarea className="min-h-32 rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder="System prompt" value={agentForm.systemPrompt ?? ''} />
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!agentForm.name.trim() || savingAgent} onClick={() => void createAgent()} type="button">{savingAgent ? 'Creating…' : 'Create agent'}</button>
          </div>
        </Modal>
      ) : null}

      {showNewGroup ? (
        <Modal onClose={() => { setShowNewGroup(false); setGroupName(''); setGroupAgentIds([]); }} title="Create group">
          <div className="grid gap-3">
            <input className="rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" value={groupName} />
            <div className="space-y-2 rounded-2xl bg-surface-container p-4">
              {agents.map((agent) => (
                <label className="flex items-center gap-2 text-sm text-on-surface" key={agent.id}>
                  <input checked={groupAgentIds.includes(agent.id)} onChange={() => setGroupAgentIds((current) => (current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id]))} type="checkbox" />
                  {agent.name}
                </label>
              ))}
            </div>
            <button className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={!groupName.trim() || savingGroup} onClick={() => void createGroupChat()} type="button">{savingGroup ? 'Creating…' : 'Create group'}</button>
          </div>
        </Modal>
      ) : null}

      {showMembers && selectedChannel && selectedChannelIsGroup ? (
        <Modal onClose={() => setShowMembers(false)} title={`Manage ${selectedChannel.name}`}>
          <div className="space-y-4">
            <p className="text-sm leading-6 text-on-surface-variant">Add or remove agents from this group. The app will post join events so the room feels like a normal team chat.</p>
            <div className="space-y-2 rounded-2xl bg-surface-container p-4">
              {agents.map((agent) => (
                <label className="flex items-center gap-2 text-sm text-on-surface" key={agent.id}>
                  <input checked={selectedChannelAgentIds.includes(agent.id)} onChange={() => setSelectedChannelAgentIds((current) => (current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id]))} type="checkbox" />
                  {agent.name}
                </label>
              ))}
            </div>
            <button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50" disabled={savingMembers} onClick={() => void saveGroupMembers()} type="button">{savingMembers ? 'Saving…' : 'Save members'}</button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
