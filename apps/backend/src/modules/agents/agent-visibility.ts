/**
 * Agent Message Visibility Rules
 *
 * Defines which channel messages are visible inside an agent's prompt context.
 * User messages are broadly visible to eligible channel members, while agent
 * replies stay private unless they are the agent's own reply or explicitly
 * mention another agent to hand off the turn.
 */

import type { SenderType } from '@nextgenchat/types';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isExplicitlyMentioned(content: string, candidate: { slug: string; name: string }, senderType: SenderType) {
  const lowered = content.toLowerCase();
  const slugMention = lowered.includes(`@${candidate.slug.toLowerCase()}`);

  if (senderType === 'AGENT') {
    return slugMention;
  }

  const escapedName = escapeRegExp(candidate.name.toLowerCase());
  const nameMention = new RegExp(`(^|[^a-z0-9])${escapedName}([^a-z0-9]|$)`, 'i').test(lowered);
  return slugMention || nameMention;
}

export function isMessageVisibleToAgent(input: {
  messageSenderId: string;
  messageSenderType: SenderType;
  messageContent: string;
  currentAgentId: string;
  currentAgentSlug: string;
  currentAgentName: string;
}) {
  if (input.messageSenderType === 'USER') {
    return true;
  }

  if (input.messageSenderId === input.currentAgentId) {
    return true;
  }

  return isExplicitlyMentioned(
    input.messageContent,
    {
      slug: input.currentAgentSlug,
      name: input.currentAgentName,
    },
    'AGENT',
  );
}
