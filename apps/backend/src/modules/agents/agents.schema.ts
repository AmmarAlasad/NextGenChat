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
  AgentBrowserMcpStateSchema,
  AgentCronSchema,
  AgentStatus,
  AgentTriggerMode,
  MemoryScope,
  UpdateAgentScheduleSchema,
  UpdateAgentBrowserMcpSchema,
  type CreateAgentInput,
  type UpdateAgentInput,
  type AgentBrowserMcpState,
  type AgentMemoryEntry,
  type UpdateAgentScheduleInput,
  type AgentToolInput,
  type AgentCronInput,
  type UpdateAgentBrowserMcpInput,
} from '@nextgenchat/types';
