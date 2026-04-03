/**
 * Presence Namespace Socket Handlers
 *
 * Phase 1 implementation status:
 * - This file now keeps a minimal placeholder presence namespace alive so the
 *   runtime matches the planned architecture.
 * - Current scope authenticates the connection and emits a simple ONLINE signal.
 * - Future phases will add heartbeat refreshes, bulk status queries, and Redis TTLs.
 */

import type { Namespace } from 'socket.io';

import { verifyAccessToken } from '@/middleware/auth.js';

export function registerPresenceNamespace(namespace: Namespace) {
  namespace.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (typeof token !== 'string') {
        throw new Error('Missing access token.');
      }

      socket.data.authUser = verifyAccessToken(token);
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error('Unauthorized'));
    }
  });

  namespace.on('connection', (socket) => {
    socket.emit('presence:update', {
      userId: socket.data.authUser.id,
      status: 'ONLINE',
    });
  });
}
