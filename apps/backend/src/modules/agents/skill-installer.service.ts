/**
 * Skill Installer Service
 *
 * Imports skills into managed on-disk skill directories. GitHub sources follow
 * discovery semantics similar to Paperclip: recursively scan for SKILL.md,
 * select the requested skill if needed, then install the full skill directory.
 */

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import type { AgentCreatorSkillInstall, AgentSkillType, CreateSkillInput } from '@nextgenchat/types';

import { skillService } from '@/modules/agents/skill.service.js';

const SKILL_FETCH_TIMEOUT_MS = 30_000;
const SKILL_FETCH_MAX_BYTES = 5 * 1024 * 1024;

type InstallAction = 'installed' | 'updated';
type AgentSkillSourceType = 'MANUAL' | 'GENERATED' | 'GITHUB' | 'CLAWHUB' | 'URL';
type AgentSkillFile = { path: string; kind: 'skill' | 'reference' | 'script' | 'asset' | 'other' };

interface ParsedInstallSource {
  source: string;
  selectedSkill?: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  type?: AgentSkillType;
  toolNames?: string[];
  body: string;
}

interface ImportedSkillPayload {
  sourceType: AgentSkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  name: string;
  description?: string;
  type: AgentSkillType;
  toolNames?: string[];
  content: string;
  rootPath: string;
  files: Array<{ path: string; content: string }>;
  fileInventory: AgentSkillFile[];
}

type ManagedCreateSkillInput = CreateSkillInput & {
  sourceType?: AgentSkillSourceType;
  sourceLocator?: string;
  sourceRef?: string;
  fileInventory?: AgentSkillFile[];
  files: Array<{ path: string; content: string }>;
  rootPath: string;
};

export interface InstalledSkillResult {
  action: InstallAction;
  source: string;
  resolvedFrom: string;
  sourceKind: AgentSkillSourceType | 'generated';
  skill: {
    name: string;
    type: AgentSkillType;
    description: string | null;
    toolNames: string[];
    content: string;
    rootPath: string;
    fileInventory: AgentSkillFile[];
  };
}

interface GitHubSource {
  hostname: string;
  owner: string;
  repo: string;
  ref: string;
  basePath: string;
  filePath: string | null;
  explicitRef: boolean;
}

function normalizeSkillName(rawName: string): string {
  return rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function slugFromUrl(url: string): string {
  const clean = url.replace(/\?.*$/, '').replace(/\/+$/, '');
  const last = clean.split('/').filter(Boolean).pop() ?? 'skill';
  return normalizeSkillName(last.replace(/\.(md|markdown)$/i, ''));
}

function classifyInventoryKind(relativePath: string): AgentSkillFile['kind'] {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'SKILL.md') return 'skill';
  if (normalized.startsWith('references/')) return 'reference';
  if (normalized.startsWith('scripts/')) return 'script';
  if (normalized.startsWith('assets/')) return 'asset';
  return 'other';
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!fmMatch) return { body: content.trim() };

  const fm = fmMatch[1];
  const body = (fmMatch[2] ?? '').trim();
  const lines = fm.split(/\r?\n/);
  const map = new Map<string, string>();
  const toolNames: string[] = [];
  let currentListKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch && currentListKey && (currentListKey === 'toolNames' || currentListKey === 'tool_names' || currentListKey === 'allowed-tools')) {
      toolNames.push(listMatch[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    const keyMatch = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) continue;

    currentListKey = keyMatch[1];
    map.set(keyMatch[1], keyMatch[2].trim().replace(/^['"]|['"]$/g, ''));
  }

  const inlineToolNames = (map.get('toolNames') ?? map.get('tool_names') ?? map.get('allowed-tools'))
    ?.split(/[ ,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const typeRaw = map.get('type')?.toUpperCase();
  const type = typeRaw === 'PASSIVE' || typeRaw === 'ON_DEMAND' || typeRaw === 'TOOL_BASED'
    ? typeRaw
    : undefined;

  return {
    name: map.get('name'),
    description: map.get('description'),
    type,
    toolNames: toolNames.length > 0 ? toolNames : inlineToolNames,
    body,
  };
}

async function fetchText(url: string, accept = 'text/plain, text/markdown, application/vnd.github+json, */*;q=0.8') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': 'NextGenChat-SkillInstaller/3.0',
      },
    });

    clearTimeout(timer);
    if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`);

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > SKILL_FETCH_MAX_BYTES) throw new Error(`Response too large for ${url}`);

    return {
      url,
      contentType: response.headers.get('content-type') ?? '',
      text: new TextDecoder().decode(buffer),
    };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out while fetching ${url}`, { cause: error });
    }
    throw error;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchText(url, 'application/vnd.github+json, application/json');
  return JSON.parse(response.text) as T;
}

