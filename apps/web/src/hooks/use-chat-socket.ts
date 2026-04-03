/**
 * Chat Socket Hook
 *
 * Phase 1 implementation status:
 * - This file now returns the authenticated chat socket instance for the first
 *   working local chat screen.
 * - Current scope depends on the in-memory access token managed by the auth provider.
 * - Future phases can extend this hook with presence and reconnection behaviors.
 */

'use client';

import { useMemo } from 'react';

import { getChatSocket } from '@/lib/socket';

export function useChatSocket(accessToken: string) {
  return useMemo(() => getChatSocket(accessToken), [accessToken]);
}
