/**
 * Bootstrap Context Builder
 *
 * Direct port of OpenClaw's bootstrap file budgeting and truncation logic from
 * src/agents/pi-embedded-helpers/bootstrap.ts and src/agents/system-prompt.ts.
 *
 * Responsibilities:
 *   - Per-file character limit: DEFAULT_BOOTSTRAP_MAX_CHARS_PER_FILE (20 000)
 *   - Total budget across all files: DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS (150 000)
 *   - Truncation strategy: 70 % head + 20 % tail with an inline marker (matches OpenClaw exactly)
 *   - Priority ordering: CONTEXT_FILE_ORDER map mirrors OpenClaw's CONTEXT_FILE_ORDER
 *   - SOUL.md instruction: injected before file listing when soul.md is present
 *   - Dynamic file set: heartbeat.md is the only dynamic file; all others are static/cached
 *
 * The storage layer (reading from DB / disk) is handled by workspace.service.ts.
 * This module receives already-loaded content strings and applies the OpenClaw budget rules.
 *
 * Phase 5 implementation status:
 * - Truncation and budget logic: identical to OpenClaw.
 * - Priority ordering: identical to OpenClaw.
 * - Dynamic / static split: identical to OpenClaw.
 * - Hook system (applyBootstrapHookOverrides): not implemented; placeholder for future phases.
 */

// ── Constants (identical to OpenClaw) ─────────────────────────────────────────

/** Per-file character limit before head+tail truncation kicks in. */
export const BOOTSTRAP_MAX_CHARS_PER_FILE = 20_000;

/** Total character budget across all static bootstrap files combined. */
export const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000;

/** Fraction of per-file budget taken from the head of the file. */
const BOOTSTRAP_HEAD_RATIO = 0.7;

/** Fraction of per-file budget taken from the tail of the file. */
const BOOTSTRAP_TAIL_RATIO = 0.2;

/** Minimum remaining total budget before a file is skipped entirely. */
const MIN_FILE_BUDGET_CHARS = 64;

// ── Priority order (mirrors OpenClaw's CONTEXT_FILE_ORDER exactly) ────────────

/**
 * Lower number = injected earlier = higher priority.
 * OpenClaw: agents.md(10) soul.md(20) identity.md(30) user.md(40) tools.md(50) bootstrap.md(60) memory.md(70)
 * NextGenChat mapping:
 *   Agent.md  → agents.md  (10) — operating manual / multi-agent rules
 *   soul.md   → soul.md    (20)
 *   identity.md → identity.md (30)
 *   user.md   → user.md    (40)
 *   tools.md  → tools.md   (50) — generated, not from disk
 *   agency.md → bootstrap.md (60) — workspace constitution
 *   project.md → (65)      — channel-scoped project context
 *   memory.md → memory.md  (70)
 *
 * heartbeat.md is excluded here — it is dynamic and always loaded below the cache boundary.
 */
export const CONTEXT_FILE_ORDER = new Map<string, number>([
  ['Agent.md', 10],
  ['soul.md', 20],
  ['identity.md', 30],
  ['user.md', 40],
  ['tools.md', 50],
  ['agency.md', 60],
  ['project.md', 65],
  ['memory.md', 70],
]);

/** Files that change frequently and must always be rebuilt (never cached). */
export const DYNAMIC_CONTEXT_FILES = new Set(['heartbeat.md']);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BootstrapDoc {
  /** Canonical file name, e.g. 'soul.md' */
  name: string;
  /** Raw content as loaded from storage. */
  content: string;
}

export interface BootstrapResult {
  name: string;
  /** Content after truncation (may be shorter than input). */
  content: string;
  truncated: boolean;
  originalLength: number;
}

// ── Core functions (direct port of OpenClaw) ──────────────────────────────────

/**
 * Sort documents by CONTEXT_FILE_ORDER priority.
 * Unknown files sort after all known ones (MAX_SAFE_INTEGER), then alphabetically.
 */
