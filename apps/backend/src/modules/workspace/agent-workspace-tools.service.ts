/**
 * Agent Workspace Tools Service
 *
 * Implements the first workspace-native file tools that every agent gets by
 * default: read_file and apply_patch. These tools now operate directly on the
 * per-agent workspace folder on disk and stay separate from the admin UI.
 */

import { workspaceService } from '@/modules/workspace/workspace.service.js';

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
    return workspaceService.readAgentWorkspaceFile(input.agentId, input.fileName);
  }

  async applyPatch(input: ApplyPatchInput) {
    const file = await workspaceService.readAgentWorkspaceFile(input.agentId, input.fileName);
    const currentContent = file.content;
    const { search, replace } = parsePatchText(input.patchText);

    if (!currentContent.includes(search)) {
      throw new Error('Patch search block was not found in the target file.');
    }

    const nextContent = currentContent.replace(search, replace);

    return workspaceService.writeAgentWorkspaceFile(input.agentId, input.fileName, nextContent);
  }
}

export const agentWorkspaceToolsService = new AgentWorkspaceToolsService();
