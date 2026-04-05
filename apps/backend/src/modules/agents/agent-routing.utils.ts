/**
 * Agent Routing Utilities
 *
 * Phase 4 implementation status:
 * - This file holds the pure message-analysis and heuristic-routing helpers used
 *   by the centralized group router.
 * - Current scope keeps these helpers deterministic and dependency-free so they
 *   can be unit tested without the database or provider stack.
 * - Future phases can expand these utilities into richer thread-state features
 *   or replace the heuristic scorer with a trained ranker.
 */

import type { AgentRoutingReason, SenderType } from '@nextgenchat/types';

const ACKNOWLEDGEMENT_RE = /^(?:ok(?:ay)?|thanks?|thank you|got it|understood|sounds good|cool|perfect|great|nice|works for me|all good|done|ty|thx|sgtm|lgtm|👍|🙏|👌|✅|cool,? thanks)(?:[!.,\s]|$)/i;
const GREETING_RE = /^(?:hi|hello|hey|yo|good morning|good afternoon|good evening|hiya|sup|what's up)(?:[!,.\s]|$)/i;
const QUESTION_RE = /\?|\b(?:can|could|would|should|do|does|did|is|are|will|who|what|when|where|why|how|thoughts|ideas)\b/i;
const FOLLOW_UP_RE = /^(?:and\b|also\b|what about\b|how about\b|can you clarify\b|clarify\b|explain\b|elaborate\b|more detail\b|more details\b|why\b|how so\b|what do you mean\b|so\b)/i;
const REQUEST_RE = /\b(?:please|can you|could you|would you|help|review|check|look at|think about|advise|recommend|suggest|compare|brainstorm)\b/i;
const MULTI_AGENT_RE = /\b(?:each of you|both of you|all of you|everyone|anyone|compare perspectives|multiple perspectives|what do you all think|what does everyone think)\b/i;
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'about', 'all', 'also', 'as', 'at', 'be', 'both', 'but', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'get', 'give', 'got', 'had', 'has', 'have', 'hello', 'help', 'hey', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'let', 'like', 'me', 'more', 'need', 'of', 'ok', 'okay', 'on', 'or', 'our', 'please', 'should', 'so', 'some', 'team', 'thanks', 'thank', 'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'to', 'us', 'want', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

const MAX_MULTI_AGENT_RESPONSES = 2;

export interface ChannelStateSnapshot {
  ownerAgentId: string | null;
  lastAgentResponderId: string | null;
  lastMessageSenderType: SenderType | null;
}

export interface RoutingMessageAnalysis {
  normalized: string;
  tokens: string[];
  isAcknowledgement: boolean;
  isGreeting: boolean;
  isQuestion: boolean;
  isFollowUp: boolean;
  isRequest: boolean;
  isBrainstorm: boolean;
  isDirectedToGroup: boolean;
  projectsAgentResponse: boolean;
  allowsMultipleAgents: boolean;
}

export interface HeuristicRoutingCandidate {
  agentId: string;
  name: string;
  mentionsMatched: boolean;
  alreadyRepliedRecently: boolean;
  profileText: string;
}

interface RoutingDecision {
  selectedAgentIds: string[];
  diagnostics: AgentRoutingReason[];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(value: string) {
  return normalizeText(value)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function summarizeReason(parts: string[]) {
  return parts.filter(Boolean).join(' ').trim() || 'Central router fallback.';
}

function shouldPreferOwner(analysis: RoutingMessageAnalysis, state: ChannelStateSnapshot) {
  if (!state.ownerAgentId) {
    return false;
  }

  if (analysis.isAcknowledgement) {
    return false;
  }

  return analysis.isFollowUp || (analysis.isQuestion && state.lastMessageSenderType === 'AGENT');
}

export function clampMultiSelection(agentIds: string[], allowsMultipleAgents: boolean) {
  if (!allowsMultipleAgents) {
    return agentIds.slice(0, 1);
  }

  return agentIds.slice(0, MAX_MULTI_AGENT_RESPONSES);
}

export function analyzeRoutingMessage(content: string): RoutingMessageAnalysis {
  const normalized = normalizeText(content);
  const tokens = unique(tokenize(content));
  const isAcknowledgement = ACKNOWLEDGEMENT_RE.test(normalized) && normalized.length <= 120;
  const isGreeting = GREETING_RE.test(normalized);
  const isQuestion = QUESTION_RE.test(content);
  const isFollowUp = FOLLOW_UP_RE.test(normalized) || (tokens.length <= 8 && /\b(?:that|this|it|they|them)\b/i.test(content));
  const isRequest = REQUEST_RE.test(normalized) || isQuestion;
  const isBrainstorm = MULTI_AGENT_RE.test(normalized)
    || /\b(?:brainstorm|ideas|thoughts|perspectives|pros and cons|tradeoffs|compare)\b/i.test(normalized);
  const isDirectedToGroup = /\b(?:everyone|anyone|team|friends|folks|you all|all of you|both of you|each of you)\b/i.test(normalized)
    || isBrainstorm;

  return {
    normalized,
    tokens,
    isAcknowledgement,
    isGreeting,
    isQuestion,
    isFollowUp,
    isRequest,
    isBrainstorm,
    isDirectedToGroup,
    projectsAgentResponse: !isAcknowledgement,
    allowsMultipleAgents: isBrainstorm,
  };
}

export function routeCandidatesWithHeuristics(input: {
  candidates: HeuristicRoutingCandidate[];
  analysis: RoutingMessageAnalysis;
  state: ChannelStateSnapshot;
}): RoutingDecision {
  const scored = input.candidates.map((candidate) => {
    let score = 0;
    const reasons: string[] = [];

    if (candidate.mentionsMatched) {
      score += 10;
      reasons.push('Explicitly mentioned.');
    }

    if (input.state.ownerAgentId === candidate.agentId && shouldPreferOwner(input.analysis, input.state)) {
      score += 4;
      reasons.push('Owns the current follow-up.');
    }

    if (input.analysis.isQuestion) {
      score += 1;
    }

    if (input.analysis.isRequest) {
      score += 1;
    }

    if (input.analysis.isGreeting) {
      score += 0.5;
      reasons.push('Greeting should receive a visible response.');
    }

    if (input.analysis.isDirectedToGroup) {
      score += 1;
      reasons.push('Message is directed at the group.');
    }

    const profileTokens = new Set(tokenize(candidate.profileText));
    const overlap = input.analysis.tokens.filter((token) => profileTokens.has(token)).length;

    if (overlap > 0) {
      score += Math.min(4, overlap * 1.5);
      reasons.push(`Domain overlap on ${overlap} keyword${overlap === 1 ? '' : 's'}.`);
    }

    if (candidate.alreadyRepliedRecently && input.state.ownerAgentId !== candidate.agentId) {
      score -= 2;
      reasons.push('Penalty for having replied recently.');
    }

    return {
      agentId: candidate.agentId,
      score,
      reasons,
    };
  }).sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      selectedAgentIds: [],
      diagnostics: [],
    };
  }

  if (scored[0]?.score < 2) {
    return {
      selectedAgentIds: input.analysis.projectsAgentResponse ? [scored[0].agentId] : [],
      diagnostics: scored.map((candidate) => ({
        agentId: candidate.agentId,
        score: candidate.score,
        decision: input.analysis.projectsAgentResponse && candidate.agentId === scored[0].agentId ? 'RESPOND' : 'IGNORE',
        reason: input.analysis.projectsAgentResponse && candidate.agentId === scored[0].agentId
          ? 'Fallback responder selected to keep the conversation moving.'
          : summarizeReason(candidate.reasons) || 'No candidate cleared the response threshold.',
      })),
    };
  }

  const selectedAgentIds = input.analysis.allowsMultipleAgents
    && scored.length > 1
    && scored[1].score >= scored[0].score - 1
    && scored[1].score >= 3
      ? scored.slice(0, MAX_MULTI_AGENT_RESPONSES).map((candidate) => candidate.agentId)
      : [scored[0].agentId];

  return {
    selectedAgentIds,
    diagnostics: scored.map((candidate) => ({
      agentId: candidate.agentId,
      score: candidate.score,
      decision: selectedAgentIds.includes(candidate.agentId) ? 'RESPOND' : 'OPTIONAL',
      reason: summarizeReason(candidate.reasons),
    })),
  };
}
