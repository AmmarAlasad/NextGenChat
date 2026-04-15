/**
 * Skill Service
 *
 * Manages installed agent skills as directories rooted in the agent workspace.
 * Each skill lives at:
 *   {agentWorkspace}/skills/{name}/SKILL.md
 * with optional references, scripts, and assets stored alongside it.
 *
 * Metadata lives in the AgentSkill table, while the full skill directory lives
 * on disk so activation can expose the real installed structure.
 */

import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CreateSkillSchema, UpdateSkillSchema } from '@nextgenchat/types';
import type { AgentSkill, AgentSkillFile, CreateSkillInput, UpdateSkillInput } from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { staticPrefixCache } from '@/modules/context/static-prefix-cache.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

type SkillRow = {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  type: string;
  toolNames: string | null;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  rootPath: string;
  fileInventory: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function classifyInventoryKind(relativePath: string): AgentSkillFile['kind'] {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'SKILL.md') return 'skill';
  if (normalized.startsWith('references/')) return 'reference';
  if (normalized.startsWith('scripts/')) return 'script';
  if (normalized.startsWith('assets/')) return 'asset';
  return 'other';
}

export class SkillService {
  private skillsDirBySlug(slug: string): string {
    return path.join(workspaceService.getAgentWorkspaceDir(slug), 'skills');
  }

  private async resolveSkillsDir(agentId: string): Promise<string> {
    const slug = await workspaceService.fetchSlug(agentId);
    return this.skillsDirBySlug(slug);
  }

