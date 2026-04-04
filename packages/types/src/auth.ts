/**
 * Auth Types & Schemas
 *
 * Phase 1 implementation status:
 * - This file now defines the contracts used by the first working local-only flow.
 * - Current scope includes first-run setup, login, refresh, logout, and current user state.
 * - Future phases will expand this file with invite-only registration, password reset,
 *   email verification, and network-mode auth hardening without replacing these basics.
 *
 * Defines all authentication-related contracts:
 * - Registration (setup wizard in local mode, invite-only in shared mode)
 * - Login / logout / token refresh
 * - JWT payload structure
 * - RBAC roles (workspace-scoped)
 * - Password reset flow
 *
 * All Zod schemas here are used by:
 * - Backend: Fastify route validation (preHandler)
 * - Frontend: React Hook Form validation
 * - Socket.io: handshake auth validation
 */

import { z } from 'zod';

// ── Roles ──────────────────────────────────────────────

export const WorkspaceRole = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const SetupSchema = z
  .object({
    username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
    agentName: z.string().min(1).max(100),
    agentSystemPrompt: z.string().min(1).max(10_000),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type SetupInput = z.infer<typeof SetupSchema>;

// ── Registration ───────────────────────────────────────

export const RegisterSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().optional(), // optional in local mode
  password: z.string().min(8).max(128),
  inviteToken: z.string().optional(),   // required in shared mode
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

// ── Login ──────────────────────────────────────────────

export const LoginSchema = z.object({
  login: z.string().min(1), // accepts email or username
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

// ── JWT Payload ────────────────────────────────────────

export const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),       // userId
  username: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

// ── Token Response ─────────────────────────────────────

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(), // seconds
  user: AuthUserSchema,
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const HealthStatusSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  db: z.enum(['ok', 'error']),
  redis: z.enum(['ok', 'error', 'disabled']),
  setupRequired: z.boolean(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// ── Password Reset ─────────────────────────────────────

export const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