function parseGitHubSourceUrl(rawUrl: string): GitHubSource {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('GitHub source URL must use HTTPS');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Invalid GitHub URL');

  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');
  let ref = 'main';
  let basePath = '';
  let filePath: string | null = null;
  let explicitRef = false;

  if (parts[2] === 'tree') {
    ref = parts[3] ?? 'main';
    basePath = parts.slice(4).join('/');
    explicitRef = true;
  } else if (parts[2] === 'blob') {
    ref = parts[3] ?? 'main';
    filePath = parts.slice(4).join('/');
    basePath = filePath ? path.posix.dirname(filePath) : '';
    explicitRef = true;
  }

  return { hostname: url.hostname, owner, repo, ref, basePath, filePath, explicitRef };
}

function gitHubApiBase(hostname: string) {
  return hostname === 'github.com' ? 'https://api.github.com' : `https://${hostname}/api/v3`;
}

function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  if (hostname === 'github.com') {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  }
  return `https://${hostname}/${owner}/${repo}/raw/${ref}/${filePath}`;
}

async function resolveGitHubDefaultBranch(owner: string, repo: string, apiBase: string) {
  const response = await fetchJson<{ default_branch?: string }>(`${apiBase}/repos/${owner}/${repo}`);
  return response.default_branch || 'main';
}

async function resolveGitHubCommitSha(owner: string, repo: string, ref: string, apiBase: string) {
  const response = await fetchJson<{ sha?: string }>(`${apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!response.sha) throw new Error(`Failed to resolve GitHub ref ${ref}`);
  return response.sha;
}

async function resolveGitHubPinnedRef(parsed: GitHubSource) {
  const apiBase = gitHubApiBase(parsed.hostname);
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return { pinnedRef: parsed.ref };
  }

  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo, apiBase);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef, apiBase);
  return { pinnedRef };
}

function extractCommandTokens(raw: string) {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function parseInstallSource(rawInput: string): ParsedInstallSource {
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error('Skill source is required.');

  let source = trimmed;
  let selectedSkill: string | undefined;

  if (/^npx\s+skills\s+add\s+/i.test(trimmed)) {
    const tokens = extractCommandTokens(trimmed);
    const addIndex = tokens.findIndex((token, index) => token === 'add' && index > 0 && tokens[index - 1]?.toLowerCase() === 'skills');
    if (addIndex >= 0) {
      source = tokens[addIndex + 1] ?? '';
      for (let index = addIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === '--skill') {
          selectedSkill = normalizeSkillName(tokens[index + 1] ?? '');
          index += 1;
          continue;
        }
        if (token.startsWith('--skill=')) {
          selectedSkill = normalizeSkillName(token.slice('--skill='.length));
        }
      }
    }
  }

  if (!/^https?:\/\//i.test(source) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    const [owner, repo, skillSlug] = source.split('/');
    return { source: `https://github.com/${owner}/${repo}`, selectedSkill: normalizeSkillName(skillSlug) };
  }

  if (!/^https?:\/\//i.test(source) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return { source: `https://github.com/${source}`, selectedSkill };
  }

  // skills.sh URLs use the format: skills.sh/github/{owner}/{repo}[/{skill}]
  // The "github" segment is a platform indicator, not the owner — skip it.
  const skillsShMatch = source.match(/^https?:\/\/(?:www\.)?skills\.sh\/github\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:[?#].*)?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      source: `https://github.com/${owner}/${repo}`,
      selectedSkill: skillSlugRaw ? normalizeSkillName(skillSlugRaw) : selectedSkill,
    };
  }

  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const querySkill = url.searchParams.get('skill')?.trim();
    const hashSkill = url.hash.startsWith('#skill=') ? url.hash.slice('#skill='.length).trim() : undefined;
    url.searchParams.delete('skill');
    url.hash = '';
    const rawSkill = querySkill || hashSkill || selectedSkill;
    return {
      source: url.toString().replace(/\?$/, '').replace(/\/+$/, ''),
      selectedSkill: rawSkill ? normalizeSkillName(rawSkill) : undefined,
    };
  }

  return { source, selectedSkill };
}

function matchesRequestedSkill(relativeSkillPath: string, requestedSkillSlug?: string) {
  if (!requestedSkillSlug) return true;
  const skillDir = path.posix.dirname(relativeSkillPath);
  return normalizeSkillName(path.posix.basename(skillDir)) === requestedSkillSlug;
}