export function sortByContextFileOrder(docs: BootstrapDoc[]): BootstrapDoc[] {
  return [...docs].sort((a, b) => {
    const aOrder = CONTEXT_FILE_ORDER.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = CONTEXT_FILE_ORDER.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Truncate file content to maxChars using the OpenClaw 70 % head + 20 % tail strategy.
 * Inserts a truncation marker between head and tail so the model knows content was cut.
 */
function trimBootstrapContent(
  content: string,
  fileName: string,
  maxChars: number,
): { content: string; truncated: boolean; originalLength: number } {
  const trimmed = content.trimEnd();

  if (trimmed.length <= maxChars) {
    return { content: trimmed, truncated: false, originalLength: trimmed.length };
  }

  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = [
    '',
    `[...truncated, read ${fileName} for full content...]`,
    `\u2026(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})\u2026`,
    '',
  ].join('\n');

  return {
    content: [head, marker, tail].join('\n'),
    truncated: true,
    originalLength: trimmed.length,
  };
}

/**
 * Apply per-file and total character budgets to a list of bootstrap documents.
 * Documents must already be sorted in injection order (call sortByContextFileOrder first).
 *
 * Mirrors OpenClaw's buildBootstrapContextFiles() from pi-embedded-helpers/bootstrap.ts.
 */
export function buildBootstrapContextFiles(
  docs: BootstrapDoc[],
  opts?: {
    maxCharsPerFile?: number;
    totalMaxChars?: number;
    warn?: (message: string) => void;
  },
): BootstrapResult[] {
  const maxCharsPerFile = opts?.maxCharsPerFile ?? BOOTSTRAP_MAX_CHARS_PER_FILE;
  const totalMaxChars = opts?.totalMaxChars ?? BOOTSTRAP_TOTAL_MAX_CHARS;

  let remainingTotal = totalMaxChars;
  const results: BootstrapResult[] = [];

  for (const doc of docs) {
    if (remainingTotal < MIN_FILE_BUDGET_CHARS) {
      opts?.warn?.(`[bootstrap] budget exhausted (${remainingTotal} chars remaining); skipping ${doc.name}`);
      break;
    }

    if (!doc.content.trim()) {
      // Empty file — skip silently (don't consume budget).
      continue;
    }

    const fileMaxChars = Math.min(maxCharsPerFile, remainingTotal);
    const { content, truncated, originalLength } = trimBootstrapContent(doc.content, doc.name, fileMaxChars);

    if (truncated) {
      opts?.warn?.(`[bootstrap] ${doc.name} is ${originalLength} chars (limit ${fileMaxChars}); truncating in injected context`);
    }

    remainingTotal = Math.max(0, remainingTotal - content.length);
    results.push({ name: doc.name, content, truncated, originalLength });
  }

  return results;
}

/**
 * Build the "Project Context" section text that wraps all static bootstrap files.
 * Mirrors OpenClaw's buildProjectContextSection() from system-prompt.ts.
 *
 * Format (identical to OpenClaw):
 *   ## Project Context
 *
 *   The following project context files have been loaded:
 *   [If soul.md is present: "If soul.md is present, embody its persona…"]
 *
 *   ## soul.md
 *
 *   {content}
 *
 *   ## identity.md
 *   …
 */
export function buildProjectContextSection(results: BootstrapResult[]): string {
  if (results.length === 0) return '';

  const hasSoul = results.some((r) => r.name === 'soul.md');

  const lines: string[] = [
    '## Project Context',
    '',
    'The following project context files have been loaded and are already available to you. Do NOT use workspace_read_file to re-read them — their content is right here.',
  ];

  if (hasSoul) {
    lines.push(
      'If soul.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.',
    );
  }

  lines.push('');

  for (const result of results) {
    lines.push(`## ${result.name}`, '', result.content, '');
  }

  return lines.join('\n');
}

/**
 * Build the dynamic context section text (files below the cache boundary).
 * Currently only heartbeat.md qualifies as dynamic.
 * Mirrors OpenClaw's dynamic variant of buildProjectContextSection().
 */
export function buildDynamicContextSection(results: BootstrapResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = [
    '## Dynamic Context',
    '',
    'The following frequently-changing context files are kept below the cache boundary:',
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.name}`, '', result.content, '');
  }

  return lines.join('\n');
}
