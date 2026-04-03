/**
 * Environment Variable Validation
 *
 * Phase 1 implementation status:
 * - This file now validates the local-first configuration required for the first
 *   working backend slice: Fastify, Prisma, Redis/BullMQ, auth cookies, and OpenAI.
 * - Future phases will extend this schema with shared-mode email, storage, and
 *   advanced provider credentials without removing this foundation.
 *
 * Uses Zod to validate ALL required env vars on startup.
 * If any required variable is missing or invalid, the server
 * refuses to start with a clear error message.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_MODE: z.enum(['local', 'network']).default('local'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(16),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
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
  isDevelopment: baseEnv.NODE_ENV === 'development',
  isProduction: baseEnv.NODE_ENV === 'production',
  isLocalMode: baseEnv.DEPLOYMENT_MODE === 'local',
  corsOrigins: baseEnv.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

export type Env = typeof env;
