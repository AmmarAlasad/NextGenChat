/**
 * Token Counter Service
 *
 * Counts provider input conservatively so context assembly can respect model
 * budgets before provider calls happen. Exact provider integrations can replace
 * or refine this over time without changing the ContextBuilder contract.
 */

import type { LLMMessage, LLMProvider } from '@nextgenchat/types';

interface CountableTextBlock { type: 'text'; text: string; }
interface CountableImageBlock { type: 'image'; mimeType: string; dataBase64: string; }
type CountableBlock = CountableTextBlock | CountableImageBlock;

function estimateMessageTextLength(message: LLMMessage) {
  if (typeof message.content === 'string') {
    return message.content.length;
  }

  return (message.content as unknown as CountableBlock[]).reduce((total, block) => {
    if (block.type === 'text') return total + block.text.length;
    return total + 1024;
  }, 0);
}

export class TokenCounterService {
  async count(messages: LLMMessage[], provider?: Pick<LLMProvider, 'countTokens'>) {
    if (provider) {
      return provider.countTokens(messages);
    }

    return messages.reduce((total, message) => total + Math.ceil(estimateMessageTextLength(message) / 4) + 4, 0);
  }
}

export const tokenCounter = new TokenCounterService();
