/**
 * Socket Server Bootstrap
 *
 * Phase 1 implementation status:
 * - This file now wires the first working Socket.io layer for local chat updates.
 * - Current scope creates the `/chat` and `/presence` namespaces and attaches the
 *   Redis adapter so the architecture remains aligned with the long-term plan.
 * - Future phases will add richer presence, scaling, and moderation hooks here.
 */

import type { Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';

import type { ClientToServerEvents, ServerToClientEvents } from '@nextgenchat/types';

import { SOCKET_NAMESPACES } from '@/config/constants.js';
import { redisPublisher, redisSubscriber } from '@/lib/redis.js';
import { registerChatNamespace } from '@/sockets/chat.socket.js';
import { registerPresenceNamespace } from '@/sockets/presence.socket.js';

let io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

export function getChannelRoom(channelId: string) {
  return `channel:${channelId}`;
}

export function createSocketServer(server: HttpServer) {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.adapter(createAdapter(redisPublisher, redisSubscriber));

  registerChatNamespace(io.of(SOCKET_NAMESPACES.chat));
  registerPresenceNamespace(io.of(SOCKET_NAMESPACES.presence));

  return io;
}

export function getSocketServer() {
  if (!io) {
    throw new Error('Socket server has not been created yet.');
  }

  return io;
}

export function getChatNamespace() {
  return getSocketServer().of(SOCKET_NAMESPACES.chat);
}
