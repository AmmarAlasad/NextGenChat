/**
 * MCP Integration Routes — Fastify Route Registration
 *
 * Manages Model Context Protocol server lifecycle:
 * - POST   /workspaces/:id/mcp-servers         — Register MCP server (admin)
 * - GET    /workspaces/:id/mcp-servers         — List registered servers
 * - POST   /mcp-servers/:id/start              — Start server subprocess
 * - POST   /mcp-servers/:id/stop               — Stop server subprocess
 * - POST   /mcp-servers/:id/restart            — Restart server
 * - GET    /mcp-servers/:id/status             — Health status
 * - GET    /mcp-servers/:id/tools              — Discovered tools list
 * - DELETE /mcp-servers/:id                    — Unregister server
 *
 * MCP servers are workspace-scoped (not global).
 * Each server's tools must be individually approved per agent.
 */

// TODO: Implement route registrations
export {};
