/**
 * Agent Visibility Tests
 *
 * Verifies which messages are visible inside an agent's prompt context.
 * User messages are visible to all eligible agents, while agent replies remain
 * private unless they are the agent's own reply or explicitly mention the
 * current agent to hand off the turn.
 */

import { describe, expect, it } from 'vitest';

import { isExplicitlyMentioned, isMessageVisibleToAgent } from './agent-visibility.js';

describe('isExplicitlyMentioned', () => {
  it('matches agent slug mentions from agent messages', () => {
    expect(isExplicitlyMentioned('@ivy can you take this one?', { slug: 'ivy', name: 'Ivy' }, 'AGENT')).toBe(true);
    expect(isExplicitlyMentioned('I think ivy should answer', { slug: 'ivy', name: 'Ivy' }, 'AGENT')).toBe(false);
  });

  it('matches slug or name mentions from user messages', () => {
    expect(isExplicitlyMentioned('ivy, can you answer this?', { slug: 'ivy', name: 'Ivy' }, 'USER')).toBe(true);
    expect(isExplicitlyMentioned('@ivy, can you answer this?', { slug: 'ivy', name: 'Ivy' }, 'USER')).toBe(true);
  });
});

describe('isMessageVisibleToAgent', () => {
  const base = {
    currentAgentId: 'agent-ivy',
    currentAgentSlug: 'ivy',
    currentAgentName: 'Ivy',
  };

  it('always shows user messages', () => {
    expect(isMessageVisibleToAgent({
      ...base,
      messageSenderId: 'user-1',
      messageSenderType: 'USER',
      messageContent: 'hello team',
    })).toBe(true);
  });

  it('shows the agent its own prior replies', () => {
    expect(isMessageVisibleToAgent({
      ...base,
      messageSenderId: 'agent-ivy',
      messageSenderType: 'AGENT',
      messageContent: 'Here is my answer',
    })).toBe(true);
  });

  it('hides another agent reply by default', () => {
    expect(isMessageVisibleToAgent({
      ...base,
      messageSenderId: 'agent-coco',
      messageSenderType: 'AGENT',
      messageContent: 'Here is my answer',
    })).toBe(false);
  });

  it('shows another agent reply when it explicitly mentions the current agent', () => {
    expect(isMessageVisibleToAgent({
      ...base,
      messageSenderId: 'agent-coco',
      messageSenderType: 'AGENT',
      messageContent: '@ivy can you check the branding angle?',
    })).toBe(true);
  });
});