async function importGitHubSource(sourceUrl: string, selectedSkill?: string): Promise<ImportedSkillPayload> {
  const parsed = parseGitHubSourceUrl(sourceUrl);
  const apiBase = gitHubApiBase(parsed.hostname);
  const { pinnedRef } = await resolveGitHubPinnedRef(parsed);
  const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(`${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${pinnedRef}?recursive=1`);

  const allPaths = (tree.tree ?? []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, '')}/` : '';
  const scopedPaths = basePrefix ? allPaths.filter((entry) => entry.startsWith(basePrefix)) : allPaths;
  const relativePaths = scopedPaths.map((entry) => basePrefix ? entry.slice(basePrefix.length) : entry);
  const filteredPaths = parsed.filePath
    ? relativePaths.filter((entry) => entry === path.posix.relative(parsed.basePath || '.', parsed.filePath!))
    : relativePaths;
  const skillPaths = filteredPaths.filter((entry) => path.posix.basename(entry).toLowerCase() === 'skill.md');

  if (skillPaths.length === 0) throw new Error('No SKILL.md files were found in the provided GitHub source.');

  const matchingPaths = skillPaths.filter((entry) => matchesRequestedSkill(entry, selectedSkill));
  if (selectedSkill && matchingPaths.length === 0) {
    throw new Error(`Skill ${selectedSkill} was not found in the provided GitHub source.`);
  }
  if (!selectedSkill && matchingPaths.length > 1) {
    throw new Error(`This GitHub source contains multiple skills. Specify one with the skill parameter. Available skills: ${matchingPaths.map((entry) => normalizeSkillName(path.posix.basename(path.posix.dirname(entry)))).join(', ')}`);
  }

  const relativeSkillPath = matchingPaths[0]!;
  const skillDir = path.posix.dirname(relativeSkillPath);
  const skillDirPrefix = skillDir === '.' ? '' : `${skillDir}/`;
  const skillFiles = filteredPaths
    .filter((entry) => skillDir === '.' || entry === relativeSkillPath || entry.startsWith(skillDirPrefix))
    .sort((left, right) => left.localeCompare(right));

  const files = await Promise.all(skillFiles.map(async (entry) => {
    const repoPath = basePrefix ? `${basePrefix}${entry}` : entry;
    const response = await fetchText(resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, pinnedRef, repoPath));
    return {
      path: entry === relativeSkillPath || skillDir === '.' ? (entry === relativeSkillPath ? 'SKILL.md' : entry) : entry.slice(skillDir.length + 1),
      content: response.text,
    };
  }));

  const skillMd = files.find((file) => file.path === 'SKILL.md')?.content?.trim();
  if (!skillMd) throw new Error(`SKILL.md could not be fetched from ${sourceUrl}`);

  const frontmatter = parseSkillFrontmatter(skillMd);
  const fallbackSlug = normalizeSkillName(path.posix.basename(skillDir));
  const name = normalizeSkillName(frontmatter.name ?? fallbackSlug);

  return {
    sourceType: 'GITHUB',
    sourceLocator: sourceUrl,
    sourceRef: pinnedRef,
    name,
    description: frontmatter.description,
    type: frontmatter.type ?? 'ON_DEMAND',
    toolNames: frontmatter.toolNames,
    content: frontmatter.body || skillMd,
    rootPath: name,
    files,
    fileInventory: files.map((file) => ({ path: file.path, kind: classifyInventoryKind(file.path) })),
  };
}

async function fetchClawhubZip(slug: string) {
  const zipUrl = `https://wry-manatee-359.convex.site/api/v1/download?slug=${encodeURIComponent(slug)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(zipUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NextGenChat-SkillInstaller/3.0' },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`clawhub ZIP download failed (${response.status}) for slug "${slug}"`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function extractFilesFromZip(zipBuffer: Buffer): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  let offset = 0;

  while (offset + 30 < zipBuffer.length) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compression = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const filenameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const filename = zipBuffer.subarray(offset + 30, offset + 30 + filenameLen).toString('utf-8');
    const dataOffset = offset + 30 + filenameLen + extraLen;
    const data = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

    if (!filename.endsWith('/')) {
      let content = '';
      if (compression === 0) content = data.toString('utf-8');
      if (compression === 8) content = inflateRawSync(data).toString('utf-8');
      if (content) files.push({ path: filename.replace(/^\/+/, ''), content });
    }

    offset = dataOffset + Math.max(compressedSize, 1);
  }

  return files;
}

