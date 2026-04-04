/**
 * Workspace & File Management Types
 *
 * Defines contracts for:
 * - Agent private workspaces (S3 prefix: workspaces/agents/{agentId}/)
 * - Shared group workspace (S3 prefix: workspaces/shared/{workspaceId}/)
 * - File upload / download / delete
 * - File versioning (overwrite archives previous version)
 * - Agent doc files: agent.md, identity.md, agency.md, memory.md, heartbeat.md
 *
 * All file access goes through the backend with auth checks.
 * Never serve direct S3 URLs to clients.
 */

import { z } from 'zod';

// ── File Operations ────────────────────────────────────

export const UploadFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive().max(50 * 1024 * 1024), // 50MB max
});
export type UploadFileInput = z.infer<typeof UploadFileSchema>;

export interface FileInfo {
  key: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: Date;
  uploadedBy: string;
}

export interface FileVersion {
  versionId: string;
  key: string;
  fileSize: number;
  uploadedAt: Date;
}

// ── Agent Doc File Types ───────────────────────────────

export const AgentDocType = z.enum([
  'Agent.md',
  'identity.md',
  'agency.md',
  'memory.md',
  'Heartbeat.md',
]);
export type AgentDocType = z.infer<typeof AgentDocType>;

export const AgentDocRecordSchema = z.object({
  docType: AgentDocType,
  fileName: z.string(),
  content: z.string(),
  updatedAt: z.string(),
});
export type AgentDocRecord = z.infer<typeof AgentDocRecordSchema>;

export const UpdateAgentDocSchema = z.object({
  content: z.string().max(100_000),
});
export type UpdateAgentDocInput = z.infer<typeof UpdateAgentDocSchema>;

export const AgentDocAssistSchema = z.object({
  instruction: z.string().min(1).max(4_000),
  currentContent: z.string().max(100_000),
});
export type AgentDocAssistInput = z.infer<typeof AgentDocAssistSchema>;

export const AgentDocAssistResponseSchema = z.object({
  content: z.string(),
});
export type AgentDocAssistResponse = z.infer<typeof AgentDocAssistResponseSchema>;
