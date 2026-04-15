/**
 * @nextgenchat/types — Shared Type Definitions & Zod Schemas
 *
 * This is the single source of truth for ALL API contracts, socket event types,
 * and data transfer objects used across backend, web, and mobile apps.
 *
 * Rules:
 * - Every API request/response body has a Zod schema here.
 * - TypeScript types are INFERRED from Zod schemas (never manually duplicated).
 * - Socket event contracts are defined as discriminated unions.
 * - Both backend and frontend import from this package — never redefine types locally.
 */

export * from './auth.js';
export * from './chat.js';
export * from './agents.js';
export * from './providers.js';
export * from './providers-admin.js';
export * from './context.js';
export * from './workspace.js';
export * from './socket-events.js';
