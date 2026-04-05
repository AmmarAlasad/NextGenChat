import { describe, expect, it } from 'vitest';

import { NO_REPLY_TOKEN, sanitizeAgentVisibleContent } from './agent-output.js';

describe('sanitizeAgentVisibleContent', () => {
  it('removes leaked internal reminder blocks', () => {
    const result = sanitizeAgentVisibleContent(`Hello\n<system-reminder>secret</system-reminder>\nworld`);

    expect(result).toBe('Hello\nworld');
  });

  it('suppresses visible no-reply control tokens', () => {
    expect(sanitizeAgentVisibleContent('[[NO_REPLY]]')).toBe(NO_REPLY_TOKEN);
  });

  it('removes leaked operational control lines', () => {
    const result = sanitizeAgentVisibleContent('Your operational mode has changed from plan to build.\nReal answer.');

    expect(result).toBe('Real answer.');
  });
});
