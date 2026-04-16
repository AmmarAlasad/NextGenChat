/**
 * Agent Routing Service
 *
 * Selects which agents should engage for a new message.
 *
 * Phase 5 implementation status:
 * - Three routing modes per agent:
 *   ALL_MESSAGES / AUTO — schedule every active agent; agent uses [[NO_REPLY]] to self-filter.
 *   WAKEUP — run a cheap pickup LLM (gpt-4o-mini + wakeup.md) before scheduling.
 *   MENTIONS_ONLY — only respond when explicitly @mentioned.
 * - Agent-sender guard: when sender is an agent (isRelay=false), only @mentioned agents respond.
 * - WAKEUP checks run in parallel for all WAKEUP-mode agents.
 */

import type { AgentRoutingReason, SenderType } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { wakeupLLMService } from '@/modules/agents/wakeup-llm.service.js';
import { isExplicitlyMentioned } from '@/modules/agents/agent-visibility.js';

interface RoutingDecision {
  selectedAgentIds: string[];
  diagnostics: AgentRoutingReason[];
}

export class AgentRoutingService {
  async selectAgentsForMessage(input: {
    channelId: string;
    senderId: string;
    senderType: SenderType;
    content: string;
    messageId: string;
    isRelay?: boolean;
  }): Promise<RoutingDecision> {
    const channel = await prisma.channel.findUnique({
      where: { id: input.channelId },
      include: {
        agentMemberships: {
          include: {
            agent: {
              include: { identity: true },
            },
          },
        },
      },
    });

    if (!channel) throw new Error('Channel not found.');

    // ── Direct channels ───────────────────────────────────────────────────────
    if (channel.type === 'DIRECT') {
      if (input.senderType === 'AGENT' && !input.isRelay) {
        return { selectedAgentIds: [], diagnostics: [] };
      }

      const directAgent = channel.agentMemberships.find((m) => m.agent.status === 'ACTIVE');
      return {
        selectedAgentIds: directAgent ? [directAgent.agentId] : [],
        diagnostics: directAgent
          ? [{ agentId: directAgent.agentId, score: 1, decision: 'RESPOND', reason: 'Direct channel routes to its assigned agent.' }]
          : [],
      };
    }

    // ── Group channels — first pass: gate checks ──────────────────────────────
    const diagnostics: AgentRoutingReason[] = [];
    const selectedAgentIds: string[] = [];
    const inProgressProjectAssignees = channel.projectId && input.senderType === 'USER'
      ? new Set((await prisma.projectTicket.findMany({
          where: {
            projectId: channel.projectId,
            status: 'IN_PROGRESS',
            assignedAgentId: { not: null },
          },
          select: { assignedAgentId: true },
        })).map((ticket) => ticket.assignedAgentId).filter((agentId): agentId is string => typeof agentId === 'string'))
      : null;

    // Agents that passed basic gates and need a wakeup LLM check.
    const wakeupCandidates: Array<{ agentId: string; agentName: string }> = [];

    // Fetch recent messages for wakeup context (only if there are WAKEUP agents).
    const hasWakeupAgents = channel.agentMemberships.some(
      (m) => m.agent.status === 'ACTIVE' && m.agent.triggerMode === 'WAKEUP',
    );
    let recentMessages: Array<{ senderName: string; senderType: 'USER' | 'AGENT'; content: string }> = [];

    if (hasWakeupAgents && input.senderType === 'USER') {
      const rawMsgs = await prisma.message.findMany({
        where: { channelId: input.channelId, contentType: { not: 'SYSTEM' } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { content: true, senderType: true, senderId: true },
      });

      // Resolve sender names for the transcript.
      const agentNames = new Map<string, string>();
      for (const m of rawMsgs) {
        if (m.senderType === 'AGENT' && !agentNames.has(m.senderId)) {
          const a = channel.agentMemberships.find((mem) => mem.agentId === m.senderId);
          agentNames.set(m.senderId, a?.agent.name ?? 'Agent');
        }
      }

      recentMessages = rawMsgs.reverse().map((m) => ({
        senderName: m.senderType === 'USER' ? 'User' : (agentNames.get(m.senderId) ?? 'Agent'),
        senderType: m.senderType as 'USER' | 'AGENT',
        content: m.content,
      }));
    }

    for (const membership of channel.agentMemberships) {
      const agent = membership.agent;

      // ── Gate 1: active + not disabled ──────────────────────────────────────
      if (agent.status !== 'ACTIVE' || agent.triggerMode === 'DISABLED') {
        diagnostics.push({ agentId: agent.id, score: 0, decision: 'IGNORE', reason: 'Agent is disabled or inactive.' });
        continue;
      }

      // ── Gate 2: no self-routing ─────────────────────────────────────────────
      if (agent.id === input.senderId) {
        diagnostics.push({ agentId: agent.id, score: 0, decision: 'IGNORE', reason: 'Do not route a message back to the sender.' });
        continue;
      }

      const mentioned = isExplicitlyMentioned(input.content, { slug: agent.slug, name: agent.name }, input.senderType);

      if (inProgressProjectAssignees?.size) {
        if (inProgressProjectAssignees.has(agent.id)) {
          diagnostics.push({
            agentId: agent.id,
            score: 1,
            decision: 'RESPOND',
            reason: 'Agent currently owns an in-progress project ticket in this project.',
          });
          selectedAgentIds.push(agent.id);
          continue;
        }

        if (!mentioned) {
          diagnostics.push({
            agentId: agent.id,
            score: 0,
            decision: 'IGNORE',
            reason: 'Another agent currently owns the active in-progress project ticket for this project.',
          });
          continue;
        }
      }

      // ── Gate 3: MENTIONS_ONLY ───────────────────────────────────────────────
      if (agent.triggerMode === 'MENTIONS_ONLY') {
        diagnostics.push({
          agentId: agent.id, score: mentioned ? 1 : 0,
          decision: mentioned ? 'RESPOND' : 'IGNORE',
          reason: mentioned ? 'Explicitly mentioned (MENTIONS_ONLY mode).' : 'Not mentioned; MENTIONS_ONLY mode.',
        });
        if (mentioned) selectedAgentIds.push(agent.id);
        continue;
      }

      // ── Gate 4: agent-sender guard (for cascades) ──────────────────────────
      if (input.senderType === 'AGENT') {
        diagnostics.push({
          agentId: agent.id, score: mentioned ? 1 : 0,
          decision: mentioned ? 'RESPOND' : 'IGNORE',
          reason: mentioned ? 'Explicit agent mention handoff.' : 'Agent replies only propagate via explicit @mention.',
        });
        if (mentioned) selectedAgentIds.push(agent.id);
        continue;
      }

      // ── Gate 5: WAKEUP mode — defer to pickup LLM ─────────────────────────
      if (agent.triggerMode === 'WAKEUP') {
        wakeupCandidates.push({ agentId: agent.id, agentName: agent.name });
        continue;
      }

      // ── Gate 6: ALL_MESSAGES / AUTO — schedule unconditionally ────────────
      diagnostics.push({
        agentId: agent.id, score: 1, decision: 'RESPOND',
        reason: 'ALL_MESSAGES mode — agent is scheduled; it self-filters via [[NO_REPLY]] if needed.',
      });
      selectedAgentIds.push(agent.id);
    }

    // ── WAKEUP LLM checks (parallel) ─────────────────────────────────────────
    if (wakeupCandidates.length > 0) {
      const agentReplyCount = new Map<string, number>();
      for (const m of recentMessages.slice(-4)) {
        if (m.senderType === 'AGENT') {
          agentReplyCount.set(m.senderName, (agentReplyCount.get(m.senderName) ?? 0) + 1);
        }
      }

      const wakeupResults = await Promise.all(
        wakeupCandidates.map(async ({ agentId, agentName }) => {
          const hasRepliedRecently = (agentReplyCount.get(agentName) ?? 0) > 0;
          const should = await wakeupLLMService.shouldRespond({
            agentId,
            agentName,
            recentMessages,
            hasRepliedRecently,
          });
          return { agentId, agentName, should };
        }),
      );

      for (const { agentId, agentName, should } of wakeupResults) {
        diagnostics.push({
          agentId, score: should ? 1 : 0,
          decision: should ? 'RESPOND' : 'IGNORE',
          reason: should
            ? `Wakeup LLM approved ${agentName} to respond.`
            : `Wakeup LLM determined ${agentName} should stay silent.`,
        });
        if (should) selectedAgentIds.push(agentId);
      }
    }

    return { selectedAgentIds, diagnostics };
  }
}

export const agentRoutingService = new AgentRoutingService();