async function importClawhubSource(sourceUrl: string): Promise<ImportedSkillPayload> {
  const match = sourceUrl.match(/clawhub\.ai\/[^/]+\/([^/?#]+)/i);
  if (!match) throw new Error('Unsupported clawhub source URL');

  const zipFiles = extractFilesFromZip(await fetchClawhubZip(match[1]));
  const skillFile = zipFiles.find((file) => /(^|\/)SKILL\.md$/i.test(file.path));
  if (!skillFile) throw new Error(`SKILL.md not found in clawhub package for slug "${match[1]}"`);

  const relativeRoot = path.posix.dirname(skillFile.path);
  const files = zipFiles
    .filter((file) => file.path === skillFile.path || file.path.startsWith(`${relativeRoot}/`))
    .map((file) => ({
      path: file.path === skillFile.path ? 'SKILL.md' : file.path.slice(relativeRoot.length + 1),
      content: file.content,
    }));

  const frontmatter = parseSkillFrontmatter(skillFile.content);
  const name = normalizeSkillName(frontmatter.name ?? match[1]);
  return {
    sourceType: 'CLAWHUB',
    sourceLocator: sourceUrl,
    sourceRef: null,
    name,
    description: frontmatter.description,
    type: frontmatter.type ?? 'ON_DEMAND',
    toolNames: frontmatter.toolNames,
    content: frontmatter.body || skillFile.content.trim(),
    rootPath: name,
    files,
    fileInventory: files.map((file) => ({ path: file.path, kind: classifyInventoryKind(file.path) })),
  };
}

async function importDirectMarkdownSource(sourceUrl: string): Promise<ImportedSkillPayload> {
  const response = await fetchText(sourceUrl);
  const markdown = response.text.trim();
  if (!markdown) throw new Error(`No content returned for ${sourceUrl}`);

  const frontmatter = parseSkillFrontmatter(markdown);
  const name = normalizeSkillName(frontmatter.name ?? slugFromUrl(sourceUrl));
  return {
    sourceType: 'URL',
    sourceLocator: sourceUrl,
    sourceRef: null,
    name,
    description: frontmatter.description,
    type: frontmatter.type ?? 'ON_DEMAND',
    toolNames: frontmatter.toolNames,
    content: frontmatter.body || markdown,
    rootPath: name,
    files: [{ path: 'SKILL.md', content: markdown }],
    fileInventory: [{ path: 'SKILL.md', kind: 'skill' }],
  };
}

function toCreateSkillInput(payload: ImportedSkillPayload, overrides: { name?: string; type?: AgentSkillType }): ManagedCreateSkillInput {
  const name = normalizeSkillName(overrides.name ?? payload.name);
  return {
    name,
    description: payload.description,
    type: overrides.type ?? payload.type,
    toolNames: payload.toolNames,
    content: payload.content,
    sourceType: payload.sourceType,
    sourceLocator: payload.sourceLocator ?? undefined,
    sourceRef: payload.sourceRef ?? undefined,
    fileInventory: payload.fileInventory,
    files: payload.files,
    rootPath: name,
  };
}

class SkillInstallerService {
  async installFromSource(agentId: string, input: { url: string; name?: string; skill?: string; type?: AgentSkillType }): Promise<InstalledSkillResult> {
    const parsed = parseInstallSource(input.url);
    const selectedSkill = input.skill ? normalizeSkillName(input.skill) : parsed.selectedSkill;
    const source = parsed.source;

    let imported: ImportedSkillPayload;
    if (/github\.com\//i.test(source)) {
      imported = await importGitHubSource(source, selectedSkill);
    } else if (/clawhub\.ai\//i.test(source)) {
      imported = await importClawhubSource(source);
    } else {
      imported = await importDirectMarkdownSource(source);
    }

    const createInput = toCreateSkillInput(imported, { name: input.name, type: input.type });
    const { skill, action } = await skillService.upsert(agentId, createInput);
    const installedSkill = skill as typeof skill & { rootPath: string; fileInventory: AgentSkillFile[] };

    return {
      action,
      source,
      resolvedFrom: imported.sourceLocator ?? source,
      sourceKind: imported.sourceType,
      skill: {
        name: skill.name,
        type: skill.type,
        description: skill.description,
        toolNames: skill.toolNames,
        content: skill.content,
        rootPath: installedSkill.rootPath,
        fileInventory: installedSkill.fileInventory,
      },
    };
  }

  async installGenerated(agentId: string, input: AgentCreatorSkillInstall): Promise<InstalledSkillResult> {
    const createInput = toCreateSkillInput({
      sourceType: 'GENERATED',
      sourceLocator: null,
      sourceRef: null,
      name: normalizeSkillName(input.name),
      description: input.description,
      type: input.type,
      toolNames: input.toolNames,
      content: input.content.trim(),
      rootPath: normalizeSkillName(input.name),
      files: [{ path: 'SKILL.md', content: input.content.trim() }],
      fileInventory: [{ path: 'SKILL.md', kind: 'skill' }],
    }, {});
    const { skill, action } = await skillService.upsert(agentId, createInput);
    const installedSkill = skill as typeof skill & { rootPath: string; fileInventory: AgentSkillFile[] };

    return {
      action,
      source: 'generated',
      resolvedFrom: 'generated',
      sourceKind: 'generated',
      skill: {
        name: skill.name,
        type: skill.type,
        description: skill.description,
        toolNames: skill.toolNames,
        content: skill.content,
        rootPath: installedSkill.rootPath,
        fileInventory: installedSkill.fileInventory,
      },
    };
  }
}

export const skillInstallerService = new SkillInstallerService();
