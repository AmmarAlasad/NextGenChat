/**
 * Agent Admin Screen
 *
 * Dedicated agent workspace: settings, seven-file doc editor, skills panel,
 * AgentCreatorAgent chat, and workspace agency editor.
 *
 * Phase 5 implementation status:
 * - Seven-file agent architecture: soul.md, identity.md, Agent.md, user.md, memory.md, Heartbeat.md, pickup.md
 * - soul.md: immutable values and ethics, injected first in context
 * - user.md: agent's evolving model of the user, written by the agent via workspace_write_file
 * - memory.md: long-term patterns and learnings, written by the agent
 * - Workspace agency.md: shared across all agents, editable in the right sidebar
 * - AgentCreatorAgent chat panel: replaces the writing assistant; edits any agent file via natural-language chat
 * - Skills panel: list/create/edit/delete passive, on-demand, and tool-based skills
 * - Browser MCP toggle: enables or removes workspace Browser MCP tools for the current agent
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type {
  AgentBrowserMcpState,
  AgentCreatorChatMessage,
  AgentCreatorChatResponse,
  AgentDetail,
  AgentDocRecord,
  AgentScheduleRecord,
  AgentSkill,
  AgentSkillType,
  CreateSkillInput,
  UpdateAgentDocInput,
  UpdateAgentInput,
  WorkspaceDocRecord,
} from '@nextgenchat/types';

import { useAuth } from '@/components/auth-provider';
import { apiJson } from '@/lib/api';

const DOC_ORDER = ['soul.md', 'identity.md', 'Agent.md', 'user.md', 'memory.md', 'Heartbeat.md', 'pickup.md'] as const;
type DocTab = (typeof DOC_ORDER)[number];

const DOC_DESCRIPTIONS: Record<DocTab, string> = {
  'soul.md': 'Core values & ethics — immutable',
  'identity.md': 'Persona, tone & style',
  'Agent.md': 'Operating manual & tool rules',
  'user.md': "Agent's model of the user",
  'memory.md': 'Long-term patterns & learnings',
  'Heartbeat.md': 'Resumable work status log',
  'pickup.md': 'Pickup LLM decision instructions',
};

const DOC_ICONS: Record<DocTab, string> = {
  'soul.md': '◈',
  'identity.md': '◉',
  'Agent.md': '▣',
  'user.md': '◎',
  'memory.md': '⬡',
  'Heartbeat.md': '◇',
  'pickup.md': '◫',
};

const PROTECTED_DOCS: DocTab[] = ['soul.md', 'identity.md', 'Agent.md', 'pickup.md'];

type CenterView = 'settings' | 'doc' | 'skill' | 'agency';
type ScheduleEditorMode = 'everyMinutes' | 'everyHours' | 'daily' | 'weekdays' | 'custom';
type ScheduleEditorState = {
  mode: ScheduleEditorMode;
  interval: string;
  hour: string;
  minute: string;
  raw: string;
};

function avatarColor(name: string): string {
  const palette = ['#7289c0', '#5e6ca1', '#766f90', '#5e5973', '#7e89b4', '#4f6cb0', '#918ca6'];
  let h = 0;
  for (let i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
  return palette[Math.abs(h) % palette.length];
}

function triggerLabel(mode: string): string {
  return { AUTO: 'Auto', WAKEUP: 'Wakeup', MENTIONS_ONLY: 'Mentions', ALL_MESSAGES: 'All msgs', DISABLED: 'Disabled' }[mode] ?? mode;
}

function statusDot(status: string) {
  const color = { ACTIVE: '#22c55e', PAUSED: '#f59e0b', ARCHIVED: 'rgba(255,255,255,0.2)' }[status] ?? 'rgba(255,255,255,0.2)';
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color, boxShadow: status === 'ACTIVE' ? `0 0 6px ${color}` : 'none' }} />;
}

function formatScheduleTime(value: string | null) {
  if (!value) return 'Not scheduled';
  return new Date(value).toLocaleString();
}

function padTwo(value: string) {
  return value.padStart(2, '0');
}

function toLocalDateTimeInput(value: string) {
  const date = new Date(value);
  const localValue = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localValue.toISOString().slice(0, 16);
}

function fromLocalDateTimeInput(value: string) {
  return new Date(value).toISOString();
}

function parseCronEditor(schedule: string): ScheduleEditorState {
  const normalized = schedule.trim().replace(/\s+/g, ' ');
  const fields = normalized.split(' ');
  const cron = fields.length === 5 ? `0 ${normalized}` : normalized;
  const [seconds, minutes, hours, dayOfMonth, month, dayOfWeek] = cron.split(' ');

  if (seconds === '0' && minutes.startsWith('*/') && hours === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { mode: 'everyMinutes', interval: minutes.slice(2), hour: '09', minute: '00', raw: cron };
  }

  if (seconds === '0' && minutes === '0' && hours.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { mode: 'everyHours', interval: hours.slice(2), hour: '09', minute: '00', raw: cron };
  }

  if (seconds === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { mode: 'daily', interval: '1', hour: hours, minute: minutes, raw: cron };
  }

  if (seconds === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return { mode: 'weekdays', interval: '1', hour: hours, minute: minutes, raw: cron };
  }

  return { mode: 'custom', interval: '5', hour: '09', minute: '00', raw: cron };
}

function buildCronFromEditor(editor: ScheduleEditorState) {
  if (editor.mode === 'everyMinutes') {
    const interval = Math.max(1, Number.parseInt(editor.interval || '1', 10) || 1);
    return `0 */${interval} * * * *`;
  }

  if (editor.mode === 'everyHours') {
    const interval = Math.max(1, Number.parseInt(editor.interval || '1', 10) || 1);
    return `0 0 */${interval} * * *`;
  }

  if (editor.mode === 'daily') {
    return `0 ${padTwo(editor.minute || '00')} ${padTwo(editor.hour || '09')} * * *`;
  }

  if (editor.mode === 'weekdays') {
    return `0 ${padTwo(editor.minute || '00')} ${padTwo(editor.hour || '09')} * * 1-5`;
  }

  return editor.raw.trim();
}

// ── Form primitives ───────────────────────────────────────────────────────────

const fieldBase = {
  background: 'var(--surface-container)',
  border: '1px solid var(--outline-variant)',
  color: 'var(--on-surface)',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant/40">{label}</label>
      {children}
    </div>
  );
}

function FInput({ value, onChange, placeholder, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <input
      className="w-full rounded-md px-3 py-2 text-sm outline-none placeholder:opacity-25 transition-colors"
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => { if (!disabled) e.target.style.borderColor = 'var(--primary)'; }}
      onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
      placeholder={placeholder}
      style={{ ...fieldBase, opacity: disabled ? 0.5 : 1 }}
      value={value}
    />
  );
}

function FSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      className="w-full rounded-md px-3 py-2 text-sm outline-none"
      onChange={(e) => onChange(e.target.value)}
      style={fieldBase}
      value={value}
    >
      {children}
    </select>
  );
}

function FTextarea({ value, onChange, placeholder, rows = 4, mono = false }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean }) {
  return (
    <textarea
      className={`w-full resize-none rounded-md px-3 py-2.5 text-sm outline-none placeholder:opacity-25 transition-colors ${mono ? 'font-mono text-xs leading-6' : ''}`}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
      onBlur={(e) => { e.target.style.borderColor = 'var(--outline-variant)'; }}
      placeholder={placeholder}
      rows={rows}
      style={fieldBase}
      value={value}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AgentAdminScreen({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { accessToken, ready, setupRequired, user } = useAuth();
  const creatorScrollRef = useRef<HTMLDivElement>(null);

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
  const [centerView, setCenterView] = useState<CenterView>('doc');
  const [sidebarSection, setSidebarSection] = useState<'files' | 'skills'>('files');

  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkill | null>(null);
  const [skillDraft, setSkillDraft] = useState('');
  const [skillForm, setSkillForm] = useState<{ name: string; description: string; type: AgentSkillType; toolNames: string }>({ name: '', description: '', type: 'ON_DEMAND', toolNames: '' });
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [savingSkill, setSavingSkill] = useState(false);
  const [deletingSkill, setDeletingSkill] = useState(false);

  const [workspaceAgency, setWorkspaceAgency] = useState<WorkspaceDocRecord | null>(null);
  const [agencyDraft, setAgencyDraft] = useState('');
  const [savingAgency, setSavingAgency] = useState(false);
  const [agencySavedAt, setAgencySavedAt] = useState<string | null>(null);
  const [browserMcp, setBrowserMcp] = useState<AgentBrowserMcpState | null>(null);
  const [savingBrowserMcp, setSavingBrowserMcp] = useState(false);
  const [schedules, setSchedules] = useState<AgentScheduleRecord[]>([]);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [savingScheduleId, setSavingScheduleId] = useState<string | null>(null);
  const [scheduleTaskDraft, setScheduleTaskDraft] = useState('');
  const [scheduleTimezoneDraft, setScheduleTimezoneDraft] = useState('');
  const [scheduleOnceDraft, setScheduleOnceDraft] = useState('');
  const [scheduleCronDraft, setScheduleCronDraft] = useState<ScheduleEditorState>({ mode: 'everyMinutes', interval: '5', hour: '09', minute: '00', raw: '0 */5 * * * *' });

  useEffect(() => {
    if (!ready) return;
    if (setupRequired) { router.replace('/setup'); return; }
    if (!user) { router.replace('/login'); }
  }, [ready, router, setupRequired, user]);

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    async function load() {
      setLoading(true); setError(null);
      try {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const [nextAgent, nextDocs, nextAgency, nextSkills, nextBrowserMcp, nextSchedules] = await Promise.all([
          apiJson<AgentDetail>(`/agents/${agentId}`, { headers }),
          apiJson<AgentDocRecord[]>(`/agents/${agentId}/docs`, { headers }),
          apiJson<WorkspaceDocRecord>('/workspace/agency', { headers }),
          apiJson<AgentSkill[]>(`/agents/${agentId}/skills`, { headers }),
          apiJson<AgentBrowserMcpState>(`/agents/${agentId}/browser-mcp`, { headers }),
          apiJson<AgentScheduleRecord[]>(`/agents/${agentId}/schedules`, { headers }),
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
        setSkills(nextSkills);
        setBrowserMcp(nextBrowserMcp);
        setSchedules(nextSchedules);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Failed to load agent workspace.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accessToken, agentId]);

  const activeDoc = docs[activeTab] ?? null;

  useEffect(() => {
    setDraft(activeDoc?.content ?? '');
    setSavedAt(activeDoc?.updatedAt ?? null);
  }, [activeDoc]);

  useEffect(() => {
    if (creatorScrollRef.current) {
      creatorScrollRef.current.scrollTop = creatorScrollRef.current.scrollHeight;
    }
  }, [creatorHistory, creatorLoading]);

  const hasDocChanges = useMemo(() => draft !== (activeDoc?.content ?? ''), [activeDoc?.content, draft]);
  const hasAgentChanges = useMemo(() => {
    if (!agent) return false;
    return JSON.stringify(agentForm) !== JSON.stringify({
      name: agent.name, persona: agent.persona ?? '', systemPrompt: agent.systemPrompt ?? '',
      voiceTone: agent.voiceTone ?? '', triggerMode: agent.triggerMode, status: agent.status,
    });
  }, [agent, agentForm]);
  const hasAgencyChanges = agencyDraft !== (workspaceAgency?.content ?? '');

  async function saveDoc() {
    if (!accessToken) return;
    setSavingDoc(true); setError(null);
    try {
      const payload: UpdateAgentDocInput = { content: draft };
      const updated = await apiJson<AgentDocRecord>(`/agents/${agentId}/docs/${encodeURIComponent(activeTab)}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(payload),
      });
      setDocs((current) => ({ ...current, [updated.docType]: updated }));
      setSavedAt(updated.updatedAt);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save document.');
    } finally { setSavingDoc(false); }
  }

  async function saveAgent() {
    if (!accessToken) return;
    setSavingAgent(true); setError(null);
    try {
      await apiJson(`/agents/${agentId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(agentForm),
      });
      const refreshed = await apiJson<AgentDetail>(`/agents/${agentId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      setAgent(refreshed);
      setAgentForm({
        name: refreshed.name, persona: refreshed.persona ?? '', systemPrompt: refreshed.systemPrompt ?? '',
        voiceTone: refreshed.voiceTone ?? '', triggerMode: refreshed.triggerMode, status: refreshed.status,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save agent settings.');
    } finally { setSavingAgent(false); }
  }

  async function saveAgency() {
    if (!accessToken) return;
    setSavingAgency(true); setError(null);
    try {
      const updated = await apiJson<WorkspaceDocRecord>('/workspace/agency', {
        method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ content: agencyDraft }),
      });
      setWorkspaceAgency(updated); setAgencyDraft(updated.content); setAgencySavedAt(updated.updatedAt);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save workspace agency.');
    } finally { setSavingAgency(false); }
  }

  async function toggleBrowserMcp(enabled: boolean) {
    if (!accessToken || savingBrowserMcp) return;
    setSavingBrowserMcp(true); setError(null);
    try {
      const updated = await apiJson<AgentBrowserMcpState>(`/agents/${agentId}/browser-mcp`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ enabled }),
      });
      setBrowserMcp(updated);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to update Browser MCP.');
    } finally { setSavingBrowserMcp(false); }
  }

  async function deleteSchedule(scheduleId: string) {
    if (!accessToken || deletingScheduleId) return;
    setDeletingScheduleId(scheduleId);
    setError(null);
    try {
      await apiJson(`/agents/${agentId}/schedules/${scheduleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setSchedules((current) => current.filter((schedule) => schedule.id !== scheduleId));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete scheduled task.');
    } finally {
      setDeletingScheduleId(null);
    }
  }

  function startEditingSchedule(schedule: AgentScheduleRecord) {
    setEditingScheduleId(schedule.id);
    setScheduleTaskDraft(schedule.task);
    setScheduleTimezoneDraft(schedule.timezone);
    if (schedule.kind === 'ONCE') {
      setScheduleOnceDraft(toLocalDateTimeInput(schedule.schedule));
    } else {
      setScheduleCronDraft(parseCronEditor(schedule.schedule));
    }
  }

  function cancelEditingSchedule() {
    setEditingScheduleId(null);
    setSavingScheduleId(null);
  }

  async function saveSchedule(schedule: AgentScheduleRecord) {
    if (!accessToken || savingScheduleId) return;
    setSavingScheduleId(schedule.id);
    setError(null);
    try {
      const nextSchedule = schedule.kind === 'ONCE'
        ? fromLocalDateTimeInput(scheduleOnceDraft)
        : buildCronFromEditor(scheduleCronDraft);

      const updated = await apiJson<AgentScheduleRecord>(`/agents/${agentId}/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          task: scheduleTaskDraft,
          timezone: scheduleTimezoneDraft,
          schedule: nextSchedule,
        }),
      });

      setSchedules((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setEditingScheduleId(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update scheduled task.');
    } finally {
      setSavingScheduleId(null);
    }
  }

  async function sendCreatorMessage() {
    if (!accessToken || !creatorInput.trim() || creatorLoading) return;
    const message = creatorInput.trim();
    setCreatorInput(''); setCreatorLoading(true);
    const nextHistory: AgentCreatorChatMessage[] = [...creatorHistory, { role: 'user', content: message }];
    setCreatorHistory(nextHistory);
    try {
      const response = await apiJson<AgentCreatorChatResponse>(`/agents/${agentId}/creator/chat`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message, history: creatorHistory }),
      });
      setCreatorHistory([...nextHistory, { role: 'assistant', content: response.reply }]);
      if (response.fileUpdates.length > 0) {
        const updatedDocs = await apiJson<AgentDocRecord[]>(`/agents/${agentId}/docs`, { headers: { Authorization: `Bearer ${accessToken}` } });
        setDocs(Object.fromEntries(updatedDocs.map((doc) => [doc.docType, doc])));
      }
    } catch (creatorError) {
      setCreatorHistory([...nextHistory, { role: 'assistant', content: `Error: ${creatorError instanceof Error ? creatorError.message : 'Request failed.'}` }]);
    } finally { setCreatorLoading(false); }
  }

  function openSkill(skill: AgentSkill) {
    setSelectedSkill(skill);
    setSkillDraft(skill.content);
    setSkillForm({ name: skill.name, description: skill.description ?? '', type: skill.type, toolNames: skill.toolNames.join(', ') });
    setShowNewSkill(false);
    setCenterView('skill');
  }

  function openNewSkill() {
    setSelectedSkill(null); setSkillDraft('');
    setSkillForm({ name: '', description: '', type: 'ON_DEMAND', toolNames: '' });
    setShowNewSkill(true);
    setCenterView('skill');
  }

  async function saveSkill() {
    if (!accessToken) return;
    setSavingSkill(true); setError(null);
    try {
      const toolNames = skillForm.toolNames.split(',').map((t) => t.trim()).filter(Boolean);
      if (showNewSkill) {
        const payload: CreateSkillInput = { name: skillForm.name, description: skillForm.description || undefined, type: skillForm.type, toolNames: toolNames.length > 0 ? toolNames : undefined, content: skillDraft };
        const created = await apiJson<AgentSkill>(`/agents/${agentId}/skills`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(payload) });
        setSkills((prev) => [...prev, created]); setSelectedSkill(created); setShowNewSkill(false);
      } else if (selectedSkill) {
        const updated = await apiJson<AgentSkill>(`/agents/${agentId}/skills/${selectedSkill.name}`, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ description: skillForm.description || undefined, type: skillForm.type, toolNames, content: skillDraft }) });
        setSkills((prev) => prev.map((s) => s.name === updated.name ? updated : s)); setSelectedSkill(updated);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save skill.');
    } finally { setSavingSkill(false); }
  }

  async function deleteSkill(name: string) {
    if (!accessToken) return;
    setDeletingSkill(true); setError(null);
    try {
      await apiJson(`/agents/${agentId}/skills/${name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
      setSkills((prev) => prev.filter((s) => s.name !== name));
      if (selectedSkill?.name === name) { setSelectedSkill(null); setShowNewSkill(false); setCenterView('doc'); }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete skill.');
    } finally { setDeletingSkill(false); }
  }

  if (!ready || loading) {
    return (
      <main className="flex h-screen items-center justify-center" style={{ background: 'var(--background)' }}>
        <div className="flex items-center gap-3">
          <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0s_infinite] rounded-full bg-primary/60" />
          <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-primary/60" />
          <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-primary/60" />
        </div>
      </main>
    );
  }

  const agentColor = agent ? avatarColor(agent.name) : '#7289c0';
  const agentInitials = agent ? agent.name.slice(0, 2).toUpperCase() : '??';
  const isProtected = PROTECTED_DOCS.includes(activeTab);

  return (
    <main
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: 'var(--background)', color: 'var(--on-surface)' }}
    >

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header
        className="flex h-11 shrink-0 items-center justify-between px-4"
        style={{
          background: 'rgba(13, 15, 22, 0.9)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--outline-variant)',
        }}
      >
        {/* Left: back + agent identity */}
        <div className="flex items-center gap-3">
          <Link
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-on-surface-variant/40 transition-colors hover:bg-white/5 hover:text-on-surface-variant"
            href="/chat"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Chat
          </Link>

          <span style={{ color: 'var(--outline-variant)' }}>·</span>

          {/* Agent badge */}
          <div className="flex items-center gap-2">
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white"
              style={{ background: agentColor }}
            >
              {agentInitials}
            </div>
            <span className="font-headline text-sm font-semibold text-on-surface">{agent?.name ?? 'Agent'}</span>
            <div className="flex items-center gap-1.5">
              {statusDot(agent?.status ?? 'ACTIVE')}
              <span className="text-[10px] text-on-surface-variant/40">{triggerLabel(agent?.triggerMode ?? 'AUTO')}</span>
            </div>
          </div>
        </div>

        {/* Right: save actions + error */}
        <div className="flex items-center gap-2">
          {error && (
            <span className="truncate text-[11px]" style={{ color: 'rgba(255, 102, 133, 0.8)', maxWidth: '280px' }}>{error}</span>
          )}

          {centerView === 'settings' && (
            <button
              className="font-headline rounded-md px-3 py-1.5 text-[11px] font-semibold text-on-primary transition disabled:cursor-not-allowed disabled:opacity-30"
              disabled={!hasAgentChanges || savingAgent}
              onClick={saveAgent}
              style={{ background: 'var(--primary)' }}
              type="button"
            >
              {savingAgent ? 'Saving…' : 'Save settings'}
            </button>
          )}

          {centerView === 'doc' && (
            <>
              {savedAt && (
                <span className="text-[10px] text-on-surface-variant/30">
                  Saved {new Date(savedAt).toLocaleTimeString()}
                </span>
              )}
              {isProtected && (
                <span
                  className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                  style={{ background: 'rgba(255, 0, 51, 0.12)', color: 'rgba(255, 102, 133, 0.7)', border: '1px solid rgba(255, 0, 51, 0.2)' }}
                >
                  Protected
                </span>
              )}
              <button
                className="font-headline rounded-md px-3 py-1.5 text-[11px] font-semibold text-on-primary transition disabled:cursor-not-allowed disabled:opacity-30"
                disabled={!hasDocChanges || savingDoc}
                onClick={saveDoc}
                style={{ background: hasDocChanges ? 'var(--primary)' : 'var(--primary-dim)' }}
                type="button"
              >
                {savingDoc ? 'Saving…' : 'Save'}
              </button>
            </>
          )}

          {centerView === 'skill' && (
            <button
              className="font-headline rounded-md px-3 py-1.5 text-[11px] font-semibold text-on-primary transition disabled:cursor-not-allowed disabled:opacity-30"
              disabled={savingSkill || !skillDraft.trim() || !skillForm.name.trim()}
              onClick={saveSkill}
              style={{ background: 'var(--primary)' }}
              type="button"
            >
              {savingSkill ? 'Saving…' : showNewSkill ? 'Create skill' : 'Save skill'}
            </button>
          )}

          {centerView === 'agency' && (
            <button
              className="font-headline rounded-md px-3 py-1.5 text-[11px] font-semibold text-on-primary transition disabled:cursor-not-allowed disabled:opacity-30"
              disabled={!hasAgencyChanges || savingAgency}
              onClick={saveAgency}
              style={{ background: 'var(--primary)' }}
              type="button"
            >
              {savingAgency ? 'Saving…' : 'Save agency'}
            </button>
          )}
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar ──────────────────────────────────────────────────── */}
        <aside
          className="flex w-[210px] shrink-0 flex-col overflow-hidden"
          style={{ background: 'var(--ti-950)', borderRight: '1px solid var(--outline-variant)' }}
        >
          {/* Sidebar tabs: Files | Skills */}
          <div
            className="flex shrink-0 items-center gap-0"
            style={{ borderBottom: '1px solid var(--outline-variant)' }}
          >
            {(['files', 'skills'] as const).map((section) => (
              <button
                className="flex-1 py-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors"
                key={section}
                onClick={() => setSidebarSection(section)}
                style={{
                  color: sidebarSection === section ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  opacity: sidebarSection === section ? 1 : 0.4,
                  borderBottom: sidebarSection === section ? '1px solid var(--primary)' : '1px solid transparent',
                  marginBottom: '-1px',
                }}
                type="button"
              >
                {section === 'files' ? 'Files' : 'Skills'}
              </button>
            ))}
          </div>

          {/* Settings entry */}
          <button
            className="flex shrink-0 items-center gap-2.5 px-3 py-2 transition-colors"
            onClick={() => setCenterView('settings')}
            style={{
              background: centerView === 'settings' ? 'rgba(114, 137, 192, 0.12)' : 'transparent',
              borderLeft: centerView === 'settings' ? '2px solid var(--primary)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => { if (centerView !== 'settings') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={(e) => { if (centerView !== 'settings') (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            type="button"
          >
            <span className="text-[13px]" style={{ color: centerView === 'settings' ? 'var(--primary)' : 'var(--on-surface-variant)', opacity: centerView === 'settings' ? 1 : 0.5 }}>⚙</span>
            <span
              className="text-[12px] font-medium"
              style={{ color: centerView === 'settings' ? 'var(--on-surface)' : 'var(--on-surface-variant)', opacity: centerView === 'settings' ? 1 : 0.6 }}
            >
              Settings
            </span>
          </button>

          {/* Agency entry */}
          <button
            className="flex shrink-0 items-center gap-2.5 px-3 py-2 transition-colors"
            onClick={() => setCenterView('agency')}
            style={{
              background: centerView === 'agency' ? 'rgba(114, 137, 192, 0.12)' : 'transparent',
              borderLeft: centerView === 'agency' ? '2px solid var(--primary)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => { if (centerView !== 'agency') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={(e) => { if (centerView !== 'agency') (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            type="button"
          >
            <span className="text-[13px]" style={{ color: centerView === 'agency' ? 'var(--primary)' : 'var(--on-surface-variant)', opacity: centerView === 'agency' ? 1 : 0.5 }}>⬡</span>
            <span
              className="text-[12px] font-medium"
              style={{ color: centerView === 'agency' ? 'var(--on-surface)' : 'var(--on-surface-variant)', opacity: centerView === 'agency' ? 1 : 0.6 }}
            >
              Agency
            </span>
          </button>

          <div className="shrink-0 my-1" style={{ borderTop: '1px solid var(--outline-variant)' }} />

          {/* Files or Skills list */}
          <div className="flex-1 overflow-y-auto py-1">
            {sidebarSection === 'files' ? (
              <div>
                <p className="px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant/30">Agent Docs</p>
                {DOC_ORDER.map((docType) => {
                  const isActive = centerView === 'doc' && activeTab === docType;
                  const isProtectedDoc = PROTECTED_DOCS.includes(docType);
                  return (
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 transition-colors"
                      key={docType}
                      onClick={() => { setActiveTab(docType); setCenterView('doc'); setSelectedSkill(null); setShowNewSkill(false); }}
                      title={DOC_DESCRIPTIONS[docType]}
                      style={{
                        background: isActive ? 'rgba(114, 137, 192, 0.12)' : 'transparent',
                        borderLeft: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                      }}
                      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                      type="button"
                    >
                      <span
                        className="shrink-0 text-[11px]"
                        style={{ color: isActive ? 'var(--primary)' : 'var(--on-surface-variant)', opacity: isActive ? 1 : 0.4 }}
                      >
                        {DOC_ICONS[docType]}
                      </span>
                      <div className="min-w-0 flex-1 text-left">
                        <div
                          className="truncate font-mono text-[11px] font-medium"
                          style={{ color: isActive ? 'var(--on-surface)' : 'var(--on-surface-variant)', opacity: isActive ? 1 : 0.7 }}
                        >
                          {docType}
                        </div>
                      </div>
                      {isProtectedDoc && (
                        <span className="shrink-0 text-[8px]" style={{ color: 'rgba(255, 102, 133, 0.4)' }}>●</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between px-3 py-1.5">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant/30">Skills</p>
                  <button
                    className="rounded px-1.5 py-0.5 text-[9px] font-semibold text-on-primary transition hover:opacity-80"
                    onClick={openNewSkill}
                    style={{ background: 'var(--primary)' }}
                    type="button"
                  >
                    + New
                  </button>
                </div>
                {skills.length === 0 && !showNewSkill ? (
                  <p className="px-3 py-2 text-[11px] text-on-surface-variant/30">No skills yet.</p>
                ) : (
                  <>
                    {showNewSkill && (
                      <button
                        className="flex w-full items-center gap-2 px-3 py-1.5"
                        style={{
                          background: 'rgba(114, 137, 192, 0.12)',
                          borderLeft: '2px solid var(--primary)',
                        }}
                        type="button"
                      >
                        <span className="text-[10px]" style={{ color: 'var(--primary)' }}>+</span>
                        <span className="font-mono text-[11px] text-on-surface">New skill…</span>
                      </button>
                    )}
                    {(['PASSIVE', 'ON_DEMAND', 'TOOL_BASED'] as AgentSkillType[]).map((type) => {
                      const group = skills.filter((s) => s.type === type);
                      if (group.length === 0) return null;
                      const typeLabel = { PASSIVE: 'Passive', ON_DEMAND: 'On-demand', TOOL_BASED: 'Tool-based' }[type];
                      return (
                        <div key={type}>
                          <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-widest text-on-surface-variant/25">{typeLabel}</p>
                          {group.map((skill) => {
                            const isActive = centerView === 'skill' && selectedSkill?.name === skill.name;
                            return (
                              <button
                                className="flex w-full items-center gap-2 px-3 py-1.5 transition-colors"
                                key={skill.name}
                                onClick={() => openSkill(skill)}
                                style={{
                                  background: isActive ? 'rgba(114, 137, 192, 0.12)' : 'transparent',
                                  borderLeft: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                                }}
                                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                                type="button"
                              >
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ background: skill.isActive ? '#22c55e' : 'rgba(255,255,255,0.15)' }}
                                />
                                <span
                                  className="truncate font-mono text-[11px]"
                                  style={{ color: isActive ? 'var(--on-surface)' : 'var(--on-surface-variant)', opacity: isActive ? 1 : 0.7 }}
                                >
                                  {skill.name}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* ── Center: editor area ────────────────────────────────────────────── */}
        <section className="flex flex-1 flex-col overflow-hidden" style={{ background: 'var(--ib-950)' }}>

          {/* Editor top bar */}
          <div
            className="flex h-9 shrink-0 items-center gap-0 overflow-x-auto px-0"
            style={{ background: 'var(--ti-900)', borderBottom: '1px solid var(--outline-variant)' }}
          >
            {centerView === 'settings' && (
              <div
                className="flex h-full items-center gap-2 border-b-2 px-4"
                style={{ borderColor: 'var(--primary)', background: 'var(--ib-950)' }}
              >
                <span className="text-[10px]" style={{ color: 'var(--primary)' }}>⚙</span>
                <span className="font-mono text-[11px] text-on-surface">settings</span>
              </div>
            )}
            {centerView === 'doc' && (
              <div
                className="flex h-full items-center gap-2 border-b-2 px-4"
                style={{ borderColor: 'var(--primary)', background: 'var(--ib-950)' }}
              >
                <span className="font-mono text-[11px]" style={{ color: 'var(--primary)' }}>{DOC_ICONS[activeTab]}</span>
                <span className="font-mono text-[11px] text-on-surface">{activeTab}</span>
                {hasDocChanges && <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />}
              </div>
            )}
            {centerView === 'skill' && (
              <div
                className="flex h-full items-center gap-2 border-b-2 px-4"
                style={{ borderColor: 'var(--primary)', background: 'var(--ib-950)' }}
              >
                <span className="font-mono text-[11px]" style={{ color: 'var(--primary)' }}>◈</span>
                <span className="font-mono text-[11px] text-on-surface">{showNewSkill ? 'new-skill' : (selectedSkill?.name ?? 'skill')}</span>
              </div>
            )}
            {centerView === 'agency' && (
              <div
                className="flex h-full items-center gap-2 border-b-2 px-4"
                style={{ borderColor: 'var(--primary)', background: 'var(--ib-950)' }}
              >
                <span className="font-mono text-[11px]" style={{ color: 'var(--primary)' }}>⬡</span>
                <span className="font-mono text-[11px] text-on-surface">agency.md</span>
                {hasAgencyChanges && <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />}
              </div>
            )}
          </div>

          {/* Editor content */}
          <div className="flex flex-1 flex-col overflow-hidden">

            {/* Settings view */}
            {centerView === 'settings' && (
              <div className="flex-1 overflow-y-auto px-8 py-6">
                <div className="mx-auto max-w-xl space-y-5">
                  <div>
                    <h2 className="font-headline text-base font-semibold text-on-surface">Agent Configuration</h2>
                    <p className="mt-0.5 text-[11px] text-on-surface-variant/40">Basic settings for {agent?.name ?? 'this agent'}.</p>
                  </div>
                  <div
                    className="rounded-xl p-5 space-y-4"
                    style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Name">
                        <FInput value={agentForm.name ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, name: v }))} placeholder="Agent name" />
                      </Field>
                      <Field label="Persona">
                        <FInput value={agentForm.persona ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, persona: v }))} placeholder="Persona" />
                      </Field>
                      <Field label="Voice Tone">
                        <FInput value={agentForm.voiceTone ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, voiceTone: v }))} placeholder="e.g. calm, precise" />
                      </Field>
                      <Field label="Trigger Mode">
                        <FSelect value={agentForm.triggerMode ?? 'AUTO'} onChange={(v) => setAgentForm((c) => ({ ...c, triggerMode: v as UpdateAgentInput['triggerMode'] }))}>
                          <option value="AUTO">Auto</option>
                          <option value="WAKEUP">Wakeup</option>
                          <option value="MENTIONS_ONLY">Mentions only</option>
                          <option value="ALL_MESSAGES">All messages</option>
                          <option value="DISABLED">Disabled</option>
                        </FSelect>
                      </Field>
                    </div>
                    <Field label="Status">
                      <FSelect value={agentForm.status ?? 'ACTIVE'} onChange={(v) => setAgentForm((c) => ({ ...c, status: v as UpdateAgentInput['status'] }))}>
                        <option value="ACTIVE">Active</option>
                        <option value="PAUSED">Paused</option>
                        <option value="ARCHIVED">Archived</option>
                      </FSelect>
                    </Field>
                    <Field label="System Prompt">
                      <FTextarea value={agentForm.systemPrompt ?? ''} onChange={(v) => setAgentForm((c) => ({ ...c, systemPrompt: v }))} placeholder="System prompt override…" rows={4} />
                    </Field>
                  </div>

                  <div
                    className="rounded-xl p-5 space-y-4"
                    style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-headline text-sm font-semibold text-on-surface">Browser MCP</h3>
                        <p className="mt-1 text-[11px] text-on-surface-variant/40">
                          Exposes Browser MCP tools to this agent only. The workspace keeps one shared Browser MCP server, and this switch grants or removes its tools for the current agent.
                        </p>
                      </div>
                      <button
                        className="rounded-md px-3 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-30"
                        disabled={savingBrowserMcp}
                        onClick={() => void toggleBrowserMcp(!(browserMcp?.enabled ?? false))}
                        style={{
                          background: browserMcp?.enabled ? 'rgba(34, 197, 94, 0.16)' : 'rgba(255,255,255,0.04)',
                          color: browserMcp?.enabled ? '#86efac' : 'var(--on-surface-variant)',
                          border: browserMcp?.enabled ? '1px solid rgba(34, 197, 94, 0.28)' : '1px solid var(--outline-variant)',
                        }}
                        type="button"
                      >
                        {savingBrowserMcp ? 'Updating…' : browserMcp?.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Server">
                        <div className="rounded-md px-3 py-2 text-sm" style={fieldBase}>
                          {browserMcp?.serverName ?? 'Not configured yet'}
                        </div>
                      </Field>
                      <Field label="Status">
                        <div className="rounded-md px-3 py-2 text-sm" style={fieldBase}>
                          {browserMcp?.serverStatus ?? 'NOT_CONFIGURED'}
                        </div>
                      </Field>
                    </div>

                    <div className="rounded-md px-3 py-3 text-[11px] leading-5" style={{ ...fieldBase, background: 'rgba(255,255,255,0.02)' }}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-on-surface-variant/70">Granted tools</span>
                        <span className="font-mono text-on-surface">{browserMcp?.toolCount ?? 0}</span>
                      </div>
                      <div className="mt-2 text-on-surface-variant/55">
                        {browserMcp?.toolNames?.length
                          ? browserMcp.toolNames.join(', ')
                          : 'No Browser MCP tools are assigned to this agent.'}
                      </div>
                    </div>
                  </div>

                  <div
                    className="rounded-xl p-5 space-y-4"
                    style={{ background: 'var(--surface-container-lowest)', border: '1px solid var(--outline-variant)' }}
                  >
                    <div>
                      <h3 className="font-headline text-sm font-semibold text-on-surface">Scheduled Jobs</h3>
                      <p className="mt-1 text-[11px] text-on-surface-variant/40">
                        Active and archived wakeups for this agent, including the chat each job replies into.
                      </p>
                    </div>

                    {schedules.length === 0 ? (
                      <div className="rounded-md px-3 py-3 text-[11px] text-on-surface-variant/55" style={{ ...fieldBase, background: 'rgba(255,255,255,0.02)' }}>
                        No scheduled jobs yet.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {schedules.map((schedule) => (
                          <div
                            className="rounded-lg px-3 py-3"
                            key={schedule.id}
                            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--outline-variant)' }}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-[11px] text-on-surface">{schedule.id}</span>
                                  <span
                                    className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                                    style={{
                                      background: schedule.kind === 'CRON' ? 'rgba(114,137,192,0.15)' : 'rgba(245,158,11,0.12)',
                                      color: schedule.kind === 'CRON' ? 'var(--primary)' : '#fbbf24',
                                      border: schedule.kind === 'CRON' ? '1px solid rgba(114,137,192,0.25)' : '1px solid rgba(245,158,11,0.24)',
                                    }}
                                  >
                                    {schedule.kind}
                                  </span>
                                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--on-surface-variant)', border: '1px solid var(--outline-variant)' }}>
                                    {statusDot(schedule.status)}
                                    {schedule.status}
                                  </span>
                                </div>

                                <div className="mt-2 space-y-1.5 text-[12px] leading-5">
                                  <div><span className="text-on-surface-variant/55">Delivery:</span> <span className="text-on-surface">{schedule.deliveryDescription}</span></div>
                                  <div><span className="text-on-surface-variant/55">Task:</span> <span className="text-on-surface">{schedule.task}</span></div>
                                  <div><span className="text-on-surface-variant/55">Created from:</span> <span className="text-on-surface">#{schedule.channelName}</span></div>
                                  <div><span className="text-on-surface-variant/55">Schedule:</span> <span className="text-on-surface">{schedule.scheduleDescription}</span></div>
                                  <div><span className="text-on-surface-variant/55">Raw cron/date:</span> <span className="font-mono text-on-surface">{schedule.schedule}</span></div>
                                  <div><span className="text-on-surface-variant/55">Timezone:</span> <span className="text-on-surface">{schedule.timezone}</span></div>
                                  <div><span className="text-on-surface-variant/55">Next run:</span> <span className="text-on-surface">{formatScheduleTime(schedule.nextRunAt)}</span></div>
                                  <div><span className="text-on-surface-variant/55">Last run:</span> <span className="text-on-surface">{formatScheduleTime(schedule.lastRunAt)}</span></div>
                                </div>
                                {editingScheduleId === schedule.id && (
                                  <div
                                    className="mt-3 space-y-3 rounded-lg p-3"
                                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--outline-variant)' }}
                                  >
                                    <Field label="Task">
                                      <FTextarea rows={3} value={scheduleTaskDraft} onChange={setScheduleTaskDraft} />
                                    </Field>
                                    <Field label="Timezone">
                                      <FInput value={scheduleTimezoneDraft} onChange={setScheduleTimezoneDraft} placeholder="Europe/Berlin" />
                                    </Field>
                                    {schedule.kind === 'ONCE' ? (
                                      <Field label="Run at">
                                        <input
                                          className="w-full rounded-md px-3 py-2 text-sm outline-none"
                                          onChange={(e) => setScheduleOnceDraft(e.target.value)}
                                          style={fieldBase}
                                          type="datetime-local"
                                          value={scheduleOnceDraft}
                                        />
                                      </Field>
                                    ) : (
                                      <>
                                        <Field label="Repeat">
                                          <FSelect value={scheduleCronDraft.mode} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, mode: value as ScheduleEditorMode }))}>
                                            <option value="everyMinutes">Every N minutes</option>
                                            <option value="everyHours">Every N hours</option>
                                            <option value="daily">Every day at a time</option>
                                            <option value="weekdays">Weekdays at a time</option>
                                            <option value="custom">Custom cron</option>
                                          </FSelect>
                                        </Field>
                                        {scheduleCronDraft.mode === 'everyMinutes' && (
                                          <Field label="Minutes">
                                            <FInput value={scheduleCronDraft.interval} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, interval: value }))} placeholder="5" />
                                          </Field>
                                        )}
                                        {scheduleCronDraft.mode === 'everyHours' && (
                                          <Field label="Hours">
                                            <FInput value={scheduleCronDraft.interval} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, interval: value }))} placeholder="1" />
                                          </Field>
                                        )}
                                        {(scheduleCronDraft.mode === 'daily' || scheduleCronDraft.mode === 'weekdays') && (
                                          <div className="grid grid-cols-2 gap-3">
                                            <Field label="Hour">
                                              <FInput value={scheduleCronDraft.hour} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, hour: value }))} placeholder="09" />
                                            </Field>
                                            <Field label="Minute">
                                              <FInput value={scheduleCronDraft.minute} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, minute: value }))} placeholder="00" />
                                            </Field>
                                          </div>
                                        )}
                                        {scheduleCronDraft.mode === 'custom' && (
                                          <Field label="Cron">
                                            <FInput value={scheduleCronDraft.raw} onChange={(value) => setScheduleCronDraft((current) => ({ ...current, raw: value }))} placeholder="*/5 * * * *" />
                                          </Field>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>

                              <div className="flex shrink-0 flex-col gap-2">
                                {editingScheduleId === schedule.id ? (
                                  <>
                                    <button
                                      className="rounded-md px-3 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30"
                                      disabled={savingScheduleId === schedule.id}
                                      onClick={() => void saveSchedule(schedule)}
                                      style={{ border: '1px solid rgba(114,137,192,0.35)', color: 'var(--on-surface)', background: 'rgba(114,137,192,0.14)' }}
                                      type="button"
                                    >
                                      {savingScheduleId === schedule.id ? 'Saving...' : 'Save'}
                                    </button>
                                    <button
                                      className="rounded-md px-3 py-1.5 text-[11px] font-medium transition"
                                      onClick={cancelEditingSchedule}
                                      style={{ border: '1px solid var(--outline)', color: 'var(--on-surface-variant)', background: 'transparent' }}
                                      type="button"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="rounded-md px-3 py-1.5 text-[11px] font-medium transition"
                                    onClick={() => startEditingSchedule(schedule)}
                                    style={{ border: '1px solid rgba(114,137,192,0.35)', color: 'var(--primary)', background: 'transparent' }}
                                    type="button"
                                  >
                                    Edit
                                  </button>
                                )}
                              </div>

                              <button
                                className="rounded-md px-3 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30"
                                disabled={deletingScheduleId === schedule.id}
                                onClick={() => void deleteSchedule(schedule.id)}
                                style={{ border: '1px solid rgba(255, 0, 51, 0.25)', color: 'rgba(255, 102, 133, 0.75)', background: 'transparent' }}
                                type="button"
                              >
                                {deletingScheduleId === schedule.id ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Doc editor view */}
            {centerView === 'doc' && (
              <div className="flex flex-1 overflow-hidden">
                {/* Gutter */}
                <div
                  className="hidden w-[42px] shrink-0 select-none overflow-hidden py-5 text-right md:block"
                  style={{ borderRight: '1px solid var(--outline-variant)' }}
                >
                  {draft.split('\n').map((_, i) => (
                    <div key={i} className="pr-3 font-mono text-[10px] leading-7" style={{ color: 'var(--on-surface-variant)', opacity: 0.2 }}>
                      {i + 1}
                    </div>
                  ))}
                </div>
                {/* Textarea */}
                <textarea
                  className="flex-1 resize-none bg-transparent py-5 pl-5 pr-8 font-mono text-[13px] leading-7 text-on-surface outline-none placeholder:opacity-25"
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={isProtected ? 'This file is managed by AgentCreatorAgent.' : 'Write in markdown…'}
                  style={{ caretColor: 'var(--primary)' }}
                  value={draft}
                />
              </div>
            )}

            {/* Skill editor view */}
            {centerView === 'skill' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div
                  className="shrink-0 px-6 py-4"
                  style={{ borderBottom: '1px solid var(--outline-variant)', background: 'var(--surface-container-lowest)' }}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Skill name">
                      <FInput disabled={!showNewSkill} onChange={(v) => setSkillForm((f) => ({ ...f, name: v }))} placeholder="skill-name" value={skillForm.name} />
                    </Field>
                    <Field label="Type">
                      <FSelect value={skillForm.type} onChange={(v) => setSkillForm((f) => ({ ...f, type: v as AgentSkillType }))}>
                        <option value="PASSIVE">Passive — always active</option>
                        <option value="ON_DEMAND">On-demand</option>
                        <option value="TOOL_BASED">Tool-based</option>
                      </FSelect>
                    </Field>
                    <Field label="Description">
                      <FInput value={skillForm.description} onChange={(v) => setSkillForm((f) => ({ ...f, description: v }))} placeholder="Short description" />
                    </Field>
                    <Field label="Tool names (comma-separated)">
                      <FInput value={skillForm.toolNames} onChange={(v) => setSkillForm((f) => ({ ...f, toolNames: v }))} placeholder="tool_a, tool_b" />
                    </Field>
                  </div>
                </div>
                <textarea
                  className="flex-1 resize-none bg-transparent px-6 py-5 font-mono text-[13px] leading-7 text-on-surface outline-none placeholder:opacity-25"
                  onChange={(e) => setSkillDraft(e.target.value)}
                  placeholder="Write the skill instructions in markdown…"
                  style={{ caretColor: 'var(--primary)' }}
                  value={skillDraft}
                />
                <div
                  className="flex shrink-0 items-center gap-2 px-6 py-3"
                  style={{ borderTop: '1px solid var(--outline-variant)', background: 'var(--surface-container-lowest)' }}
                >
                  {selectedSkill && (
                    <button
                      className="rounded-md px-3 py-1.5 text-[11px] font-medium transition disabled:opacity-30"
                      disabled={deletingSkill}
                      onClick={() => void deleteSkill(selectedSkill.name)}
                      style={{ border: '1px solid rgba(255, 0, 51, 0.25)', color: 'rgba(255, 102, 133, 0.7)', background: 'transparent' }}
                      type="button"
                    >
                      {deletingSkill ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                  <button
                    className="rounded-md px-3 py-1.5 text-[11px] font-medium transition"
                    onClick={() => { setSelectedSkill(null); setShowNewSkill(false); setCenterView('doc'); }}
                    style={{ border: '1px solid var(--outline)', color: 'var(--on-surface-variant)', background: 'transparent' }}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Agency editor view */}
            {centerView === 'agency' && (
              <div className="flex flex-1 overflow-hidden">
                <div
                  className="hidden w-[42px] shrink-0 select-none overflow-hidden py-5 text-right md:block"
                  style={{ borderRight: '1px solid var(--outline-variant)' }}
                >
                  {agencyDraft.split('\n').map((_, i) => (
                    <div key={i} className="pr-3 font-mono text-[10px] leading-7" style={{ color: 'var(--on-surface-variant)', opacity: 0.2 }}>
                      {i + 1}
                    </div>
                  ))}
                </div>
                <div className="flex flex-1 flex-col overflow-hidden">
                  <textarea
                    className="flex-1 resize-none bg-transparent py-5 pl-5 pr-8 font-mono text-[13px] leading-7 text-on-surface outline-none placeholder:opacity-25"
                    onChange={(e) => setAgencyDraft(e.target.value)}
                    onFocus={(e) => { e.target.style.caretColor = 'var(--primary)'; }}
                    placeholder="Shared workspace constitution for all agents…"
                    style={{ caretColor: 'var(--primary)' }}
                    value={agencyDraft}
                  />
                  {agencySavedAt && (
                    <div
                      className="shrink-0 px-5 py-2 text-[10px] text-on-surface-variant/25"
                      style={{ borderTop: '1px solid var(--outline-variant)' }}
                    >
                      Last saved {new Date(agencySavedAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Right panel: AgentCreatorAgent chat ───────────────────────────── */}
        <aside
          className="flex w-[320px] shrink-0 flex-col overflow-hidden"
          style={{ background: 'var(--ti-950)', borderLeft: '1px solid var(--outline-variant)' }}
        >
          {/* Creator header */}
          <div
            className="shrink-0 px-4 py-3.5"
            style={{ borderBottom: '1px solid var(--outline-variant)' }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white"
                style={{ background: 'var(--primary)', boxShadow: '0 2px 8px rgba(114,137,192,0.35)' }}
              >
                AC
              </div>
              <div>
                <p className="font-headline text-[12px] font-semibold text-on-surface">AgentCreatorAgent</p>
                <p className="text-[10px] text-on-surface-variant/35">Natural language file editing</p>
              </div>
            </div>
          </div>

          {/* Creator history */}
          <div
            className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
            ref={creatorScrollRef}
          >
            {creatorHistory.length === 0 ? (
              <div className="space-y-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant/25">Try saying…</p>
                {[
                  'Make the tone warmer and more approachable',
                  'Add TypeScript expertise to identity.md',
                  'Update pickup.md to respond to code questions',
                  'She should always show code examples',
                ].map((example, i) => (
                  <button
                    className="w-full rounded-lg px-3 py-2 text-left text-[11px] text-on-surface-variant/50 transition-colors hover:text-on-surface-variant"
                    key={i}
                    onClick={() => setCreatorInput(example)}
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--outline-variant)' }}
                    type="button"
                  >
                    {example}
                  </button>
                ))}
              </div>
            ) : (
              creatorHistory.map((msg, index) => (
                <div
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  key={index}
                >
                  {msg.role === 'assistant' && (
                    <div
                      className="mr-2 mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                      style={{ background: 'var(--primary)' }}
                    >
                      AC
                    </div>
                  )}
                  <div
                    className="max-w-[84%] rounded-xl px-3 py-2.5 text-[12px] leading-[1.55]"
                    style={
                      msg.role === 'user'
                        ? { background: 'rgba(114, 137, 192, 0.2)', color: 'var(--on-surface)', border: '1px solid rgba(114, 137, 192, 0.25)' }
                        : { background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--outline-variant)' }
                    }
                  >
                    {msg.content}
                  </div>
                </div>
              ))
            )}

            {creatorLoading && (
              <div className="flex items-start gap-2">
                <div
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                  style={{ background: 'var(--primary)' }}
                >
                  AC
                </div>
                <div
                  className="flex items-center gap-1.5 rounded-xl px-3 py-2.5"
                  style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)' }}
                >
                  <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0s_infinite] rounded-full" style={{ background: 'var(--primary)' }} />
                  <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0.2s_infinite] rounded-full" style={{ background: 'var(--primary)' }} />
                  <span className="h-1.5 w-1.5 animate-[typing_1.4s_ease-in-out_0.4s_infinite] rounded-full" style={{ background: 'var(--primary)' }} />
                </div>
              </div>
            )}
          </div>

          {/* Creator input */}
          <div
            className="shrink-0 p-3"
            style={{ borderTop: '1px solid var(--outline-variant)' }}
          >
            <div
              className="flex flex-col rounded-xl overflow-hidden"
              style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)' }}
            >
              <textarea
                className="min-h-[68px] resize-none bg-transparent px-3 pt-3 pb-1 text-[12px] text-on-surface outline-none placeholder:opacity-25"
                disabled={creatorLoading}
                onChange={(e) => setCreatorInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendCreatorMessage(); }
                }}
                placeholder="Describe a change to any agent file…"
                style={{ caretColor: 'var(--primary)' }}
                value={creatorInput}
              />
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-[9px] text-on-surface-variant/25">Enter to send · Shift+Enter for newline</span>
                <button
                  className="font-headline flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-on-primary transition disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.97]"
                  disabled={!creatorInput.trim() || creatorLoading}
                  onClick={() => void sendCreatorMessage()}
                  style={{
                    background: creatorInput.trim() && !creatorLoading ? 'var(--primary)' : 'var(--primary-dim)',
                    boxShadow: creatorInput.trim() && !creatorLoading ? '0 2px 8px rgba(114,137,192,0.3)' : 'none',
                  }}
                  type="button"
                >
                  {creatorLoading ? 'Updating…' : 'Send'}
                  {!creatorLoading && (
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
