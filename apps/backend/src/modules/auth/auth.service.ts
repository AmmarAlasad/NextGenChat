/**
 * Auth Service — Business Logic
 *
 * Phase 1 implementation status:
 * - This file now implements the first working local auth slice: setup, login,
 *   refresh rotation, logout, and current-user loading.
 * - Current scope supports a single local owner account and seeds the default
 *   workspace/channel/agent required by the first milestone chat experience.
 * - Future phases will extend this service with invites, password reset, and RBAC.
 */

import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

import type { LoginInput } from '@nextgenchat/types';

import type { SetupInput } from '@/modules/auth/auth.schema.js';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_CHANNEL_NAME,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
  REFRESH_TOKEN_TTL_SECONDS,
  SETUP_COMPLETE_KEY,
} from '@/config/constants.js';
import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { encryptJson, hashToken } from '@/lib/crypto.js';
import { redis } from '@/lib/redis.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';

const FAILED_LOGIN_PREFIX = 'auth:failed-login:';

interface SessionUser {
  id: string;
  username: string;
}

function createAccessToken(user: SessionUser) {
  return jwt.sign({ sub: user.id, username: user.username }, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

async function createRefreshToken(userId: string) {
  const rawToken = randomBytes(32).toString('hex');

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });

  return rawToken;
}

function sanitizeAgentSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'primary-agent';
}

async function issueSession(
  user: SessionUser,
): Promise<{ accessToken: string; expiresIn: number; user: SessionUser; refreshToken: string }> {
  const accessToken = createAccessToken(user);
  const refreshToken = await createRefreshToken(user.id);

  return {
    accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user,
    refreshToken,
  };
}

export class AuthService {
  async getSetupRequired() {
    const count = await prisma.user.count();
    return count === 0;
  }

  async setupOwner(input: SetupInput) {
    if (!(await this.getSetupRequired())) {
      throw new Error('Setup has already been completed.');
    }

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });

    const user = await prisma.user.create({
      data: {
        username: input.username,
        passwordHash,
      },
    });

    const workspace = await prisma.workspace.create({
      data: {
        ownerId: user.id,
        name: DEFAULT_WORKSPACE_NAME,
        slug: DEFAULT_WORKSPACE_SLUG,
        memberships: {
          create: {
            userId: user.id,
            role: 'OWNER',
          },
        },
      },
    });

    const channel = await prisma.channel.create({
      data: {
        workspaceId: workspace.id,
        name: DEFAULT_CHANNEL_NAME,
        type: 'PUBLIC',
        memberships: {
          create: {
            userId: user.id,
            role: 'OWNER',
          },
        },
      },
    });

    const agent = await prisma.agent.create({
      data: {
        workspaceId: workspace.id,
        createdBy: user.id,
        name: input.agentName,
        slug: sanitizeAgentSlug(input.agentName),
        triggerMode: 'AUTO',
        primaryChannelId: channel.id,
        identity: {
          create: {
            systemPrompt: input.agentSystemPrompt,
            persona: 'Local-first collaborative AI agent',
            voiceTone: 'calm and technical',
          },
        },
        channelMemberships: {
          create: {
            channelId: channel.id,
          },
        },
        providerConfig: {
          create: {
            providerName: 'openai',
            model: env.OPENAI_MODEL || DEFAULT_AGENT_MODEL,
            credentials: encryptJson({}),
            config: { temperature: 0.4, maxTokens: 1024 },
          },
        },
        tools: {
          create: [
            {
              toolName: 'workspace.read_file',
              config: {
                description: 'Read a file from the agent workspace.',
                access: 'workspace-only',
              },
              requiresApproval: false,
            },
            {
              toolName: 'workspace.apply_patch',
              config: {
                description: 'Apply a structured patch to files inside the agent workspace.',
                access: 'workspace-only',
              },
              requiresApproval: true,
            },
          ],
        },
      },
    });

    await workspaceService.ensureAgentDocs(agent.id);

    await prisma.systemSetting.upsert({
      where: { key: SETUP_COMPLETE_KEY },
      update: { value: true },
      create: { key: SETUP_COMPLETE_KEY, value: true },
    });

    return issueSession({
      id: user.id,
      username: user.username,
    });
  }

  async login(input: LoginInput) {
    const key = `${FAILED_LOGIN_PREFIX}${input.login.toLowerCase()}`;
    const failures = Number((await redis.get(key)) ?? 0);

    if (failures >= 10) {
      throw new Error('Account temporarily locked. Please wait and try again.');
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ username: input.login }, { email: input.login }],
      },
    });

    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      await redis.multi().incr(key).expire(key, 60 * 15).exec();
      throw new Error('Invalid credentials.');
    }

    await redis.del(key);

    return issueSession({ id: user.id, username: user.username });
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);

    const token = await prisma.refreshToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!token) {
      throw new Error('Refresh token is invalid.');
    }

    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });

    return issueSession({
      id: token.user.id,
      username: token.user.username,
    });
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) {
      return;
    }

    await prisma.refreshToken.updateMany({
      where: {
        tokenHash: hashToken(refreshToken),
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new Error('User not found.');
    }

    return user;
  }
}

export const authService = new AuthService();
