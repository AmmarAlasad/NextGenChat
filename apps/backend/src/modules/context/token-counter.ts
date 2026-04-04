/**
 * Token Counter Service
 *
 * Counts provider input conservatively so context assembly can respect model
 * budgets before provider calls happen. Exact provider integrations can replace
 * or refine this over time without changing the ContextBuilder contract.
 */

import type { LLMMessage, LLMProvider } from '@nextgenchat/types';

export class TokenCounterService {
  async count(messages: LLMMessage[], provider?: Pick<LLMProvider, 'countTokens'>) {
    if (provider) {
      return provider.countTokens(messages);
    }

    return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 4, 0);
  }
}

export const tokenCounter = new TokenCounterService();
