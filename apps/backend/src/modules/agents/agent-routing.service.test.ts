/**
 * Agent Routing Service Tests
 *
 * Phase 4 implementation status:
 * - These tests cover the centralized group-routing helpers that classify
 *   messages and apply deterministic fallback ranking.
 * - Current scope verifies acknowledgment suppression, multi-agent prompting,
 *   follow-up ownership, and basic expertise matching.
 * - Future phases can add integration tests around persisted channel state and
 *   router-model decisions once richer routing logs are available.
 */

import { describe, expect, it } from 'vitest';

import { analyzeRoutingMessage, routeCandidatesWithHeuristics } from './agent-routing.utils.js';

describe('analyzeRoutingMessage', () => {
  it('suppresses short acknowledgments', () => {
    const analysis = analyzeRoutingMessage('thanks, got it');

    expect(analysis.isAcknowledgement).toBe(true);
    expect(analysis.projectsAgentResponse).toBe(false);
  });

  it('detects group brainstorm prompts', () => {
    const analysis = analyzeRoutingMessage('What do each of you think about this launch plan?');

    expect(analysis.isBrainstorm).toBe(true);
    expect(analysis.isDirectedToGroup).toBe(true);
    expect(analysis.allowsMultipleAgents).toBe(true);
  });

  it('treats non-closure human messages as response-projecting', () => {
    const analysis = analyzeRoutingMessage('hi');

    expect(analysis.isGreeting).toBe(true);
    expect(analysis.projectsAgentResponse).toBe(true);
  });
});

describe('routeCandidatesWithHeuristics', () => {
  it('keeps vague follow-ups with the previous responding agent', () => {
    const decision = routeCandidatesWithHeuristics({
      analysis: analyzeRoutingMessage('Can you clarify that?'),
      state: {
        ownerAgentId: '11111111-1111-1111-1111-111111111111',
        lastAgentResponderId: '11111111-1111-1111-1111-111111111111',
        lastMessageSenderType: 'AGENT',
      },
      candidates: [
        {
          agentId: '11111111-1111-1111-1111-111111111111',
          name: 'coco',
          mentionsMatched: false,
          alreadyRepliedRecently: true,
          profileText: 'programmer engineering software architecture code',
        },
        {
          agentId: '22222222-2222-2222-2222-222222222222',
          name: 'ivy',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'marketing design ui ux brand research',
        },
      ],
    });

    expect(decision.selectedAgentIds).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('prefers the strongest expertise match for a substantive question', () => {
    const decision = routeCandidatesWithHeuristics({
      analysis: analyzeRoutingMessage('Can someone help with the UI design and user research for this landing page?'),
      state: {
        ownerAgentId: null,
        lastAgentResponderId: null,
        lastMessageSenderType: 'USER',
      },
      candidates: [
        {
          agentId: '11111111-1111-1111-1111-111111111111',
          name: 'coco',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'programmer engineering software backend api typescript',
        },
        {
          agentId: '22222222-2222-2222-2222-222222222222',
          name: 'ivy',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'marketing design ui ux landing page user research branding',
        },
      ],
    });

    expect(decision.selectedAgentIds).toEqual(['22222222-2222-2222-2222-222222222222']);
  });

  it('allows multiple strong responders for explicit multi-perspective prompts', () => {
    const decision = routeCandidatesWithHeuristics({
      analysis: analyzeRoutingMessage('What do each of you think about the product launch and technical rollout?'),
      state: {
        ownerAgentId: null,
        lastAgentResponderId: null,
        lastMessageSenderType: 'USER',
      },
      candidates: [
        {
          agentId: '11111111-1111-1111-1111-111111111111',
          name: 'coco',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'programmer engineering technical rollout infrastructure systems',
        },
        {
          agentId: '22222222-2222-2222-2222-222222222222',
          name: 'ivy',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'marketing product launch go to market messaging brand',
        },
      ],
    });

    expect(decision.selectedAgentIds).toHaveLength(2);
    expect(decision.selectedAgentIds).toContain('11111111-1111-1111-1111-111111111111');
    expect(decision.selectedAgentIds).toContain('22222222-2222-2222-2222-222222222222');
  });

  it('selects a fallback responder even for low-signal greetings', () => {
    const decision = routeCandidatesWithHeuristics({
      analysis: analyzeRoutingMessage('hi'),
      state: {
        ownerAgentId: null,
        lastAgentResponderId: null,
        lastMessageSenderType: 'USER',
      },
      candidates: [
        {
          agentId: '11111111-1111-1111-1111-111111111111',
          name: 'coco',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'programmer engineering software backend api typescript',
        },
        {
          agentId: '22222222-2222-2222-2222-222222222222',
          name: 'ivy',
          mentionsMatched: false,
          alreadyRepliedRecently: false,
          profileText: 'marketing design ui ux brand research',
        },
      ],
    });

    expect(decision.selectedAgentIds).toHaveLength(1);
  });
});
