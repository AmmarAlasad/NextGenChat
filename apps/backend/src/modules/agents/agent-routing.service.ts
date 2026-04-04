/**
 * Agent Routing Service
 *
 * Selects which agents should engage for a new message.
 *
 * Phase 3C / redesigned routing:
 * - No hardcoded cooldowns or chain-depth limits (removed Stage 1 gates).
 * - Stage 2: MENTIONS_ONLY agents are handled deterministically — they respond only
 *   when explicitly addressed; ALL_MESSAGES agents always respond.
 * - Stage 3: every remaining AUTO-mode agent runs its own lightweight "pickup agent"
 *   in parallel. The pickup model reads the last 5 messages + the new message +
 *   the agent's compact profile and returns a yes/no decision. It never produces a
 *   visible reply — it only wakes the main agent when relevant.
 * - Agent-sent messages only wake agents that are explicitly @mentioned (prevents
 *   runaway agent-to-agent chains without a hardcoded numeric cap).
 */

import type { AgentRoutingReason, SenderType } from '@nextgenchat/types';

import { PICKUP_CONTEXT_MESSAGES, PICKUP_MODEL } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';

interface RoutingDecision {
  selectedAgentIds: string[];
  diagnostics: AgentRoutingReason[];
}

interface CandidateProfile {
  agentId: string;
  name: string;
  slug: string;
  profile: string;
  mentionsMatched: boolean;
}

function isExplicitlyMentioned(content: string, candidate: { slug: string; name: string }, senderType: SenderType) {
  const lowered = content.toLowerCase();
  const slugMention = lowered.includes(`@${candidate.slug.toLowerCase()}`);
  if (senderType === 'AGENT') {
    return slugMention;
  }
  const nameMention = new RegExp(`(^|[^a-z0-9])${candidate.name.toLowerCase()}([^a-z0-9]|$)`, 'i').test(lowered);
  return slugMention || nameMention;
}

