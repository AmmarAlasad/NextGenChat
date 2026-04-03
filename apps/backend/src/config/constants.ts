/**
 * Application Constants
 *
 * Phase 1 implementation status:
 * - This file now centralizes the constants used by the first functional milestone.
 * - Current scope covers auth timing, cookie names, queue names, socket namespaces,
 *   and the default local workspace/channel/agent setup.
 * - Future phases should extend this file additively as more subsystems become real.
 */

export const APP_VERSION = '0.1.0';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 15;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
export const REFRESH_COOKIE_NAME = 'ngc_refresh_token';

export const SOCKET_NAMESPACES = {
  chat: '/chat',
  presence: '/presence',
} as const;

export const QUEUE_NAMES = {
  agentProcess: 'agent-process',
} as const;

export const DEFAULT_WORKSPACE_NAME = 'NextGenChat Workspace';
export const DEFAULT_WORKSPACE_SLUG = 'nextgenchat-workspace';
export const DEFAULT_CHANNEL_NAME = 'general';

export const SETUP_COMPLETE_KEY = 'SETUP_COMPLETE';
export const DEFAULT_AGENT_MODEL = 'gpt-4o-mini';
export const AGENT_RESPONSE_CHUNK_DELAY_MS = 16;
