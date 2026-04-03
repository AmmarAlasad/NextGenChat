/**
 * Chat Namespace Socket Handlers
 *
 * Phase 1 implementation status:
 * - This file now handles the first working chat socket loop: auth, room joins,
 *   and user message sends.
 * - Current scope validates the shared message payload schema and reuses the chat service.
 * - Future phases will add edits, deletes, typing, and reactions here.
 */

import type { Namespace } from 'socket.io';

import { SendMessageSchema } from '@/modules/chat/chat.schema.js';
import { chatService } from '@/modules/chat/chat.service.js';
import { verifyAccessToken } from '@/middleware/auth.js';
import { getChannelRoom } from '@/sockets/socket-server.js';

export function registerChatNamespace(namespace: Namespace) {
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
    socket.on('channel:join', async ({ channelId }) => {
      try {
        await chatService.ensureSocketChannelAccess(socket.data.authUser.id, channelId);
        await socket.join(getChannelRoom(channelId));
      } catch (error) {
        socket.emit('error', {
          code: 'CHANNEL_ACCESS_DENIED',
          message: error instanceof Error ? error.message : 'Unable to join channel.',
        });
      }
    });

    socket.on('channel:leave', async ({ channelId }) => {
      await socket.leave(getChannelRoom(channelId));
    });

    socket.on('message:send', async (payload) => {
      try {
        const input = SendMessageSchema.parse(payload);
        await chatService.createUserMessage(socket.data.authUser.id, input);
      } catch (error) {
        socket.emit('error', {
          code: 'MESSAGE_SEND_FAILED',
          message: error instanceof Error ? error.message : 'Unable to send message.',
        });
      }
    });
  });
}
