/**
 * Auth Routes — Fastify Route Registration
 *
 * Phase 1 implementation status:
 * - This file now exposes the working first-run setup and local auth routes.
 * - Current scope includes setup, login, refresh, logout, and current-user lookup.
 * - Future phases will add invite, reset-password, and shared-mode flows here.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_SECONDS } from '@/config/constants.js';
import { env } from '@/config/env.js';
import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import {
  LoginSchema,
  SetupSchema,
} from '@/modules/auth/auth.schema.js';
import { authService } from '@/modules/auth/auth.service.js';

function setRefreshCookie(reply: FastifyReply, refreshToken: string) {
  (reply as FastifyReply & { setCookie: (...args: unknown[]) => FastifyReply }).setCookie(
    REFRESH_COOKIE_NAME,
    refreshToken,
    {
    httpOnly: true,
    sameSite: 'strict',
    secure: !env.isLocalMode,
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
    },
  );
}

function getCookies(request: FastifyRequest) {
  return (request as FastifyRequest & { cookies: Record<string, string | undefined> }).cookies ?? {};
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/setup', async (request, reply) => {
    const input = SetupSchema.parse(request.body);
    const result = await authService.setupOwner(input);

    setRefreshCookie(reply, result.refreshToken);
    return reply.send({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  });

  fastify.post('/login', async (request, reply) => {
    const input = LoginSchema.parse(request.body);
    const result = await authService.login(input);

    setRefreshCookie(reply, result.refreshToken);
    return reply.send({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  });

  fastify.post('/refresh', async (request, reply) => {
    const refreshToken = getCookies(request)[REFRESH_COOKIE_NAME];

    if (!refreshToken) {
      return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Missing refresh token.' });
    }

    const result = await authService.refresh(refreshToken);
    setRefreshCookie(reply, result.refreshToken);

    return reply.send({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  });

  fastify.post('/logout', async (request, reply) => {
    await authService.logout(getCookies(request)[REFRESH_COOKIE_NAME]);

    (reply as FastifyReply & { clearCookie: (...args: unknown[]) => FastifyReply }).clearCookie(
      REFRESH_COOKIE_NAME,
      {
        path: '/',
      },
    );

    return reply.status(204).send();
  });

  fastify.get('/me', { preHandler: authenticateRequest }, async (request) => {
    const authUser = requireAuthUser(request);
    return authService.getCurrentUser(authUser.id);
  });
};
