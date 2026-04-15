/**
 * Socket.io Client Helpers
 *
 * Phase 1 implementation status:
 * - This file now creates the authenticated `/chat` socket used by the first
 *   working local chat screen.
 * - Current scope keeps one live socket instance per in-memory access token.
 * - Future phases can expand this file with `/presence` and reconnection policies.
 */

import { io, type Socket } from 'socket.io-client';

import type { ClientToServerEvents, ServerToClientEvents } from '@nextgenchat/types';

let chatSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let activeToken: string | null = null;

function getSocketBaseUrl() {
  if (process.env.NEXT_PUBLIC_SOCKET_URL) {
    return process.env.NEXT_PUBLIC_SOCKET_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }

  return 'http://localhost:3001';
}

export function getChatSocket(accessToken: string) {
  const baseUrl = getSocketBaseUrl();

  if (!chatSocket || activeToken !== accessToken) {
    chatSocket?.disconnect();

    chatSocket = io(`${baseUrl}/chat`, {
      autoConnect: false,
      withCredentials: true,
      auth: {
        token: accessToken,
      },
    });

    activeToken = accessToken;
  }

  return chatSocket;
}

export function disconnectChatSocket() {
  chatSocket?.disconnect();
  chatSocket = null;
  activeToken = null;
}
