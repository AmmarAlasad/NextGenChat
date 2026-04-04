/**
 * Agent Workspace Tools Service
 *
 * Implements the first workspace-native file tools that every agent gets by
 * default: read_file and apply_patch. These tools currently operate on files
 * stored in the agent workspace layer and are kept separate from the lightweight
 * doc-writing assistant bubble used by the admin UI.
 */

import { prisma } from '@/db/client.js';

interface ReadFileInput {
  agentId: string;
  fileName: string;
}

interface ApplyPatchInput {
  agentId: string;
  fileName: string;
  patchText: string;
}

function parsePatchText(patchText: string) {
  const match = patchText.match(/=== SEARCH ===\n([\s\S]*?)\n=== REPLACE ===\n([\s\S]*)$/);

  if (!match) {
    throw new Error('Patch format is invalid. Use === SEARCH === and === REPLACE === blocks.');
  }

  return {
    search: match[1],
    replace: match[2],
  };
}

export class AgentWorkspaceToolsService {
  async readFile(input: ReadFileInput) {
    const file = await prisma.workspaceFile.findFirst({
      where: {
        agentId: input.agentId,
        fileName: input.fileName,
      },
      select: {
        fileName: true,
        content: true,
        version: true,
        updatedAt: true,
      },
    });

    if (!file) {
      throw new Error('Workspace file not found.');
    }

    return {
      fileName: file.fileName,
      content: file.content ?? '',
      version: file.version,
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async applyPatch(input: ApplyPatchInput) {
    const file = await prisma.workspaceFile.findFirst({
      where: {
        agentId: input.agentId,
        fileName: input.fileName,
      },
      select: {
        id: true,
        key: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        content: true,
        version: true,
      },
    });

    if (!file) {
      throw new Error('Workspace file not found.');
    }

    const currentContent = String(file.content ?? '');
    const { search, replace } = parsePatchText(input.patchText);

    if (!currentContent.includes(search)) {
      throw new Error('Patch search block was not found in the target file.');
    }

    const nextContent = currentContent.replace(search, replace);

    await prisma.$transaction(async (tx) => {
      await tx.workspaceFileVersion.create({
        data: {
          fileId: file.id,
          key: `${file.key}.v${file.version}`,
          fileSize: file.fileSize,
          mimeType: file.mimeType,
          content: file.content,
          version: file.version,
        },
      });

      await tx.workspaceFile.update({
        where: { id: file.id },
        data: {
          content: nextContent,
          fileSize: Buffer.byteLength(nextContent, 'utf8'),
          version: file.version + 1,
        },
      });
    });

    return {
      fileName: file.fileName,
      content: nextContent,
      version: file.version + 1,
    };
  }
}

export const agentWorkspaceToolsService = new AgentWorkspaceToolsService();
