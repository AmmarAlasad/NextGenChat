/**
 * Prompt Cache Service
 *
 * Keeps cache-sensitive prompt concerns out of the provider and context builder
 * so both can stay focused on assembly and execution.
 */

import { createHash } from 'node:crypto';

import type { LLMMessage } from '@nextgenchat/types';

export class PromptCacheService {
  buildStaticPrefixKey(messages: LLMMessage[], staticMessageCount: number) {
    return createHash('sha256')
      .update(JSON.stringify(messages.slice(0, staticMessageCount)))
      .digest('hex');
  }
}

export const promptCacheService = new PromptCacheService();
