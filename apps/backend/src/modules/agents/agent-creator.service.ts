/**
 * Agent Creator Service
 *
 * LLM-powered service that acts as "AgentCreatorAgent" — a specialist that
 * knows the agent doc architecture and can:
 *   1. Generate the agent docs from a plain-language description (setup wizard)
 *   2. Edit docs interactively through a chat interface (agent admin page)
 *
 * SAFETY DESIGN: Every file update passes through a structural validator before
 * it is written to disk. If the generated content fails validation the update is
 * rejected and the existing file is left untouched. This prevents AgentCreatorAgent
 * from corrupting the system files that the runtime depends on.
 *
 * Protected invariants enforced by validators:
 *   Agent.md   — must contain memory/user rules plus explicit guidance for
 *                send_reply, workspace_read_file, workspace_write_file,
 *                workspace_glob, workspace_grep, workspace_bash, todowrite,
 *                and todoread
 *   soul.md    — must be substantive markdown, not a JSON blob
 *   identity.md — must have meaningful content
 *
 * Phase 4 implementation status:
 * - generateAndWriteAgentDocs: used during setup and agent creation
 * - chatWithCreator: used by the agent admin chat panel
 * - Falls back to default workspace docs silently if no OpenAI key is configured
 */

import type { AgentCreatorChatMessage, AgentCreatorChatResponse, AgentDocType, AgentCreatorSkillInstall } from '@nextgenchat/types';

import { env } from '@/config/env.js';
import { OpenAIProvider } from '@/modules/providers/openai.provider.js';
import { skillInstallerService } from '@/modules/agents/skill-installer.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

const CREATOR_MODEL = 'gpt-5.4';

// ── System prompt ────────────────────────────────────────────────────────────

