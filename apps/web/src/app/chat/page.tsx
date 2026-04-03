/**
 * Chat Route
 *
 * Phase 1 implementation status:
 * - This file now hosts the first real chat interface for the working milestone.
 * - Current scope renders one workspace, one channel, one agent, and live message updates.
 * - Future phases can expand this route into a fuller multi-workspace application shell.
 */

import { ChatScreen } from '@/components/chat-screen';

export default function ChatPage() {
  return <ChatScreen />;
}