function compactText(value: string | null | undefined, maxLength: number) {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildCompactProfile(input: {
  name: string;
  slug: string;
  persona: string | null;
  systemPrompt: string | null;
  agentDoc: string | null;
  agencyDoc: string | null;
  identityDoc: string | null;
}) {
  const roleSummary = compactText(input.persona || input.systemPrompt || input.identityDoc, 220);
  const operatingNotes = compactText(input.agentDoc, 160);
  const agencyNotes = compactText(input.agencyDoc, 120);

  return JSON.stringify({ name: input.name, slug: input.slug, roleSummary, operatingNotes, agencyNotes });
}

export class AgentRoutingService {
  async selectAgentsForMessage(input: {
    channelId: string;
    senderId: string;
    senderType: SenderType;
    content: string;
    messageId: string;
  }): Promise<RoutingDecision> {
    const channel = await prisma.channel.findUnique({
      where: { id: input.channelId },
      include: {
        agentMemberships: {
          include: {
            agent: {
              include: {
                identity: true,
                files: {
                  where: {
                    docType: { in: ['AGENT_MD', 'IDENTITY_MD', 'AGENCY_MD'] },
                  },
                  select: { docType: true, content: true },
                },
              },
            },
          },
        },
        messages: {
          where: { id: { not: input.messageId } },
          orderBy: { createdAt: 'desc' },
          take: PICKUP_CONTEXT_MESSAGES,
          select: { id: true, senderId: true, senderType: true, content: true },
        },
      },
    });

    if (!channel) {
      throw new Error('Channel not found.');
    }

    // Direct channel: always routes to its single assigned agent (never from agent-sender).
    if (channel.type === 'DIRECT') {
      if (input.senderType === 'AGENT') {
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

    // ── Group channel ────────────────────────────────────────────────────────
    const recentMessages = channel.messages; // already filtered to exclude the trigger message
    const selectedAgentIds: string[] = [];
    const diagnostics: AgentRoutingReason[] = [];
    const pickupCandidates: CandidateProfile[] = [];

    for (const membership of channel.agentMemberships) {
      const agent = membership.agent;

      // Skip inactive or disabled agents.
      if (agent.status !== 'ACTIVE' || agent.triggerMode === 'DISABLED') {
        continue;
      }

      // Skip the agent that sent this message.
      if (agent.id === input.senderId) {
        continue;
      }

      const mentioned = isExplicitlyMentioned(input.content, { slug: agent.slug, name: agent.name }, input.senderType);

      // MENTIONS_ONLY: respond only when explicitly addressed.
      if (agent.triggerMode === 'MENTIONS_ONLY') {
        if (mentioned) {
          selectedAgentIds.push(agent.id);
          diagnostics.push({ agentId: agent.id, score: 1, decision: 'RESPOND', reason: 'Explicitly mentioned (MENTIONS_ONLY mode).' });
        } else {
          diagnostics.push({ agentId: agent.id, score: 0, decision: 'IGNORE', reason: 'Not mentioned; agent is in MENTIONS_ONLY mode.' });
        }
        continue;
      }

      // ALL_MESSAGES: always respond.
      if (agent.triggerMode === 'ALL_MESSAGES') {
        selectedAgentIds.push(agent.id);
        diagnostics.push({ agentId: agent.id, score: 1, decision: 'RESPOND', reason: 'ALL_MESSAGES mode — always responds.' });
        continue;
      }

      // AUTO: collect for pickup stage.
      // When the sender is an agent, only consider explicitly mentioned agents to
      // prevent runaway agent-to-agent chains.
      if (input.senderType === 'AGENT' && !mentioned) {
        diagnostics.push({ agentId: agent.id, score: 0, decision: 'IGNORE', reason: 'Agent-sent message; only explicitly mentioned agents respond.' });
        continue;
      }

      const docMap = new Map(agent.files.map((f) => [f.docType, f.content ?? '']));

      pickupCandidates.push({
        agentId: agent.id,
        name: agent.name,
        slug: agent.slug,
        mentionsMatched: mentioned,
        profile: buildCompactProfile({
          name: agent.name,
          slug: agent.slug,
          persona: agent.identity?.persona ?? null,
          systemPrompt: agent.identity?.systemPrompt ?? null,
          agentDoc: docMap.get('AGENT_MD') ?? null,
          agencyDoc: docMap.get('AGENCY_MD') ?? null,
          identityDoc: docMap.get('IDENTITY_MD') ?? null,
        }),
      });
    }

    // ── Stage 3: per-agent pickup LLMs (parallel) ───────────────────────────
    if (pickupCandidates.length > 0) {
      const pickupResults = await Promise.allSettled(
        pickupCandidates.map((candidate) =>
          this.runPickupAgent(candidate, recentMessages, input),
        ),
      );

      for (let i = 0; i < pickupCandidates.length; i++) {
        const candidate = pickupCandidates[i];
        const result = pickupResults[i];

        if (result.status === 'fulfilled' && result.value.shouldRespond) {
          selectedAgentIds.push(candidate.agentId);
          diagnostics.push({ agentId: candidate.agentId, score: 0.8, decision: 'RESPOND', reason: result.value.reason });
        } else {
          const reason =
            result.status === 'rejected'
              ? 'Pickup agent error; defaulting to silence.'
              : result.value.reason;
          diagnostics.push({ agentId: candidate.agentId, score: 0, decision: 'IGNORE', reason });
        }
      }
    }

    return { selectedAgentIds, diagnostics };
  }

  private async runPickupAgent(
    candidate: CandidateProfile,
    recentMessages: Array<{ senderType: SenderType; content: string }>,
    input: { senderType: SenderType; content: string },
  ): Promise<{ shouldRespond: boolean; reason: string }> {
    // No API key: fall back to mention-based decision.
    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
      return candidate.mentionsMatched
        ? { shouldRespond: true, reason: 'Explicit mention (no API key for pickup).' }
        : { shouldRespond: false, reason: 'No API key available; defaulting to silence.' };
    }

    const transcript = [...recentMessages].reverse()
      .map((m) => `[${m.senderType}]: ${m.content.slice(0, 300)}`)
      .join('\n');

    try {
      const provider = new OpenAIProvider(env.OPENAI_API_KEY, PICKUP_MODEL);
      const response = await provider.complete({
        messages: [
          {
            role: 'system',
            content: `You are the pickup agent for ${candidate.name}. Your only job is to decide whether the latest message is addressed to or meaningfully relevant for ${candidate.name}. Return ONLY valid JSON with two fields: {"shouldRespond": true or false, "reason": "one short sentence"}. Do not add any other text.`,
          },
          {
            role: 'user',
            content: `Agent profile:\n${candidate.profile}\n\nRecent conversation (oldest first):\n${transcript || '(no prior messages)'}\n\nLatest message:\n[${input.senderType}]: ${input.content}\n\nShould ${candidate.name} respond?`,
          },
        ],
        maxTokens: 60,
        temperature: 0.0,
      });

      const match = response.content.match(/\{[\s\S]*?\}/);

      if (match) {
        const parsed = JSON.parse(match[0]) as { shouldRespond?: unknown; reason?: unknown };
        return {
          shouldRespond: parsed.shouldRespond === true,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'Pickup agent decision.',
        };
      }
    } catch {
      // Fall through to fallback.
    }

    // Fallback: trust explicit mention.
    return candidate.mentionsMatched
      ? { shouldRespond: true, reason: 'Pickup agent failed; responding because explicitly mentioned.' }
      : { shouldRespond: false, reason: 'Pickup agent failed; defaulting to silence.' };
  }
}

export const agentRoutingService = new AgentRoutingService();
