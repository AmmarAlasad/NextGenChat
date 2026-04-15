/**
 * Environment Variable Validation
 *
 * Phase 1 implementation status:
 * - This file now validates the local-first configuration required for the first
 *   working backend slice: Fastify, Prisma, optional Redis/BullMQ, auth cookies,
 *   and OpenAI.
 * - Future phases will extend this schema with shared-mode email, storage,
 *   managed infra toggles, and advanced provider credentials.
 *
 * Uses Zod to validate ALL required env vars on startup.
 * If any required variable is missing or invalid, the server
 * refuses to start with a clear error message.
 */

import { z } from 'zod';
import path from 'node:path';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

const defaultAgentWorkspaceDir = path.join(process.env.HOME ?? process.cwd(), '.nextgenchat', 'agent-workspaces');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_MODE: z.enum(['local', 'network']).default('local'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default(''),
  REDIS_ENABLED: booleanish.optional(),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(16),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.4'),
  AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(0).default(24),
  AGENT_WORKSPACES_DIR: z.string().min(1).default(defaultAgentWorkspaceDir),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: z.coerce.boolean().default(false),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin123'),
  MINIO_BUCKET: z.string().default('nextgenchat'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${details}`);
}

const baseEnv = parsedEnv.data;

export const env = {
  ...baseEnv,
  agentMaxToolRounds: baseEnv.AGENT_MAX_TOOL_ROUNDS,
  agentWorkspacesDir: path.resolve(baseEnv.AGENT_WORKSPACES_DIR),
  isDevelopment: baseEnv.NODE_ENV === 'development',
  isProduction: baseEnv.NODE_ENV === 'production',
  isLocalMode: baseEnv.DEPLOYMENT_MODE === 'local',
  redisEnabled:
    baseEnv.REDIS_ENABLED ?? (baseEnv.DEPLOYMENT_MODE === 'network' && baseEnv.REDIS_URL.length > 0),
  corsOrigins: baseEnv.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

export type Env = typeof env;