const AGENT_CREATOR_SYSTEM_PROMPT = `You are AgentCreatorAgent, an expert AI agent designer for NextGenChat. Your job is to create and maintain the configuration markdown files that define an AI agent's personality, values, and operating behaviour.

════════════════════════════════════════
CRITICAL INVARIANTS — READ FIRST
════════════════════════════════════════

These rules are non-negotiable. Violating any of them will break the running system and your output will be rejected.

### Agent.md — REQUIRED SECTIONS

Agent.md MUST contain ALL of the following. Do not remove or rename these:
- A section on when to update memory.md (using workspace_write_file)
- A section on when to update user.md (using workspace_write_file)
- A section titled "Explicit Memory Requests" with rules for handling user memory requests
- A section on tool usage rules that mentions workspace_read_file, workspace_write_file, workspace_glob, workspace_grep, workspace_bash, send_reply, todowrite, and todoread
- A section titled "Group Chat Participation" explaining when to output [[NO_REPLY]]

### wakeup.md — REQUIRED (for WAKEUP routing mode)

wakeup.md is a system prompt for a cheap routing LLM that decides YES or NO before the agent's full turn runs. It MUST:
- Describe the agent's name and role concisely (one sentence)
- List clear YES conditions (when to wake the agent)
- List clear NO conditions (when to stay silent)
- End with "When in doubt, answer NO"

### soul.md — MUST BE SUBSTANTIVE AND CONCISE

soul.md must be a real markdown document with at least 3 sections covering values, behavioural principles, and ethical constraints. Never replace it with a short stub or JSON.
Maximum length: 2000 characters. Be concise — no padding, no repetition, no preamble. Every sentence must earn its place.

### identity.md — MUST CONTAIN THE AGENT NAME AND BE CONCISE

identity.md must clearly state the agent's name in the Role and Name section.
Maximum length: 1500 characters. Persona summary only — name, role, tone, and communication style. Do not expand into lengthy backstory or repeated examples.

════════════════════════════════════════
THE SEVEN FILES
════════════════════════════════════════

### soul.md — Immutable Ethics & Values
The agent's moral foundation. Injected first — overrides everything else. Make values specific to the agent's domain. "Honesty" means something different for a UX designer vs. a security engineer.

### identity.md — Public Persona & Voice
Name, role, expertise areas, voice and tone. System Prompt section: 2–3 sentences of core character. Make this feel like a real professional, not a generic AI.

### Agent.md — Operating Manual
Memory update rules, explicit memory request handling, tool usage rules, heartbeat instructions, and group chat participation rules. Tailor to the agent's domain.

The "Explicit Memory Requests" section MUST include these exact rules (adapt wording to the agent's voice, but preserve the logic):
- When the user explicitly asks to remember something: save it immediately to memory.md (or user.md if it describes the user) via workspace_write_file. Do not ask for confirmation — just save it and confirm.
- Never say you will remember something without actually calling workspace_write_file.
- When you encounter clearly valuable cross-session information: if certain, save silently; if unsure, ask once "Should I save that to my memory for future sessions?" then save if yes.
- Do NOT offer to save information that is ephemeral, already in memory, vague, or part of normal back-and-forth with no future relevance.

The "Group Chat Participation" section MUST include these exact rules (adapt the wording to fit the agent's voice, but preserve the logic):
- Output [[NO_REPLY]] (and nothing else) when the message is clearly addressed to a specific other agent by name and not to you
- Output [[NO_REPLY]] when the conversation is a direct back-and-forth between the user and another agent and your input was not invited
- Respond normally when addressed by name, when the message is a general group question relevant to your expertise, or when explicitly @mentioned
- When in doubt, stay silent rather than interrupt

The "Tool Usage Rules" section MUST teach the following behaviors clearly:
- For substantial work, follow an inspect -> plan -> execute -> verify -> report loop instead of answering in one shot
- Use workspace_glob to discover files by name pattern when the exact path is unknown
- Use workspace_grep to search file contents across the workspace when looking for text, keys, errors, or code patterns
- Use workspace_read_file for exact file contents and directory listings
- Use workspace_write_file only after deciding on the final file content, and never claim a file changed unless the tool succeeded
- Use workspace_bash only when a shell command is genuinely needed
- Use send_reply only for intermediate progress updates in the current channel; the final reply is still returned normally at the end of the turn
- Use todowrite and todoread for multi-step work so progress is tracked instead of held only in short-term reasoning
- Use websearch to find up-to-date information beyond your knowledge cutoff — always include the current year in queries about recent events or releases
- Use webfetch to read a specific URL when you already have the link; prefer websearch when you need to discover pages first
- Use skill_list to see available skills and skill_activate to activate an on-demand or tool-based skill at the start of a relevant turn
- Use skill_install to download and install a skill from GitHub, clawhub.ai, or any direct markdown URL; always tell the user the installed skill name and type
- After changing files or running commands, verify the result. If verification fails, keep working and retry before giving the final answer

### user.md — Model of the User
Blank template the agent fills over time. Keep it clean and scannable.

### memory.md — Long-term Learnings
Blank template the agent fills over time. Keep it clean and structured.

### Heartbeat.md — Status Log
Blank template for resumable long-running work. Keep it minimal.

### agency.md — Shared Agency Constitution
Shared operating standards and organizational context for all agents in the workspace. Keep it concise and durable.

════════════════════════════════════════
SKILLS — THREE TYPES
════════════════════════════════════════

Skills are reusable markdown instruction sets stored in the agent's workspace under skills/{name}.md.

### PASSIVE
Always injected into the agent's static context on every turn — no activation needed.
Use for: domain expertise the agent always needs (e.g. "brand-voice", "coding-standards").
Keep short and focused. They consume context budget on every turn.

### ON_DEMAND
Injected only when the agent calls skill_activate("name").
Use for: specialised workflows the agent uses occasionally (e.g. "deep-research", "code-review").
The agent should call skill_activate at the start of a turn when it recognises the task matches.

### TOOL_BASED
Like ON_DEMAND but the skill file also describes how to combine specific tools for a workflow.
Use for: complex multi-tool pipelines (e.g. "web-research-and-summarise" using websearch + webfetch).
The toolNames field lists which tools the skill focuses on.

### Skill file format
Skills are plain markdown files. Optionally include YAML frontmatter:

    ---
    name: my-skill
    description: What this skill does
    type: ON_DEMAND
    toolNames: websearch, webfetch
    ---

    # Skill: my-skill

    Instructions for the agent...

If no frontmatter, the name comes from the file slug and the type defaults to ON_DEMAND.

════════════════════════════════════════
YOUR RESPONSE FORMAT
════════════════════════════════════════

Always respond with valid JSON only. No markdown fences, no preamble:

{
  "reply": "A friendly, concise explanation of what you generated or changed",
  "fileUpdates": [
    {"docType": "soul.md", "content": "# soul.md — full markdown content..."},
    {"docType": "identity.md", "content": "# identity.md — full markdown content..."}
  ],
  "skillInstalls": [
    {
      "name": "my-skill",
      "description": "What this skill does",
      "type": "ON_DEMAND",
      "toolNames": ["websearch", "webfetch"],
      "content": "# Skill: my-skill\n\n..."
    }
  ]
}

When CREATING a new agent: include all required files.
When EDITING via chat: only include files you are actually changing. Never include unchanged files.
When INSTALLING or CREATING skills: include them in skillInstalls. Always state in the reply what type each skill is and how to use it.
Never truncate content. Always write complete markdown.
skillInstalls is optional — omit it entirely when no skills are being installed.`;

