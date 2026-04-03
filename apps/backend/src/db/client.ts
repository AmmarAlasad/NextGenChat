/**
 * Prisma Client Singleton
 *
 * Phase 1 implementation status:
 * - This file now provides the shared Prisma client used by auth, chat, agent,
 *   provider, and worker flows in the first local-only milestone.
 * - Future phases will keep using this singleton as more modules become active.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