  private parseToolNames(raw: string | null): string[] {
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  private parseInventory(raw: string | null): AgentSkillFile[] {
    if (!raw) return [{ path: 'SKILL.md', kind: 'skill' }];
    try {
      const parsed = JSON.parse(raw) as AgentSkillFile[];
      return parsed.length > 0 ? parsed : [{ path: 'SKILL.md', kind: 'skill' }];
    } catch {
      return [{ path: 'SKILL.md', kind: 'skill' }];
    }
  }

  private serializeInventory(inventory: AgentSkillFile[] | undefined) {
    const normalized = (inventory && inventory.length > 0 ? inventory : [{ path: 'SKILL.md', kind: 'skill' }])
      .map((entry) => ({ path: entry.path.replace(/\\/g, '/'), kind: entry.kind ?? classifyInventoryKind(entry.path) }));
    return JSON.stringify(normalized);
  }

  private resolveRootPath(skill: SkillRow) {
    return skill.rootPath?.trim() || skill.name;
  }

  private async readContentByRoot(skillsDir: string, rootPath: string, name: string): Promise<string> {
    const primaryPath = path.join(skillsDir, rootPath, 'SKILL.md');
    try {
      return await readFile(primaryPath, 'utf8');
    } catch {
      try {
        return await readFile(path.join(skillsDir, `${name}.md`), 'utf8');
      } catch {
        return '';
      }
    }
  }

  private async writeInstalledFiles(skillsDir: string, rootPath: string, input: { content: string; files?: Array<{ path: string; content: string }> }) {
    const skillRoot = path.join(skillsDir, rootPath);
    await rm(skillRoot, { recursive: true, force: true });
    await mkdir(skillRoot, { recursive: true });

    const files = input.files && input.files.length > 0
      ? input.files
      : [{ path: 'SKILL.md', content: input.content }];

    for (const file of files) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      const absolute = path.join(skillRoot, normalized);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, 'utf8');
    }
  }

  private toRecord(skill: SkillRow, content: string): AgentSkill {
    return {
      id: skill.id,
      agentId: skill.agentId,
      name: skill.name,
      description: skill.description,
      type: skill.type as AgentSkill['type'],
      toolNames: this.parseToolNames(skill.toolNames),
      isActive: skill.isActive,
      content,
      sourceType: skill.sourceType as AgentSkill['sourceType'],
      sourceLocator: skill.sourceLocator,
      sourceRef: skill.sourceRef,
      rootPath: this.resolveRootPath(skill),
      fileInventory: this.parseInventory(skill.fileInventory),
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString(),
    };
  }

  async list(agentId: string): Promise<AgentSkill[]> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const skills = await prisma.agentSkill.findMany({
      where: { agentId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    return Promise.all(skills.map(async (skill) => this.toRecord(skill, await this.readContentByRoot(skillsDir, this.resolveRootPath(skill), skill.name))));
  }

  async get(agentId: string, name: string): Promise<AgentSkill | null> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const skill = await prisma.agentSkill.findUnique({
      where: { agentId_name: { agentId, name } },
    });
    if (!skill) return null;
    return this.toRecord(skill, await this.readContentByRoot(skillsDir, this.resolveRootPath(skill), skill.name));
  }

  async create(
    agentId: string,
    input: CreateSkillInput & { files?: Array<{ path: string; content: string }>; rootPath?: string },
  ): Promise<AgentSkill> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const parsed = CreateSkillSchema.parse(input);
    const existing = await prisma.agentSkill.findUnique({
      where: { agentId_name: { agentId, name: parsed.name } },
    });
    if (existing) throw new Error(`Skill "${parsed.name}" already exists for this agent.`);

    const rootPath = (input.rootPath?.trim() || parsed.name).replace(/^\/+|\/+$/g, '');
    await mkdir(skillsDir, { recursive: true });
    await this.writeInstalledFiles(skillsDir, rootPath, { content: parsed.content, files: input.files });

    const skill = await prisma.agentSkill.create({
      data: {
        agentId,
        name: parsed.name,
        description: parsed.description ?? null,
        type: parsed.type,
        toolNames: parsed.toolNames && parsed.toolNames.length > 0 ? JSON.stringify(parsed.toolNames) : null,
        sourceType: parsed.sourceType ?? 'MANUAL',
        sourceLocator: parsed.sourceLocator ?? null,
        sourceRef: parsed.sourceRef ?? null,
        rootPath,
        fileInventory: this.serializeInventory(parsed.fileInventory),
        isActive: true,
      },
    });

    if (parsed.type === 'PASSIVE') staticPrefixCache.invalidate(agentId);
    return this.toRecord(skill, parsed.content);
  }

  async update(
    agentId: string,
    name: string,
    input: UpdateSkillInput & { files?: Array<{ path: string; content: string }>; rootPath?: string },
  ): Promise<AgentSkill> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const parsed = UpdateSkillSchema.parse(input);
    const existing = await prisma.agentSkill.findUnique({
      where: { agentId_name: { agentId, name } },
    });
    if (!existing) throw new Error(`Skill "${name}" not found.`);

    const rootPath = (input.rootPath?.trim() || this.resolveRootPath(existing)).replace(/^\/+|\/+$/g, '');
    const currentContent = await this.readContentByRoot(skillsDir, this.resolveRootPath(existing), name);
    if (parsed.content !== undefined || input.files !== undefined || rootPath !== this.resolveRootPath(existing)) {
      await this.writeInstalledFiles(skillsDir, rootPath, {
        content: parsed.content ?? currentContent,
        files: input.files,
      });
      if (rootPath !== this.resolveRootPath(existing)) {
        await rm(path.join(skillsDir, this.resolveRootPath(existing)), { recursive: true, force: true });
        try {
          await unlink(path.join(skillsDir, `${name}.md`));
        } catch {
          // Legacy file already absent.
        }
      }
    }

    const updated = await prisma.agentSkill.update({
      where: { agentId_name: { agentId, name } },
      data: {
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.type !== undefined ? { type: parsed.type } : {}),
        ...(parsed.toolNames !== undefined ? { toolNames: parsed.toolNames.length > 0 ? JSON.stringify(parsed.toolNames) : null } : {}),
        ...(parsed.sourceType !== undefined ? { sourceType: parsed.sourceType } : {}),
        ...(parsed.sourceLocator !== undefined ? { sourceLocator: parsed.sourceLocator || null } : {}),
        ...(parsed.sourceRef !== undefined ? { sourceRef: parsed.sourceRef || null } : {}),
        ...(parsed.fileInventory !== undefined ? { fileInventory: this.serializeInventory(parsed.fileInventory) } : {}),
        ...(input.rootPath !== undefined ? { rootPath } : {}),
        ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {}),
      },
    });

    if (updated.type === 'PASSIVE' || existing.type === 'PASSIVE') staticPrefixCache.invalidate(agentId);
    return this.toRecord(updated, parsed.content ?? await this.readContentByRoot(skillsDir, this.resolveRootPath(updated), name));
  }

  async upsert(
    agentId: string,
    input: CreateSkillInput & { files?: Array<{ path: string; content: string }>; rootPath?: string },
  ): Promise<{ skill: AgentSkill; action: 'installed' | 'updated' }> {
    const existing = await this.get(agentId, input.name);
    if (existing) {
      const skill = await this.update(agentId, input.name, {
        content: input.content,
        type: input.type,
        description: input.description,
        toolNames: input.toolNames,
        sourceType: input.sourceType,
        sourceLocator: input.sourceLocator,
        sourceRef: input.sourceRef,
        fileInventory: input.fileInventory,
        files: input.files,
        rootPath: input.rootPath,
      });
      return { skill, action: 'updated' };
    }

    const skill = await this.create(agentId, input);
    return { skill, action: 'installed' };
  }

  async delete(agentId: string, name: string): Promise<void> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const existing = await prisma.agentSkill.findUnique({
      where: { agentId_name: { agentId, name } },
    });
    if (!existing) throw new Error(`Skill "${name}" not found.`);

    await prisma.agentSkill.delete({ where: { agentId_name: { agentId, name } } });
    await rm(path.join(skillsDir, this.resolveRootPath(existing)), { recursive: true, force: true });
    try {
      await unlink(path.join(skillsDir, `${name}.md`));
    } catch {
      // Legacy file already absent.
    }

    if (existing.type === 'PASSIVE') staticPrefixCache.invalidate(agentId);
  }

  async getPassiveContent(agentId: string): Promise<Array<{ name: string; content: string }>> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const passiveSkills = await prisma.agentSkill.findMany({
      where: { agentId, type: 'PASSIVE', isActive: true },
      orderBy: { name: 'asc' },
    });

    const results: Array<{ name: string; content: string }> = [];
    for (const skill of passiveSkills) {
      const content = await this.readContentByRoot(skillsDir, this.resolveRootPath(skill), skill.name);
      if (content.trim()) results.push({ name: `skill:${skill.name}`, content });
    }
    return results;
  }

  async readSkillFiles(agentId: string, name: string): Promise<Array<{ path: string; content: string }>> {
    const skillsDir = await this.resolveSkillsDir(agentId);
    const skill = await prisma.agentSkill.findUnique({ where: { agentId_name: { agentId, name } } });
    if (!skill) throw new Error(`Skill "${name}" not found.`);

    const inventory = this.parseInventory(skill.fileInventory);
    const rootPath = path.join(skillsDir, this.resolveRootPath(skill));
    const files: Array<{ path: string; content: string }> = [];
    for (const entry of inventory) {
      const absolute = path.join(rootPath, entry.path);
      const content = await readFile(absolute, 'utf8').catch(() => '');
      if (content) files.push({ path: entry.path, content });
    }
    return files;
  }
}

export const skillService = new SkillService();
