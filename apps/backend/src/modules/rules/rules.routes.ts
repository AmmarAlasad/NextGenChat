/**
 * Rules Engine Routes — Fastify Route Registration
 *
 * Endpoints for policy rule management:
 * - POST   /workspaces/:id/rules     — Create rule (admin only)
 * - GET    /workspaces/:id/rules     — List rules (priority order)
 * - PATCH  /rules/:id                — Update rule
 * - DELETE /rules/:id                — Deactivate (never hard-delete for audit)
 *
 * Approval Workflow:
 * - GET    /workspaces/:id/approvals — List pending approvals
 * - POST   /approvals/:id/approve    — Approve paused tool call
 * - POST   /approvals/:id/deny       — Deny paused tool call
 *
 * Audit Log:
 * - GET    /workspaces/:id/audit-log — Paginated audit log (admin only)
 *
 * Rules are attached to TOOLS, not agents. A rule like
 * "block file_write to /protected/*" applies to any agent calling that tool.
 */

// TODO: Implement route registrations
export {};
