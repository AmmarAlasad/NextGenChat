/**
 * Workspace & File Routes — Fastify Route Registration
 *
 * Manages agent private workspaces + shared group workspace:
 *
 * Agent Private Workspace (S3: workspaces/agents/{agentId}/):
 * - GET    /agents/:id/workspace/files        — List files
 * - POST   /agents/:id/workspace/files        — Upload file (admin)
 * - DELETE /agents/:id/workspace/files/:key   — Delete file
 *
 * Shared Group Workspace (S3: workspaces/shared/{workspaceId}/):
 * - GET    /workspaces/:id/files              — List shared files (all members)
 * - POST   /workspaces/:id/files              — Upload to shared workspace
 * - DELETE /workspaces/:id/files/:key         — Delete (admin or file owner)
 *
 * File Versioning:
 * - GET    /workspaces/:id/files/:key/versions — List previous versions
 * - POST   /workspaces/:id/files/:key/restore/:versionId — Restore old version
 *
 * Agent Doc Files (Agent.md, identity.md, memory.md, Heartbeat.md):
 * - GET    /agents/:id/docs/:docType          — Read doc file
 * - PUT    /agents/:id/docs/:docType          — Update doc file
 *
 * All file access goes through backend with auth check.
 * Never serve direct S3/MinIO URLs to clients.
 */

// TODO: Implement route registrations
export {};
