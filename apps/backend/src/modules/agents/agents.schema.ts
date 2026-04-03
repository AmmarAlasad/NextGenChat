/**
 * Agent Schema Re-exports
 *
 * Re-exports Zod schemas from @nextgenchat/types for route validation.
 * Single source of truth is packages/types — never redefine here.
 */

export {
  CreateAgentSchema,
  UpdateAgentSchema,
  AgentMemoryEntrySchema,
  AgentToolSchema,
  AgentCronSchema,
  AgentStatus,
  AgentTriggerMode,
  MemoryScope,
  type CreateAgentInput,
  type UpdateAgentInput,
  type AgentMemoryEntry,
  type AgentToolInput,
  type AgentCronInput,
} from '@nextgenchat/types';
