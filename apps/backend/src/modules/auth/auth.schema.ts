/**
 * Auth Schema Re-exports
 *
 * Re-exports Zod schemas from @nextgenchat/types for use in route validation.
 * DO NOT redefine schemas here — single source of truth is packages/types.
 *
 * This file exists so route handlers can import from a module-local path
 * while the actual schemas live in the shared types package.
 */

export {
  SetupSchema,
  RegisterSchema,
  LoginSchema,
  AuthUserSchema,
  HealthStatusSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  JwtPayloadSchema,
  type SetupInput,
  type RegisterInput,
  type LoginInput,
  type AuthUser,
  type HealthStatus,
  type ForgotPasswordInput,
  type ResetPasswordInput,
  type JwtPayload,
  type AuthTokens,
} from '@nextgenchat/types';
