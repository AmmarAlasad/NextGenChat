/**
 * Agent Admin Route
 *
 * Hosts the dedicated management UI for a single agent workspace, including its
 * durable markdown operating documents.
 */

import { AgentAdminScreen } from '@/components/agent-admin-screen';

export default async function AgentAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <AgentAdminScreen agentId={id} />;
}