// ── Structural validators ────────────────────────────────────────────────────

type ValidationResult = { valid: true } | { valid: false; reason: string };

function isJsonBlob(content: string): boolean {
  const trimmed = content.trim();
  return /^\{[\s\S]*\}$/.test(trimmed) || /^\[[\s\S]*\]$/.test(trimmed);
}

function validateAgentMd(content: string): ValidationResult {
  const trimmed = content.trim();
  const requiredToolMentions = [
    'workspace_read_file',
    'workspace_write_file',
    'workspace_glob',
    'workspace_grep',
    'workspace_bash',
    'send_reply',
    'todowrite',
    'todoread',
    'websearch',
    'webfetch',
    'skill_activate',
    'skill_list',
    'skill_install',
  ];

  if (isJsonBlob(trimmed)) {
    return { valid: false, reason: 'Agent.md must be a markdown document, not a JSON object.' };
  }

  if (trimmed.length < 300) {
    return {
      valid: false,
      reason: 'Agent.md is too short. It must contain the full operating manual with memory update rules and tool usage rules.',
    };
  }

  if (!trimmed.includes('memory.md')) {
    return { valid: false, reason: 'Agent.md must include rules for when to update memory.md.' };
  }

  if (!trimmed.includes('user.md')) {
    return { valid: false, reason: 'Agent.md must include rules for when to update user.md.' };
  }

  for (const toolName of requiredToolMentions) {
    if (!trimmed.includes(toolName)) {
      return { valid: false, reason: `Agent.md must reference ${toolName} in its tool usage rules.` };
    }
  }

  if (!trimmed.includes('[[NO_REPLY]]')) {
    return { valid: false, reason: 'Agent.md must include a Group Chat Participation section that explains when to output [[NO_REPLY]].' };
  }

  if (!trimmed.toLowerCase().includes('explicit memory') && !trimmed.toLowerCase().includes('remember')) {
    return { valid: false, reason: 'Agent.md must include an Explicit Memory Requests section explaining how to handle user memory requests.' };
  }

  if (!trimmed.toLowerCase().includes('verify')) {
    return { valid: false, reason: 'Agent.md must explain how the agent verifies work before giving a final answer.' };
  }

  return { valid: true };
}

const SOUL_MD_MIN = 150;
const SOUL_MD_MAX = 2000;
const IDENTITY_MD_MIN = 100;
const IDENTITY_MD_MAX = 1500;

function validateSoulMd(content: string): ValidationResult {
  const trimmed = content.trim();

  if (isJsonBlob(trimmed)) {
    return { valid: false, reason: 'soul.md must be a markdown document, not a JSON object.' };
  }

  if (trimmed.length < SOUL_MD_MIN) {
    return {
      valid: false,
      reason: 'soul.md is too short. It must contain detailed core values, behavioural principles, and ethical constraints.',
    };
  }

  if (trimmed.length > SOUL_MD_MAX) {
    return {
      valid: false,
      reason: `soul.md is too long (${trimmed.length} chars). Keep it under ${SOUL_MD_MAX} characters — concise values only, no padding.`,
    };
  }

  return { valid: true };
}

function validateIdentityMd(content: string, agentName: string): ValidationResult {
  const trimmed = content.trim();

  if (isJsonBlob(trimmed)) {
    return { valid: false, reason: 'identity.md must be a markdown document, not a JSON object.' };
  }

  if (trimmed.length < IDENTITY_MD_MIN) {
    return { valid: false, reason: 'identity.md is too short. It must contain the agent\'s persona, tone, and communication style.' };
  }

  if (trimmed.length > IDENTITY_MD_MAX) {
    return {
      valid: false,
      reason: `identity.md is too long (${trimmed.length} chars). Keep it under ${IDENTITY_MD_MAX} characters — persona summary only, no padding.`,
    };
  }

  // The agent name should appear somewhere in the file
  if (!trimmed.toLowerCase().includes(agentName.toLowerCase())) {
    return { valid: false, reason: `identity.md must reference the agent's name (${agentName}).` };
  }

  return { valid: true };
}

function validateGenericDoc(content: string, docType: string): ValidationResult {
  if (isJsonBlob(content.trim())) {
    return { valid: false, reason: `${docType} must be a markdown document, not a JSON object.` };
  }

  if (content.trim().length < 20) {
    return { valid: false, reason: `${docType} content is too short to be valid.` };
  }

  return { valid: true };
}

