/**
 * Agent Admin Screen
 *
 * Dedicated agent workspace where the operator edits agent settings and durable
 * markdown docs. Includes a lightweight writing-assistant bubble for doc help.
 *
 * Phase 4 implementation status:
 * - Seven-file agent architecture: soul.md, identity.md, Agent.md, user.md, memory.md, Heartbeat.md, pickup.md
 * - soul.md: immutable values and ethics, injected first in context
 * - user.md: agent's evolving model of the user, written by the agent via workspace_write_file
 * - memory.md: long-term patterns and learnings, written by the agent
 * - Workspace agency.md: shared across all agents, editable in the right sidebar
 * - AgentCreatorAgent chat panel: replaces the writing assistant; edits any agent file via natural-language chat
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { AgentCreatorChatMessage, AgentCreatorChatResponse, AgentDetail, AgentDocRecord, UpdateAgentDocInput, UpdateAgentInput, WorkspaceDocRecord } from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';

const DOC_ORDER = ['soul.md', 'identity.md', 'Agent.md', 'user.md', 'memory.md', 'Heartbeat.md', 'pickup.md'] as const;
type DocTab = (typeof DOC_ORDER)[number];

const DOC_DESCRIPTIONS: Record<DocTab, string> = {
  'soul.md': 'Core values & ethics — immutable principles',
  'identity.md': 'Public persona, tone & communication style',
  'Agent.md': 'Operating manual — tool rules & memory triggers',
  'user.md': "Agent's model of the user — written by the agent",
  'memory.md': 'Long-term patterns & learnings — written by the agent',
  'Heartbeat.md': 'Periodic status log for resumable work',
  'pickup.md': 'Pickup agent decision instructions',
};

export function AgentAdminScreen({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { accessToken, ready, setupRequired, user } = useAuth();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [docs, setDocs] = useState<Record<string, AgentDocRecord>>({});
  const [activeTab, setActiveTab] = useState<DocTab>('identity.md');
  const [draft, setDraft] = useState('');
  const [agentForm, setAgentForm] = useState<UpdateAgentInput>({});
  const [creatorHistory, setCreatorHistory] = useState<AgentCreatorChatMessage[]>([]);
  const [creatorInput, setCreatorInput] = useState('');
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingDoc, setSavingDoc] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Workspace agency state
  const [workspaceAgency, setWorkspaceAgency] = useState<WorkspaceDocRecord | null>(null);
  const [agencyDraft, setAgencyDraft] = useState('');
  const [savingAgency, setSavingAgency] = useState(false);
  const [agencySavedAt, setAgencySavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) {
      router.replace('/setup');
      return;
    }
    if (!user) {
      router.replace('/login');
    }
  }, [ready, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken) return;

    let active = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const [nextAgent, nextDocs, nextAgency] = await Promise.all([
          apiJson<AgentDetail>(`/agents/${agentId}`, { headers }),
          apiJson<AgentDocRecord[]>(`/agents/${agentId}/docs`, { headers }),
          apiJson<WorkspaceDocRecord>('/workspace/agency', { headers }),
        ]);

        if (!active) return;

        setAgent(nextAgent);
        setAgentForm({
          name: nextAgent.name,
          persona: nextAgent.persona ?? '',
          systemPrompt: nextAgent.systemPrompt ?? '',
          voiceTone: nextAgent.voiceTone ?? '',
          triggerMode: nextAgent.triggerMode,
          status: nextAgent.status,
        });
        setDocs(Object.fromEntries(nextDocs.map((doc) => [doc.docType, doc])));
        setWorkspaceAgency(nextAgency);
        setAgencyDraft(nextAgency.content);
        setAgencySavedAt(nextAgency.updatedAt);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load agent workspace.');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [accessToken, agentId]);

  const activeDoc = docs[activeTab] ?? null;

  useEffect(() => {
    setDraft(activeDoc?.content ?? '');
    setSavedAt(activeDoc?.updatedAt ?? null);
  }, [activeDoc]);

  const hasDocChanges = useMemo(() => draft !== (activeDoc?.content ?? ''), [activeDoc?.content, draft]);
  const hasAgentChanges = useMemo(() => {
    if (!agent) return false;
    return JSON.stringify(agentForm) !== JSON.stringify({
      name: agent.name,
      persona: agent.persona ?? '',
      systemPrompt: agent.systemPrompt ?? '',
      voiceTone: agent.voiceTone ?? '',
      triggerMode: agent.triggerMode,
      status: agent.status,
    });
  }, [agent, agentForm]);
  const hasAgencyChanges = agencyDraft !== (workspaceAgency?.content ?? '');

  async function saveDoc() {
    if (!accessToken) return;
    setSavingDoc(true);
    setError(null);

    try {
      const payload: UpdateAgentDocInput = { content: draft };
      const updated = await apiJson<AgentDocRecord>(`/agents/${agentId}/docs/${encodeURIComponent(activeTab)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });
      setDocs((current) => ({ ...current, [updated.docType]: updated }));
      setSavedAt(updated.updatedAt);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save document.');
    } finally {
      setSavingDoc(false);
    }
  }

  async function saveAgent() {
    if (!accessToken) return;
    setSavingAgent(true);
    setError(null);

    try {
      await apiJson(`/agents/${agentId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(agentForm),
      });
      const refreshed = await apiJson<AgentDetail>(`/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setAgent(refreshed);
      setAgentForm({
        name: refreshed.name,
        persona: refreshed.persona ?? '',
        systemPrompt: refreshed.systemPrompt ?? '',
        voiceTone: refreshed.voiceTone ?? '',
        triggerMode: refreshed.triggerMode,
        status: refreshed.status,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save agent settings.');
    } finally {
      setSavingAgent(false);
    }
  }

  async function saveAgency() {
    if (!accessToken) return;
    setSavingAgency(true);
    setError(null);

    try {
      const updated = await apiJson<WorkspaceDocRecord>('/workspace/agency', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ content: agencyDraft }),
      });
      setWorkspaceAgency(updated);
      setAgencyDraft(updated.content);
      setAgencySavedAt(updated.updatedAt);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save workspace agency.');
    } finally {
      setSavingAgency(false);
    }
  }

  async function sendCreatorMessage() {
    if (!accessToken || !creatorInput.trim() || creatorLoading) return;
    const message = creatorInput.trim();
    setCreatorInput('');
    setCreatorLoading(true);

    const nextHistory: AgentCreatorChatMessage[] = [...creatorHistory, { role: 'user', content: message }];
    setCreatorHistory(nextHistory);

    try {
      const response = await apiJson<AgentCreatorChatResponse>(`/agents/${agentId}/creator/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message, history: creatorHistory }),
      });

      setCreatorHistory([...nextHistory, { role: 'assistant', content: response.reply }]);

      if (response.fileUpdates.length > 0) {
        // Re-fetch updated docs so the editor reflects the new content.
        const updatedDocs = await apiJson<AgentDocRecord[]>(`/agents/${agentId}/docs`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        setDocs(Object.fromEntries(updatedDocs.map((doc) => [doc.docType, doc])));
      }
    } catch (creatorError) {
      setCreatorHistory([...nextHistory, { role: 'assistant', content: `Error: ${creatorError instanceof Error ? creatorError.message : 'Request failed.'}` }]);
    } finally {
      setCreatorLoading(false);
    }
  }

  if (!ready || loading) {
    return <main className="flex min-h-screen items-center justify-center px-6 py-16 text-on-surface-variant">Loading agent workspace…</main>;
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-6 px-4 py-6 lg:px-6">
        <header className="flex flex-col gap-4 rounded-[1.75rem] border border-outline/10 bg-surface-container-lowest p-6 shadow-sm xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/55">Agent Workspace</p>
            <h1 className="font-headline mt-3 text-3xl font-bold tracking-tight text-on-surface">{agent?.name ?? 'Agent'}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-on-surface-variant">Edit agent settings, maintain durable markdown docs, and configure the pickup agent that decides when this agent should engage in group conversations.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="rounded-full border border-outline/20 px-4 py-2 text-sm font-semibold text-on-surface-variant transition hover:bg-surface-container" href="/chat">Back to chat</Link>
            <button className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-dim disabled:opacity-50" disabled={!hasAgentChanges || savingAgent} onClick={saveAgent} type="button">{savingAgent ? 'Saving agent…' : 'Save agent settings'}</button>
            <button className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-dim disabled:opacity-50" disabled={!hasDocChanges || savingDoc} onClick={saveDoc} type="button">{savingDoc ? 'Saving doc…' : 'Save document'}</button>
          </div>
        </header>

        {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

        <section className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
          <aside className="space-y-6 rounded-[1.5rem] border border-outline/10 bg-surface-container-lowest p-4 shadow-sm">
            <section>
              <p className="px-2 pb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Agent settings</p>
              <div className="space-y-3 rounded-2xl bg-surface-container p-4">
                <input className="w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))} placeholder="Agent name" value={agentForm.name ?? ''} />
                <input className="w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, persona: event.target.value }))} placeholder="Persona" value={agentForm.persona ?? ''} />
                <input className="w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, voiceTone: event.target.value }))} placeholder="Voice tone" value={agentForm.voiceTone ?? ''} />
                <select className="w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, triggerMode: event.target.value as UpdateAgentInput['triggerMode'] }))} value={agentForm.triggerMode}>
                  <option value="AUTO">Auto</option>
                  <option value="MENTIONS_ONLY">Mentions only</option>
                  <option value="ALL_MESSAGES">All messages</option>
                  <option value="DISABLED">Disabled</option>
                </select>
                <select className="w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, status: event.target.value as UpdateAgentInput['status'] }))} value={agentForm.status}>
                  <option value="ACTIVE">Active</option>
                  <option value="PAUSED">Paused</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
                <textarea className="min-h-32 w-full rounded-xl border border-outline/15 bg-transparent px-3 py-2 text-sm outline-none" onChange={(event) => setAgentForm((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder="System prompt" value={agentForm.systemPrompt ?? ''} />
              </div>
            </section>

            <section>
              <p className="px-2 pb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Agent docs</p>
              <div className="space-y-2">
                {DOC_ORDER.map((docType) => {
                  const selected = docType === activeTab;
                  return (
                    <button className={`w-full rounded-2xl px-4 py-3 text-left transition ${selected ? 'bg-primary text-on-primary shadow-sm' : 'bg-surface-container text-on-surface hover:bg-surface-container-high'}`} key={docType} onClick={() => setActiveTab(docType)} type="button">
                      <div className="text-sm font-semibold">{docs[docType]?.fileName ?? docType}</div>
                      <div className={`mt-1 text-xs ${selected ? 'text-on-primary/75' : 'text-on-surface-variant/60'}`}>{DOC_DESCRIPTIONS[docType]}</div>
                    </button>
                  );
                })}
              </div>
            </section>
          </aside>

          <section className="flex min-h-[74vh] flex-col rounded-[1.5rem] border border-outline/10 bg-surface-container-lowest shadow-sm">
            <div className="border-b border-outline/10 px-6 py-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Editor</p>
              <h2 className="mt-2 text-xl font-bold text-on-surface">{activeDoc?.fileName ?? activeTab}</h2>
              <p className="mt-2 text-sm text-on-surface-variant">{savedAt ? `Last saved ${new Date(savedAt).toLocaleString()}` : 'Not saved yet'}</p>
            </div>
            <textarea className="min-h-[65vh] flex-1 resize-none bg-transparent px-6 py-5 font-mono text-sm leading-7 text-on-surface outline-none" onChange={(event) => setDraft(event.target.value)} value={draft} />
          </section>

          <aside className="flex min-h-[74vh] flex-col gap-6 rounded-[1.5rem] border border-outline/10 bg-surface-container-lowest p-5 shadow-sm">
            <section className="rounded-2xl bg-surface-container p-5 ring-1 ring-outline/10">
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Preview</p>
              <div className="mt-4 max-h-[20vh] overflow-auto rounded-xl bg-surface-container-lowest p-4">
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-on-surface/85">{draft}</pre>
              </div>
            </section>

            <section className="flex flex-1 flex-col rounded-2xl bg-surface-container ring-1 ring-outline/10">
              <div className="flex items-center justify-between gap-3 border-b border-outline/10 px-5 py-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">AgentCreatorAgent</p>
                  <p className="mt-1 text-xs leading-5 text-on-surface-variant">Chat to edit any of this agent&apos;s files. It knows all the rules.</p>
                </div>
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-on-primary">AC</div>
              </div>

              {/* Message history */}
              <div className="flex max-h-64 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
                {creatorHistory.length === 0 ? (
                  <p className="text-xs leading-6 text-on-surface-variant/50">
                    Tell me what to change. Examples:<br />
                    &ldquo;Make her tone warmer and more casual&rdquo;<br />
                    &ldquo;She should be an expert in React and performance&rdquo;<br />
                    &ldquo;Add a rule that she always shows code examples&rdquo;
                  </p>
                ) : (
                  creatorHistory.map((msg, index) => (
                    <div className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`} key={index}>
                      <div className={`max-w-[90%] rounded-2xl px-3 py-2 text-xs leading-5 ${msg.role === 'user' ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface ring-1 ring-outline/10'}`}>
                        {msg.content}
                      </div>
                    </div>
                  ))
                )}
                {creatorLoading ? (
                  <div className="flex items-start">
                    <div className="rounded-2xl bg-surface-container-lowest px-3 py-2 text-xs text-on-surface-variant ring-1 ring-outline/10">Thinking…</div>
                  </div>
                ) : null}
              </div>

              {/* Input */}
              <div className="border-t border-outline/10 px-5 py-4">
                <textarea
                  className="min-h-16 w-full resize-none rounded-xl border border-outline/15 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-on-surface-variant/40"
                  disabled={creatorLoading}
                  onChange={(event) => setCreatorInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendCreatorMessage();
                    }
                  }}
                  placeholder="Describe a change..."
                  value={creatorInput}
                />
                <button
                  className="mt-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50"
                  disabled={!creatorInput.trim() || creatorLoading}
                  onClick={() => void sendCreatorMessage()}
                  type="button"
                >
                  {creatorLoading ? 'Updating…' : 'Send'}
                </button>
              </div>
            </section>

            {/* ── Workspace Agency ────────────────────────────────────────── */}
            <section className="rounded-2xl bg-surface-container p-5 ring-1 ring-outline/10">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-on-surface-variant/50">Workspace agency</p>
                  <p className="mt-2 text-sm leading-6 text-on-surface-variant">Shared mission and standards injected into every agent&apos;s context. One file, all agents.</p>
                  <p className="mt-1 text-xs text-on-surface-variant/50">{agencySavedAt ? `Saved ${new Date(agencySavedAt).toLocaleString()}` : 'Not saved yet'}</p>
                </div>
              </div>
              <textarea
                className="mt-4 min-h-48 w-full resize-none rounded-xl border border-outline/15 bg-surface-container-lowest px-3 py-3 font-mono text-sm leading-7 text-on-surface outline-none"
                onChange={(event) => setAgencyDraft(event.target.value)}
                value={agencyDraft}
              />
              <button
                className="mt-4 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50"
                disabled={!hasAgencyChanges || savingAgency}
                onClick={saveAgency}
                type="button"
              >
                {savingAgency ? 'Saving…' : 'Save workspace agency'}
              </button>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
