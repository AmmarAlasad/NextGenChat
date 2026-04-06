/**
 * Wakeup LLM Service
 *
 * Implements the lightweight pickup-LLM pre-filter for WAKEUP-mode agents.
 * Before a full agent turn is scheduled, this service runs a cheap gpt-4o-mini
 * call using the agent's wakeup.md as the system prompt. It returns YES or NO.
 * Only agents that return YES are enqueued for a full LLM turn.
 *
 * Phase 5 implementation status:
 * - shouldRespond(): reads wakeup.md, formats last N messages, calls gpt-4o-mini.
 * - Defaults to NO on any error (silence over noise).
 * - Called in parallel for all WAKEUP agents by agent-routing.service.ts.
 * - Future phases: caching wakeup.md reads, per-agent model override.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import OpenAI from 'openai';

import { env } from '@/config/env.js';

const WAKEUP_MODEL = 'gpt-4o-mini';
const WAKEUP_MAX_TOKENS = 10;
const WAKEUP_CONTEXT_MESSAGES = 8;

interface RecentMessage {
  senderName: string;
  senderType: 'USER' | 'AGENT';
  content: string;
}

class WakeupLLMService {
  private client: OpenAI | null = null;

  private getClient(): OpenAI | null {
    if (!env.OPENAI_API_KEY) return null;
    if (!this.client) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
    return this.client;
  }

  private async readWakeupMd(agentId: string): Promise<string | null> {
    const filePath = path.join(env.agentWorkspacesDir, agentId, 'wakeup.md');
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Ask the wakeup LLM whether this agent should respond to the latest message.
   * Returns true (YES) or false (NO). Defaults to false on any error.
   */
  async shouldRespond(input: {
    agentId: string;
    agentName: string;
    recentMessages: RecentMessage[];
    hasRepliedRecently: boolean;
  }): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;

    const wakeupContent = await this.readWakeupMd(input.agentId);
    if (!wakeupContent) return false;

    const recent = input.recentMessages.slice(-WAKEUP_CONTEXT_MESSAGES);

    const transcript = recent
      .map((m) => `${m.senderName}: ${m.content.slice(0, 300)}`)
      .join('\n');

    const userPrompt = [
      'Recent conversation:',
      transcript,
      '',
      `Has ${input.agentName} replied in the last few messages? ${input.hasRepliedRecently ? 'Yes' : 'No'}`,
      '',
      `Should ${input.agentName} respond to the latest message? Answer YES or NO only.`,
    ].join('\n');

    try {
      const response = await client.chat.completions.create({
        model: WAKEUP_MODEL,
        messages: [
          { role: 'system', content: wakeupContent },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: WAKEUP_MAX_TOKENS,
        temperature: 0,
      });

      const answer = (response.choices[0]?.message?.content ?? '').trim().toUpperCase();
      return answer.startsWith('YES');
    } catch (err) {
      console.warn(`[wakeup] LLM call failed for agent ${input.agentName}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}

export const wakeupLLMService = new WakeupLLMService();