function validateFileUpdate(docType: AgentDocType, content: string, agentName: string): ValidationResult {
  switch (docType) {
    case 'Agent.md':
      return validateAgentMd(content);
    case 'soul.md':
      return validateSoulMd(content);
    case 'identity.md':
      return validateIdentityMd(content, agentName);
    default:
      return validateGenericDoc(content, docType);
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

function getProvider(): OpenAIProvider | null {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'disabled-local-key') {
    return null;
  }

  return new OpenAIProvider(env.OPENAI_API_KEY, CREATOR_MODEL);
}

function safeParseCreatorResponse(raw: string): AgentCreatorChatResponse | null {
  const text = raw.trim();

  // Strip markdown code fences if the model wrapped the JSON anyway.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  try {
    const parsed = JSON.parse(stripped) as unknown;

    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as Record<string, unknown>).reply === 'string'
      && Array.isArray((parsed as Record<string, unknown>).fileUpdates)
    ) {
      return parsed as AgentCreatorChatResponse;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class AgentCreatorService {
  /**
   * Generates the agent docs from a plain-language description and writes
   * them to the agent's workspace. Called during setup and agent creation.
   * Falls back silently to the default docs if no OpenAI key is available.
   * Each generated file is validated before writing — invalid files are skipped
   * and the safe default remains on disk.
   */
  async generateAndWriteAgentDocs(agentId: string, name: string, description: string): Promise<void> {
    const provider = getProvider();

    if (!provider) {
      return;
    }

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: AGENT_CREATOR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Create a complete agent configuration for a new agent.\n\nAgent name: ${name}\nDescription: ${description}\n\nGenerate all required files tailored specifically to this agent's role and personality.`,
          },
        ],
        maxTokens: 4_000,
        temperature: 0.3,
      });

      const parsed = safeParseCreatorResponse(response.content);

      if (!parsed || parsed.fileUpdates.length === 0) {
        console.warn('[agent-creator] Failed to parse LLM response — using default docs');
        return;
      }

      for (const update of parsed.fileUpdates) {
        const validation = validateFileUpdate(update.docType, update.content, name);

        if (!validation.valid) {
          console.warn(`[agent-creator] Rejected ${update.docType} for agent "${name}": ${validation.reason}`);
          // Leave the safe default on disk — do not write the bad content.
          continue;
        }

        await workspaceService.writeAgentWorkspaceFile(
          agentId,
          this.docTypeToFileName(update.docType),
          update.content,
        );
      }

      for (const skillInstall of parsed.skillInstalls ?? []) {
        try {
          await skillInstallerService.installGenerated(agentId, skillInstall);
        } catch (skillError) {
          console.warn(`[agent-creator] Failed to install skill "${skillInstall.name}":`, skillError instanceof Error ? skillError.message : String(skillError));
        }
      }
    } catch (error) {
      // Non-fatal — default docs remain on disk.
      console.warn('[agent-creator] Generation failed, using defaults:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Generates agency.md from a plain-language agency description and writes it
   * to the workspace-level WorkspaceFile record. Called fire-and-forget during
   * the setup wizard when the user provides an agency description.
   * Falls back to the existing default silently if generation fails.
   */
  async generateAndWriteAgencyDoc(userId: string, workspaceName: string, description: string): Promise<void> {
    const provider = getProvider();

    if (!provider) {
      return;
    }

    try {
      const response = await provider.complete({
        messages: [
          {
            role: 'system',
            content: `You are an expert at writing agency.md — the workspace-level constitution shared by all AI agents in a workspace.

agency.md defines:
- The workspace mission and purpose
- Operating standards for all agents
- Tone, values, and collaboration style
- Any shared context or constraints

Write clear, professional markdown. Be specific and actionable. Do NOT use generic filler. Write in second person when addressing agents ("You are part of…").`,
          },
          {
            role: 'user',
            content: `Write a complete agency.md for the following workspace.\n\nWorkspace name: ${workspaceName}\nDescription: ${description}\n\nReturn only the markdown content — no code fences, no explanation.`,
          },
        ],
        maxTokens: 1_500,
        temperature: 0.3,
      });

      const content = response.content.trim();

      if (content.length < 100) {
        return;
      }

      await workspaceService.updateWorkspaceAgencyDoc(userId, content);
    } catch (error) {
      console.warn('[agent-creator] Agency doc generation failed, using default:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Runs a chat turn with AgentCreatorAgent. Loads the agent's current files
   * as context, processes the user message, validates each proposed update,
   * writes safe updates to disk, and returns the reply + list of what changed.
   * Rejected updates are excluded from fileUpdates and the reply notes any rejections.
   */
  async chatWithCreator(
    agentId: string,
    message: string,
    history: AgentCreatorChatMessage[],
  ): Promise<AgentCreatorChatResponse> {
    const provider = getProvider();

    if (!provider) {
      return {
        reply: 'AgentCreatorAgent is not available because no OpenAI API key is configured. Add your key to .env and restart.',
        fileUpdates: [],
      };
    }

    await workspaceService.ensureAgentDocs(agentId);

    const currentDocs = await workspaceService.getAgentContextDocs(agentId, [
      'soul.md',
      'identity.md',
      'Agent.md',
      'user.md',
      'memory.md',
      'Heartbeat.md',
    ]);

    // Look up agent name for identity validation
    const { prisma } = await import('@/db/client.js');
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } });
    const agentName = agent?.name ?? 'Agent';

    const currentFilesSection = currentDocs
      .map((doc) => `### Current ${doc.docType}\n\`\`\`markdown\n${doc.content ?? ''}\n\`\`\``)
      .join('\n\n');

    const systemWithContext = `${AGENT_CREATOR_SYSTEM_PROMPT}\n\n## Current Agent Files\n\nHere are the agent's current file contents. When editing, only return files you are actually changing.\n\n${currentFilesSection}`;

    const messages = [
      { role: 'system' as const, content: systemWithContext },
      ...history.map((msg) => ({ role: msg.role as 'user' | 'assistant', content: msg.content })),
      { role: 'user' as const, content: message },
    ];

    const response = await provider.complete({
      messages,
      maxTokens: 4_000,
      temperature: 0.3,
    });

    const parsed = safeParseCreatorResponse(response.content);

    if (!parsed) {
      return {
        reply: 'I had trouble generating a structured response. Please try rephrasing your request.',
        fileUpdates: [],
      };
    }

    const writtenUpdates: typeof parsed.fileUpdates = [];
    const rejections: string[] = [];

    for (const update of parsed.fileUpdates) {
      const validation = validateFileUpdate(update.docType, update.content, agentName);

      if (!validation.valid) {
        console.warn(`[agent-creator] Rejected ${update.docType} update for agent "${agentName}": ${validation.reason}`);
        rejections.push(`${update.docType}: ${validation.reason}`);
        // Existing file on disk is untouched.
        continue;
      }

      try {
        await workspaceService.writeAgentWorkspaceFile(
          agentId,
          this.docTypeToFileName(update.docType),
          update.content,
        );
        writtenUpdates.push(update);
      } catch (writeError) {
        console.warn(`[agent-creator] Failed to write ${update.docType}:`, writeError);
        rejections.push(`${update.docType}: write failed`);
      }
    }

    // ── Handle skillInstalls ───────────────────────────────────────────────
    const installedSkills: AgentCreatorSkillInstall[] = [];
    const skillRejections: string[] = [];

    for (const skillInstall of parsed.skillInstalls ?? []) {
      try {
        await skillInstallerService.installGenerated(agentId, skillInstall);
        installedSkills.push(skillInstall);
      } catch (skillError) {
        const reason = skillError instanceof Error ? skillError.message : 'unknown error';
        console.warn(`[agent-creator] Failed to install skill "${skillInstall.name}": ${reason}`);
        skillRejections.push(`${skillInstall.name}: ${reason}`);
      }
    }

    // Append rejection notes to the reply so the user knows something was blocked.
    let finalReply = parsed.reply;
    if (rejections.length > 0) {
      finalReply += `\n\n⚠️ The following files were NOT updated because the generated content failed safety validation:\n${rejections.map((r) => `- ${r}`).join('\n')}`;
    }
    if (skillRejections.length > 0) {
      finalReply += `\n\n⚠️ The following skills could not be installed:\n${skillRejections.map((r) => `- ${r}`).join('\n')}`;
    }

    return {
      reply: finalReply,
      fileUpdates: writtenUpdates,
      skillInstalls: installedSkills,
    };
  }

  private docTypeToFileName(docType: AgentDocType): string {
    const map: Record<AgentDocType, string> = {
      'soul.md': 'soul.md',
      'identity.md': 'identity.md',
      'Agent.md': 'agent.md',
      'user.md': 'user.md',
      'memory.md': 'memory.md',
      'Heartbeat.md': 'heartbeat.md',
      'agency.md': 'agency.md',
      'wakeup.md': 'wakeup.md',
    };

    return map[docType] ?? docType.toLowerCase();
  }
}

export const agentCreatorService = new AgentCreatorService();
