/**
 * Workspace & File Management Types
 *
 * Defines contracts for:
 * - Agent private workspaces stored on disk under a per-agent folder
 * - Shared group workspace documents managed by the backend
 * - File upload / download / delete
 * - File versioning (overwrite archives previous version)
 * - Agent doc files: agent.md, soul.md, identity.md, user.md, memory.md, heartbeat.md
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
  'soul.md',
  'agency.md',
  'memory.md',
  'Heartbeat.md',
  'user.md',
  'wakeup.md',
]);
export type AgentDocType = z.infer<typeof AgentDocType>;

// ── Projects ───────────────────────────────────────────

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2_000).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2_000).optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const ProjectSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectFileRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  fileName: z.string(),
  relativePath: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int().nonnegative(),
  updatedAt: z.string(),
  downloadPath: z.string(),
  editable: z.boolean(),
});
export type ProjectFileRecord = z.infer<typeof ProjectFileRecordSchema>;

export const UploadProjectFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  contentBase64: z.string().min(1),
});
export type UploadProjectFileInput = z.infer<typeof UploadProjectFileSchema>;

export const ProjectTicketStatusSchema = z.enum(['TODO', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'CANCELLED']);
export type ProjectTicketStatus = z.infer<typeof ProjectTicketStatusSchema>;

export const ProjectTicketAssignmentModeSchema = z.enum(['MANUAL', 'AUTO']);
export type ProjectTicketAssignmentMode = z.infer<typeof ProjectTicketAssignmentModeSchema>;

export const ProjectTicketRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: ProjectTicketStatusSchema,
  assignedAgentId: z.string().uuid().nullable(),
  assignedAgentName: z.string().nullable(),
  createdByUserId: z.string().uuid(),
  createdByUsername: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type ProjectTicketRecord = z.infer<typeof ProjectTicketRecordSchema>;

export const CreateProjectTicketSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8_000).optional(),
  assignmentMode: ProjectTicketAssignmentModeSchema.default('MANUAL'),
  assignedAgentId: z.string().uuid().optional(),
});
export type CreateProjectTicketInput = z.infer<typeof CreateProjectTicketSchema>;

export const UpdateProjectTicketSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(8_000).nullable().optional(),
  status: ProjectTicketStatusSchema.optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
  channelMessage: z.string().max(8_000).optional(),
}).refine((value) => value.title !== undefined || value.description !== undefined || value.status !== undefined || value.assignedAgentId !== undefined, {
  message: 'At least one ticket field must be provided.',
});
export type UpdateProjectTicketInput = z.infer<typeof UpdateProjectTicketSchema>;

// Workspace-level (shared) document — not tied to a specific agent.
export const WorkspaceDocRecordSchema = z.object({
  fileName: z.string(),
  content: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceDocRecord = z.infer<typeof WorkspaceDocRecordSchema>;

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

// ── Agent Creator ──────────────────────────────────────

export const AgentCreatorChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type AgentCreatorChatMessage = z.infer<typeof AgentCreatorChatMessageSchema>;

export const AgentCreatorChatInputSchema = z.object({
  message: z.string().min(1).max(4_000),
  history: z.array(AgentCreatorChatMessageSchema).max(40).default([]),
});
export type AgentCreatorChatInput = z.infer<typeof AgentCreatorChatInputSchema>;

export const AgentCreatorFileUpdateSchema = z.object({
  docType: AgentDocType,
  content: z.string(),
});
export type AgentCreatorFileUpdate = z.infer<typeof AgentCreatorFileUpdateSchema>;

export const AgentCreatorSkillInstallSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  description: z.string().max(1024).optional(),
  type: z.enum(['PASSIVE', 'ON_DEMAND', 'TOOL_BASED']),
  toolNames: z.array(z.string()).optional(),
  content: z.string().min(1),
});
export type AgentCreatorSkillInstall = z.infer<typeof AgentCreatorSkillInstallSchema>;

export const AgentCreatorChatResponseSchema = z.object({
  reply: z.string(),
  fileUpdates: z.array(AgentCreatorFileUpdateSchema),
  skillInstalls: z.array(AgentCreatorSkillInstallSchema).optional(),
});
export type AgentCreatorChatResponse = z.infer<typeof AgentCreatorChatResponseSchema>;
