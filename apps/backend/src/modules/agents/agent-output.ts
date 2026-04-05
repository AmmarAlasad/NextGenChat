/**
 * Agent Visible Output Sanitizer
 *
 * Removes internal control wrappers and prompt-leak fragments before agent text
 * is shown to users.
 */

const STRIP_BLOCK_TAGS = [
  'message',
  'reply',
  'final',
  'analysis',
  'thinking',
  'system-reminder',
  'assistant-reminder',
  'scratchpad',
];

const LEAKY_LINE_PATTERNS = [
  /your operational mode has changed/i,
  /you are no longer in read-only mode/i,
  /you are permitted to make file changes/i,
  /utilize your arsenal of tools/i,
  /return exactly \[\[no_reply\]\]/i,
];

export const NO_REPLY_TOKEN = '[[NO_REPLY]]';

export function sanitizeAgentVisibleContent(raw: string) {
  let content = raw.trim();

  for (const tag of STRIP_BLOCK_TAGS) {
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    content = content.replace(blockRe, ' ');
  }

  content = content
    .replace(/^<message\b[^>]*>\s*/i, '')
    .replace(/\s*<\/message>\s*$/i, '')
    .replace(/^<reply\b[^>]*>\s*/i, '')
    .replace(/\s*<\/reply>\s*$/i, '');

  const cleanedLines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !LEAKY_LINE_PATTERNS.some((pattern) => pattern.test(line)));

  content = cleanedLines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();

  if (content === NO_REPLY_TOKEN) {
    return NO_REPLY_TOKEN;
  }

  if (!content || content.replace(/[[\]\s._-]/g, '') === 'NOREPLY') {
    return NO_REPLY_TOKEN;
  }

  return content;
}
