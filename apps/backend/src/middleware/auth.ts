/**
 * Auth Middleware
 *
 * Phase 1 implementation status:
 * - This file now verifies access tokens for the first working local-only flow.
 * - Current scope covers REST route protection and Socket.io handshake verification.
 * - Future phases can extend this middleware with RBAC helpers and richer policy checks.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';

import type { JwtPayload } from '@nextgenchat/types';

import { env } from '@/config/env.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
}

export type AuthenticatedRequest = FastifyRequest & {
  authUser?: AuthenticatedUser;
};

export function verifyAccessToken(token: string): AuthenticatedUser {
  const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

  return {
    id: payload.sub,
    username: payload.username,
  };
}

export async function authenticateRequest(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Missing access token.' });
  }

  try {
    const authUser = verifyAccessToken(header.slice('Bearer '.length));
    (request as AuthenticatedRequest).authUser = authUser;
  } catch {
    return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid access token.' });
  }
}

export function requireAuthUser(request: FastifyRequest) {
  const authUser = (request as AuthenticatedRequest).authUser;

  if (!authUser) {
    throw new Error('Request is missing authenticated user context.');
  }

  return authUser;
}
