/**
 * Workspace Service — File Management Business Logic
 *
 * Handles file operations against S3/MinIO:
 * - listFiles(prefix) — list objects under an S3 prefix
 * - generatePresignedUpload(key, mimeType) — presigned PUT URL (5min expiry)
 * - deleteFile(key) — remove from S3
 * - getVersions(key) — list archived versions
 * - restoreVersion(key, versionId) — copy old version to current
 *
 * File key validation: must match /^workspaces\/[a-z0-9\-\/]+\.[a-z0-9]+$/i
 * MIME type verified server-side via file-type library (magic bytes, not extension).
 * Max workspace size: 1GB per agent (configurable).
 *
 * Agent doc files (Agent.md etc.) are auto-created from templates on agent creation.
 * memory.md auto-syncs when AgentMemory is updated.
 */

// TODO: Implement workspace service
export {};
