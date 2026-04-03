/**
 * Token Counter Service
 *
 * Phase 1 implementation status:
 * - This file now provides a lightweight token estimate for the first milestone.
 * - Current scope uses a conservative character-based estimate so the provider layer
 *   can stay simple while the app gains a working chat loop.
 * - Future phases should replace this with provider-specific token counting.
 */

import type { LLMMessage } from '@nextgenchat/types';

export class TokenCounterService {
  async count(messages: LLMMessage[]) {
    return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 4, 0);
  }
}

export const tokenCounter = new TokenCounterService();
